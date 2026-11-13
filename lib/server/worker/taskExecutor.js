'use strict';

// 阶段 5.3：把"领取到任务"推进成"供应商调用 + 任务终态"。
// 这一层只负责单次领取的执行语义，不负责轮询调度、进程管理或额度计算：
// - 提交前先按 taskId 找回未终结的调用记录，避免崩溃恢复时重复提交；
// - 提交被受理后保留调用租约并轮询，调用租约与任务租约分别由 heartbeat 续期；
// - 成功由"调用记录 → succeeded"与"任务 → succeeded + result"在同一事务内提交，
//   不允许出现"调用成功但任务仍在运行"的中间态，否则恢复时会再提交一次；
// - 失败按 providerExecution 的决策分成重试、终态失败和未知提交三种，未知提交复用同一把幂等键。

const queue = require('./taskQueue');
const ledger = require('../providers/providerCallLedger');
const { mapProviderError } = require('../providers/providerExecution');
const { validateProviderResult } = require('../providers/resultBoundary');
const { isProviderInvocationNotStarted } = require('../providers/providerInvocationGate');
const { createResultFetcher } = require('../providers/resultFetcher');
const { createAssetArchive } = require('../assetArchive');

const { TaskQueueError } = queue;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

// 真实文件归档要等对象存储接入；这里显式标注，避免把"只有描述符"误读成"结果已落盘"。
const ARCHIVE_STATE = 'not_configured';

const DEFAULT_POLL = Object.freeze({
    maxAttempts: 40,
    minDelayMs: 10,
    maxDelayMs: 1000,
});

const DEFAULT_RETRY_DELAY_SECONDS = 30;
const DEFAULT_UNKNOWN_RETRY_DELAY_SECONDS = 5;
const DEFAULT_RESULT_ARCHIVE_MAX_BYTES = 50 * 1024 * 1024;

class TaskExecutionError extends Error {
    constructor(code, message, { retryable = false, retryDelaySeconds = 0 } = {}) {
        super(message);
        this.name = 'TaskExecutionError';
        this.code = code;
        this.taskFailure = Object.freeze({
            errorMessage: code,
            retryDelaySeconds: Number.isInteger(retryDelaySeconds) && retryDelaySeconds > 0 ? retryDelaySeconds : 0,
            terminal: retryable !== true,
        });
    }
}

function assertPool(pool) {
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
        throw new TypeError('pool is required');
    }
}

function assertTask(task) {
    if (!task || typeof task !== 'object') throw new TypeError('task is required');
    if (typeof task.id !== 'string' || !UUID_PATTERN.test(task.id)) throw new TypeError('task.id must be a UUID');
    if (typeof task.lease_token !== 'string' || task.lease_token.trim() === '') {
        throw new TypeError('task.lease_token is required');
    }
    if (!Number.isInteger(task.attempts) || task.attempts <= 0) {
        throw new TypeError('task.attempts must be a positive integer');
    }
    if (typeof task.task_type !== 'string' || task.task_type.trim() === '') {
        throw new TypeError('task.task_type is required');
    }
    if (!task.payload || typeof task.payload !== 'object' || Array.isArray(task.payload)) {
        throw new TypeError('task.payload must be an object');
    }
}

function normalizeOptions(options) {
    const provider = options.provider;
    if (!provider || typeof provider !== 'object'
        || typeof provider.submit !== 'function' || typeof provider.query !== 'function') {
        throw new TypeError('provider with submit and query is required');
    }
    if (typeof provider.name !== 'string' || provider.name.trim() === '') {
        throw new TypeError('provider.name is required');
    }
    if (typeof options.workerId !== 'string' || options.workerId.trim() === '') {
        throw new TypeError('workerId is required');
    }
    const leaseSeconds = options.leaseSeconds ?? 60;
    if (!Number.isInteger(leaseSeconds) || leaseSeconds <= 0) {
        throw new TypeError('leaseSeconds must be a positive integer');
    }
    const poll = { ...DEFAULT_POLL, ...(options.poll || {}) };
    for (const name of ['maxAttempts', 'minDelayMs', 'maxDelayMs']) {
        if (!Number.isInteger(poll[name]) || poll[name] <= 0) {
            throw new TypeError(`poll.${name} must be a positive integer`);
        }
    }
    if (poll.minDelayMs > poll.maxDelayMs) {
        throw new TypeError('poll.minDelayMs cannot exceed poll.maxDelayMs');
    }
    const retryDelaySeconds = options.retryDelaySeconds ?? DEFAULT_RETRY_DELAY_SECONDS;
    const unknownRetryDelaySeconds = options.unknownRetryDelaySeconds ?? DEFAULT_UNKNOWN_RETRY_DELAY_SECONDS;
    for (const [name, value] of [['retryDelaySeconds', retryDelaySeconds], ['unknownRetryDelaySeconds', unknownRetryDelaySeconds]]) {
        if (!Number.isInteger(value) || value < 0) {
            throw new TypeError(`${name} must be a non-negative integer`);
        }
    }
    const assetArchive = options.assetArchive || (options.objectStore
        ? createAssetArchive({ pool: options.assetPool || options.archivePool || options.pool, objectStore: options.objectStore, maxBytes: options.archiveMaxBytes ?? DEFAULT_RESULT_ARCHIVE_MAX_BYTES })
        : null);
    return {
        provider,
        providerName: provider.name.trim(),
        workerId: options.workerId.trim(),
        leaseSeconds,
        poll,
        retryDelaySeconds,
        unknownRetryDelaySeconds,
        signal: options.signal,
        assetArchive,
        // 结果 URL 策略（回环/明文）只在本地与测试环境放宽，
        // 与 resultBoundary 和抓取器共用同一个开关，避免两处策略不一致。
        allowInsecureResultFetch: options.allowInsecureResultFetch === true,
        // 结果只有 URL 时，必须先由服务端抓成二进制才能归档。
        // 没有归档器就不抓：描述符保留 URL，行为与之前一致。
        resultFetcher: assetArchive
            ? (options.resultFetcher || createResultFetcher({
                maxBytes: options.archiveMaxBytes ?? DEFAULT_RESULT_ARCHIVE_MAX_BYTES,
                timeoutMs: options.resultFetchTimeoutMs ?? 30_000,
                allowInsecureLoopback: options.allowInsecureResultFetch === true,
            }))
            : null,
        sleep: typeof options.sleep === 'function'
            ? options.sleep
            : (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    };
}

// 供应商幂等键在 provider_calls 里必须唯一，因此按"任务 + 第几次提交"派生。
// 崩溃恢复不会新建提交轮次，所以同一轮次始终复用同一把键。
function providerIdempotencyKey(taskId, attemptNo) {
    return `pt_${taskId.replaceAll('-', '')}_${attemptNo}`;
}

function resultDescriptor(providerResult, providerName, { allowInsecureLoopback = false } = {}) {
    if (!providerResult || typeof providerResult !== 'object' || Array.isArray(providerResult)) {
        throw new TaskExecutionError('RESULT_INVALID', 'Provider result is missing');
    }
    if (providerResult.asset && typeof providerResult.asset === 'object') {
        // mock/内联产物：只保留可审计摘要，绝不把 content 之类的内容写进数据库。
        const asset = providerResult.asset;
        return {
            kind: typeof asset.kind === 'string' && asset.kind.trim() ? asset.kind.trim().slice(0, 64) : 'asset',
            mediaType: typeof asset.mediaType === 'string' ? asset.mediaType : null,
            sizeBytes: Number.isSafeInteger(asset.sizeBytes) ? asset.sizeBytes : null,
            resultUrl: null,
            archive: ARCHIVE_STATE,
            provider: providerName,
        };
    }
    let normalized;
    try {
        normalized = validateProviderResult(providerResult, { allowInsecureLoopback });
    } catch (error) {
        throw new TaskExecutionError('RESULT_INVALID', error.message || 'Provider result is invalid');
    }
    return {
        kind: 'asset',
        mediaType: normalized.mediaType,
        sizeBytes: normalized.sizeBytes,
        // 描述符先记下 URL；若配置了归档器，finalizeSuccess 会在事务外抓取它，
        // 抓取成功后用本地资产地址替换，抓取失败不会把外部 URL 暴露给客户端。
        resultUrl: normalized.resultUrl,
        archive: ARCHIVE_STATE,
        provider: providerName,
    };
}

function clampDelay(pollAfterMs, poll) {
    const requested = Number.isFinite(pollAfterMs) ? Math.floor(pollAfterMs) : poll.minDelayMs;
    return Math.min(poll.maxDelayMs, Math.max(poll.minDelayMs, requested));
}

function translateLeaseLoss(error) {
    if (error instanceof ledger.ProviderCallLedgerError && error.code === 'LEASE_LOST') {
        return new TaskQueueError('LEASE_LOST', error.message || 'Provider call lease is no longer valid');
    }
    return error;
}

function isAborted(signal) {
    return Boolean(signal && signal.aborted);
}

// 取消沿用 TaskExecutionError 的通道，但必须与"失败"区分：
// Worker 看到 cancelled=true 会写 cancelled 终态，而不是 failTask（后者可能把任务退回队列）。
function cancellationError() {
    const error = new TaskExecutionError('TASK_CANCELLED', 'Task cancellation was requested');
    error.cancelled = true;
    return error;
}

// 放弃一条仍由本 Worker 持有的调用记录。调用侧租约已丢失时不在这里报错：
// 任务侧取消仍然成立，租约问题交给上层统一翻译成 LEASE_LOST。
async function abandonProviderCall(pool, call, ctx, errorCode = 'TASK_CANCEL_REQUESTED') {
    try {
        await ledger.markProviderCallTerminal(pool, {
            callId: call.id,
            workerId: ctx.workerId,
            leaseToken: call.lease_token,
            status: 'cancelled',
            errorCode,
        });
    } catch (error) {
        if (!(error instanceof ledger.ProviderCallLedgerError && error.code === 'LEASE_LOST')) throw error;
    }
}

// 执行器只在安全点检查取消：提交前、每次轮询前。检查本身不改状态，
// 真正写 cancelled 由 Worker 在收到 cancelled 错误后调用 cancelClaimedTask 完成。
async function assertNotCancelled(pool, task, ctx, call) {
    const requested = await queue.isCancellationRequested(pool, {
        taskId: task.id,
        leaseToken: task.lease_token,
    });
    if (!requested) return;
    if (call) await abandonProviderCall(pool, call, ctx);
    throw cancellationError();
}

async function settleCallFailure(pool, call, ctx, errorCode, status = 'failed') {
    if (!ERROR_CODE_PATTERN.test(errorCode)) {
        throw new TypeError('errorCode must be a fixed uppercase code');
    }
    await ledger.markProviderCallTerminal(pool, {
        callId: call.id,
        workerId: ctx.workerId,
        leaseToken: call.lease_token,
        status,
        errorCode,
    });
}

// 未知提交：状态停在 unknown，等待退避后用同一把幂等键重新提交。
async function parkUnknownCall(pool, call, ctx, errorCode) {
    if (call.status === ledger.CALL_STATUS.SUBMITTING) {
        await ledger.markProviderCallUnknown(pool, {
            callId: call.id,
            workerId: ctx.workerId,
            leaseToken: call.lease_token,
            errorCode,
        });
        return;
    }
    await ledger.deferProviderCall(pool, {
        callId: call.id,
        workerId: ctx.workerId,
        leaseToken: call.lease_token,
        errorCode,
        retryDelaySeconds: ctx.unknownRetryDelaySeconds,
    });
}

async function finalizeSuccess(pool, task, call, ctx, providerResult, providerJobId) {
    let result;
    let normalizedResult = null;
    try {
        result = resultDescriptor(providerResult, ctx.providerName, {
            allowInsecureLoopback: ctx.allowInsecureResultFetch,
        });
        if (!(providerResult?.asset && typeof providerResult.asset === 'object')) {
            normalizedResult = validateProviderResult(providerResult, {
                allowInsecureLoopback: ctx.allowInsecureResultFetch,
            });
        }
    } catch (error) {
        // 结果不合契约时先终结调用记录，再让任务进入终态失败：
        // 否则会留下一条永远无法恢复的 submitting/accepted 记录。
        if (error instanceof TaskExecutionError && error.code === 'RESULT_INVALID') {
            await settleCallFailure(pool, call, ctx, 'RESULT_INVALID');
        }
        throw error;
    }
    // 同步完成时提交从未经过 accepted，provider_job_id 还没写下；
    // 没有任务号就无法满足"成功必须有任务号"的约束，按协议违规处理。
    const needsJobId = call.status === ledger.CALL_STATUS.SUBMITTING;
    if (needsJobId && (typeof providerJobId !== 'string' || providerJobId.trim() === '')) {
        await settleCallFailure(pool, call, ctx, 'RESULT_INVALID');
        throw new TaskExecutionError('RESULT_INVALID', 'A completed submission must include a provider job id');
    }
    // URL 形式的结果必须先在事务外抓成二进制：供应商 CDN 可能很慢，
    // 不能在持有任务行锁时等待网络。抓取失败按可重试处理，
    // 调用记录停在 accepted，重试会用同一任务号重新取结果，不会重复计费。
    let archivedBytes = normalizedResult?.bytes ?? null;
    let archivedMimeType = normalizedResult?.mimeType ?? null;
    if (!archivedBytes && normalizedResult?.resultUrl && ctx.assetArchive) {
        if (!ctx.resultFetcher) {
            throw new TaskExecutionError('RESULT_FETCH_UNAVAILABLE', 'Provider result URL cannot be downloaded');
        }
        try {
            const fetched = await ctx.resultFetcher.fetchResult({
                url: normalizedResult.resultUrl,
                mediaType: normalizedResult.mediaType,
                signal: ctx.signal,
            });
            archivedBytes = fetched.bytes;
            archivedMimeType = fetched.mimeType || archivedMimeType;
        } catch (error) {
            if (isAborted(ctx.signal)) throw cancellationError();
            const failure = new TaskExecutionError(
                'RESULT_FETCH_FAILED',
                'Provider result could not be downloaded',
                { retryable: true, retryDelaySeconds: ctx.retryDelaySeconds },
            );
            failure.cause = error;
            throw failure;
        }
    }
    const client = await pool.connect();
    let archivedStorageKey = null;
    let archiveSucceeded = false;
    try {
        await client.query('BEGIN');
        // 先锁任务行：把"结果落库"与"用户取消"串行化。取消事务先提交时这里能看到意图，
        // 任务按取消终结、不写入 result；反过来则取消 API 会看到 succeeded 并拒绝取消。
        const locked = await queue.lockClaimedTask(client, {
            taskId: task.id,
            leaseToken: task.lease_token,
        });
        // 顺序固定：先把调用记录推进到 accepted（补上供应商任务号），再结算成功，最后结算任务。
        if (needsJobId) {
            await ledger.acceptProviderCallHolding(client, {
                callId: call.id,
                workerId: ctx.workerId,
                leaseToken: call.lease_token,
                providerJobId,
                leaseSeconds: ctx.leaseSeconds,
            });
        }
        await ledger.markProviderCallSucceeded(client, {
            callId: call.id,
            workerId: ctx.workerId,
            leaseToken: call.lease_token,
        });
        if (locked.cancel_requested) {
            // 供应商确实完成了（成本已经发生），调用记录如实记为 succeeded；
            // 但用户在结果落库前已请求取消，任务不写入 result，直接按取消终结。
            await queue.cancelClaimedTask(client, {
                taskId: task.id,
                leaseToken: task.lease_token,
            });
            await client.query('COMMIT');
            return {
                finalized: true,
                status: queue.TASK_STATUS.CANCELLED,
                taskId: task.id,
                providerCallId: call.id,
                result: null,
            };
        }
        if (ctx.assetArchive && archivedBytes) {
            try {
                const archived = await ctx.assetArchive.archive({
                    client,
                    ownerId: task.owner_id,
                    mediaType: normalizedResult.mediaType,
                    mimeType: archivedMimeType,
                    bytes: archivedBytes,
                    metadata: { source: 'provider', provider: ctx.providerName, taskId: task.id },
                });
                archivedStorageKey = archived.storageKey;
                archiveSucceeded = true;
                result = {
                    kind: 'asset',
                    mediaType: archived.mediaType,
                    sizeBytes: archived.sizeBytes,
                    assetId: archived.assetId,
                    resultUrl: archived.resultUrl,
                    archive: archived.archive,
                    provider: ctx.providerName,
                };
            } catch (error) {
                // 对外仍只暴露固定码；原始原因挂在 cause 上，供本地诊断打印，
                // 否则只会看到 ASSET_ARCHIVE_FAILED 而无从判断是权限、约束还是路径问题。
                const failure = new TaskExecutionError('ASSET_ARCHIVE_FAILED', 'Provider result could not be archived');
                failure.cause = error;
                throw failure;
            }
        }
        const updated = await queue.completeTask(client, {
            taskId: task.id,
            leaseToken: task.lease_token,
            result,
        });
        await client.query('COMMIT');
        return {
            finalized: true,
            status: queue.TASK_STATUS.SUCCEEDED,
            taskId: task.id,
            providerCallId: call.id,
            result: updated.result,
        };
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        if (archiveSucceeded && archivedStorageKey) {
            await ctx.assetArchive?.discard?.({ storageKey: archivedStorageKey });
        }
        throw error;
    } finally {
        client.release();
    }
}

async function pollProviderCall(pool, task, initialCall, ctx) {
    let call = initialCall;
    for (let attempt = 0; attempt < ctx.poll.maxAttempts; attempt += 1) {
        if (isAborted(ctx.signal)) {
            throw new TaskExecutionError('WORKER_ABORTED', 'Worker aborted while polling the provider');
        }
        call = await ledger.heartbeatProviderCall(pool, {
            callId: call.id,
            workerId: ctx.workerId,
            leaseToken: call.lease_token,
            leaseSeconds: ctx.leaseSeconds,
        });
        // 取消只在轮询边界生效：已经开始的一次 query 无法撤回，但不会再发起下一次。
        await assertNotCancelled(pool, task, ctx, call);

        let status;
        try {
            status = await ctx.provider.query(
                { providerJobId: call.provider_job_id, taskId: task.id },
                { signal: ctx.signal },
            );
        } catch (error) {
            return handleQueryFailure(pool, task, call, ctx, error);
        }

        const state = status && typeof status === 'object' ? status.state : null;
        if (state === 'succeeded') {
            return finalizeSuccess(pool, task, call, ctx, status.result);
        }
        if (state === 'cancelled') {
            await settleCallFailure(pool, call, ctx, 'PROVIDER_CANCELLED', 'cancelled');
            throw new TaskExecutionError('PROVIDER_CANCELLED', 'Provider job was cancelled');
        }
        if (state === 'failed' || state === 'expired') {
            const code = state === 'failed' ? 'PROVIDER_JOB_FAILED' : 'PROVIDER_JOB_EXPIRED';
            await settleCallFailure(pool, call, ctx, code);
            throw new TaskExecutionError(code, `Provider job ended in state ${state}`);
        }
        if (state !== 'queued' && state !== 'running') {
            await settleCallFailure(pool, call, ctx, 'PROVIDER_PROTOCOL_VIOLATION');
            throw new TaskExecutionError('PROVIDER_PROTOCOL_VIOLATION', 'Provider returned an unsupported job state');
        }
        await ctx.sleep(clampDelay(status.pollAfterMs, ctx.poll));
    }

    await deferCall(pool, call, ctx, 'PROVIDER_POLL_TIMEOUT');
    throw new TaskExecutionError('PROVIDER_POLL_TIMEOUT', 'Provider job did not finish within the polling window', {
        retryable: true,
        retryDelaySeconds: ctx.retryDelaySeconds,
    });
}

async function deferCall(pool, call, ctx, errorCode) {
    await ledger.deferProviderCall(pool, {
        callId: call.id,
        workerId: ctx.workerId,
        leaseToken: call.lease_token,
        errorCode,
        retryDelaySeconds: ctx.retryDelaySeconds,
    });
}

async function handleQueryFailure(pool, task, call, ctx, error) {
    const decision = mapProviderError(error, { phase: 'query', retryDelaySeconds: ctx.retryDelaySeconds });
    if (decision.retryable) {
        // 可重试的查询失败不终结调用：保留 accepted 与 provider_job_id，退避后继续轮询。
        await deferCall(pool, call, ctx, decision.errorCode);
        throw new TaskExecutionError(decision.errorCode, 'Provider query failed', {
            retryable: true,
            retryDelaySeconds: ctx.retryDelaySeconds,
        });
    }
    await settleCallFailure(pool, call, ctx, decision.errorCode);
    throw new TaskExecutionError(decision.errorCode, 'Provider query failed');
}

async function handleSubmissionFailure(pool, call, ctx, error, newCall) {
    if (isProviderInvocationNotStarted(error)) {
        const code = /^PROVIDER_GATE_(?:REVOKED|CLOSED|DRAINING|ABORTED)$/.test(error.code) ? error.code : 'PROVIDER_GATE_CLOSED';
        // 本次未发送不能证明崩溃前未发送；历史记录必须保留原幂等键及不确定性。
        if (!newCall) {
            await parkUnknownCall(pool, call, ctx, code);
            throw new TaskExecutionError(code, 'Historical provider submission remains unknown', {
                retryable: true,
                retryDelaySeconds: ctx.unknownRetryDelaySeconds,
            });
        }
        await settleCallFailure(pool, call, ctx, code);
        throw new TaskExecutionError(code, 'Provider submission was rejected before dispatch');
    }
    const decision = mapProviderError(error, { phase: 'submit', retryDelaySeconds: ctx.retryDelaySeconds });
    if (decision.action === 'unknown_submission') {
        await parkUnknownCall(pool, call, ctx, decision.errorCode);
        throw new TaskExecutionError(decision.errorCode, 'Provider submission result is unknown', {
            retryable: true,
            retryDelaySeconds: ctx.unknownRetryDelaySeconds,
        });
    }
    await settleCallFailure(pool, call, ctx, decision.errorCode);
    throw new TaskExecutionError(decision.errorCode, 'Provider submission failed', {
        retryable: decision.retryable,
        retryDelaySeconds: decision.retryable ? ctx.retryDelaySeconds : 0,
    });
}

async function handleSubmissionResult(pool, task, call, ctx, submitted) {
    if (!submitted || typeof submitted !== 'object' || typeof submitted.kind !== 'string') {
        await settleCallFailure(pool, call, ctx, 'PROVIDER_PROTOCOL_VIOLATION');
        throw new TaskExecutionError('PROVIDER_PROTOCOL_VIOLATION', 'Provider returned an unsupported submission result');
    }
    switch (submitted.kind) {
        case 'completed':
            return finalizeSuccess(pool, task, call, ctx, submitted.result, submitted.providerJobId);
        case 'accepted': {
            const accepted = await ledger.acceptProviderCallHolding(pool, {
                callId: call.id,
                workerId: ctx.workerId,
                leaseToken: call.lease_token,
                providerJobId: submitted.providerJobId,
                leaseSeconds: ctx.leaseSeconds,
            });
            return pollProviderCall(pool, task, accepted, ctx);
        }
        case 'unknown':
            await parkUnknownCall(pool, call, ctx, 'PROVIDER_SUBMISSION_UNKNOWN');
            throw new TaskExecutionError('PROVIDER_SUBMISSION_UNKNOWN', 'Provider submission result is unknown', {
                retryable: true,
                retryDelaySeconds: ctx.unknownRetryDelaySeconds,
            });
        default:
            await settleCallFailure(pool, call, ctx, 'PROVIDER_PROTOCOL_VIOLATION');
            throw new TaskExecutionError('PROVIDER_PROTOCOL_VIOLATION', `Unsupported provider submission kind: ${submitted.kind}`);
    }
}

async function runSubmission(pool, task, call, ctx, newCall = false) {
    if (isAborted(ctx.signal)) {
        throw new TaskExecutionError('WORKER_ABORTED', 'Worker aborted before submitting to the provider');
    }
    // 提交前最后确认一次：已登记取消的任务不应再向供应商发起新的提交。
    await assertNotCancelled(pool, task, ctx, call);
    let submitted;
    try {
        submitted = await ctx.provider.submit({
            taskId: task.id,
            // 恢复时复用记录里的键，而不是按当前 attempts 重新派生：两者可能不同（恢复不新增轮次）。
            idempotencyKey: call.idempotency_key,
            taskType: task.task_type,
            input: task.payload,
        }, { signal: ctx.signal });
    } catch (error) {
        return handleSubmissionFailure(pool, call, ctx, error, newCall);
    }
    return handleSubmissionResult(pool, task, call, ctx, submitted);
}

async function continueProviderCall(pool, task, call, ctx) {
    switch (call.status) {
        case ledger.CALL_STATUS.ACCEPTED:
            return pollProviderCall(pool, task, call, ctx);
        case ledger.CALL_STATUS.SUBMITTING:
        case ledger.CALL_STATUS.UNKNOWN:
            return runSubmission(pool, task, call, ctx);
        default:
            throw new TaskExecutionError(
                'PROVIDER_CALL_STATE_INVALID',
                `Provider call cannot be resumed from status ${call.status}`,
            );
    }
}

async function execute(pool, task, options) {
    assertPool(pool);
    assertTask(task);
    const hasRoute = ['logical_model_pk', 'route_snapshot', 'route_snapshot_version', 'route_snapshot_hash']
        .some(key => task[key] != null);
    let selectedProvider = options.provider;
    if (hasRoute) {
        if (!options.providerSelector || typeof options.providerSelector.select !== 'function') {
            throw new TaskExecutionError('TASK_ROUTE_SELECTOR_REQUIRED', 'Trusted route selector is required', { retryable: true, retryDelaySeconds: 30 });
        }
        try {
            selectedProvider = await options.providerSelector.select(task);
        } catch {
            throw new TaskExecutionError('TASK_ROUTE_REJECTED', 'Task route is not approved', { retryable: true, retryDelaySeconds: 30 });
        }
    }
    const ctx = normalizeOptions({ ...options, provider: selectedProvider });
    // 已中止（停机或租约丢失）时不登记调用：否则会留下一条无人负责的 submitting 记录。
    if (isAborted(ctx.signal)) {
        throw new TaskExecutionError('WORKER_ABORTED', 'Worker aborted before starting the provider call');
    }
    // 领取后、建账本前先看一次取消意图：避免为一个已经不想执行的任务创建供应商提交。
    await assertNotCancelled(pool, task, ctx);

    const resumable = await ledger.claimProviderCallForRecovery(pool, {
        workerId: ctx.workerId,
        leaseSeconds: ctx.leaseSeconds,
        taskId: task.id,
    });
    if (resumable) {
        if (resumable.provider_name !== ctx.providerName) {
            // 不终结或重提历史未知调用；等待正确的可信 Provider 恢复处理。
            throw new TaskExecutionError('PROVIDER_ROUTE_MISMATCH', 'Historical provider does not match selected route', {
                retryable: true, retryDelaySeconds: ctx.retryDelaySeconds,
            });
        }
        return continueProviderCall(pool, task, resumable, ctx);
    }

    // 没有可领取的调用，但仍存在未终结的调用（例如调用租约被上一个 Worker 持有）：
    // 此时新建提交会造成重复调用，只能退避后重试，等待该租约过期。
    const active = await ledger.findActiveProviderCall(pool, { taskId: task.id });
    if (active) {
        throw new TaskExecutionError('PROVIDER_CALL_IN_FLIGHT', 'Another worker still holds an unfinished provider call', {
            retryable: true,
            retryDelaySeconds: ctx.retryDelaySeconds,
        });
    }

    let call;
    try {
        call = await ledger.beginProviderCall(pool, {
            taskId: task.id,
            attemptNo: task.attempts,
            providerName: ctx.providerName,
            idempotencyKey: providerIdempotencyKey(task.id, task.attempts),
            workerId: ctx.workerId,
            leaseSeconds: ctx.leaseSeconds,
        });
    } catch (error) {
        if (error instanceof ledger.ProviderCallLedgerError && error.code === 'ATTEMPT_EXISTS') {
            // 本轮次已有记录但不是可恢复状态：交给下一轮领取，避免在同一轮里覆盖历史。
            throw new TaskExecutionError('PROVIDER_ATTEMPT_CONFLICT', error.message, {
                retryable: true,
                retryDelaySeconds: ctx.retryDelaySeconds,
            });
        }
        throw error;
    }
    return runSubmission(pool, task, call, ctx, true);
}

async function executeTask(pool, task, options = {}) {
    try {
        return await execute(pool, task, options);
    } catch (error) {
        throw translateLeaseLoss(error);
    }
}

// 供 Worker 直接使用的处理器工厂：绑定连接池与 Provider，运行期不再接受外部注入。
function createTaskProcessor({ pool, provider, workerId, ...options } = {}) {
    if (!pool) throw new TypeError('pool is required');
    if (!options.assetArchive && !options.objectStore && process.env.PAINTTRACK_ASSET_STORAGE_ROOT) {
        const { createFileObjectStore } = require('../storage/fileObjectStore');
        options.objectStore = createFileObjectStore({ rootDirectory: process.env.PAINTTRACK_ASSET_STORAGE_ROOT });
    }
    // 归档器在 normalizeOptions 里用 options.pool 构造；pool 已在参数里解构出来，
    // 若不显式回填，配置了对象存储后每次执行都会在归档阶段抛 "pool is required"。
    const executionOptions = { ...options, pool };
    return async function processTask(task, context = {}) {
        return executeTask(pool, task, {
            ...executionOptions,
            provider,
            workerId,
            signal: context.signal,
        });
    };
}

module.exports = {
    ARCHIVE_STATE,
    DEFAULT_POLL,
    TaskExecutionError,
    createTaskProcessor,
    executeTask,
    providerIdempotencyKey,
    resultDescriptor,
};
