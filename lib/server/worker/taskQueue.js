const { randomUUID } = require('node:crypto');
const { TASK_STATUS } = require('./taskStateMachine');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

class TaskQueueError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'TaskQueueError';
        this.code = code;
    }
}

function assertPositiveInteger(value, name) {
    if (!Number.isInteger(value) || value <= 0) {
        throw new TypeError(`${name} must be a positive integer`);
    }
}

function assertNonNegativeInteger(value, name) {
    if (!Number.isInteger(value) || value < 0) {
        throw new TypeError(`${name} must be a non-negative integer`);
    }
}

function normalizeTaskRow(row) {
    return row ? { ...row } : null;
}

async function withTransaction(pool, callback) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

// 创建任务是唯一会生成新任务的入口，因此归属、幂等键和请求指纹在这里强制校验。
// 幂等键在 owner 范围内唯一：同一 owner 用同一键并发提交时，只有一个 INSERT 生效，
// 另一个会在同一事务里读回原任务，由调用方比较指纹后决定"重放"还是"同键不同请求"。
async function createTask(pool, {
    ownerId, idempotencyKey, requestFingerprint, taskType, payload,
    routeResolver, maxAttempts = 3, availableAt = new Date(),
}) {
    if (!pool || typeof pool.connect !== 'function') {
        throw new TypeError('pool is required');
    }
    if (typeof ownerId !== 'string' || !UUID_PATTERN.test(ownerId)) {
        throw new TypeError('ownerId must be a UUID');
    }
    if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
        throw new TypeError('idempotencyKey must be 8-128 URL-safe characters');
    }
    if (typeof requestFingerprint !== 'string' || !FINGERPRINT_PATTERN.test(requestFingerprint)) {
        throw new TypeError('requestFingerprint must be a lowercase sha256 hex digest');
    }
    if (typeof taskType !== 'string' || taskType.trim() === '') {
        throw new TypeError('taskType is required');
    }
    assertPositiveInteger(maxAttempts, 'maxAttempts');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new TypeError('payload must be an object');
    }

    if (routeResolver !== undefined && (!routeResolver || typeof routeResolver.resolve !== 'function')) {
        throw new TypeError('routeResolver must provide resolve when supplied');
    }

    return withTransaction(pool, async (client) => {
        if (routeResolver) {
            const existing = await client.query(
                `SELECT * FROM generation_tasks WHERE owner_id = $1::uuid AND idempotency_key = $2 FOR SHARE`,
                [ownerId, idempotencyKey],
            );
            if (existing.rowCount === 1) return { task: normalizeTaskRow(existing.rows[0]), inserted: false };
        }
        const route = routeResolver ? await routeResolver.resolve({ taskType: taskType.trim(), payload }) : null;
        const inserted = routeResolver
            ? await client.query(
                `INSERT INTO generation_tasks
                    (owner_id, idempotency_key, request_fingerprint, task_type, payload, max_attempts, available_at, updated_at,
                     logical_model_pk, route_snapshot, route_snapshot_version, route_snapshot_hash)
                 VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6, $7, now(), $8::uuid, $9::jsonb, $10, $11)
                 ON CONFLICT (owner_id, idempotency_key) DO NOTHING
                 RETURNING *`,
                [ownerId, idempotencyKey, requestFingerprint, taskType.trim(), JSON.stringify(payload), maxAttempts, availableAt,
                    route.logicalModelPk, JSON.stringify(route.routeSnapshot), route.routeSnapshotVersion, route.routeSnapshotHash],
            )
            : await client.query(
                `INSERT INTO generation_tasks
                    (owner_id, idempotency_key, request_fingerprint, task_type, payload, max_attempts, available_at, updated_at)
                 VALUES ($1::uuid, $2, $3, $4, $5::jsonb, $6, $7, now())
                 ON CONFLICT (owner_id, idempotency_key) DO NOTHING
                 RETURNING *`,
                [ownerId, idempotencyKey, requestFingerprint, taskType.trim(), JSON.stringify(payload), maxAttempts, availableAt],
            );
        if (inserted.rowCount === 1) {
            return { task: normalizeTaskRow(inserted.rows[0]), inserted: true };
        }

        const existing = await client.query(
            `SELECT * FROM generation_tasks WHERE owner_id = $1::uuid AND idempotency_key = $2`,
            [ownerId, idempotencyKey],
        );
        if (existing.rowCount !== 1) {
            // 唯一冲突后原行又不可见，说明并发删除或权限异常；不能把它当成成功重放。
            throw new TaskQueueError('CREATE_CONFLICT', 'Idempotent task could not be read back');
        }
        return { task: normalizeTaskRow(existing.rows[0]), inserted: false };
    });
}

// 参数编号只由本模块固定传入；任务内容与批准范围始终作为参数传递。
function approvedRoutePredicate(parameter) {
    return `EXISTS (SELECT 1 FROM jsonb_to_recordset($${parameter}::jsonb)
        AS approved(model_pk uuid, snapshot_version integer, snapshot_hash text, snapshot jsonb, owner_id uuid)
        WHERE generation_tasks.task_type = 'image.generate'
          AND (approved.owner_id IS NULL OR generation_tasks.owner_id = approved.owner_id)
          AND generation_tasks.logical_model_pk = approved.model_pk
          AND generation_tasks.route_snapshot_version = approved.snapshot_version
          AND generation_tasks.route_snapshot_hash = approved.snapshot_hash
          AND generation_tasks.route_snapshot = approved.snapshot
          AND generation_tasks.payload->>'logicalModelId' = approved.snapshot->>'logicalModelId'
          AND generation_tasks.payload->'outputCount' = '1'::jsonb)`;
}

const MOCK_SCOPE = "(route_snapshot IS NULL OR route_snapshot->>'adapterType' = 'mock')";

function routeScope(approvedRoutesJson, mockOnly, parameter) {
    if (approvedRoutesJson !== undefined) return `AND ${approvedRoutePredicate(parameter)}`;
    return mockOnly ? `AND ${MOCK_SCOPE}` : '';
}

async function recoverExpiredTasks(client, approvedRoutesJson, mockOnly = false) {
    const result = await client.query(
        `UPDATE generation_tasks
         SET status = CASE
                 WHEN cancel_requested_at IS NOT NULL THEN $3
                 WHEN attempts < max_attempts THEN $1
                 ELSE $2
             END,
             available_at = CASE
                 WHEN cancel_requested_at IS NULL AND attempts < max_attempts THEN now()
                 ELSE available_at
             END,
             lease_token = NULL,
             lease_expires_at = NULL,
             worker_id = NULL,
             last_error = CASE
                 WHEN cancel_requested_at IS NULL AND attempts >= max_attempts
                     THEN COALESCE(last_error, 'Task lease expired after maximum attempts')
                 ELSE last_error
             END,
             updated_at = now(),
             completed_at = CASE
                 WHEN cancel_requested_at IS NOT NULL THEN COALESCE(completed_at, now())
                 WHEN attempts < max_attempts THEN completed_at
                 ELSE COALESCE(completed_at, now())
             END
         WHERE status = $4 AND lease_expires_at <= now()
           ${routeScope(approvedRoutesJson, mockOnly, 5)}
         RETURNING id, status`,
        [TASK_STATUS.QUEUED, TASK_STATUS.FAILED, TASK_STATUS.CANCELLED, TASK_STATUS.RUNNING,
            ...(approvedRoutesJson === undefined ? [] : [approvedRoutesJson])],
    );
    return result.rowCount;
}

async function claimNextTask(pool, { workerId, leaseSeconds = 60, taskType, taskId, approvedRoutes, mockOnly = false } = {}) {
    if (!pool || typeof pool.connect !== 'function') {
        throw new TypeError('pool is required');
    }
    if (typeof workerId !== 'string' || workerId.trim() === '') {
        throw new TypeError('workerId is required');
    }
    assertPositiveInteger(leaseSeconds, 'leaseSeconds');
    if (taskType !== undefined && (typeof taskType !== 'string' || taskType.trim() === '')) {
        throw new TypeError('taskType must be a non-empty string when provided');
    }
    if (taskId !== undefined && (typeof taskId !== 'string' || !UUID_PATTERN.test(taskId))) {
        throw new TypeError('taskId must be a UUID when provided');
    }

    if (typeof mockOnly !== 'boolean' || (approvedRoutes !== undefined && (mockOnly || !Array.isArray(approvedRoutes)
        || approvedRoutes.length < 1 || approvedRoutes.length > 16 || approvedRoutes.some(route => !route
            || !UUID_PATTERN.test(route.model_pk) || !Number.isInteger(route.snapshot_version) || route.snapshot_version < 1
            || !FINGERPRINT_PATTERN.test(route.snapshot_hash) || !route.snapshot || typeof route.snapshot !== 'object'
            || (route.owner_id !== undefined && (typeof route.owner_id !== 'string' || !UUID_PATTERN.test(route.owner_id))))))) {
        throw new TypeError('Invalid queue route scope');
    }
    const approvedRoutesJson = approvedRoutes === undefined ? undefined : JSON.stringify(approvedRoutes);
    return withTransaction(pool, async (client) => {
        await recoverExpiredTasks(client, approvedRoutesJson, mockOnly);
        const selected = await client.query(
            `SELECT *
             FROM generation_tasks
             WHERE status = $1 AND available_at <= now()
               AND ($2::text IS NULL OR task_type = $2)
               AND ($3::uuid IS NULL OR id = $3::uuid)
               ${routeScope(approvedRoutesJson, mockOnly, 4)}
             ORDER BY available_at ASC, created_at ASC
             FOR UPDATE SKIP LOCKED
             LIMIT 1`,
            [TASK_STATUS.QUEUED, taskType ? taskType.trim() : null, taskId || null,
                ...(approvedRoutesJson === undefined ? [] : [approvedRoutesJson])],
        );
        if (selected.rowCount === 0) {
            return null;
        }

        const task = selected.rows[0];
        const leaseToken = randomUUID();
        const updated = await client.query(
            `UPDATE generation_tasks
             SET status = $1,
                 attempts = attempts + 1,
                 lease_token = $2::uuid,
                 lease_expires_at = now() + ($3::text || ' seconds')::interval,
                 worker_id = $4,
                 updated_at = now()
             WHERE id = $5 AND status = $6
             RETURNING *`,
            [TASK_STATUS.RUNNING, leaseToken, leaseSeconds, workerId.trim(), task.id, TASK_STATUS.QUEUED],
        );
        if (updated.rowCount !== 1) {
            throw new TaskQueueError('CLAIM_CONFLICT', 'Task could not be claimed');
        }
        return normalizeTaskRow(updated.rows[0]);
    });
}

async function heartbeatTask(pool, { taskId, leaseToken, leaseSeconds = 60 }) {
    assertPositiveInteger(leaseSeconds, 'leaseSeconds');
    const result = await pool.query(
        `UPDATE generation_tasks
         SET lease_expires_at = now() + ($1::text || ' seconds')::interval,
             updated_at = now()
         WHERE id = $2 AND status = $3 AND lease_token = $4::uuid AND lease_expires_at > now()
         RETURNING *`,
        [leaseSeconds, taskId, TASK_STATUS.RUNNING, leaseToken],
    );
    if (result.rowCount !== 1) {
        throw new TaskQueueError('LEASE_LOST', 'Task lease is no longer valid');
    }
    return normalizeTaskRow(result.rows[0]);
}

// 成功必须同时写入结果描述符：succeeded 却没有结果会让用户看到一个"成功但什么都没有"的任务。
// result 只保存可审计的结构化摘要（媒体类型、大小、来源、归档状态），不保存生成内容本身。
function assertTaskResult(result) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
        throw new TypeError('result must be an object');
    }
    return result;
}

async function completeTask(pool, { taskId, leaseToken, result }) {
    const taskResult = assertTaskResult(result);
    const updated = await pool.query(
        `UPDATE generation_tasks
         SET status = $1,
             result = $5::jsonb,
             lease_token = NULL,
             lease_expires_at = NULL,
             worker_id = NULL,
             completed_at = now(),
             updated_at = now()
         WHERE id = $2 AND status = $3 AND lease_token = $4::uuid AND lease_expires_at > now()
         RETURNING *`,
        [TASK_STATUS.SUCCEEDED, taskId, TASK_STATUS.RUNNING, leaseToken, JSON.stringify(taskResult)],
    );
    if (updated.rowCount !== 1) {
        throw new TaskQueueError('LEASE_LOST', 'Task lease is no longer valid');
    }
    return normalizeTaskRow(updated.rows[0]);
}

// terminal=true 表示"这类错误重试也没用"（例如供应商拒绝请求），立即进入 failed，不再浪费重试预算。
// 默认为 false，保持原有"attempts < max_attempts 就回队列"的语义。
async function failTask(pool, {
    taskId, leaseToken, errorMessage, retryDelaySeconds = 0, terminal = false,
}) {
    assertNonNegativeInteger(retryDelaySeconds, 'retryDelaySeconds');
    if (typeof terminal !== 'boolean') {
        throw new TypeError('terminal must be a boolean');
    }
    const safeMessage = typeof errorMessage === 'string' && errorMessage.trim()
        ? errorMessage.trim().slice(0, 1000)
        : 'Task failed';
    const giveUp = terminal ? 'true' : 'attempts >= max_attempts';
    const updated = await pool.query(
        `UPDATE generation_tasks
         SET status = CASE WHEN ${giveUp} THEN $2 ELSE $1 END,
             available_at = CASE
                 WHEN ${giveUp} THEN available_at
                 ELSE now() + ($3::text || ' seconds')::interval
             END,
             lease_token = NULL,
             lease_expires_at = NULL,
             worker_id = NULL,
             last_error = $4,
             completed_at = CASE WHEN ${giveUp} THEN COALESCE(completed_at, now()) ELSE completed_at END,
             updated_at = now()
         WHERE id = $5 AND status = $6 AND lease_token = $7::uuid AND lease_expires_at > now()
         RETURNING *`,
        [TASK_STATUS.QUEUED, TASK_STATUS.FAILED, retryDelaySeconds, safeMessage, taskId, TASK_STATUS.RUNNING, leaseToken],
    );
    if (updated.rowCount !== 1) {
        throw new TaskQueueError('LEASE_LOST', 'Task lease is no longer valid');
    }
    return normalizeTaskRow(updated.rows[0]);
}

// 取消意图由 API 写入 cancel_requested_at；这里只读取、不改状态。
// 真正的 cancelled 统一由 cancelClaimedTask 写入，避免"检查取消"顺带产生状态变更，
// 让两条路径互相覆盖。读取时同时校验租约：租约已被回收说明本次执行不再有写入权，
// 必须按 LEASE_LOST 退出，而不是继续对别人的任务做取消判断。
async function isCancellationRequested(pool, { taskId, leaseToken }) {
    const result = await pool.query(
        `SELECT cancel_requested_at IS NOT NULL AS requested
         FROM generation_tasks
         WHERE id = $1::uuid AND status = $2 AND lease_token = $3::uuid AND lease_expires_at > now()`,
        [taskId, TASK_STATUS.RUNNING, leaseToken],
    );
    if (result.rowCount !== 1) {
        throw new TaskQueueError('LEASE_LOST', 'Task lease is no longer valid');
    }
    return result.rows[0].requested === true;
}

// 协作取消的落库点：只有持有有效租约的执行方能把 running 写成 cancelled。
// 不写 last_error：取消是用户意图，不是失败；原因看 cancel_requested_at 与调用记录。
async function cancelClaimedTask(pool, { taskId, leaseToken }) {
    const updated = await pool.query(
        `UPDATE generation_tasks
         SET status = $1,
             lease_token = NULL,
             lease_expires_at = NULL,
             worker_id = NULL,
             completed_at = COALESCE(completed_at, now()),
             updated_at = now()
         WHERE id = $2 AND status = $3 AND lease_token = $4::uuid AND lease_expires_at > now()
         RETURNING *`,
        [TASK_STATUS.CANCELLED, taskId, TASK_STATUS.RUNNING, leaseToken],
    );
    if (updated.rowCount !== 1) {
        throw new TaskQueueError('LEASE_LOST', 'Task lease is no longer valid');
    }
    return normalizeTaskRow(updated.rows[0]);
}

// 成功结算前在事务内锁定任务行：既确认租约仍有效，也把"取消请求"与"写入成功"串行化。
// 若取消事务先提交，这里能看到 cancel_requested；若这里先提交，取消 API 随后会看到 succeeded 并拒绝取消。
// 没有行锁时两者之间存在一个可被忽略的时间窗，会把用户已取消的任务写成成功。
async function lockClaimedTask(client, { taskId, leaseToken }) {
    const result = await client.query(
        `SELECT id, status, cancel_requested_at IS NOT NULL AS cancel_requested
         FROM generation_tasks
         WHERE id = $1::uuid AND status = $2 AND lease_token = $3::uuid AND lease_expires_at > now()
         FOR UPDATE`,
        [taskId, TASK_STATUS.RUNNING, leaseToken],
    );
    if (result.rowCount !== 1) {
        throw new TaskQueueError('LEASE_LOST', 'Task lease is no longer valid');
    }
    return result.rows[0];
}

module.exports = {
    TASK_STATUS,
    TaskQueueError,
    cancelClaimedTask,
    claimNextTask,
    completeTask,
    createTask,
    failTask,
    heartbeatTask,
    isCancellationRequested,
    lockClaimedTask,
    recoverExpiredTasks,
};
