const test = require('node:test');
const assert = require('node:assert/strict');
const {
    TASK_STATUS,
    TaskQueueError,
    cancelClaimedTask,
    claimNextTask,
    completeTask,
    failTask,
    heartbeatTask,
    isCancellationRequested,
    recoverExpiredTasks,
} = require('../lib/server/worker/taskQueue');

function scriptedPool(results) {
    const calls = [];
    return {
        calls,
        async query(text, values) {
            calls.push({ text, values });
            const next = results.shift();
            if (next instanceof Error) throw next;
            return next || { rowCount: 0, rows: [] };
        },
        async connect() {
            return {
                async query(text, values) {
                    calls.push({ text, values });
                    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text)) {
                        return { rowCount: 0, rows: [] };
                    }
                    const next = results.shift();
                    if (next instanceof Error) throw next;
                    return next || { rowCount: 0, rows: [] };
                },
                release() {},
            };
        },
    };
}

test('claimNextTask recovers expired leases and claims with SKIP LOCKED and a new token', async () => {
    const pool = scriptedPool([
        { rowCount: 1, rows: [{ id: 'expired', status: TASK_STATUS.QUEUED }] },
        { rowCount: 1, rows: [{ id: 'queued', status: TASK_STATUS.QUEUED }] },
        { rowCount: 1, rows: [{ id: 'queued', status: TASK_STATUS.RUNNING, lease_token: 'token' }] },
        { rowCount: 1, rows: [] },
        { rowCount: 1, rows: [] },
    ]);
    const claimed = await claimNextTask(pool, { workerId: 'worker-a', leaseSeconds: 30 });
    assert.equal(claimed.id, 'queued');
    const selectCall = pool.calls.find((call) => /FOR UPDATE SKIP LOCKED/.test(call.text));
    const updateCall = pool.calls.find((call) => /UPDATE generation_tasks/.test(call.text) && /attempts = attempts \+ 1/.test(call.text));
    assert.ok(selectCall);
    assert.ok(updateCall);
    assert.equal(updateCall.values[0], TASK_STATUS.RUNNING);
    assert.equal(updateCall.values[3], 'worker-a');
});

test('claimNextTask binds the fixture task type in the locked queue selection', async () => {
    const pool = scriptedPool([
        { rowCount: 0, rows: [] },
        { rowCount: 1, rows: [{ id: 'cancel-task', status: TASK_STATUS.QUEUED }] },
        { rowCount: 1, rows: [{ id: 'cancel-task', status: TASK_STATUS.RUNNING }] },
    ]);
    const claimed = await claimNextTask(pool, {
        workerId: 'cancel-fixture-worker',
        leaseSeconds: 30,
        taskType: 'task-cancel-fixture',
    });
    assert.equal(claimed.id, 'cancel-task');
    const selection = pool.calls.find((call) => /FOR UPDATE SKIP LOCKED/.test(call.text));
    assert.match(selection.text, /\(\$2::text IS NULL OR task_type = \$2\)/);
    assert.match(selection.text, /\(\$3::uuid IS NULL OR id = \$3::uuid\)/);
    assert.deepEqual(selection.values, [TASK_STATUS.QUEUED, 'task-cancel-fixture', null]);
});

test('trusted scope binds the same complete snapshot list for recovery and locked selection', async () => {
    const pool = scriptedPool([]);
    const approvedRoutes = [{ model_pk: '11111111-1111-4111-8111-111111111111', snapshot_version: 1,
        snapshot_hash: 'a'.repeat(64), snapshot: { logicalModelId: 'trusted-image' },
        owner_id: '22222222-2222-4222-8222-222222222222' }];
    assert.equal(await claimNextTask(pool, { workerId: 'worker-a', approvedRoutes }), null);
    const [, recovery, selection] = pool.calls;
    for (const query of [recovery, selection]) {
        assert.match(query.text, /logical_model_pk = approved\.model_pk/);
        assert.match(query.text, /route_snapshot_version = approved\.snapshot_version/);
        assert.match(query.text, /route_snapshot_hash = approved\.snapshot_hash/);
        assert.match(query.text, /route_snapshot = approved\.snapshot/);
        assert.match(query.text, /generation_tasks\.owner_id = approved\.owner_id/);
        assert.deepEqual(JSON.parse(query.values.at(-1)), approvedRoutes);
    }
    assert.match(recovery.text, /jsonb_to_recordset\(\$5::jsonb\)/);
    assert.match(selection.text, /jsonb_to_recordset\(\$4::jsonb\)/);
    assert.ok(pool.calls.every(({ text }) => !text.includes('attempts = attempts + 1')));
    await assert.rejects(claimNextTask(pool, { workerId: 'worker-a', approvedRoutes: [] }), TypeError);
});

test('Mock worker limits both recovery and claim to legacy or Mock snapshots', async () => {
    const pool = scriptedPool([]);
    assert.equal(await claimNextTask(pool, { workerId: 'mock-worker', mockOnly: true }), null);
    const [, recovery, selection] = pool.calls;
    for (const query of [recovery, selection]) {
        assert.match(query.text, /route_snapshot IS NULL OR route_snapshot->>'adapterType' = 'mock'/);
    }
});

test('heartbeat, complete, and fail updates fence on the lease token', async () => {
    const pool = scriptedPool([
        { rowCount: 1, rows: [{ id: 'task', status: TASK_STATUS.RUNNING }] },
        { rowCount: 1, rows: [{ id: 'task', status: TASK_STATUS.SUCCEEDED }] },
        { rowCount: 1, rows: [{ id: 'task', status: TASK_STATUS.QUEUED }] },
    ]);
    await heartbeatTask(pool, { taskId: 'task', leaseToken: 'token', leaseSeconds: 20 });
    await completeTask(pool, { taskId: 'task', leaseToken: 'token', result: { kind: 'test' } });
    await failTask(pool, { taskId: 'task', leaseToken: 'token', errorMessage: 'provider unavailable' });
    for (const call of pool.calls) {
        assert.match(call.text, /lease_token = \$\d+::uuid/);
        assert.ok(call.values.includes('token'));
        assert.match(call.text, /status = \$\d+ AND lease_token = \$\d+::uuid AND lease_expires_at > now\(\)/);
        assert.ok(call.values.includes(TASK_STATUS.RUNNING));
    }
});

test('stale lease cannot complete a reclaimed task', async () => {
    const pool = scriptedPool([{ rowCount: 0, rows: [] }]);
    await assert.rejects(
        completeTask(pool, { taskId: 'task', leaseToken: 'old-token', result: { kind: 'test' } }),
        (error) => error instanceof TaskQueueError && error.code === 'LEASE_LOST',
    );
});

test('completion requires a result descriptor and writes it with the success transition', async () => {
    await assert.rejects(
        completeTask(scriptedPool([{ rowCount: 1, rows: [{}] }]), { taskId: 'task', leaseToken: 'token' }),
        /result must be an object/,
    );
    const pool = scriptedPool([{ rowCount: 1, rows: [{ id: 'task', status: TASK_STATUS.SUCCEEDED }] }]);
    await completeTask(pool, { taskId: 'task', leaseToken: 'token', result: { kind: 'mock-asset' } });
    assert.match(pool.calls[0].text, /result = \$\d+::jsonb/);
    assert.equal(pool.calls[0].values.at(-1), JSON.stringify({ kind: 'mock-asset' }));
});

for (const operation of [heartbeatTask, completeTask, failTask]) {
    test(`${operation.name} rejects expired or reclaimed leases consistently`, async () => {
        const pool = scriptedPool([{ rowCount: 0, rows: [] }]);
        await assert.rejects(
            operation(pool, {
                taskId: 'task',
                leaseToken: 'stale-token',
                errorMessage: 'late failure',
                result: { kind: 'test' },
            }),
            (error) => error instanceof TaskQueueError && error.code === 'LEASE_LOST',
        );
        assert.equal(pool.calls.length, 1);
        assert.match(pool.calls[0].text, /lease_expires_at > now\(\)/);
    });
}

test('terminal failures skip the remaining retry budget', async () => {
    const pool = scriptedPool([{ rowCount: 1, rows: [{ id: 'task', status: TASK_STATUS.FAILED }] }]);
    await failTask(pool, {
        taskId: 'task',
        leaseToken: 'token',
        errorMessage: 'INVALID_REQUEST',
        terminal: true,
    });
    assert.match(pool.calls[0].text, /CASE WHEN true THEN \$\d+ ELSE \$\d+ END/);
    assert.match(pool.calls[0].text, /COALESCE\(completed_at, now\(\)\)/);
});

test('expired tasks are requeued until max attempts, then become failed', async () => {
    const pool = scriptedPool([{ rowCount: 2, rows: [{ id: 'a' }, { id: 'b' }] }]);
    const count = await recoverExpiredTasks({
        query: async (text, values) => {
            assert.match(text, /attempts < max_attempts/);
            assert.match(text, /cancel_requested_at IS NOT NULL THEN \$\d+/);
            assert.deepEqual(values, [TASK_STATUS.QUEUED, TASK_STATUS.FAILED, TASK_STATUS.CANCELLED, TASK_STATUS.RUNNING]);
            return pool.calls.length ? pool.calls.shift() : { rowCount: 2, rows: [] };
        },
    });
    assert.equal(count, 2);
});

test('a cancelled task whose lease expired is not requeued for another attempt', async () => {
    const pool = scriptedPool([{ rowCount: 1, rows: [{ id: 'a', status: TASK_STATUS.CANCELLED }] }]);
    await recoverExpiredTasks(pool);
    const sql = pool.calls[0].text;
    // 取消优先于重试：即使还有剩余尝试次数，也必须终结为 cancelled。
    assert.match(sql, /WHEN cancel_requested_at IS NOT NULL THEN \$3\s+WHEN attempts < max_attempts THEN \$1/);
    assert.match(sql, /WHEN cancel_requested_at IS NOT NULL THEN COALESCE\(completed_at, now\(\)\)/);
});

test('cancellation checks are read-only and fail closed when the lease is gone', async () => {
    const pool = scriptedPool([{ rowCount: 1, rows: [{ requested: true }] }]);
    assert.equal(
        await isCancellationRequested(pool, { taskId: 'task', leaseToken: 'token' }),
        true,
    );
    assert.doesNotMatch(pool.calls[0].text, /UPDATE/);

    const stale = scriptedPool([{ rowCount: 0, rows: [] }]);
    await assert.rejects(
        isCancellationRequested(stale, { taskId: 'task', leaseToken: 'stale' }),
        (error) => error instanceof TaskQueueError && error.code === 'LEASE_LOST',
    );
});

test('cancelClaimedTask only writes cancelled for the current lease holder and leaves last_error alone', async () => {
    const pool = scriptedPool([{ rowCount: 1, rows: [{ id: 'task', status: TASK_STATUS.CANCELLED }] }]);
    const task = await cancelClaimedTask(pool, { taskId: 'task', leaseToken: 'token' });
    assert.equal(task.status, TASK_STATUS.CANCELLED);
    const sql = pool.calls[0].text;
    assert.match(sql, /status = \$\d+/);
    assert.match(sql, /lease_token = \$\d+::uuid AND lease_expires_at > now\(\)/);
    assert.doesNotMatch(sql, /last_error\s*=/);

    const stale = scriptedPool([{ rowCount: 0, rows: [] }]);
    await assert.rejects(
        cancelClaimedTask(stale, { taskId: 'task', leaseToken: 'stale' }),
        (error) => error instanceof TaskQueueError && error.code === 'LEASE_LOST',
    );
});
