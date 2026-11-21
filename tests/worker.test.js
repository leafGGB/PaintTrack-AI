const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorker, startWorker } = require('../lib/server/worker');
const { TaskQueueError } = require('../lib/server/worker/taskQueue');
const { Pool } = require('pg');

const task = { id: 'task-1', lease_token: 'lease-1', payload: { marker: 'ok' } };

function createPool({ claimedTask = task, completeError, failError, cancelError, claimError, heartbeatError, heartbeatDelayMs = 0 } = {}) {
    const calls = [];
    return {
        calls,
        async claimNextTask(_pool, options) {
            calls.push({ type: 'claim', options });
            if (claimError) throw claimError;
            return claimedTask;
        },
        async heartbeatTask(_pool, args) {
            calls.push({ type: 'heartbeat', args });
            if (heartbeatDelayMs) await new Promise((resolve) => setTimeout(resolve, heartbeatDelayMs));
            if (heartbeatError) throw heartbeatError;
        },
        async completeTask(_pool, args) {
            calls.push({ type: 'complete', args });
            if (completeError) throw completeError;
        },
        async failTask(_pool, args) {
            calls.push({ type: 'fail', args });
            if (failError) throw failError;
        },
        async cancelClaimedTask(_pool, args) {
            calls.push({ type: 'cancel', args });
            if (cancelError) throw cancelError;
        },
    };
}

function withQueueStubs(pool, run) {
    const queue = require('../lib/server/worker/taskQueue');
    const originals = {
        claimNextTask: queue.claimNextTask,
        heartbeatTask: queue.heartbeatTask,
        completeTask: queue.completeTask,
        failTask: queue.failTask,
        cancelClaimedTask: queue.cancelClaimedTask,
    };
    queue.claimNextTask = pool.claimNextTask.bind(pool);
    queue.heartbeatTask = pool.heartbeatTask.bind(pool);
    queue.completeTask = pool.completeTask.bind(pool);
    queue.failTask = pool.failTask.bind(pool);
    queue.cancelClaimedTask = pool.cancelClaimedTask.bind(pool);
    return Promise.resolve()
        .then(run)
        .finally(() => Object.assign(queue, originals));
}

test('createWorker requires an explicit task processor', () => {
    assert.throws(
        () => createWorker({ pool: {}, workerId: 'worker-a' }),
        /processTask is required/,
    );
});

test('startWorker closes its pool when worker configuration is invalid', async (t) => {
    const originalEnd = Pool.prototype.end;
    let poolClosed = false;
    Pool.prototype.end = async function end() {
        poolClosed = true;
    };
    t.after(() => {
        Pool.prototype.end = originalEnd;
    });

    await assert.rejects(
        startWorker({ databaseUrl: 'postgres://localhost/painttrack', processTask: async () => {}, pollIntervalMs: 0 }),
        /pollIntervalMs must be a positive integer/,
    );
    assert.equal(poolClosed, true);
});

test('worker processes and completes a claimed task', async () => {
    const pool = createPool();
    const processed = [];
    await withQueueStubs(pool, async () => {
        const worker = createWorker({
            pool,
            workerId: 'worker-a',
            processTask: async (claimed) => processed.push(claimed.id),
        });
        assert.deepEqual(await worker.runOnce(), { status: 'succeeded', taskId: task.id });
    });
    assert.deepEqual(processed, [task.id]);
    assert.deepEqual(pool.calls.map((call) => call.type), ['claim', 'complete']);
});

test('worker narrows the claim to an explicit task type only when configured', async () => {
    const scoped = createPool();
    await withQueueStubs(scoped, async () => {
        const worker = createWorker({
            pool: scoped,
            workerId: 'worker-a',
            taskType: ' postgres-worker-acceptance ',
            processTask: async () => {},
        });
        assert.deepEqual(await worker.runOnce(), { status: 'succeeded', taskId: task.id });
    });
    assert.deepEqual(scoped.calls[0].options, {
        workerId: 'worker-a', leaseSeconds: 60, taskType: 'postgres-worker-acceptance',
    });

    const unscoped = createPool();
    await withQueueStubs(unscoped, async () => {
        const worker = createWorker({ pool: unscoped, workerId: 'worker-a', processTask: async () => {} });
        assert.deepEqual(await worker.runOnce(), { status: 'succeeded', taskId: task.id });
    });
    assert.deepEqual(unscoped.calls[0].options, { workerId: 'worker-a', leaseSeconds: 60 });

    assert.throws(
        () => createWorker({ pool: {}, workerId: 'worker-a', taskType: '   ', processTask: async () => {} }),
        /taskType must be a non-empty string/,
    );
});

test('worker renews the lease while a task is processing', async () => {
    const pool = createPool();
    await withQueueStubs(pool, async () => {
        const worker = createWorker({
            pool,
            workerId: 'worker-a',
            leaseSeconds: 1,
            heartbeatIntervalMs: 2,
            processTask: async () => new Promise((resolve) => setTimeout(resolve, 15)),
        });
        assert.deepEqual(await worker.runOnce(), { status: 'succeeded', taskId: task.id });
    });
    assert.ok(pool.calls.some((call) => call.type === 'heartbeat'));
});

test('worker waits for an in-flight heartbeat before finalizing', async () => {
    const pool = createPool({ heartbeatDelayMs: 20 });
    await withQueueStubs(pool, async () => {
        const worker = createWorker({
            pool,
            workerId: 'worker-a',
            leaseSeconds: 1,
            heartbeatIntervalMs: 2,
            processTask: async () => new Promise((resolve) => setTimeout(resolve, 10)),
        });
        assert.deepEqual(await worker.runOnce(), { status: 'succeeded', taskId: task.id });
    });
    assert.deepEqual(pool.calls.map((call) => call.type), ['claim', 'heartbeat', 'complete']);
});

test('worker aborts processing and does not finalize after lease loss', async () => {
    const pool = createPool({ heartbeatError: new TaskQueueError('LEASE_LOST', 'Task lease is no longer valid') });
    let signal;
    await withQueueStubs(pool, async () => {
        const worker = createWorker({
            pool,
            workerId: 'worker-a',
            leaseSeconds: 1,
            heartbeatIntervalMs: 2,
            processTask: async (_claimed, context) => {
                signal = context.signal;
                await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
            },
        });
        assert.deepEqual(await worker.runOnce(), { status: 'lease-lost', taskId: task.id });
    });
    assert.equal(signal.aborted, true);
    assert.deepEqual(pool.calls.map((call) => call.type), ['claim', 'heartbeat']);
});

test('worker aborts processing and avoids finalization after heartbeat errors', async () => {
    const pool = createPool({ heartbeatError: new Error('database unavailable') });
    let signal;
    await withQueueStubs(pool, async () => {
        const worker = createWorker({
            pool,
            workerId: 'worker-a',
            leaseSeconds: 1,
            heartbeatIntervalMs: 2,
            processTask: async (_claimed, context) => {
                signal = context.signal;
                await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
            },
        });
        assert.deepEqual(await worker.runOnce(), { status: 'heartbeat-error', taskId: task.id });
    });
    assert.equal(signal.aborted, true);
    assert.deepEqual(pool.calls.map((call) => call.type), ['claim', 'heartbeat']);
});

test('cancellation is persisted as a terminal cancelled state, not a retryable failure', async () => {
    const pool = createPool();
    await withQueueStubs(pool, async () => {
        const worker = createWorker({
            pool,
            workerId: 'worker-a',
            processTask: async () => {
                const error = new Error('cancel requested');
                error.cancelled = true;
                throw error;
            },
        });
        assert.deepEqual(await worker.runOnce(), { status: 'cancelled', taskId: task.id });
    });
    assert.deepEqual(pool.calls.map((call) => call.type), ['claim', 'cancel']);
    assert.equal(pool.calls.at(-1).args.taskId, task.id);
    assert.equal(pool.calls.at(-1).args.leaseToken, task.lease_token);
});

test('a stale lease cannot be written as cancelled', async () => {
    const pool = createPool({ cancelError: new TaskQueueError('LEASE_LOST', 'lost') });
    await withQueueStubs(pool, async () => {
        const worker = createWorker({
            pool,
            workerId: 'worker-a',
            processTask: async () => {
                const error = new Error('cancel requested');
                error.cancelled = true;
                throw error;
            },
        });
        assert.deepEqual(await worker.runOnce(), { status: 'lease-lost', taskId: task.id });
    });
    assert.deepEqual(pool.calls.map((call) => call.type), ['claim', 'cancel']);
});

test('worker persists processing errors through failTask', async () => {
    const pool = createPool();
    await withQueueStubs(pool, async () => {
        const worker = createWorker({
            pool,
            workerId: 'worker-a',
            processTask: async () => { throw new Error('provider unavailable'); },
        });
        assert.deepEqual(await worker.runOnce(), { status: 'failed', taskId: task.id });
    });
    const failureCall = pool.calls.find((call) => call && call.type === 'fail');
    assert.ok(failureCall);
    assert.equal(failureCall.args.errorMessage, 'provider unavailable');
});

test('worker returns idle when no task is available', async () => {
    const pool = createPool({ claimedTask: null });
    await withQueueStubs(pool, async () => {
        const worker = createWorker({ pool, workerId: 'worker-a', processTask: async () => {} });
        assert.deepEqual(await worker.runOnce(), { status: 'idle' });
    });
    assert.deepEqual(pool.calls.map((call) => call.type), ['claim']);
});

test('continuous worker polls while idle and stops promptly', async () => {
    const pool = createPool({ claimedTask: null });
    await withQueueStubs(pool, async () => {
        const worker = createWorker({
            pool,
            workerId: 'worker-a',
            pollIntervalMs: 10000,
            processTask: async () => {},
        });
        const runPromise = worker.run();
        await new Promise((resolve) => setImmediate(resolve));
        worker.stop();
        assert.deepEqual(await runPromise, { status: 'stopped' });
    });
    assert.equal(pool.calls.filter((call) => call.type === 'claim').length, 1);
});

test('stop lets the active task finish and prevents another claim', async () => {
    let finishTask;
    const pool = createPool();
    let claims = 0;
    const originalClaim = pool.claimNextTask;
    pool.claimNextTask = async (...args) => {
        claims += 1;
        return originalClaim(...args);
    };
    await withQueueStubs(pool, async () => {
        const worker = createWorker({
            pool,
            workerId: 'worker-a',
            processTask: async () => new Promise((resolve) => { finishTask = resolve; }),
        });
        const runPromise = worker.run();
        while (!finishTask) await new Promise((resolve) => setImmediate(resolve));
        worker.stop();
        finishTask();
        assert.deepEqual(await runPromise, { status: 'stopped' });
    });
    assert.equal(claims, 1);
    assert.deepEqual(pool.calls.map((call) => call.type), ['claim', 'complete']);
});

test('stopped worker does not claim tasks', async () => {
    const pool = createPool();
    await withQueueStubs(pool, async () => {
        const worker = createWorker({ pool, workerId: 'worker-a', processTask: async () => {} });
        worker.stop();
        assert.deepEqual(await worker.runOnce(), { status: 'stopped' });
    });
    assert.deepEqual(pool.calls, []);
});

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

async function bounded(promise) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('测试等待超时')), 1500); }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

function cancellationWorker(pool, processTask, options = {}) {
    return createWorker({
        pool, workerId: 'worker-a', heartbeatIntervalMs: 100,
        shutdownGraceMs: 5, cancellationTimeoutMs: 15, processTask, ...options,
    });
}

test('heartbeat interval is strictly shorter than the lease and shutdown options are validated', () => {
    const options = { pool: {}, workerId: 'worker-a', processTask: async () => {}, leaseSeconds: 1 };
    assert.doesNotThrow(() => createWorker(options));
    assert.doesNotThrow(() => createWorker({ ...options, heartbeatIntervalMs: 999, shutdownGraceMs: 0 }));
    for (const heartbeatIntervalMs of [1000, 1001]) {
        assert.throws(() => createWorker({ ...options, heartbeatIntervalMs }), /shorter than the lease/);
    }
    for (const shutdownGraceMs of [-1, 0.5]) {
        assert.throws(() => createWorker({ ...options, shutdownGraceMs }), /shutdownGraceMs/);
    }
    for (const cancellationTimeoutMs of [0, -1, 0.5]) {
        assert.throws(() => createWorker({ ...options, cancellationTimeoutMs }), /cancellationTimeoutMs/);
    }
});

test('one-second lease uses a default heartbeat before expiry', async () => {
    const pool = createPool();
    await withQueueStubs(pool, async () => {
        const worker = createWorker({
            pool, workerId: 'worker-a', leaseSeconds: 1,
            processTask: () => new Promise((resolve) => setTimeout(resolve, 450)),
        });
        assert.equal((await bounded(worker.runOnce())).status, 'succeeded');
    });
    assert.ok(pool.calls.some((call) => call.type === 'heartbeat'));
});

test('stop during claim never starts or finalizes the claimed task', async () => {
    const pool = createPool();
    const claim = deferred();
    pool.claimNextTask = () => claim.promise;
    await withQueueStubs(pool, async () => {
        const worker = cancellationWorker(pool, () => assert.fail('停止后不能执行新领取任务'));
        const running = worker.run();
        worker.stop();
        claim.resolve(task);
        assert.deepEqual(await bounded(running), { status: 'stopped' });
    });
    assert.deepEqual(pool.calls, []);
});

test('stop bounds a stuck claim and ignores its late result', async () => {
    const pool = createPool();
    const claim = deferred();
    pool.claimNextTask = () => claim.promise;
    await withQueueStubs(pool, async () => {
        const worker = cancellationWorker(pool, () => assert.fail('超时领取不能执行'));
        const running = worker.run();
        worker.stop();
        worker.stop();
        assert.deepEqual(await bounded(running), { status: 'cancellation-timeout', phase: 'claiming' });
        claim.resolve(task);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal((await worker.runOnce()).status, 'cancellation-timeout');
        assert.equal((await worker.run()).status, 'cancellation-timeout');
    });
    assert.deepEqual(pool.calls, []);
});

test('stop requests cooperative cancellation after grace without success or failure writes', async () => {
    const pool = createPool();
    const started = deferred();
    let signal;
    await withQueueStubs(pool, async () => {
        const worker = cancellationWorker(pool, async (_task, context) => {
            signal = context.signal;
            started.resolve();
            await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        });
        const running = worker.run();
        await started.promise;
        worker.stop();
        assert.deepEqual(await bounded(running), { status: 'stopped' });
    });
    assert.equal(signal.aborted, true);
    assert.deepEqual(pool.calls.map((call) => call.type), ['claim']);
});

for (const lateFailure of [false, true]) {
    test(`non-cooperative processor times out and cannot finalize after late ${lateFailure ? 'rejection' : 'resolution'}`, async () => {
        const pool = createPool();
        const started = deferred();
        const processing = deferred();
        await withQueueStubs(pool, async () => {
            const worker = cancellationWorker(pool, () => { started.resolve(); return processing.promise; });
            const running = worker.run();
            await started.promise;
            worker.stop();
            assert.deepEqual(await bounded(running), {
                status: 'cancellation-timeout', taskId: task.id, phase: 'processing',
            });
            if (lateFailure) processing.reject(new Error('迟到的失败'));
            else processing.resolve();
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal((await worker.runOnce()).status, 'cancellation-timeout');
        });
        assert.deepEqual(pool.calls.map((call) => call.type), ['claim']);
    });
}

for (const heartbeatError of [new TaskQueueError('LEASE_LOST', 'lost'), new Error('offline')]) {
    test(`non-cooperative processor is bounded after heartbeat ${heartbeatError.message}`, async () => {
        const pool = createPool({ heartbeatError });
        await withQueueStubs(pool, async () => {
            const worker = cancellationWorker(pool, () => new Promise(() => {}), { heartbeatIntervalMs: 2 });
            assert.equal((await bounded(worker.runOnce())).status, 'cancellation-timeout');
            assert.equal((await worker.runOnce()).status, 'cancellation-timeout');
        });
        assert.deepEqual(pool.calls.map((call) => call.type), ['claim', 'heartbeat']);
    });
}

test('stop bounds an in-flight heartbeat that never settles', async () => {
    const pool = createPool();
    const beating = deferred();
    const processing = deferred();
    const heartbeat = deferred();
    pool.heartbeatTask = () => { beating.resolve(); return heartbeat.promise; };
    await withQueueStubs(pool, async () => {
        const worker = cancellationWorker(pool, () => processing.promise, { heartbeatIntervalMs: 2 });
        const running = worker.run();
        await beating.promise;
        processing.resolve();
        await new Promise((resolve) => setImmediate(resolve));
        worker.stop();
        assert.deepEqual(await bounded(running), {
            status: 'cancellation-timeout', taskId: task.id, phase: 'heartbeat',
        });
        heartbeat.resolve();
        await new Promise((resolve) => setImmediate(resolve));
    });
    assert.deepEqual(pool.calls.map((call) => call.type), ['claim']);
});

test('stop bounds a pending finalization but cannot revoke a query already sent', async () => {
    const pool = createPool();
    const finalizing = deferred();
    const completion = deferred();
    pool.completeTask = () => { finalizing.resolve(); return completion.promise; };
    await withQueueStubs(pool, async () => {
        const worker = cancellationWorker(pool, async () => {});
        const running = worker.run();
        await finalizing.promise;
        worker.stop();
        assert.deepEqual(await bounded(running), {
            status: 'cancellation-timeout', taskId: task.id, phase: 'finalizing',
        });
        completion.reject(new TaskQueueError('LEASE_LOST', 'lost'));
        await new Promise((resolve) => setImmediate(resolve));
    });
    assert.deepEqual(pool.calls.map((call) => call.type), ['claim']);
});

test('concurrent runOnce calls cannot create untracked claims', async () => {
    const pool = createPool();
    const claim = deferred();
    pool.claimNextTask = () => claim.promise;
    await withQueueStubs(pool, async () => {
        const worker = cancellationWorker(pool, async () => {});
        const first = worker.runOnce();
        await assert.rejects(worker.runOnce(), /already has an active task/);
        worker.stop();
        claim.resolve(null);
        assert.equal((await first).status, 'stopped');
    });
});

test('failure write maps LEASE_LOST consistently without retrying a stale token', async () => {
    const pool = createPool({ failError: new TaskQueueError('LEASE_LOST', 'lost') });
    await withQueueStubs(pool, async () => {
        const worker = cancellationWorker(pool, async () => { throw new Error('provider failed'); });
        assert.deepEqual(await worker.runOnce(), { status: 'lease-lost', taskId: task.id });
    });
    assert.deepEqual(pool.calls.map((call) => call.type), ['claim', 'fail']);
});

test('ordinary failure-write errors remain visible to the caller', async () => {
    const failure = new Error('database offline');
    const pool = createPool({ failError: failure });
    await withQueueStubs(pool, async () => {
        const worker = cancellationWorker(pool, async () => { throw new Error('provider failed'); });
        await assert.rejects(worker.runOnce(), (error) => error === failure);
    });
});

test('falsy processor rejection is still persisted as a failure', async () => {
    const pool = createPool();
    await withQueueStubs(pool, async () => {
        const worker = cancellationWorker(pool, async () => { throw null; });
        assert.equal((await worker.runOnce()).status, 'failed');
    });
    assert.equal(pool.calls.at(-1).args.errorMessage, 'null');
});

test('worker reports lease loss without trying to fail with a stale token', async () => {
    const pool = createPool({
        completeError: new TaskQueueError('LEASE_LOST', 'Task lease is no longer valid'),
    });
    await withQueueStubs(pool, async () => {
        const worker = createWorker({ pool, workerId: 'worker-a', processTask: async () => {} });
        assert.deepEqual(await worker.runOnce(), { status: 'lease-lost', taskId: task.id });
    });
    assert.deepEqual(pool.calls.map((call) => call.type), ['claim', 'complete']);
});

test('a processor that finalized its own transaction is not written twice', async () => {
    const pool = createPool();
    await withQueueStubs(pool, async () => {
        const worker = createWorker({
            pool,
            workerId: 'worker-a',
            processTask: async () => ({ finalized: true, status: 'succeeded' }),
        });
        assert.deepEqual(await worker.runOnce(), { status: 'succeeded', taskId: task.id });
    });
    assert.deepEqual(pool.calls.map((call) => call.type), ['claim']);
});

test('processor failure metadata controls the retry delay and terminal decision', async () => {
    const pool = createPool();
    await withQueueStubs(pool, async () => {
        const worker = createWorker({
            pool,
            workerId: 'worker-a',
            processTask: async () => {
                const error = new Error('rate limited');
                error.taskFailure = { errorMessage: 'RATE_LIMITED', retryDelaySeconds: 9, terminal: false };
                throw error;
            },
        });
        assert.deepEqual(await worker.runOnce(), { status: 'failed', taskId: task.id });
    });
    const failure = pool.calls.find((call) => call.type === 'fail');
    assert.equal(failure.args.errorMessage, 'RATE_LIMITED');
    assert.equal(failure.args.retryDelaySeconds, 9);
    assert.equal(failure.args.terminal, false);
});

test('a processor without an explicit result completes with an unspecified descriptor', async () => {
    const pool = createPool();
    await withQueueStubs(pool, async () => {
        const worker = createWorker({ pool, workerId: 'worker-a', processTask: async () => {} });
        await worker.runOnce();
    });
    const completion = pool.calls.find((call) => call.type === 'complete');
    assert.deepEqual(completion.args.result, {
        kind: 'unspecified',
        archive: 'not_configured',
        source: 'processor',
    });
});
