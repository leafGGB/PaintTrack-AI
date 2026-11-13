const { randomUUID } = require('node:crypto');

const CALL_STATUS = Object.freeze({
    SUBMITTING: 'submitting',
    UNKNOWN: 'unknown',
    ACCEPTED: 'accepted',
    SUCCEEDED: 'succeeded',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
});

const CLAIMABLE_STATUSES = [CALL_STATUS.SUBMITTING, CALL_STATUS.UNKNOWN, CALL_STATUS.ACCEPTED];
const TERMINAL_STATUSES = new Set([CALL_STATUS.SUCCEEDED, CALL_STATUS.FAILED, CALL_STATUS.CANCELLED]);
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

class ProviderCallLedgerError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'ProviderCallLedgerError';
        this.code = code;
    }
}

function assertPositiveInteger(value, name) {
    if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
}

function assertNonNegativeInteger(value, name) {
    if (!Number.isInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer`);
}

function assertString(value, name) {
    if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} is required`);
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

function assertWorkerLease(result) {
    if (result.rowCount !== 1) {
        throw new ProviderCallLedgerError('LEASE_LOST', 'Provider call lease is no longer valid');
    }
    return result.rows[0];
}

async function beginProviderCall(pool, {
    taskId, attemptNo, providerName, idempotencyKey, workerId, leaseSeconds = 60,
} = {}) {
    assertString(taskId, 'taskId');
    assertPositiveInteger(attemptNo, 'attemptNo');
    assertString(providerName, 'providerName');
    assertString(idempotencyKey, 'idempotencyKey');
    assertString(workerId, 'workerId');
    assertPositiveInteger(leaseSeconds, 'leaseSeconds');

    return withTransaction(pool, async (client) => {
        const leaseToken = randomUUID();
        const inserted = await client.query(
            `INSERT INTO provider_calls
                (task_id, attempt_no, provider_name, idempotency_key, status,
                 worker_id, lease_token, lease_expires_at)
             VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::uuid,
                     now() + ($8::text || ' seconds')::interval)
             ON CONFLICT (task_id, attempt_no) DO NOTHING
             RETURNING *`,
            [taskId, attemptNo, providerName.trim(), idempotencyKey, CALL_STATUS.SUBMITTING,
                workerId.trim(), leaseToken, leaseSeconds],
        );
        if (inserted.rowCount === 1) return inserted.rows[0];

        // 该尝试已存在时，本函数不再尝试接管：接管/恢复必须走 claimProviderCallForRecovery。
        // 原因：unknown / accepted 的租约字段为 NULL，任何 `lease_expires_at <= now()` 条件都匹配不到 NULL，
        // 混在同一个入口里只会得到"看起来能恢复、实际永远 LEASE_LOST"的假象。
        const existing = await client.query(
            `SELECT status, idempotency_key, provider_name FROM provider_calls
             WHERE task_id = $1::uuid AND attempt_no = $2`,
            [taskId, attemptNo],
        );
        const call = existing.rows[0];
        if (!call) {
            throw new ProviderCallLedgerError('ATTEMPT_CONFLICT', 'Provider call attempt could not be created');
        }
        if (call.idempotency_key !== idempotencyKey || call.provider_name !== providerName.trim()) {
            throw new ProviderCallLedgerError('ATTEMPT_IDENTITY_MISMATCH', 'Provider call attempt does not match its original identity');
        }
        throw new ProviderCallLedgerError(
            'ATTEMPT_EXISTS',
            'Provider call attempt already exists; use claimProviderCallForRecovery to take it over',
        );
    });
}

async function markProviderCallUnknown(pool, {
    callId, workerId, leaseToken, errorCode,
} = {}) {
    assertString(callId, 'callId');
    assertString(workerId, 'workerId');
    assertString(leaseToken, 'leaseToken');
    if (typeof errorCode !== 'string' || !ERROR_CODE_PATTERN.test(errorCode)) {
        throw new TypeError('errorCode must be a fixed uppercase code');
    }
    const result = await pool.query(
        `UPDATE provider_calls
         SET status = $1, last_error_code = $2,
             worker_id = NULL, lease_token = NULL, lease_expires_at = NULL,
             available_at = now(), updated_at = now()
         WHERE id = $3::uuid AND status = $4 AND worker_id = $5 AND lease_token = $6::uuid
           AND lease_expires_at > now()
         RETURNING *`,
        [CALL_STATUS.UNKNOWN, errorCode, callId, CALL_STATUS.SUBMITTING, workerId, leaseToken],
    );
    return assertWorkerLease(result);
}

async function markProviderCallAccepted(pool, {
    callId, workerId, leaseToken, providerJobId,
} = {}) {
    assertString(callId, 'callId');
    assertString(workerId, 'workerId');
    assertString(leaseToken, 'leaseToken');
    assertString(providerJobId, 'providerJobId');
    const result = await pool.query(
        `UPDATE provider_calls
         SET status = $1, provider_job_id = $2, last_error_code = NULL,
             worker_id = NULL, lease_token = NULL, lease_expires_at = NULL,
             updated_at = now()
         WHERE id = $3::uuid AND status IN ($4, $5) AND worker_id = $6 AND lease_token = $7::uuid
           AND lease_expires_at > now()
         RETURNING *`,
        [CALL_STATUS.ACCEPTED, providerJobId, callId, CALL_STATUS.SUBMITTING, CALL_STATUS.UNKNOWN, workerId, leaseToken],
    );
    return assertWorkerLease(result);
}

// Worker 在执行器内轮询时，必须继续持有调用租约：否则另一个 Worker 的恢复领取会把同一次提交
// 当成"无人负责"再接管一次，造成重复轮询。与 markProviderCallAccepted 的区别是保留租约。
async function acceptProviderCallHolding(pool, {
    callId, workerId, leaseToken, providerJobId, leaseSeconds = 60,
} = {}) {
    assertString(callId, 'callId');
    assertString(workerId, 'workerId');
    assertString(leaseToken, 'leaseToken');
    assertString(providerJobId, 'providerJobId');
    assertPositiveInteger(leaseSeconds, 'leaseSeconds');
    const result = await pool.query(
        `UPDATE provider_calls
         SET status = $1, provider_job_id = $2, last_error_code = NULL,
             lease_expires_at = now() + ($8::text || ' seconds')::interval,
             updated_at = now()
         WHERE id = $3::uuid AND status IN ($4, $5) AND worker_id = $6 AND lease_token = $7::uuid
           AND lease_expires_at > now()
         RETURNING *`,
        [CALL_STATUS.ACCEPTED, providerJobId, callId, CALL_STATUS.SUBMITTING, CALL_STATUS.UNKNOWN,
            workerId, leaseToken, leaseSeconds],
    );
    return assertWorkerLease(result);
}

async function heartbeatProviderCall(pool, { callId, workerId, leaseToken, leaseSeconds = 60 } = {}) {
    assertString(callId, 'callId');
    assertString(workerId, 'workerId');
    assertString(leaseToken, 'leaseToken');
    assertPositiveInteger(leaseSeconds, 'leaseSeconds');
    const result = await pool.query(
        `UPDATE provider_calls
         SET lease_expires_at = now() + ($1::text || ' seconds')::interval,
             updated_at = now()
         WHERE id = $2::uuid AND status = ANY($3::text[]) AND worker_id = $4 AND lease_token = $5::uuid
           AND lease_expires_at > now()
         RETURNING *`,
        [leaseSeconds, callId, CLAIMABLE_STATUSES, workerId, leaseToken],
    );
    return assertWorkerLease(result);
}

async function claimProviderCallForRecovery(pool, {
    workerId, leaseSeconds = 60, taskId,
} = {}) {
    assertString(workerId, 'workerId');
    assertPositiveInteger(leaseSeconds, 'leaseSeconds');
    if (taskId !== undefined) assertString(taskId, 'taskId');

    return withTransaction(pool, async (client) => {
        // 可取回的状态：submitting（进程在提交途中崩溃）、unknown（结果不明）、accepted（已受理但未完成轮询）。
        // 租约必须为 NULL 或已过期；available_at 必须已到期（退避窗口内不领取）；
        // accepted 必须已有 provider_job_id，否则不是可恢复的调用。
        const selected = await client.query(
            `SELECT * FROM provider_calls
             WHERE status = ANY($1::text[])
               AND (lease_expires_at IS NULL OR lease_expires_at <= now())
               AND available_at <= now()
               AND (status <> $3 OR provider_job_id IS NOT NULL)
               AND ($2::uuid IS NULL OR task_id = $2::uuid)
             ORDER BY available_at ASC, updated_at ASC
             FOR UPDATE SKIP LOCKED LIMIT 1`,
            [CLAIMABLE_STATUSES, taskId || null, CALL_STATUS.ACCEPTED],
        );
        if (selected.rowCount === 0) return null;
        const call = selected.rows[0];
        const leaseToken = randomUUID();
        const updated = await client.query(
            `UPDATE provider_calls
             SET worker_id = $1, lease_token = $2::uuid,
                 lease_expires_at = now() + ($3::text || ' seconds')::interval,
                 recovery_attempts = recovery_attempts + 1, updated_at = now()
             WHERE id = $4::uuid AND status = $5
               AND (lease_expires_at IS NULL OR lease_expires_at <= now())
               AND available_at <= now()
             RETURNING *`,
            [workerId.trim(), leaseToken, leaseSeconds, call.id, call.status],
        );
        if (updated.rowCount !== 1) {
            throw new ProviderCallLedgerError('CLAIM_CONFLICT', 'Provider call could not be claimed for recovery');
        }
        return updated.rows[0];
    });
}

async function releaseProviderCallForRecovery(pool, {
    callId, workerId, leaseToken, errorCode, retryDelaySeconds = 0,
} = {}) {
    assertString(callId, 'callId');
    assertString(workerId, 'workerId');
    assertString(leaseToken, 'leaseToken');
    if (typeof errorCode !== 'string' || !ERROR_CODE_PATTERN.test(errorCode)) {
        throw new TypeError('errorCode must be a fixed uppercase code');
    }
    assertNonNegativeInteger(retryDelaySeconds, 'retryDelaySeconds');
    const result = await pool.query(
        `UPDATE provider_calls
         SET worker_id = NULL, lease_token = NULL, lease_expires_at = NULL,
             available_at = now() + ($1::text || ' seconds')::interval,
             last_error_code = $2, updated_at = now()
         WHERE id = $3::uuid AND status = $4 AND worker_id = $5 AND lease_token = $6::uuid
           AND lease_expires_at > now()
         RETURNING *`,
        [retryDelaySeconds, errorCode, callId, CALL_STATUS.UNKNOWN, workerId, leaseToken],
    );
    return assertWorkerLease(result);
}

// 同步供应商在提交返回时就已完成，此时调用记录仍处于 submitting；因此成功转换允许 submitting 与 accepted。
async function markProviderCallSucceeded(pool, {
    callId, workerId, leaseToken,
} = {}) {
    assertString(callId, 'callId');
    assertString(workerId, 'workerId');
    assertString(leaseToken, 'leaseToken');
    const result = await pool.query(
        `UPDATE provider_calls
         SET status = $1, last_error_code = NULL,
             worker_id = NULL, lease_token = NULL, lease_expires_at = NULL,
             updated_at = now()
         WHERE id = $2::uuid AND status IN ($3, $4) AND worker_id = $5 AND lease_token = $6::uuid
           AND lease_expires_at > now() AND provider_job_id IS NOT NULL
         RETURNING *`,
        [CALL_STATUS.SUCCEEDED, callId, CALL_STATUS.ACCEPTED, CALL_STATUS.SUBMITTING, workerId, leaseToken],
    );
    return assertWorkerLease(result);
}

async function markProviderCallTerminal(pool, {
    callId, workerId, leaseToken, status, errorCode = null,
} = {}) {
    assertString(callId, 'callId');
    assertString(workerId, 'workerId');
    assertString(leaseToken, 'leaseToken');
    if (!TERMINAL_STATUSES.has(status)) throw new TypeError('status must be a terminal provider call status');
    if (errorCode !== null && (typeof errorCode !== 'string' || !ERROR_CODE_PATTERN.test(errorCode))) {
        throw new TypeError('errorCode must be a fixed uppercase code or null');
    }
    const result = await pool.query(
        `UPDATE provider_calls
         SET status = $1, last_error_code = $2,
             worker_id = NULL, lease_token = NULL, lease_expires_at = NULL,
             updated_at = now()
         WHERE id = $3::uuid AND status = ANY($4::text[]) AND worker_id = $5 AND lease_token = $6::uuid
           AND lease_expires_at > now()
         RETURNING *`,
        [status, errorCode, callId, CLAIMABLE_STATUSES, workerId, leaseToken],
    );
    return assertWorkerLease(result);
}

// 保留状态、释放租约并推迟下次可领取时间：用于轮询超时、可重试的查询失败，
// 以及"未知提交"需要退避后重新提交的场景。状态本身不推进，避免丢掉 provider_job_id。
async function deferProviderCall(pool, {
    callId, workerId, leaseToken, errorCode, retryDelaySeconds = 0,
} = {}) {
    assertString(callId, 'callId');
    assertString(workerId, 'workerId');
    assertString(leaseToken, 'leaseToken');
    if (typeof errorCode !== 'string' || !ERROR_CODE_PATTERN.test(errorCode)) {
        throw new TypeError('errorCode must be a fixed uppercase code');
    }
    assertNonNegativeInteger(retryDelaySeconds, 'retryDelaySeconds');
    const result = await pool.query(
        `UPDATE provider_calls
         SET worker_id = NULL, lease_token = NULL, lease_expires_at = NULL,
             available_at = now() + ($1::text || ' seconds')::interval,
             last_error_code = $2, updated_at = now()
         WHERE id = $3::uuid AND status = ANY($4::text[]) AND worker_id = $5 AND lease_token = $6::uuid
           AND lease_expires_at > now()
         RETURNING *`,
        [retryDelaySeconds, errorCode, callId, CLAIMABLE_STATUSES, workerId, leaseToken],
    );
    return assertWorkerLease(result);
}

// 恢复前的前置检查：该任务是否还有未终结的调用。
// 调用租约仍被别人持有时，恢复领取会拿不到该行；此时若直接新建一次提交就会造成重复调用，
// 因此执行器会退避重试而不是另起一轮。
async function findActiveProviderCall(pool, { taskId } = {}) {
    assertString(taskId, 'taskId');
    const result = await pool.query(
        `SELECT id, status, attempt_no, provider_job_id, worker_id, lease_expires_at, available_at
         FROM provider_calls
         WHERE task_id = $1::uuid AND status = ANY($2::text[])
         ORDER BY attempt_no DESC
         LIMIT 1`,
        [taskId, CLAIMABLE_STATUSES],
    );
    return result.rows[0] || null;
}

module.exports = {
    CALL_STATUS,
    ProviderCallLedgerError,
    acceptProviderCallHolding,
    beginProviderCall,
    claimProviderCallForRecovery,
    deferProviderCall,
    findActiveProviderCall,
    heartbeatProviderCall,
    markProviderCallAccepted,
    markProviderCallSucceeded,
    markProviderCallTerminal,
    markProviderCallUnknown,
    releaseProviderCallForRecovery,
};
