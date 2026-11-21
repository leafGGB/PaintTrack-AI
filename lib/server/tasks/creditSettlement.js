'use strict';

// 内部终态裁决：把已冻结的额度一次性结算或释放。
// 仅供已受信的账务 owner 宿主使用；不接 HTTP，也不接收管理员/迁移连接。
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OUTCOMES = new Set(['settle', 'release']);
// 与 credit_pending_settlements(p_limit) 的数据库侧区间一致，避免两端上限漂移。
const SWEEP_DEFAULT_LIMIT = 50;
const SWEEP_MAX_LIMIT = 500;

class SettlementError extends Error {
    constructor(reason) {
        super('SETTLEMENT_UNAVAILABLE');
        this.name = 'SettlementError';
        this.code = 'SETTLEMENT_UNAVAILABLE';
        Object.defineProperty(this, 'reason', { value: reason });
    }

    toJSON() { return { code: this.code }; }
}

const fail = reason => { throw new SettlementError(reason); };
// 数据库拒绝只暴露固定理由，不把SQL细节带给调用方，也不把失败误判成成功。
const databaseReasons = new Map([
    ['CREDIT_OUTCOME_INVALID', 'INPUT_INVALID'],
    ['CREDIT_SWEEP_LIMIT_INVALID', 'INPUT_INVALID'],
    ['CREDIT_SETTLE_CONFLICT', 'SETTLE_CONFLICT'],
    ['CREDIT_RESERVE_NOT_FOUND', 'RESERVE_NOT_FOUND'],
    ['CREDIT_TASK_NOT_FOUND', 'TASK_NOT_FOUND'],
    ['CREDIT_TASK_NOT_TERMINAL', 'TASK_NOT_TERMINAL'],
    ['CREDIT_RESERVED_UNDERFLOW', 'RESERVED_UNDERFLOW'],
]);
const translateFailure = error => {
    if (error instanceof SettlementError) return error;
    const reason = databaseReasons.get(error?.message);
    if (!reason) return error;
    const wrapped = new SettlementError(reason);
    wrapped.cause = error;
    return wrapped;
};

function createCreditSettlementStore({ pool } = {}) {
    if (!pool || typeof pool.connect !== 'function') throw new TypeError('pool is required');

    async function transaction(run) {
        const client = await pool.connect();
        let begun = false;
        try {
            await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
            begun = true;
            const allowed = (await client.query(`SELECT current_user = 'pt_ledger_owner_' ||
                substr(md5(current_database()), 1, 16) AS allowed`)).rows[0]?.allowed;
            if (allowed !== true) fail('SETTLEMENT_EXECUTOR_REQUIRED');
            const result = await run(client);
            await client.query('COMMIT');
            begun = false;
            return result;
        } catch (error) {
            if (begun) {
                try { await client.query('ROLLBACK'); }
                catch (rollbackError) { throw new AggregateError([error, rollbackError], 'SETTLEMENT_ROLLBACK_FAILED'); }
            }
            throw translateFailure(error);
        } finally { client.release(); }
    }

    function assertLimit(limit) {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > SWEEP_MAX_LIMIT) fail('INPUT_INVALID');
    }

    // settle：成功任务把冻结额度扣掉；release：失败/取消任务把冻结额度退回可用。
    // 不支持部分结算、跨任务调整或对非终态任务裁决。
    async function finalize({ ownerId, taskId, outcome } = {}) {
        if (typeof ownerId !== 'string' || !UUID_PATTERN.test(ownerId)
            || typeof taskId !== 'string' || !UUID_PATTERN.test(taskId)) fail('INPUT_INVALID');
        if (typeof outcome !== 'string' || !OUTCOMES.has(outcome)) fail('INPUT_INVALID');
        const user = ownerId.toLowerCase();
        const task = taskId.toLowerCase();

        return transaction(async client => {
            const prior = (await client.query(
                'SELECT kind, event_id FROM public.credit_settlements WHERE task_id=$1', [task])).rows[0];
            // 已存在的裁决由数据库函数复核并返回原事件；这里只记录是否是重放。
            const settled = (await client.query(
                'SELECT public.credit_finalize_task($1,$2,$3) AS event_id', [user, task, outcome])).rows[0];
            const balances = (await client.query(
                'SELECT available_tenths::text AS available, reserved_tenths::text AS reserved FROM public.credit_accounts WHERE user_id=$1',
                [user])).rows[0];
            return Object.freeze({
                taskId: task,
                outcome,
                eventId: settled.event_id,
                availableTenths: balances?.available ?? null,
                reservedTenths: balances?.reserved ?? null,
                replayed: Boolean(prior),
            });
        });
    }

    // 只读：列出已终态、已冻结、尚未裁决的任务。结局由数据库按任务状态给出，JS 不自行推断。
    async function pending({ limit = SWEEP_DEFAULT_LIMIT } = {}) {
        assertLimit(limit);
        return transaction(async client => (await client.query(
            `SELECT task_id, user_id, credit_tenths::text AS credit_tenths, outcome
               FROM public.credit_pending_settlements($1)`, [limit])).rows.map(row => Object.freeze({
            taskId: row.task_id,
            ownerId: row.user_id,
            creditTenths: row.credit_tenths,
            outcome: row.outcome,
        })));
    }

    // 逐个收敛：每笔裁决独立事务，单笔失败不会拖垮整批，也不会把部分结果当成已全部完成。
    // 只有已登记的业务拒绝才记录后继续；连接断开、权限变更等未知错误必须上抛，由宿主停止本轮。
    async function sweep({ limit = SWEEP_DEFAULT_LIMIT } = {}) {
        const candidates = await pending({ limit });
        const finalized = [];
        const failed = [];
        for (const candidate of candidates) {
            try {
                const result = await finalize({
                    ownerId: candidate.ownerId, taskId: candidate.taskId, outcome: candidate.outcome,
                });
                finalized.push(Object.freeze({
                    taskId: result.taskId, outcome: result.outcome, eventId: result.eventId, replayed: result.replayed,
                }));
            } catch (error) {
                if (!(error instanceof SettlementError)) throw error;
                failed.push(Object.freeze({
                    taskId: candidate.taskId, outcome: candidate.outcome, reason: error.reason,
                }));
            }
        }
        return Object.freeze({
            examined: candidates.length,
            finalized: Object.freeze(finalized),
            failed: Object.freeze(failed),
        });
    }

    return Object.freeze({ finalize, pending, sweep });
}

module.exports = { createCreditSettlementStore, SettlementError, SWEEP_MAX_LIMIT };
