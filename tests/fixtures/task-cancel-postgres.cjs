const assert = require('node:assert/strict');
const { createTaskCancellationService } = require('../../lib/server/tasks/taskCancellation');
const { createTaskQueryService } = require('../../lib/server/tasks/taskQuery');
const queue = require('../../lib/server/worker/taskQueue');

// 两个互不相关的 owner，用来验证取消与查询都严格按 owner 隔离。
const OWNER_A = '00000000-0000-4000-8000-0000000000c1';
const OWNER_B = '00000000-0000-4000-8000-0000000000c2';

async function createTask(pool, ownerId, marker, createdTasks) {
    const result = await pool.query(
        `INSERT INTO generation_tasks(owner_id,idempotency_key,request_fingerprint,task_type,payload)
         VALUES ($1::uuid,$2,$3,$4,$5::jsonb) RETURNING id`,
        [
            ownerId,
            `cancel:${marker}:${Date.now()}:${createdTasks.length}`,
            'd'.repeat(64),
            'task-cancel-fixture',
            JSON.stringify({ marker }),
        ],
    );
    createdTasks.push(result.rows[0].id);
    return result.rows[0].id;
}

async function checkTaskCancellation(pool, record, { workerPool, owner }) {
    const createdTasks = [];
    try {
        await runChecks(pool, record, createdTasks, workerPool);
    } finally {
        // 后续 Worker 验收要求 generation_tasks 从空表开始，失败时也必须清理。
        if (createdTasks.length > 0) {
            await owner.query('DELETE FROM provider_calls WHERE task_id = ANY($1::uuid[])', [createdTasks]);
            await owner.query('DELETE FROM generation_tasks WHERE id = ANY($1::uuid[])', [createdTasks]);
        }
    }
}

async function runChecks(pool, record, createdTasks, workerPool) {
    const cancel = createTaskCancellationService({ pool }).cancel;
    const query = createTaskQueryService({ pool });

    // 1. queued 任务：API 直接写 cancelled，并同时落下取消时间与完成时间。
    const queuedId = await createTask(pool, OWNER_A, 'queued', createdTasks);
    const immediate = await cancel({ ownerId: OWNER_A, taskId: queuedId });
    assert.equal(immediate.outcome, 'cancelled');
    assert.equal(immediate.task.status, 'cancelled');
    assert.ok(immediate.task.cancelRequestedAt);
    const queuedRow = (await pool.query(
        'SELECT status, cancel_requested_at, completed_at, lease_token FROM generation_tasks WHERE id=$1',
        [queuedId],
    )).rows[0];
    assert.equal(queuedRow.status, 'cancelled');
    assert.ok(queuedRow.cancel_requested_at);
    assert.ok(queuedRow.completed_at);
    assert.equal(queuedRow.lease_token, null);
    record('取消queued任务直接终结并记录取消时间/完成时间', 'passed');

    // 2. 重复取消幂等：不覆盖首次取消时间。
    const repeated = await cancel({ ownerId: OWNER_A, taskId: queuedId });
    assert.equal(repeated.outcome, 'already_cancelled');
    assert.equal(
        new Date(repeated.task.cancelRequestedAt).getTime(),
        new Date(immediate.task.cancelRequestedAt).getTime(),
    );
    record('重复取消返回当前任务且不覆盖取消时间', 'passed');

    // 3. 跨 owner 取消与查询统一 404/null，不泄露任务是否存在。
    const isolatedId = await createTask(pool, OWNER_A, 'isolated', createdTasks);
    await assert.rejects(
        cancel({ ownerId: OWNER_B, taskId: isolatedId }),
        (error) => error.code === 'TASK_NOT_FOUND' && error.status === 404,
    );
    assert.equal(await query.get({ ownerId: OWNER_B, taskId: isolatedId }), null);
    assert.equal((await query.get({ ownerId: OWNER_A, taskId: isolatedId })).id, isolatedId);
    // 列表也只含自己的任务，不把他人任务混进分页结果。
    const otherPage = await query.list({ ownerId: OWNER_B, limit: '50' });
    assert.equal(otherPage.tasks.some((task) => task.id === isolatedId), false);
    record('取消与查询严格按owner隔离', 'passed');
    await cancel({ ownerId: OWNER_A, taskId: isolatedId });

    // 4. running 任务：只登记意图，状态仍由持有租约的执行方推进。
    const runningId = await createTask(pool, OWNER_A, 'running', createdTasks);
    const claimed = await queue.claimNextTask(workerPool, {
        workerId: 'cancel-fixture-worker',
        leaseSeconds: 30,
        taskType: 'task-cancel-fixture',
    });
    assert.ok(claimed);
    assert.equal(claimed.id, runningId);
    const requested = await cancel({ ownerId: OWNER_A, taskId: claimed.id });
    assert.equal(requested.outcome, 'requested');
    assert.equal(requested.task.status, 'running');
    assert.ok(requested.task.cancelRequestedAt);
    const stillRunning = (await pool.query('SELECT status, cancel_requested_at FROM generation_tasks WHERE id=$1',
        [claimed.id])).rows[0];
    assert.equal(stillRunning.status, 'running');
    assert.ok(stillRunning.cancel_requested_at);
    assert.equal(await queue.isCancellationRequested(workerPool, {
        taskId: claimed.id,
        leaseToken: claimed.lease_token,
    }), true);
    record('running任务只登记取消意图且执行方可观察到', 'passed');

    // 5. 执行方在安全点写入 cancelled：只有当前租约持有者能写，旧租约被拒绝。
    const cancelled = await queue.cancelClaimedTask(workerPool, {
        taskId: claimed.id,
        leaseToken: claimed.lease_token,
    });
    assert.equal(cancelled.status, 'cancelled');
    assert.ok(cancelled.completed_at);
    await assert.rejects(
        queue.cancelClaimedTask(workerPool, { taskId: claimed.id, leaseToken: claimed.lease_token }),
        (error) => error instanceof queue.TaskQueueError && error.code === 'LEASE_LOST',
    );
    record('协作取消只允许当前租约持有者写入且不可重复', 'passed');

    // 6. 租约过期但已登记取消：恢复时必须终结为 cancelled，而不是回队列再执行一次。
    const expiredId = await createTask(pool, OWNER_A, 'expired-cancel', createdTasks);
    const expiredClaim = await queue.claimNextTask(workerPool, {
        workerId: 'cancel-fixture-worker',
        leaseSeconds: 30,
        taskType: 'task-cancel-fixture',
    });
    assert.ok(expiredClaim);
    assert.equal(expiredClaim.id, expiredId);
    await cancel({ ownerId: OWNER_A, taskId: expiredId });
    await workerPool.query("UPDATE generation_tasks SET lease_expires_at = now() - interval '1 second' WHERE id=$1",
        [expiredId]);
    await queue.recoverExpiredTasks(workerPool);
    const recovered = (await pool.query('SELECT status, attempts FROM generation_tasks WHERE id=$1',
        [expiredId])).rows[0];
    assert.equal(recovered.status, 'cancelled');
    assert.equal(recovered.attempts, 1);
    record('租约过期且已请求取消的任务恢复为cancelled而非重新排队', 'passed');

    // 7. 终态不可取消，也不能反过来给终态挂取消意图（CHECK 负例）。
    const succeededId = await createTask(pool, OWNER_A, 'succeeded', createdTasks);
    await workerPool.query(
        `UPDATE generation_tasks SET status='succeeded', result='{"kind":"probe","archive":"not_configured"}'::jsonb WHERE id=$1`,
        [succeededId],
    );
    await assert.rejects(
        cancel({ ownerId: OWNER_A, taskId: succeededId }),
        (error) => error.code === 'TASK_NOT_CANCELLABLE' && error.status === 409,
    );
    let constraintCode = null;
    try {
        await pool.query('UPDATE generation_tasks SET cancel_requested_at = now() WHERE id=$1', [succeededId]);
    } catch (error) {
        constraintCode = error.code;
    }
    assert.equal(constraintCode, '23514');
    record('终态任务拒绝取消且cancel_requested_at约束为负例', 'passed');
}

module.exports = { checkTaskCancellation };
