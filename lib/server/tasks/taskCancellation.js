'use strict';

const { TaskApiError } = require('./taskSubmission');
const { TASK_STATUS, isTerminalStatus } = require('../worker/taskStateMachine');
const { toPublicTask } = require('./taskView');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TASK_COLUMNS = `id, task_type, status, created_at, updated_at, completed_at,
                      cancel_requested_at, result, last_error`;

// 取消不是一次状态覆盖：
// - queued：尚未被领取，没有执行方需要通知，直接写 cancelled；
// - running：只登记 cancel_requested_at，由持有租约的 Worker 在安全点协作停止后写 cancelled。
//   Web 进程不直接改 running 任务的状态，避免"数据库显示已取消、供应商仍在跑并计费"。
// 取消是幂等的：重复请求返回当前任务，不再写入新的时间戳。
function createTaskCancellationService({ pool } = {}) {
    if (!pool || typeof pool.connect !== 'function') throw new TypeError('pool is required');

    async function cancel({ ownerId, taskId } = {}) {
        if (typeof ownerId !== 'string' || !UUID_PATTERN.test(ownerId)) {
            throw new TypeError('ownerId must be a UUID');
        }
        if (typeof taskId !== 'string' || !UUID_PATTERN.test(taskId)) {
            throw new TaskApiError('TASK_NOT_FOUND', 404);
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            // FOR UPDATE 让"取消 queued 任务"与"Worker 领取"串行化：
            // 任一方先拿到行锁，另一方看到的都是已经确定的最终状态。
            const selected = await client.query(
                `SELECT ${TASK_COLUMNS}
                 FROM generation_tasks
                 WHERE id = $1::uuid AND owner_id = $2::uuid
                 FOR UPDATE`,
                [taskId, ownerId],
            );
            if (selected.rowCount !== 1) throw new TaskApiError('TASK_NOT_FOUND', 404);
            const row = selected.rows[0];

            if (isTerminalStatus(row.status)) {
                if (row.status === TASK_STATUS.CANCELLED) {
                    await client.query('COMMIT');
                    return { task: toPublicTask(row), outcome: 'already_cancelled' };
                }
                throw new TaskApiError('TASK_NOT_CANCELLABLE', 409);
            }

            if (row.status === TASK_STATUS.QUEUED) {
                const updated = await client.query(
                    `UPDATE generation_tasks
                     SET status = $1,
                         cancel_requested_at = COALESCE(cancel_requested_at, now()),
                         completed_at = now(),
                         updated_at = now()
                     WHERE id = $2::uuid AND owner_id = $3::uuid AND status = $4
                     RETURNING ${TASK_COLUMNS}`,
                    [TASK_STATUS.CANCELLED, taskId, ownerId, TASK_STATUS.QUEUED],
                );
                if (updated.rowCount !== 1) throw new TaskApiError('TASK_NOT_CANCELLABLE', 409);
                await client.query('COMMIT');
                return { task: toPublicTask(updated.rows[0]), outcome: 'cancelled' };
            }

            const updated = await client.query(
                `UPDATE generation_tasks
                 SET cancel_requested_at = COALESCE(cancel_requested_at, now()),
                     updated_at = now()
                 WHERE id = $1::uuid AND owner_id = $2::uuid AND status = $3
                 RETURNING ${TASK_COLUMNS}`,
                [taskId, ownerId, TASK_STATUS.RUNNING],
            );
            if (updated.rowCount !== 1) throw new TaskApiError('TASK_NOT_CANCELLABLE', 409);
            await client.query('COMMIT');
            return { task: toPublicTask(updated.rows[0]), outcome: 'requested' };
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
        } finally {
            client.release();
        }
    }

    return Object.freeze({ cancel });
}

module.exports = { createTaskCancellationService };
