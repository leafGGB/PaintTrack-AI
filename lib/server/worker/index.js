const { Pool } = require('pg');
const taskQueue = require('./taskQueue');

// 处理器没有声明结果时，落一个显式的"无归档产物"描述符：
// succeeded 状态必须带 result，否则用户会看到一个成功但什么都没有的任务。
const UNSPECIFIED_RESULT = Object.freeze({
    kind: 'unspecified',
    archive: 'not_configured',
    source: 'processor',
});

// 处理器可用 error.taskFailure 声明这次失败应该如何记录：
// - errorMessage：写进 last_error 的固定错误码（不放供应商原文）
// - retryDelaySeconds：回队列前的退避时间
// - terminal：即使还有重试次数也立即终态失败（例如供应商拒绝请求）
// 没有该标记时退回原始错误信息，保持既有行为。
function failureInput(error) {
    const failure = error && typeof error === 'object' ? error.taskFailure : null;
    if (failure && typeof failure === 'object') {
        const errorMessage = typeof failure.errorMessage === 'string' && failure.errorMessage.trim()
            ? failure.errorMessage
            : 'Task failed';
        const retryDelaySeconds = Number.isInteger(failure.retryDelaySeconds) && failure.retryDelaySeconds > 0
            ? failure.retryDelaySeconds
            : 0;
        return { errorMessage, retryDelaySeconds, terminal: failure.terminal === true };
    }
    return { errorMessage: error instanceof Error ? error.message : String(error) };
}

// 本地开发诊断：任务失败原因对外只暴露固定码，自由文本会被前端折叠成 TASK_FAILED。
// 为了让本地排障不靠猜，仅在显式开启诊断时把脱敏后的名称/码/原文打到启动器终端；
// 生产环境与未开启时完全不输出，避免内部信息离开本机。
function localFailureDiagnostic(task, error, phase) {
    if (process.env.PAINTTRACK_LOCAL_DIAGNOSTICS !== '1' || process.env.NODE_ENV === 'production') return;
    const name = error instanceof Error ? error.name : typeof error;
    const code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : '-';
    const describe = (value) => {
        if (!value) return '';
        const valueName = value instanceof Error ? value.name : typeof value;
        const valueCode = value && typeof value === 'object' && typeof value.code === 'string' ? value.code : '-';
        const valueMessage = (value instanceof Error ? value.message : String(value))
            .replace(/[\r\n]+/g, ' ')
            .replace(/(?:postgres(?:ql)?|https?):\/\/\S+/gi, '[redacted-url]')
            .slice(0, 300);
        return ` cause=${valueName} causeCode=${valueCode} causeMessage=${valueMessage}`;
    };
    const message = (error instanceof Error ? error.message : String(error))
        .replace(/[\r\n]+/g, ' ')
        .replace(/(?:postgres(?:ql)?|https?):\/\/\S+/gi, '[redacted-url]')
        .slice(0, 300);
    process.stderr.write(`LOCAL_TASK_FAILURE taskId=${task.id} phase=${phase} name=${name} code=${code} message=${message}${describe(error && error.cause)}\n`);
}

function createWorker({
    pool,
    workerId,
    leaseSeconds = 60,
    pollIntervalMs = 1000,
    heartbeatIntervalMs = Math.max(1, Math.floor((leaseSeconds * 1000) / 3)),
    shutdownGraceMs = 5000,
    cancellationTimeoutMs = 1000,
    processTask,
} = {}) {
    if (!pool) {
        throw new TypeError('pool is required');
    }
    if (typeof workerId !== 'string' || workerId.trim() === '') {
        throw new TypeError('workerId is required');
    }
    if (typeof processTask !== 'function') {
        throw new TypeError('processTask is required and must be a function');
    }
    for (const [name, value] of [['leaseSeconds', leaseSeconds], ['pollIntervalMs', pollIntervalMs], ['heartbeatIntervalMs', heartbeatIntervalMs]]) {
        if (!Number.isInteger(value) || value <= 0) {
            throw new TypeError(`${name} must be a positive integer`);
        }
    }

    if (heartbeatIntervalMs >= leaseSeconds * 1000) {
        throw new TypeError('heartbeatIntervalMs must be shorter than the lease');
    }
    for (const [name, value] of [['shutdownGraceMs', shutdownGraceMs], ['cancellationTimeoutMs', cancellationTimeoutMs]]) {
        if (!Number.isInteger(value) || value < (name === 'shutdownGraceMs' ? 0 : 1)) {
            throw new TypeError(`${name} must be ${name === 'shutdownGraceMs' ? 'a non-negative' : 'a positive'} integer`);
        }
    }

    let stopped = false;
    let running = false;
    let wakePoll = null;
    let active = null;
    let terminalResult = null;
    const isLeaseLost = (error) => error instanceof taskQueue.TaskQueueError && error.code === 'LEASE_LOST';

    async function runOnce() {
        if (active) throw new Error('Worker already has an active task');
        if (stopped) return terminalResult || { status: 'stopped' };

        const controller = new AbortController();
        let resolveDeadline;
        const deadline = new Promise((resolve) => { resolveDeadline = resolve; });
        const context = {
            closed: false,
            phase: 'claiming',
            task: null,
            cancellation: null,
            graceTimer: null,
            cancelTimer: null,
            heartbeatTimer: null,
            cancel(status, error) {
                if (context.closed || context.cancellation) return;
                context.cancellation = status;
                clearInterval(context.heartbeatTimer);
                context.cancelTimer = setTimeout(() => {
                    // 无法强制终止同进程处理器；隔离此 Worker，交由进程宿主终止。
                    stopped = true;
                    terminalResult = {
                        status: 'cancellation-timeout',
                        ...(context.task ? { taskId: context.task.id } : {}),
                        phase: context.phase,
                    };
                    resolveDeadline(terminalResult);
                }, cancellationTimeoutMs);
                controller.abort(error);
            },
        };
        active = context;

        async function execute() {
            const task = await taskQueue.claimNextTask(pool, { workerId, leaseSeconds });
            if (context.closed) return;
            context.task = task;
            // 领取无法撤销时不启动处理器，也不提前释放租约导致重叠执行。
            if (stopped) return { status: 'stopped' };
            if (!task) return { status: 'idle' };

            let heartbeatInProgress = null;
            context.heartbeatTimer = setInterval(() => {
                if (heartbeatInProgress || context.cancellation || context.closed) return;
                heartbeatInProgress = Promise.resolve().then(() => taskQueue.heartbeatTask(pool, {
                    taskId: task.id,
                    leaseToken: task.lease_token,
                    leaseSeconds,
                })).catch((error) => {
                    context.cancel(isLeaseLost(error) ? 'lease-lost' : 'heartbeat-error', error);
                }).finally(() => {
                    heartbeatInProgress = null;
                });
            }, heartbeatIntervalMs);

            context.phase = 'processing';
            let processingFailed = false;
            let processingError;
            let processingResult;
            try {
                processingResult = await processTask(task, { signal: controller.signal });
            } catch (error) {
                processingFailed = true;
                processingError = error;
            } finally {
                clearInterval(context.heartbeatTimer);
            }
            if (context.closed) return;
            context.phase = 'heartbeat';
            if (heartbeatInProgress) await heartbeatInProgress;
            if (context.closed) return;
            if (context.cancellation) return { status: context.cancellation, taskId: task.id };
            if (processingFailed && isLeaseLost(processingError)) {
                return { status: 'lease-lost', taskId: task.id };
            }
            context.phase = 'finalizing';
            try {
                if (processingFailed) {
                    // 取消不是失败：写 cancelled 终态，不能走 failTask 退回队列，
                    // 否则被取消的任务会在退避后重新执行。
                    if (processingError && processingError.cancelled === true) {
                        await taskQueue.cancelClaimedTask(pool, {
                            taskId: task.id,
                            leaseToken: task.lease_token,
                        });
                        return { status: 'cancelled', taskId: task.id };
                    }
                    localFailureDiagnostic(task, processingError, context.phase);
                    await taskQueue.failTask(pool, {
                        taskId: task.id,
                        leaseToken: task.lease_token,
                        ...failureInput(processingError),
                    });
                    return { status: 'failed', taskId: task.id };
                }
                if (processingResult && processingResult.finalized === true) {
                    // 处理器已在同一事务里写完"调用记录 + 任务终态"，再写一次会重复覆盖或触发 LEASE_LOST。
                    return {
                        status: typeof processingResult.status === 'string' ? processingResult.status : 'succeeded',
                        taskId: task.id,
                    };
                }
                await taskQueue.completeTask(pool, {
                    taskId: task.id,
                    leaseToken: task.lease_token,
                    result: processingResult && processingResult.result ? processingResult.result : UNSPECIFIED_RESULT,
                });
                return { status: 'succeeded', taskId: task.id };
            } catch (error) {
                if (isLeaseLost(error)) return { status: 'lease-lost', taskId: task.id };
                throw error;
            }
        }

        try {
            return await Promise.race([execute(), deadline]);
        } finally {
            context.closed = true;
            clearTimeout(context.graceTimer);
            clearTimeout(context.cancelTimer);
            clearInterval(context.heartbeatTimer);
            active = null;
        }
    }

    async function waitForPoll() {
        if (stopped) return;
        await new Promise((resolve) => {
            const timer = setTimeout(() => {
                wakePoll = null;
                resolve();
            }, pollIntervalMs);
            wakePoll = () => {
                clearTimeout(timer);
                wakePoll = null;
                resolve();
            };
        });
    }

    return {
        runOnce,
        async run() {
            if (running) throw new Error('Worker is already running');
            running = true;
            try {
                while (!stopped) {
                    const result = await runOnce();
                    if (result.status === 'cancellation-timeout') return result;
                    if (result.status === 'idle') await waitForPoll();
                }
                return terminalResult || { status: 'stopped' };
            } finally {
                running = false;
            }
        },
        stop() {
            if (stopped) return;
            stopped = true;
            wakePoll?.();
            if (active) {
                const context = active;
                context.graceTimer = setTimeout(() => {
                    context.cancel('stopped', new Error('Worker shutdown requested'));
                }, shutdownGraceMs);
            }
        },
    };
}

async function startWorker({
    databaseUrl, workerId = `worker-${process.pid}`, processTask, createProcessor, PoolClass = Pool, ...workerOptions
} = {}) {
    // Worker must receive its own credential explicitly; never fall back to the Web DATABASE_URL.
    const configuredDatabaseUrl = databaseUrl || process.env.PAINTTRACK_WORKER_DATABASE_URL;
    if (!configuredDatabaseUrl) {
        throw new Error('PAINTTRACK_WORKER_DATABASE_URL is required to start the worker');
    }
    const pool = new PoolClass({
        connectionString: configuredDatabaseUrl,
        max: 2,
        connectionTimeoutMillis: 3000,
        idleTimeoutMillis: 10000,
        allowExitOnIdle: true,
    });
    try {
        // 处理器需要连接池，而连接池又要在配置校验失败时关闭，因此允许用工厂延后绑定。
        const processor = typeof createProcessor === 'function'
            ? createProcessor({ pool, workerId })
            : processTask;
        const worker = createWorker({ pool, workerId, processTask: processor, ...workerOptions });
        return { pool, worker };
    } catch (error) {
        await pool.end();
        throw error;
    }
}

// 控制能力仅交给可信宿主；Pool/秘密生命周期仍由运行入口与 bootstrap 的 finally 持有。
function createWorkerHostLifecycle(worker, providerGate) {
    let mode = 'running';
    return Object.freeze({
        getState: () => mode,
        rotate(deadline) {
            if (mode !== 'running') return false;
            const at = deadline instanceof Date ? deadline.getTime() : deadline;
            if (!Number.isFinite(at)) throw new TypeError('A finite drain deadline is required');
            providerGate.drain(at);
            mode = 'draining';
            worker.stop();
            return true;
        },
        revoke() {
            if (mode === 'revoked' || mode === 'closed') return false;
            providerGate.revoke();
            mode = 'revoked';
            worker.stop();
            return true;
        },
        finish() { mode = 'closed'; },
    });
}

async function runWorkerProcess(options) {
    const { pool, worker } = await startWorker(options);
    const lifecycle = options?.providerGateControl
        ? createWorkerHostLifecycle(worker, options.providerGateControl) : null;
    let shuttingDown = false;
    const requestShutdown = () => {
        if (shuttingDown) return;
        shuttingDown = true;
        // 进程信号使用保守撤销；正常轮换由可信宿主显式给出 deadline。
        if (lifecycle) lifecycle.revoke();
        else worker.stop();
    };
    process.once('SIGINT', requestShutdown);
    process.once('SIGTERM', requestShutdown);
    try {
        if (options?.onHostLifecycle !== undefined) {
            if (!lifecycle || typeof options.onHostLifecycle !== 'function') throw new TypeError('Invalid host lifecycle configuration');
            options.onHostLifecycle(Object.freeze({
                getState: lifecycle.getState, rotate: lifecycle.rotate, revoke: lifecycle.revoke,
            }));
        }
        const result = await worker.run();
        if (result.status === 'cancellation-timeout') {
            // 不配合取消的处理器可能仍持有句柄，不能声称已正常停止。
            await new Promise(() => {
                process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(1));
            });
        }
        process.stdout.write(`${JSON.stringify(result)}\n`);
        process.exitCode = result.status === 'failed' ? 1 : 0;
    } finally {
        lifecycle?.revoke();
        lifecycle?.finish();
        process.removeListener('SIGINT', requestShutdown);
        process.removeListener('SIGTERM', requestShutdown);
        // 卡住的查询也可能阻塞 pool.end，进程退出不能无限等待连接池。
        const timer = setTimeout(() => {
            process.stderr.write('Worker pool shutdown timed out\n', () => process.exit(1));
        }, options?.cancellationTimeoutMs ?? 1000);
        try {
            await pool.end();
        } finally {
            clearTimeout(timer);
        }
    }
}

class WorkerBootstrapError extends Error {
    constructor(code) {
        super(code);
        this.name = 'WorkerBootstrapError';
        this.code = code;
    }
}

const PROVIDER_BOOTSTRAP_CODES = new Set([
    'PROVIDER_CONFIG_INVALID', 'PROVIDER_BINDING_DENIED', 'PROVIDER_SECRET_RESOLVER_REQUIRED',
    'PROVIDER_SECRET_UNAVAILABLE', 'PROVIDER_SECRET_INVALID',
]);

// 仅接受可信宿主显式注入的能力；不从环境或任务数据建立秘密解析器和批准清单。
async function bootstrapWorker({ descriptor, approvedBindings, secretResolver, secretBoundaryLifecycle,
    onProviderGate, ...workerOptions } = {}, { run = runWorkerProcess,
    createTaskProcessor = require('./taskExecutor').createTaskProcessor, adapterFactory } = {}) {
    let failure;
    let failureCode = 'WORKER_START_FAILED';
    let result;
    let close;
    let gateControl;
    try {
        close = secretBoundaryLifecycle?.close;
        if (secretBoundaryLifecycle !== undefined && typeof close !== 'function') {
            failureCode = 'WORKER_BOOTSTRAP_CONFIG_INVALID';
            throw new WorkerBootstrapError(failureCode);
        }
        const registry = require('../providers/providerRegistry');
        let provider;
        try {
            provider = await registry.resolveWorkerProviderWithSecrets({
                descriptor, approvedBindings, secretResolver, adapterFactory,
            });
        } catch (error) {
            failureCode = error instanceof registry.ProviderUnavailableError && PROVIDER_BOOTSTRAP_CODES.has(error.code)
                ? error.code : 'PROVIDER_CONFIG_INVALID';
            throw new WorkerBootstrapError(failureCode);
        }
        const { createProviderInvocationGate } = require('../providers/providerInvocationGate');
        const gate = createProviderInvocationGate(provider);
        gateControl = gate.control;
        if (onProviderGate !== undefined) {
            if (typeof onProviderGate !== 'function') throw new WorkerBootstrapError('WORKER_BOOTSTRAP_CONFIG_INVALID');
            onProviderGate(gateControl);
        }
        const workerId = workerOptions.workerId ?? `worker-${process.pid}`;
        result = await run({
            ...workerOptions,
            workerId,
            providerGateControl: gateControl,
            createProcessor: ({ pool }) => createTaskProcessor({ pool, provider: gate.provider, workerId }),
        });
    } catch {
        failure = new WorkerBootstrapError(failureCode);
    } finally {
        if (gateControl) await gateControl.close().catch(() => { failure ??= new WorkerBootstrapError('WORKER_PROVIDER_GATE_CLOSE_FAILED'); });
        // 传入此句柄即显式委派关闭；仅传 resolver 时资源仍由调用方持有。
        if (typeof close === 'function') {
            try { await close.call(secretBoundaryLifecycle); }
            catch { failure ??= new WorkerBootstrapError('WORKER_SECRET_CLOSE_FAILED'); }
        }
    }
    if (failure) throw failure;
    return result;
}

async function runWorkerCli() {
    const registry = require('../providers/providerRegistry');
    const mode = (process.env[registry.ENV_MODE] || '').trim().toLowerCase();
    if (!mode || mode === 'none') throw new WorkerBootstrapError('PROVIDER_NOT_CONFIGURED');
    // CLI 尚无可信部署引导能力，非 mock 一律拒绝，禁止进入旧 env 凭据分支。
    if (mode !== 'mock') throw new WorkerBootstrapError('WORKER_TRUSTED_BOOTSTRAP_REQUIRED');
    if (process.env.NODE_ENV === 'production') throw new WorkerBootstrapError('PROVIDER_MODE_FORBIDDEN');
    try {
        const provider = registry.resolveWorkerProvider();
        const providerSelector = process.env.PAINTTRACK_LOCAL_MOCK_ROUTING === '1'
            ? await require('../tasks/localMockCatalog').createLocalMockProviderSelector({ environment: process.env, provider })
            : undefined;
        const workerId = process.env.PAINTTRACK_WORKER_ID || `worker-${process.pid}`;
        await runWorkerProcess({
            workerId,
            createProcessor: ({ pool }) => require('./taskExecutor').createTaskProcessor({ pool, provider, providerSelector, workerId }),
        });
    } catch {
        throw new WorkerBootstrapError('WORKER_START_FAILED');
    }
}

if (require.main === module) {
    runWorkerCli().catch((error) => {
        process.stderr.write(`${error instanceof WorkerBootstrapError ? error.code : 'WORKER_START_FAILED'}\n`);
        process.exitCode = 1;
    });
}

module.exports = { createWorker, startWorker, runWorkerProcess, bootstrapWorker };
