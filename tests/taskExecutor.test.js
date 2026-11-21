const test = require('node:test');
const assert = require('node:assert/strict');
const queue = require('../lib/server/worker/taskQueue');
const ledgerModule = require('../lib/server/providers/providerCallLedger');
const { createMockProvider } = require('../lib/server/providers/mockProvider');
const { TaskExecutionError, executeTask, providerIdempotencyKey } = require('../lib/server/worker/taskExecutor');
const { createProviderInvocationGate } = require('../lib/server/providers/providerInvocationGate');

const { ProviderCallLedgerError } = ledgerModule;
const { TASK_STATUS } = queue;

const CLAIMABLE = ['submitting', 'unknown', 'accepted'];
const taskId = '11111111-1111-4111-8111-111111111111';

function baseTask(overrides = {}) {
    return {
        id: taskId,
        lease_token: 'task-lease-token',
        attempts: 1,
        task_type: 'image.generate',
        payload: { mock: { mode: 'sync' } },
        ...overrides,
    };
}

// 内存版账本：只模拟执行器依赖的状态机与租约语义，不模拟真实 SQL。
function createLedgerFake() {
    const rows = new Map();
    let sequence = 0;
    const now = () => new Date();
    const clone = (row) => (row ? { ...row } : null);
    const leaseHeld = (row) => row.worker_id !== null && row.lease_expires_at > now();
    const claimable = (row) => CLAIMABLE.includes(row.status);
    const requireLease = (row, workerId, leaseToken) => {
        if (!row || row.worker_id !== workerId || row.lease_token !== leaseToken) {
            throw new ProviderCallLedgerError('LEASE_LOST', 'Provider call lease is no longer valid');
        }
        return row;
    };
    const ofTask = () => [...rows.values()]
        .filter((row) => row.task_id === taskId)
        .sort((a, b) => a.attempt_no - b.attempt_no);

    return {
        rows,
        ofTask,
        async beginProviderCall(_db, { taskId: id, attemptNo, providerName, idempotencyKey, workerId }) {
            if (ofTask().some((row) => row.attempt_no === attemptNo)) {
                throw new ProviderCallLedgerError('ATTEMPT_EXISTS', 'Provider call attempt already exists');
            }
            const row = {
                id: `call-${++sequence}`,
                task_id: id,
                attempt_no: attemptNo,
                provider_name: providerName,
                idempotency_key: idempotencyKey,
                provider_job_id: null,
                status: ledgerModule.CALL_STATUS.SUBMITTING,
                worker_id: workerId,
                lease_token: `call-lease-${sequence}`,
                lease_expires_at: new Date(Date.now() + 60_000),
                available_at: now(),
                last_error_code: null,
            };
            rows.set(row.id, row);
            return clone(row);
        },
        async claimProviderCallForRecovery(_db, { workerId }) {
            const row = ofTask().find((candidate) => claimable(candidate) && !leaseHeld(candidate)
                && candidate.available_at <= now());
            if (!row) return null;
            row.worker_id = workerId;
            row.lease_token = `call-lease-recovery-${++sequence}`;
            row.lease_expires_at = new Date(Date.now() + 60_000);
            return clone(row);
        },
        async findActiveProviderCall(_db) {
            return clone(ofTask().filter(claimable).at(-1) || null);
        },
        async heartbeatProviderCall(_db, { callId, workerId, leaseToken }) {
            const row = requireLease(rows.get(callId), workerId, leaseToken);
            row.lease_expires_at = new Date(Date.now() + 60_000);
            return clone(row);
        },
        async acceptProviderCallHolding(_db, { callId, workerId, leaseToken, providerJobId }) {
            const row = requireLease(rows.get(callId), workerId, leaseToken);
            row.status = ledgerModule.CALL_STATUS.ACCEPTED;
            row.provider_job_id = providerJobId;
            return clone(row);
        },
        async markProviderCallUnknown(_db, { callId, workerId, leaseToken, errorCode }) {
            const row = requireLease(rows.get(callId), workerId, leaseToken);
            Object.assign(row, {
                status: ledgerModule.CALL_STATUS.UNKNOWN,
                worker_id: null,
                lease_token: null,
                lease_expires_at: null,
                last_error_code: errorCode,
            });
            return clone(row);
        },
        async markProviderCallSucceeded(_db, { callId, workerId, leaseToken }) {
            const row = requireLease(rows.get(callId), workerId, leaseToken);
            Object.assign(row, {
                status: ledgerModule.CALL_STATUS.SUCCEEDED,
                worker_id: null,
                lease_token: null,
                lease_expires_at: null,
                last_error_code: null,
            });
            return clone(row);
        },
        async markProviderCallTerminal(_db, { callId, workerId, leaseToken, status, errorCode }) {
            const row = requireLease(rows.get(callId), workerId, leaseToken);
            Object.assign(row, {
                status,
                worker_id: null,
                lease_token: null,
                lease_expires_at: null,
                last_error_code: errorCode ?? null,
            });
            return clone(row);
        },
        async deferProviderCall(_db, { callId, workerId, leaseToken, errorCode }) {
            const row = requireLease(rows.get(callId), workerId, leaseToken);
            Object.assign(row, {
                worker_id: null,
                lease_token: null,
                lease_expires_at: null,
                available_at: new Date(Date.now() + 5_000),
                last_error_code: errorCode,
            });
            return clone(row);
        },
    };
}

const LEDGER_METHODS = [
    'claimProviderCallForRecovery',
    'beginProviderCall',
    'findActiveProviderCall',
    'heartbeatProviderCall',
    'acceptProviderCallHolding',
    'markProviderCallUnknown',
    'markProviderCallSucceeded',
    'markProviderCallTerminal',
    'deferProviderCall',
];

function withStubs({ ledger, onComplete, cancellation = false, lockCancellation = cancellation, onLock }, run) {
    const originalComplete = queue.completeTask;
    const originalCancel = queue.cancelClaimedTask;
    const originalIsCancellationRequested = queue.isCancellationRequested;
    const originalLockClaimedTask = queue.lockClaimedTask;
    const originalLedger = Object.fromEntries(LEDGER_METHODS.map((name) => [name, ledgerModule[name]]));
    const requested = () => (typeof cancellation === 'function' ? cancellation() : cancellation);
    queue.completeTask = async (_client, args) => {
        onComplete(args);
        return { ...args, status: TASK_STATUS.SUCCEEDED };
    };
    queue.cancelClaimedTask = async (_client, args) => ({ ...args, status: TASK_STATUS.CANCELLED });
    // 取消检查与行锁在单测里用桩替代：它们各自有独立的 SQL 与真实库验收，
    // 这里只验证执行器在正确的位置调用它们，并遵守返回的取消意图。
    queue.isCancellationRequested = async () => requested();
    queue.lockClaimedTask = async () => {
        onLock?.();
        return {
            id: taskId,
            status: TASK_STATUS.RUNNING,
            cancel_requested: typeof lockCancellation === 'function' ? lockCancellation() : lockCancellation,
        };
    };
    for (const name of LEDGER_METHODS) {
        ledgerModule[name] = ledger[name];
    }
    const restore = () => {
        queue.completeTask = originalComplete;
        queue.cancelClaimedTask = originalCancel;
        queue.isCancellationRequested = originalIsCancellationRequested;
        queue.lockClaimedTask = originalLockClaimedTask;
        for (const name of LEDGER_METHODS) {
            ledgerModule[name] = originalLedger[name];
        }
    };
    return Promise.resolve().then(run).finally(restore);
}

function createPool() {
    return {
        async query() {
            throw new Error('执行器不应直接查询连接池，所有账本访问必须走账本单位');
        },
        async connect() {
            return {
                async query(text) {
                    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text)) return { rowCount: 0, rows: [] };
                    throw new Error(`事务内出现了未预期的 SQL：${text}`);
                },
                release() {},
            };
        },
    };
}

function sleepRecorder() {
    const delays = [];
    return {
        delays,
        async sleep(milliseconds) {
            delays.push(milliseconds);
        },
    };
}

async function localRoutedTask(media = 'image', payload = {}) {
    const { createLocalMockCatalog } = require('../lib/server/tasks/localMockCatalog');
    const { createModelRouteResolver } = require('../lib/server/tasks/modelRouteResolver');
    const env = { NODE_ENV: 'development', PAINTTRACK_LOCAL_INTERNAL_GUARD: '1', PAINTTRACK_LOCAL_MOCK_ROUTING: '1' };
    const task = baseTask({ task_type: `${media}.generate`, payload: { logicalModelId: `local-mock-${media}`, ...(media === 'image' ? { outputCount: 1 } : { durationMs: 1000, fps: 1 }), ...payload } });
    const route = await createModelRouteResolver({ catalog: createLocalMockCatalog(env) }).resolve({ taskType: task.task_type, payload: task.payload });
    return { env, task: { ...task, logical_model_pk: route.logicalModelPk, route_snapshot: route.routeSnapshot,
        route_snapshot_version: route.routeSnapshotVersion, route_snapshot_hash: route.routeSnapshotHash } };
}

test('local routed image/video select approved mock and finalize; unknown recovery keeps original key', async () => {
    const { createLocalMockProviderSelector } = require('../lib/server/tasks/localMockCatalog');
    for (const media of ['image', 'video']) {
        const { env, task } = await localRoutedTask(media, { mock: { unknownSubmit: true } });
        const provider = createMockProvider();
        const providerSelector = await createLocalMockProviderSelector({ environment: env, provider });
        const ledger = createLedgerFake();
        await withStubs({ ledger, onComplete: () => {} }, async () => {
            const options = { provider: { name: 'wrong-fallback', submit() { assert.fail(); }, query() { assert.fail(); } }, providerSelector, workerId: 'worker-a' };
            await assert.rejects(executeTask(createPool(), task, options), { code: 'PROVIDER_SUBMISSION_UNKNOWN' });
            const key = ledger.ofTask()[0].idempotency_key;
            const outcome = await executeTask(createPool(), task, options);
            assert.equal(outcome.status, TASK_STATUS.SUCCEEDED);
            assert.equal(outcome.result.provider, 'mock-provider');
            assert.equal(ledger.ofTask().length, 1);
            assert.equal(ledger.ofTask()[0].idempotency_key, key);
        });
    }
});

test('unapproved or partial snapshots and missing selector reject before any database or provider call', async () => {
    const { createLocalMockProviderSelector } = require('../lib/server/tasks/localMockCatalog');
    const { env, task } = await localRoutedTask();
    const provider = createMockProvider();
    const providerSelector = await createLocalMockProviderSelector({ environment: env, provider });
    const pool = { query() { assert.fail('zero SQL'); }, connect() { assert.fail('zero SQL'); } };
    const variants = [
        { ...task, route_snapshot_hash: '0'.repeat(64) }, { ...task, logical_model_pk: null },
        { ...task, route_snapshot_version: 2 }, { ...task, route_snapshot: { ...task.route_snapshot, providerInstanceId: 'other' } },
        { ...task, task_type: 'video.generate' }, { ...task, payload: { logicalModelId: 'unapproved' } },
        baseTask({ route_snapshot_hash: 'partial' }),
    ];
    for (const variant of variants) await assert.rejects(executeTask(pool, variant, { provider, providerSelector, workerId: 'worker-a' }), { code: 'TASK_ROUTE_REJECTED' });
    await assert.rejects(executeTask(pool, task, { provider, workerId: 'worker-a' }), { code: 'TASK_ROUTE_SELECTOR_REQUIRED' });
});

test('historical provider mismatch preserves unknown record and original idempotency key without dispatch', async () => {
    const { createLocalMockProviderSelector } = require('../lib/server/tasks/localMockCatalog');
    const { env, task } = await localRoutedTask('image', { mock: { unknownSubmit: true } });
    const provider = createMockProvider();
    const providerSelector = await createLocalMockProviderSelector({ environment: env, provider });
    const ledger = createLedgerFake();
    await withStubs({ ledger, onComplete: () => assert.fail() }, async () => {
        await assert.rejects(executeTask(createPool(), task, { provider, providerSelector, workerId: 'worker-a' }), { code: 'PROVIDER_SUBMISSION_UNKNOWN' });
        const row = [...ledger.rows.values()][0];
        const key = row.idempotency_key;
        row.provider_name = 'historical-other-provider';
        await assert.rejects(executeTask(createPool(), task, { provider, providerSelector, workerId: 'worker-a' }), { code: 'PROVIDER_ROUTE_MISMATCH' });
        assert.equal(row.status, ledgerModule.CALL_STATUS.UNKNOWN);
        assert.equal(row.idempotency_key, key);
        assert.equal(ledger.rows.size, 1);
    });
});

test('同步完成的调用在成功时同时写入调用记录与任务终态', async () => {
    const ledger = createLedgerFake();
    const provider = createMockProvider();
    const completed = [];
    await withStubs({ ledger, onComplete: (args) => completed.push(args) }, async () => {
        const outcome = await executeTask(createPool(), baseTask(), {
            provider,
            workerId: 'worker-a',
        });
        assert.equal(outcome.finalized, true);
        assert.equal(outcome.status, TASK_STATUS.SUCCEEDED);
        assert.equal(completed.length, 1);
        assert.equal(ledger.ofTask().length, 1);
        assert.equal(ledger.ofTask()[0].status, ledgerModule.CALL_STATUS.SUCCEEDED);
        assert.equal(ledger.ofTask()[0].idempotency_key, providerIdempotencyKey(taskId, 1));
        assert.equal(outcome.result.kind, 'asset');
        assert.equal(outcome.result.archive, 'not_configured');
        assert.equal(outcome.result.provider, 'mock-provider');
        // 结果描述符只保存摘要，图片字节不得进入数据库。
        assert.equal(JSON.stringify(outcome.result).includes('bytes'), false);
    });
});

test('异步受理后轮询到成功，并把轮询间隔限制在配置范围内', async () => {
    const ledger = createLedgerFake();
    const provider = createMockProvider();
    const recorder = sleepRecorder();
    let completed = 0;
    await withStubs({ ledger, onComplete: () => { completed += 1; } }, async () => {
        const outcome = await executeTask(createPool(), baseTask({ payload: { mock: { mode: 'async' } } }), {
            provider,
            workerId: 'worker-a',
            poll: { minDelayMs: 25, maxDelayMs: 50 },
            sleep: recorder.sleep,
        });
        assert.equal(outcome.status, TASK_STATUS.SUCCEEDED);
        assert.equal(completed, 1);
    });
    assert.deepEqual(recorder.delays, [25]);
    assert.equal(ledger.ofTask()[0].status, ledgerModule.CALL_STATUS.SUCCEEDED);
});

test('未知提交不新建轮次，退避后用同一把幂等键恢复', async () => {
    const ledger = createLedgerFake();
    const provider = createMockProvider();
    const task = baseTask({ payload: { mock: { unknownSubmit: true } } });
    await withStubs({ ledger, onComplete: () => {} }, async () => {
        await assert.rejects(
            executeTask(createPool(), task, { provider, workerId: 'worker-a' }),
            (error) => error instanceof TaskExecutionError
                && error.code === 'PROVIDER_SUBMISSION_UNKNOWN'
                && error.taskFailure.terminal === false,
        );
        assert.equal(ledger.ofTask().length, 1);
        assert.equal(ledger.ofTask()[0].status, ledgerModule.CALL_STATUS.UNKNOWN);
        const recovered = await executeTask(createPool(), task, { provider, workerId: 'worker-a' });
        assert.equal(recovered.status, TASK_STATUS.SUCCEEDED);
        // 恢复复用同一条调用记录与同一把幂等键：不产生第二次供应商提交。
        assert.equal(ledger.ofTask().length, 1);
        assert.equal(ledger.ofTask()[0].attempt_no, 1);
    });
});

test('可重试的提交失败会回队列并带上退避，终态失败跳过剩余重试预算', async () => {
    const ledger = createLedgerFake();
    const provider = createMockProvider();
    await withStubs({ ledger, onComplete: () => {} }, async () => {
        await assert.rejects(
            executeTask(createPool(), baseTask({ payload: { mock: { error: 'RATE_LIMITED' } } }), {
                provider, workerId: 'worker-a', retryDelaySeconds: 12,
            }),
            (error) => error.taskFailure.errorMessage === 'RATE_LIMITED'
                && error.taskFailure.retryDelaySeconds === 12
                && error.taskFailure.terminal === false,
        );
        assert.equal(ledger.ofTask()[0].status, ledgerModule.CALL_STATUS.FAILED);

        await assert.rejects(
            executeTask(createPool(), baseTask({ attempts: 2, payload: { mock: { error: 'FORBIDDEN' } } }), {
                provider, workerId: 'worker-a', retryDelaySeconds: 12,
            }),
            (error) => error.taskFailure.errorMessage === 'FORBIDDEN'
                && error.taskFailure.terminal === true
                && error.taskFailure.retryDelaySeconds === 0,
        );
    });
});

test('轮询超过上限时释放租约并退避，不把调用记录误判为失败', async () => {
    const ledger = createLedgerFake();
    const provider = createMockProvider();
    const recorder = sleepRecorder();
    await withStubs({ ledger, onComplete: () => {} }, async () => {
        await assert.rejects(
            executeTask(createPool(), baseTask({ payload: { mock: { mode: 'async', failOnQuery: null } } }), {
                provider,
                workerId: 'worker-a',
                poll: { maxAttempts: 1, minDelayMs: 5, maxDelayMs: 5 },
                sleep: recorder.sleep,
                retryDelaySeconds: 7,
            }),
            (error) => error.code === 'PROVIDER_POLL_TIMEOUT'
                && error.taskFailure.terminal === false
                && error.taskFailure.retryDelaySeconds === 7,
        );
    });
    const call = ledger.ofTask()[0];
    assert.equal(call.status, ledgerModule.CALL_STATUS.ACCEPTED);
    assert.equal(call.lease_token, null);
    assert.equal(call.last_error_code, 'PROVIDER_POLL_TIMEOUT');
});

test('调用租约仍被其他 Worker 持有时拒绝新建提交', async () => {
    const ledger = createLedgerFake();
    const provider = createMockProvider();
    await withStubs({ ledger, onComplete: () => {} }, async () => {
        // 手工构造"已受理、租约仍在别人手上"的调用记录。
        const call = await ledger.beginProviderCall(null, {
            taskId,
            attemptNo: 1,
            providerName: provider.name,
            idempotencyKey: providerIdempotencyKey(taskId, 1),
            workerId: 'worker-other',
        });
        await ledger.acceptProviderCallHolding(null, {
            callId: call.id,
            workerId: 'worker-other',
            leaseToken: call.lease_token,
            providerJobId: 'mock_job_other',
        });
        await assert.rejects(
            executeTask(createPool(), baseTask(), { provider, workerId: 'worker-a' }),
            (error) => error.code === 'PROVIDER_CALL_IN_FLIGHT' && error.taskFailure.terminal === false,
        );
        assert.equal(ledger.ofTask().length, 1);
    });
});

test('调用账本租约丢失统一翻译成任务租约丢失', async () => {
    const ledger = createLedgerFake();
    const provider = createMockProvider();
    await withStubs({
        ledger,
        onComplete: () => {},
    }, async () => {
        ledgerModule.heartbeatProviderCall = async () => {
            throw new ProviderCallLedgerError('LEASE_LOST', 'Provider call lease is no longer valid');
        };
        await assert.rejects(
            executeTask(createPool(), baseTask({ payload: { mock: { mode: 'async' } } }), {
                provider, workerId: 'worker-a', sleep: async () => {},
            }),
            (error) => error instanceof queue.TaskQueueError && error.code === 'LEASE_LOST',
        );
    });
});

test('中止信号阻止提交，处理器返回不合契约的结果时按协议错误终止', async () => {
    const ledger = createLedgerFake();
    const provider = createMockProvider();
    const aborted = new AbortController();
    aborted.abort();
    await withStubs({ ledger, onComplete: () => {} }, async () => {
        await assert.rejects(
            executeTask(createPool(), baseTask(), { provider, workerId: 'worker-a', signal: aborted.signal }),
            (error) => error.code === 'WORKER_ABORTED',
        );
        assert.equal(ledger.ofTask().length, 0);
    });

    await withStubs({ ledger, onComplete: () => {} }, async () => {
        const broken = {
            name: 'broken-provider',
            async submit() { return { kind: 'completed', result: {} }; },
            async query() { throw new Error('unused'); },
        };
        await assert.rejects(
            executeTask(createPool(), baseTask(), { provider: broken, workerId: 'worker-a' }),
            (error) => error.code === 'RESULT_INVALID' && error.taskFailure.terminal === true,
        );
    });
});

test('已登记取消的任务在提交前就停止，不创建供应商调用', async () => {
    const ledger = createLedgerFake();
    const provider = createMockProvider();
    await withStubs({ ledger, onComplete: () => {}, cancellation: true }, async () => {
        await assert.rejects(
            executeTask(createPool(), baseTask(), { provider, workerId: 'worker-a' }),
            (error) => error.code === 'TASK_CANCELLED'
                && error.cancelled === true
                // 取消不能复用失败通道：Worker 需要据此写 cancelled 而不是退回队列。
                && error.taskFailure !== undefined,
        );
        assert.equal(ledger.ofTask().length, 0);
    });
});

test('轮询过程中请求取消会终止调用记录并抛出可识别的取消错误', async () => {
    const ledger = createLedgerFake();
    const provider = createMockProvider();
    let requested = false;
    await withStubs({
        ledger,
        onComplete: () => assert.fail('取消后不能再写成功终态'),
        cancellation: () => requested,
    }, async () => {
        await assert.rejects(
            executeTask(createPool(), baseTask({ payload: { mock: { mode: 'async' } } }), {
                provider,
                workerId: 'worker-a',
                sleep: async () => { requested = true; },
            }),
            (error) => error.code === 'TASK_CANCELLED' && error.cancelled === true,
        );
    });
    const call = ledger.ofTask()[0];
    assert.equal(call.status, ledgerModule.CALL_STATUS.CANCELLED);
    assert.equal(call.last_error_code, 'TASK_CANCEL_REQUESTED');
});

test('结果落库前已请求取消时，任务按取消终结且不写入结果', async () => {
    const ledger = createLedgerFake();
    const provider = createMockProvider();
    const completed = [];
    await withStubs({
        ledger,
        onComplete: (args) => completed.push(args),
        cancellation: false,
        lockCancellation: true,
    }, async () => {
        const outcome = await executeTask(createPool(), baseTask(), { provider, workerId: 'worker-a' });
        assert.equal(outcome.status, TASK_STATUS.CANCELLED);
        assert.equal(outcome.result, null);
        assert.equal(completed.length, 0);
    });
    // 供应商确实完成并产生成本，调用记录如实记账；只有任务侧按用户意图取消。
    assert.equal(ledger.ofTask()[0].status, ledgerModule.CALL_STATUS.SUCCEEDED);
});

test('缺少 Provider 或任务字段时在写入任何账本前就拒绝', async () => {
    const ledger = createLedgerFake();
    const provider = createMockProvider();
    await withStubs({ ledger, onComplete: () => {} }, async () => {
        await assert.rejects(
            executeTask(createPool(), baseTask(), { workerId: 'worker-a' }),
            /provider with submit and query is required/,
        );
        await assert.rejects(
            executeTask(createPool(), baseTask({ attempts: 0 }), { provider, workerId: 'worker-a' }),
            /task.attempts must be a positive integer/,
        );
    });
    assert.equal(ledger.ofTask().length, 0);
});

// 执行真实 ledger SQL 路径；内存连接池只实现本组回归所需的查询和租约条件。
function createLedgerMemoryPool() {
    const rows = [];
    const queries = [];
    const clone = (row) => ({ ...row });
    const active = (row) => CLAIMABLE.includes(row.status);
    const available = (row) => (!row.lease_expires_at || row.lease_expires_at <= Date.now()) && row.available_at <= Date.now();
    const pool = {
        rows, queries,
        async connect() { return { query: pool.query, release() {} }; },
        async query(text, values = []) {
            queries.push({ text, values });
            if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text)) return { rowCount: 0, rows: [] };
            let row;
            if (/INSERT INTO provider_calls/.test(text)) {
                const [id, attempt, provider, key, status, worker, token, seconds] = values;
                assert.equal(rows.some((candidate) => candidate.attempt_no === attempt), false);
                row = { id: `call-${rows.length + 1}`, task_id: id, attempt_no: attempt, provider_name: provider,
                    idempotency_key: key, status, worker_id: worker, lease_token: token,
                    lease_expires_at: Date.now() + seconds * 1000, available_at: Date.now(), recovery_attempts: 0 };
                rows.push(row);
            } else if (/SELECT \* FROM provider_calls/.test(text)) {
                row = rows.find((candidate) => active(candidate) && available(candidate) && candidate.task_id === values[1]);
            } else if (/SELECT id, status/.test(text)) {
                row = rows.find((candidate) => active(candidate) && candidate.task_id === values[0]);
            } else if (/recovery_attempts = recovery_attempts \+ 1/.test(text)) {
                row = rows.find((candidate) => candidate.id === values[3] && candidate.status === values[4] && available(candidate));
                if (row) Object.assign(row, { worker_id: values[0], lease_token: values[1],
                    lease_expires_at: Date.now() + values[2] * 1000, recovery_attempts: row.recovery_attempts + 1 });
            } else if (/SET status = \$1, last_error_code = \$2/.test(text)) {
                const [status, code, id, expected, worker, token] = values;
                row = rows.find((candidate) => candidate.id === id && (Array.isArray(expected) ? expected.includes(candidate.status) : candidate.status === expected)
                    && candidate.worker_id === worker && candidate.lease_token === token && candidate.lease_expires_at > Date.now());
                if (row) Object.assign(row, { status, last_error_code: code, worker_id: null, lease_token: null,
                    lease_expires_at: null, available_at: Date.now() });
            } else if (/SET worker_id = NULL, lease_token = NULL/.test(text)) {
                const [delay, code, id, expected, worker, token] = values;
                row = rows.find((candidate) => candidate.id === id && expected.includes(candidate.status)
                    && candidate.worker_id === worker && candidate.lease_token === token && candidate.lease_expires_at > Date.now());
                if (row) Object.assign(row, { last_error_code: code, worker_id: null, lease_token: null,
                    lease_expires_at: null, available_at: Date.now() + delay * 1000 });
            } else assert.fail(`未实现的内存账本 SQL：${text}`);
            return { rowCount: row ? 1 : 0, rows: row ? [clone(row)] : [] };
        },
    };
    return pool;
}

test('真实 gate + executor + ledger：历史 unknown/submitting 被拒发后保留 unknown、租约释放、幂等键不变', async () => {
    for (const status of ['unknown', 'submitting']) {
        for (const action of ['revoke', 'close', 'drain', 'abort', 'sync-revoke']) {
            const pool = createLedgerMemoryPool();
            const seeded = await ledgerModule.beginProviderCall(pool, { taskId, attemptNo: 1, providerName: 'memory-provider',
                idempotencyKey: 'historical-key', workerId: 'crashed-worker' });
            Object.assign(pool.rows[0], { status, lease_expires_at: Date.now() - 1 });
            const keys = [];
            const adapter = { name: 'memory-provider', submit: async (request) => { keys.push(request.idempotencyKey); return { kind: 'unknown' }; },
                query: async () => {}, cancel: async () => {} };
            const gate = createProviderInvocationGate(adapter);
            const caller = new AbortController();
            if (action === 'drain') gate.control.drain(Date.now() + 10000);
            else if (action === 'revoke' || action === 'close') gate.control[action]();
            const provider = { ...gate.provider, submit(request, options) {
                const pending = gate.provider.submit(request, options);
                if (action === 'abort') caller.abort(new Error('同步中止恢复'));
                if (action === 'sync-revoke') gate.control.revoke();
                return pending;
            } };
            await withStubs({ ledger: ledgerModule, onComplete: () => assert.fail('不应结算成功') }, async () => {
                await assert.rejects(executeTask(pool, baseTask({ attempts: 2 }), { provider, workerId: 'worker-b', signal: caller.signal }),
                    (error) => error.taskFailure.terminal === false && error.taskFailure.retryDelaySeconds === 5);
                const row = pool.rows[0];
                assert.equal(row.id, seeded.id);
                assert.equal(row.status, 'unknown', `${status}/${action}`);
                assert.equal(row.lease_token, null);
                assert.equal(row.worker_id, null);
                assert.equal(row.idempotency_key, 'historical-key');
                assert.equal(keys.length, 0);
                assert.equal(pool.queries.some(({ text, values }) => /UPDATE provider_calls/.test(text)
                    && /SET status =/.test(text) && ['failed', 'cancelled', 'succeeded'].includes(values[0])), false);
                await gate.control.close();
                // 模拟下一次崩溃恢复和退避结束，任务 attempts 已前进也不能创建新幂等键。
                row.available_at = Date.now() - 1;
                const reopened = createProviderInvocationGate(adapter);
                try {
                    await assert.rejects(executeTask(pool, baseTask({ attempts: 3 }), { provider: reopened.provider, workerId: 'worker-c' }),
                        (error) => error.code === 'PROVIDER_SUBMISSION_UNKNOWN' && error.taskFailure.terminal === false);
                } finally { await reopened.control.close(); }
                assert.deepEqual(keys, ['historical-key']);
                assert.equal(pool.rows.length, 1);
                assert.equal(row.attempt_no, 1);
                assert.equal(row.status, 'unknown');
                assert.equal(row.recovery_attempts, 2);
                assert.equal(pool.queries.filter(({ text }) => /INSERT INTO provider_calls/.test(text)).length, 1);
            });
        }
    }
});

test('真实 gate + executor + ledger：新调用同步撤销或中止可终结，adapter 零调用', async () => {
    for (const action of ['revoke', 'abort']) {
        const pool = createLedgerMemoryPool();
        let calls = 0;
        const caller = new AbortController();
        const gate = createProviderInvocationGate({ name: 'memory-provider', submit: async () => { calls++; },
            query: async () => {}, cancel: async () => {} });
        const provider = { ...gate.provider, submit(request, options) {
            const pending = gate.provider.submit(request, options);
            if (action === 'revoke') gate.control.revoke();
            else caller.abort(new Error('同步中止'));
            return pending;
        } };
        await withStubs({ ledger: ledgerModule, onComplete: () => assert.fail('不应成功') }, async () => {
            await assert.rejects(executeTask(pool, baseTask(), { provider, workerId: 'worker-a', signal: caller.signal }),
                (error) => error.code === `PROVIDER_GATE_${action === 'revoke' ? 'REVOKED' : 'ABORTED'}` && error.taskFailure.terminal === true);
        });
        assert.equal(calls, 0);
        assert.equal(pool.rows.length, 1);
        assert.equal(pool.rows[0].status, 'failed');
        assert.equal(pool.rows[0].lease_token, null);
        await gate.control.close();
    }
});

test('真实 gate + executor + ledger：旧 gate error 作为已 dispatch 的 abort reason 只能保留 unknown', async () => {
    const previous = createProviderInvocationGate(createMockProvider());
    previous.control.revoke();
    const oldError = await previous.provider.submit({}).catch((error) => error);
    const pool = createLedgerMemoryPool();
    const caller = new AbortController();
    let calls = 0;
    const gate = createProviderInvocationGate({ name: 'memory-provider', submit: async () => {
        calls++;
        caller.abort(oldError);
        return { kind: 'completed', providerJobId: 'late-job', result: {} };
    }, query: async () => {}, cancel: async () => {} });
    await withStubs({ ledger: ledgerModule, onComplete: () => assert.fail('中止后不应接受结果') }, async () => {
        await assert.rejects(executeTask(pool, baseTask(), { provider: gate.provider, workerId: 'worker-a', signal: caller.signal }),
            (error) => error.code === 'PROVIDER_UNKNOWN' && error.taskFailure.terminal === false);
    });
    assert.equal(calls, 1);
    assert.equal(pool.rows[0].status, 'unknown');
    assert.equal(pool.rows[0].lease_token, null);
    assert.equal(pool.rows[0].idempotency_key, providerIdempotencyKey(taskId, 1));
    await gate.control.close();
    await previous.control.close();
});

// 回归：createTaskProcessor 解构参数时会把 pool 从 options 里剥离。
// 一旦本地配置了对象存储，归档器就必须仍能拿到这个连接池，
// 否则每条图片任务都会在结算阶段以 "pool is required" 失败。
test('createTaskProcessor 把绑定的连接池交给归档器，图片结果可完成 pending→ready 归档', async () => {
    const { createTaskProcessor } = require('../lib/server/worker/taskExecutor');
    const ownerId = '33333333-3333-4333-8333-333333333333';
    const assetId = '44444444-4444-4444-8444-444444444444';
    const statements = [];
    const pool = {
        async query() { throw new Error('执行器不应直接查询连接池'); },
        async connect() {
            return {
                async query(text) {
                    statements.push(text);
                    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text)) return { rowCount: 0, rows: [] };
                    if (text.includes('INSERT INTO assets')) return { rowCount: 1, rows: [{ id: assetId }] };
                    if (text.includes("UPDATE assets SET status='ready'")) return { rowCount: 1, rows: [{ id: assetId }] };
                    throw new Error(`事务内出现了未预期的 SQL：${text}`);
                },
                release() {},
            };
        },
    };
    const objects = new Map();
    const objectStore = {
        async putObject({ key, body, acl }) {
            assert.equal(acl, 'private');
            objects.set(key, Buffer.from(body));
        },
        async deleteObject({ key }) { objects.delete(key); },
    };
    let completed;
    await withStubs({ ledger: createLedgerFake(), onComplete: (args) => { completed = args; } }, async () => {
        const processTask = createTaskProcessor({
            pool,
            provider: createMockProvider(),
            workerId: 'worker-archive',
            objectStore,
            poll: { minDelayMs: 1, maxDelayMs: 2 },
        });
        const outcome = await processTask({ ...baseTask(), owner_id: ownerId });
        assert.equal(outcome.status, TASK_STATUS.SUCCEEDED);
        assert.equal(outcome.result.archive, 'ready');
        assert.equal(outcome.result.assetId, assetId);
        assert.equal(outcome.result.resultUrl, `/api/assets/${assetId}/content`);
        assert.deepEqual([...objects.keys()], [`users/${ownerId}/assets/${assetId}`]);
        assert.equal([...objects.values()][0].subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
        assert.equal(completed.result.assetId, assetId);
        assert.ok(statements.some((text) => text.includes('INSERT INTO assets')));
    });
});

test('受控单图宿主仅在 Worker 就绪时接受指定会话，提交和领取使用同一冻结目录', async () => {
    const { createControlledImageHost } = require('../lib/server/worker');
    const { randomBytes } = require('node:crypto');
    const ownerId = '33333333-3333-4333-8333-333333333333';
    const otherId = '44444444-4444-4444-8444-444444444444';
    const modelId = 'controlled-image';
    const binding = { providerInstanceId: 'controlled-provider', credentialRef: 'controlled-ref', credentialVersion: 1,
        adapterType: 'myvigna-image', baseUrl: 'https://provider.example.test/v1', upstreamModel: 'gpt-image-2' };
    const model = { id: '77777777-7777-4777-8777-777777777777', logicalModelId: modelId,
        mediaType: 'image', enabled: true, catalogVersion: 1, supportedOperations: ['image.generate'], bindings: [{
            id: 'controlled-binding', enabled: true, isPrimary: true, bindingVersion: 1,
            providerInstance: { id: binding.providerInstanceId, enabled: true, configVersion: 1,
                credentialVersion: 1, adapterType: binding.adapterType },
            providerModel: { id: 'controlled-model', enabled: true, validationState: 'verified', mediaType: 'image',
                upstreamModelName: binding.upstreamModel, capabilities: { operations: ['image.generate'] },
                adapterVersion: '1', operationProfile: 'image.generate', requestMappingVersion: 1, responseMappingVersion: 1 },
        }] };
    let account = ownerId;
    let row;
    let writes = 0;
    const database = { async execute() { return { rows: [{ id: account, role: 'user', auth_level: 'password' }] }; },
        $client: { async connect() { return { release() {}, async query(sql, params) {
            if (sql.includes('INSERT INTO generation_tasks')) {
                writes++;
                row = { id: taskId, owner_id: params[0], task_type: params[3], payload: JSON.parse(params[4]),
                    logical_model_pk: params[7], route_snapshot: JSON.parse(params[8]), route_snapshot_version: params[9],
                    route_snapshot_hash: params[10], status: 'queued', created_at: new Date(), updated_at: new Date() };
                return { rows: [row], rowCount: 1 };
            }
            assert.match(sql, /^(BEGIN|COMMIT|ROLLBACK|SELECT \*)/);
            return { rows: [], rowCount: 0 };
        } }; } } };
    const origin = 'https://painttrack.example.test';
    const environment = { APP_BASE_URL: origin, NODE_ENV: 'development', PAINTTRACK_LOCAL_INTERNAL_GUARD: '1' };
    const token = randomBytes(32).toString('base64url');
    const post = (host, id = modelId) => host.submit(new Request(`${origin}/api/tasks`, { method: 'POST', headers: {
        origin, cookie: `painttrack_session=${token}`, 'content-type': 'application/json', 'idempotency-key': 'controlled-image-0001',
    }, body: JSON.stringify({ taskType: 'image.generate', payload: { logicalModelId: id, prompt: 'Fixture',
        aspectRatio: '1:1', size: '1024x1024', outputCount: 1 } }) }));
    const objectStore = { async putObject() { assert.fail('无实际归档'); }, async deleteObject() {} };
    const config = { catalog: { getLogicalModel: async () => model }, logicalModelId: modelId, ownerId, database,
        databaseUrl: 'postgres://unused/worker', environment, descriptor: binding, approvedBindings: [binding],
        secretResolver: async () => 'synthetic-secret', objectStore, sink: { info() {}, warn() {}, error() {} } };
    await assert.rejects(createControlledImageHost({ ...config, objectStore: undefined }), { code: 'CONTROLLED_IMAGE_HOST_CONFIG_INVALID' });
    await assert.rejects(createControlledImageHost({ ...config, environment: { ...environment, PAINTTRACK_CHARGED_SUBMISSION: '1' } }),
        { code: 'CONTROLLED_IMAGE_HOST_CONFIG_INVALID' });
    const adapter = { name: 'controlled-fixture', submit() { assert.fail('无真实上游'); },
        query() { assert.fail('无真实上游'); }, cancel() { assert.fail('无真实上游'); } };
    let revoked = false;
    const host = await createControlledImageHost(config, {
        adapterFactory: () => adapter,
        createTaskProcessor: (options) => options,
        run: (worker) => (async () => {
            assert.equal((await post(host)).status, 503);
            worker.onHostLifecycle({ getState: () => revoked ? 'revoked' : 'running', revoke() { revoked = true; } });
            assert.equal(host.getState(), 'ready');
            account = otherId;
            assert.equal((await post(host)).status, 403);
            account = ownerId;
            assert.equal((await post(host, 'other-image')).status, 409);
            assert.equal(writes, 0);
            assert.equal((await post(host)).status, 201);
            assert.equal(worker.approvedRoutes[0].owner_id, ownerId);
            assert.equal(row.route_snapshot.logicalModelVersion, 1);
            assert.equal(worker.approvedRoutes[0].snapshot_hash, row.route_snapshot_hash);
            const processor = worker.createProcessor({ pool: {} });
            assert.equal(processor.objectStore, objectStore);
            await processor.providerSelector.select(row);
            await assert.rejects(processor.providerSelector.select({ ...row, owner_id: otherId }));
            assert.equal(host.stop(), true);
            assert.equal((await post(host)).status, 503);
        })().then(() => null, (error) => error),
    });
    model.catalogVersion = 2;
    assert.equal((await post(host)).status, 503);
    const runError = await host.run();
    if (runError) throw runError;
    assert.equal(revoked, true);
    assert.equal(host.getState(), 'closed');
    assert.equal((await post(host)).status, 503);
    assert.equal(writes, 1);
});

test('可信单图从 HTTP 入队到私有归档，目录变更不重写快照或提交上游', async () => {
    const { randomBytes } = require('node:crypto');
    const { createRoutedTaskHandler } = require('../lib/server/tasks/taskHttp');
    const { bootstrapWorker } = require('../lib/server/worker');
    const { createTaskProcessor } = require('../lib/server/worker/taskExecutor');
    const ownerId = '33333333-3333-4333-8333-333333333333';
    const assetId = '66666666-6666-4666-8666-666666666666';
    const binding = { providerInstanceId: 'synthetic-image', credentialRef: 'fixture-ref', credentialVersion: 1,
        adapterType: 'myvigna-image', baseUrl: 'https://provider.example.test/v1', upstreamModel: 'gpt-image-2' };
    const model = { id: '77777777-7777-4777-8777-777777777777', logicalModelId: 'trusted-image',
        mediaType: 'image', enabled: true, catalogVersion: 1, supportedOperations: ['image.generate'], bindings: [{
            id: 'synthetic-binding', enabled: true, isPrimary: true, bindingVersion: 1,
            providerInstance: { id: binding.providerInstanceId, enabled: true, configVersion: 1,
                credentialVersion: binding.credentialVersion, adapterType: binding.adapterType },
            providerModel: { id: 'synthetic-model', enabled: true, validationState: 'verified', mediaType: 'image',
                upstreamModelName: binding.upstreamModel, capabilities: { operations: ['image.generate'] },
                adapterVersion: '1', operationProfile: 'image.generate', requestMappingVersion: 1, responseMappingVersion: 1 },
        }] };
    let catalogVersion = 1;
    const catalog = { async getLogicalModel(id) { return id === model.logicalModelId ? { ...model, catalogVersion } : null; } };
    let storedTask;
    let ready = false;
    const objects = new Map();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
    const pool = {
        async query() { assert.fail('预期所有 SQL 都在连接事务中'); },
        async connect() {
            return { release() {}, async query(sql, params) {
                if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [], rowCount: 0 };
                if (sql.includes('SELECT * FROM generation_tasks')) {
                    const rows = storedTask && storedTask.owner_id === params[0] && storedTask.idempotency_key === params[1] ? [storedTask] : [];
                    return { rows, rowCount: rows.length };
                }
                if (sql.includes('INSERT INTO generation_tasks')) {
                    assert.equal(storedTask, undefined);
                    assert.match(sql, /logical_model_pk, route_snapshot, route_snapshot_version, route_snapshot_hash/);
                    const [owner_id, idempotency_key, request_fingerprint, task_type, payload, , , logical_model_pk,
                        route_snapshot, route_snapshot_version, route_snapshot_hash] = params;
                    storedTask = { id: taskId, owner_id, idempotency_key, request_fingerprint, task_type,
                        payload: JSON.parse(payload), logical_model_pk, route_snapshot: JSON.parse(route_snapshot),
                        route_snapshot_version, route_snapshot_hash, status: TASK_STATUS.QUEUED,
                        created_at: new Date(), updated_at: new Date() };
                    return { rows: [storedTask], rowCount: 1 };
                }
                if (sql.includes('INSERT INTO assets')) {
                    assert.deepEqual(params.slice(0, 4), [ownerId, 'image', 'image/png', png.length]);
                    return { rows: [{ id: assetId }], rowCount: 1 };
                }
                if (sql.includes("UPDATE assets SET status='ready'")) {
                    ready = true;
                    return { rows: [{ id: assetId }], rowCount: 1 };
                }
                assert.fail(`未预期的 SQL: ${sql}`);
            } };
        },
    };
    const origin = 'https://painttrack.example.test';
    const token = randomBytes(32).toString('base64url');
    const handler = createRoutedTaskHandler({ catalog, environment: { APP_BASE_URL: origin },
        sink: { info() {}, warn() {}, error() {} }, database: { $client: pool,
            async execute() { return { rows: [{ id: ownerId, role: 'user', auth_level: 'password' }] }; } } });
    const post = () => handler(new Request(`${origin}/api/tasks`, { method: 'POST', headers: {
        origin, cookie: `painttrack_session=${token}`, 'content-type': 'application/json', 'idempotency-key': 'synthetic-image-0001',
    }, body: JSON.stringify({ taskType: 'image.generate', payload: { logicalModelId: model.logicalModelId,
        prompt: 'An offline fixture', aspectRatio: '1:1', size: '1024x1024', outputCount: 1 } }) }));
    const response = await post();
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.task.id, taskId);
    assert.equal(body.task.routeSnapshot, undefined);
    assert.equal(storedTask.owner_id, ownerId);
    const originalHash = storedTask.route_snapshot_hash;
    catalogVersion = 2;
    const replay = await post();
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('Idempotency-Replayed'), 'true');
    assert.equal(storedTask.route_snapshot_hash, originalHash);

    let submissions = 0;
    let completed;
    const ledger = createLedgerFake();
    await withStubs({ ledger, onComplete: (result) => { completed = result; } }, async () => {
        const run = async (historicalCatalogs) => {
            const runError = await bootstrapWorker({ descriptor: binding, approvedBindings: [binding], secretResolver: async () => 'offline-fixture',
                trustedCatalog: catalog, historicalCatalogs, logicalModelId: model.logicalModelId, workerId: 'worker-trusted-image' }, {
            adapterFactory: () => ({ name: 'synthetic-image-adapter', async submit() {
                submissions++;
                return { kind: 'completed', providerJobId: 'offline-image-1', providerState: 'succeeded',
                    result: { mediaType: 'image', mimeType: 'image/png', bytes: png } };
            }, async query() { assert.fail('同步结果不轮询'); }, async cancel() { assert.fail('未请求取消'); } }),
            createTaskProcessor: (config) => createTaskProcessor({ ...config, objectStore: {
                async putObject({ key, body, acl }) { assert.equal(acl, 'private'); objects.set(key, Buffer.from(body)); },
                async deleteObject({ key }) { objects.delete(key); },
            } }),
            run: ({ createProcessor, approvedRoutes, taskType }) => (async () => {
                assert.equal(taskType, 'image.generate');
                assert.equal(approvedRoutes.length, historicalCatalogs ? 2 : 1);
                const processTask = createProcessor({ pool });
                // 从提交层保存的同一行构造领取后的任务，不重新生成快照。
                const claimed = { ...storedTask, status: TASK_STATUS.RUNNING, attempts: 1, lease_token: 'offline-lease' };
                assert.equal(approvedRoutes.some(route => route.snapshot_hash === originalHash), Boolean(historicalCatalogs));
                if (!historicalCatalogs) {
                    await assert.rejects(processTask(claimed), { code: 'TASK_ROUTE_REJECTED' });
                    assert.equal(submissions, 0);
                    assert.equal(ledger.ofTask().length, 0);
                    assert.equal(objects.size, 0);
                    return;
                }
                const outcome = await processTask(claimed);
                assert.equal(outcome.status, TASK_STATUS.SUCCEEDED);
                assert.equal(outcome.result.archive, 'ready');
                assert.equal(outcome.result.resultUrl, `/api/assets/${assetId}/content`);
            })().then(() => null, (error) => error),
            });
            if (runError) throw runError;
        };
        await run();
        await run([{ async getLogicalModel(id) { return id === model.logicalModelId ? model : null; } }]);
    });
    assert.equal(catalogVersion, 2);
    assert.equal(submissions, 1);
    assert.equal(ledger.ofTask().length, 1);
    assert.equal(ready, true);
    assert.equal(completed.result.assetId, assetId);
    assert.deepEqual([...objects], [[`users/${ownerId}/assets/${assetId}`, png]]);
});

// 真实 Provider（如 MyVigna）只返回结果 URL。若不先抓成二进制，
// 任务会成功但资产永远不落盘，Studio 就又变成"完成但没图"。
test('Provider 只给结果 URL 时，执行器先抓取再归档，并把描述符换成授权内容地址', async () => {
    const { createServer } = require('node:http');
    const { createTaskProcessor } = require('../lib/server/worker/taskExecutor');
    const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
        'base64',
    );
    let downloads = 0;
    const server = createServer((request, response) => {
        downloads += 1;
        assert.equal(request.url, '/result.png');
        response.writeHead(200, { 'Content-Type': 'image/png' });
        response.end(png);
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    const ownerId = '33333333-3333-4333-8333-333333333333';
    const assetId = '55555555-5555-4555-8555-555555555555';
    const objects = new Map();
    const statements = [];
    const pool = {
        async query() { throw new Error('执行器不应直接查询连接池'); },
        async connect() {
            return {
                async query(text) {
                    statements.push(text);
                    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text)) return { rowCount: 0, rows: [] };
                    if (text.includes('INSERT INTO assets')) return { rowCount: 1, rows: [{ id: assetId }] };
                    if (text.includes("UPDATE assets SET status='ready'")) return { rowCount: 1, rows: [{ id: assetId }] };
                    throw new Error(`事务内出现了未预期的 SQL：${text}`);
                },
                release() {},
            };
        },
    };
    const objectStore = {
        async putObject({ key, body, acl }) {
            assert.equal(acl, 'private');
            objects.set(key, Buffer.from(body));
        },
        async deleteObject({ key }) { objects.delete(key); },
    };
    const provider = {
        name: 'url-provider',
        async submit() {
            return {
                kind: 'completed',
                providerJobId: 'url-job-1',
                providerState: 'succeeded',
                pollAfterMs: 0,
                result: { mediaType: 'image', resultUrl: `http://127.0.0.1:${port}/result.png` },
                usage: null,
            };
        },
        async query() { assert.fail('同步完成不应再轮询'); },
    };
    try {
        let completed;
        await withStubs({ ledger: createLedgerFake(), onComplete: (args) => { completed = args; } }, async () => {
            const processTask = createTaskProcessor({
                pool,
                provider,
                workerId: 'worker-fetch',
                objectStore,
                allowInsecureResultFetch: true,
                poll: { minDelayMs: 1, maxDelayMs: 2 },
            });
            const outcome = await processTask({ ...baseTask(), owner_id: ownerId });
            assert.equal(outcome.status, TASK_STATUS.SUCCEEDED);
            assert.equal(outcome.result.archive, 'ready');
            assert.equal(outcome.result.assetId, assetId);
            // 外部供应商地址不得出现在任务结果里：客户端只能看到授权内容路由。
            assert.equal(outcome.result.resultUrl, `/api/assets/${assetId}/content`);
            assert.equal(completed.result.resultUrl, `/api/assets/${assetId}/content`);
            // 归档的正是下载回来的字节，且 MIME 取自响应头。
            assert.equal([...objects.values()][0].subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
            assert.ok(statements.some((text) => text.includes('INSERT INTO assets')));
            assert.equal(downloads, 1);
        });
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test('结果 URL 抓取失败时任务按可重试失败，不写入 succeeded，也不落任何对象', async () => {
    const { createServer } = require('node:http');
    const { createTaskProcessor } = require('../lib/server/worker/taskExecutor');
    const ownerId = '33333333-3333-4333-8333-333333333333';
    const server = createServer((request, response) => {
        response.writeHead(404, { 'Content-Type': 'text/plain' });
        response.end('gone');
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    const objects = new Map();
    const pool = {
        async query() { throw new Error('执行器不应直接查询连接池'); },
        async connect() {
            assert.fail('抓取失败时不应开启结算事务');
        },
    };
    const objectStore = {
        async putObject({ key, body }) { objects.set(key, Buffer.from(body)); },
        async deleteObject({ key }) { objects.delete(key); },
    };
    const provider = {
        name: 'url-provider',
        async submit() {
            return {
                kind: 'completed',
                providerJobId: 'url-job-2',
                providerState: 'succeeded',
                pollAfterMs: 0,
                result: { mediaType: 'image', resultUrl: `http://127.0.0.1:${port}/missing.png` },
                usage: null,
            };
        },
        async query() { assert.fail('同步完成不应再轮询'); },
    };
    try {
        await withStubs({ ledger: createLedgerFake(), onComplete: () => assert.fail('不应结算成功') }, async () => {
            const processTask = createTaskProcessor({
                pool,
                provider,
                workerId: 'worker-fetch-fail',
                objectStore,
                allowInsecureResultFetch: true,
                poll: { minDelayMs: 1, maxDelayMs: 2 },
            });
            await assert.rejects(
                processTask({ ...baseTask(), owner_id: ownerId }),
                (error) => error instanceof TaskExecutionError
                    && error.code === 'RESULT_FETCH_FAILED'
                    && error.taskFailure.terminal === false
                    && error.cause?.code === 'RESULT_FETCH_HTTP_STATUS',
            );
            assert.equal(objects.size, 0);
        });
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

