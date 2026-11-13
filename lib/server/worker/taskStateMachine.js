const TASK_STATUS = Object.freeze({
    QUEUED: 'queued',
    RUNNING: 'running',
    SUCCEEDED: 'succeeded',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
});

const ALL_TASK_STATUSES = Object.freeze(Object.values(TASK_STATUS));

// 终态一旦写入不可再变。重复写入同一终态按幂等成功处理（noop）；
// 写入另一个终态属于迟到结果或冲突，必须明确拒绝（conflict），不能静默覆盖。
const TERMINAL_STATUSES = Object.freeze([
    TASK_STATUS.SUCCEEDED,
    TASK_STATUS.FAILED,
    TASK_STATUS.CANCELLED,
]);

const TERMINAL_STATUS_SET = new Set(TERMINAL_STATUSES);

// 合法转换表只允许描述"业务上可能发生"的边：
// queued -> running    Worker 领取并持有租约
// queued -> cancelled  未领取前用户取消
// running -> queued    可重试失败或租约过期，回到队列等待下一次领取
// running -> succeeded Worker 完成且结果已通过边界校验
// running -> failed    失败不可重试或达到最大尝试次数
// running -> cancelled Worker 协作取消成功，或用户取消已由执行方确认
// 终态没有任何出边。
const ALLOWED_TRANSITIONS = Object.freeze({
    [TASK_STATUS.QUEUED]: Object.freeze([TASK_STATUS.RUNNING, TASK_STATUS.CANCELLED]),
    [TASK_STATUS.RUNNING]: Object.freeze([
        TASK_STATUS.QUEUED,
        TASK_STATUS.SUCCEEDED,
        TASK_STATUS.FAILED,
        TASK_STATUS.CANCELLED,
    ]),
    [TASK_STATUS.SUCCEEDED]: Object.freeze([]),
    [TASK_STATUS.FAILED]: Object.freeze([]),
    [TASK_STATUS.CANCELLED]: Object.freeze([]),
});

const TRANSITION_ACTION = Object.freeze({
    APPLY: 'apply',
    NOOP: 'noop',
    CONFLICT: 'conflict',
});

class TaskStateError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'TaskStateError';
        this.code = code;
    }
}

function assertKnownStatus(status, name) {
    if (typeof status !== 'string' || !Object.prototype.hasOwnProperty.call(ALLOWED_TRANSITIONS, status)) {
        throw new TaskStateError('UNKNOWN_STATUS', `${name} must be a known task status`);
    }
}

function isTaskStatus(value) {
    return typeof value === 'string' && ALL_TASK_STATUSES.includes(value);
}

function isTerminalStatus(status) {
    return TERMINAL_STATUS_SET.has(status);
}

function canTransition(from, to) {
    assertKnownStatus(from, 'from');
    assertKnownStatus(to, 'to');
    return ALLOWED_TRANSITIONS[from].includes(to);
}

function assertTransition(from, to) {
    assertKnownStatus(from, 'from');
    assertKnownStatus(to, 'to');
    if (!ALLOWED_TRANSITIONS[from].includes(to)) {
        throw new TaskStateError(
            'ILLEGAL_TRANSITION',
            `Task status cannot transition from ${from} to ${to}`,
        );
    }
    return true;
}

// 供 API/Worker 在写库前判断"这次写入到底应该执行什么"：
// - apply：合法转换，照常执行带条件的 UPDATE
// - noop：重复写入同一终态，按幂等成功返回，不重复产生副作用
// - conflict：终态不可覆盖（例如取消后供应商结果迟到），必须拒绝并保留原终态
// - 其它非法组合直接抛 ILLEGAL_TRANSITION，由调用方转成 4xx 或失败路径
function resolveTransition(from, to) {
    assertKnownStatus(from, 'from');
    assertKnownStatus(to, 'to');
    if (from === to) {
        return isTerminalStatus(from)
            ? Object.freeze({ action: TRANSITION_ACTION.NOOP, from, to })
            : Object.freeze({ action: TRANSITION_ACTION.APPLY, from, to });
    }
    if (isTerminalStatus(from)) {
        return Object.freeze({ action: TRANSITION_ACTION.CONFLICT, from, to });
    }
    assertTransition(from, to);
    return Object.freeze({ action: TRANSITION_ACTION.APPLY, from, to });
}

function assertAttemptCounters(attempts, maxAttempts) {
    if (!Number.isInteger(attempts) || attempts < 0) {
        throw new TypeError('attempts must be a non-negative integer');
    }
    if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
        throw new TypeError('maxAttempts must be a positive integer');
    }
    if (attempts > maxAttempts) {
        throw new RangeError('attempts cannot exceed maxAttempts');
    }
}

// 失败后的下一状态与现有 taskQueue.failTask 的 SQL 语义一致：
// attempts 已在领取时自增，因此 attempts < maxAttempts 表示还有下一次机会。
function nextStatusAfterFailure({ attempts, maxAttempts } = {}) {
    assertAttemptCounters(attempts, maxAttempts);
    return attempts < maxAttempts ? TASK_STATUS.QUEUED : TASK_STATUS.FAILED;
}

// 租约过期只对 running 有意义；queued 的 lease_expires_at 必须为 NULL。
function isLeaseExpired({ status, leaseExpiresAt, now = new Date() } = {}) {
    assertKnownStatus(status, 'status');
    if (status !== TASK_STATUS.RUNNING) return false;
    if (leaseExpiresAt === null || leaseExpiresAt === undefined) {
        throw new TaskStateError('LEASE_INCONSISTENT', 'A running task must have a lease expiry');
    }
    const expiry = leaseExpiresAt instanceof Date ? leaseExpiresAt : new Date(leaseExpiresAt);
    if (Number.isNaN(expiry.getTime())) {
        throw new TypeError('leaseExpiresAt must be a valid date');
    }
    const reference = now instanceof Date ? now : new Date(now);
    if (Number.isNaN(reference.getTime())) {
        throw new TypeError('now must be a valid date');
    }
    return expiry.getTime() <= reference.getTime();
}

// 取消路径不是单一转换：queued 可直接取消；running 必须由持有租约的执行方
// 协作停止后才能写 cancelled，否则会把仍在运行的供应商任务伪造成已取消。
const CANCEL_PATH = Object.freeze({
    IMMEDIATE: 'immediate',
    COOPERATIVE: 'cooperative',
});

function cancelPathFor(status) {
    assertKnownStatus(status, 'status');
    if (status === TASK_STATUS.QUEUED) return CANCEL_PATH.IMMEDIATE;
    if (status === TASK_STATUS.RUNNING) return CANCEL_PATH.COOPERATIVE;
    return null;
}

module.exports = {
    ALL_TASK_STATUSES,
    ALLOWED_TRANSITIONS,
    CANCEL_PATH,
    TASK_STATUS,
    TERMINAL_STATUSES,
    TRANSITION_ACTION,
    TaskStateError,
    assertTransition,
    canTransition,
    cancelPathFor,
    isLeaseExpired,
    isTaskStatus,
    isTerminalStatus,
    nextStatusAfterFailure,
    resolveTransition,
};
