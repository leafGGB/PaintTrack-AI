const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createCreditSettlementStore, SettlementError, SWEEP_MAX_LIMIT } = require('../lib/server/tasks/creditSettlement');

const user = '11111111-1111-4111-8111-111111111111';
const task = '33333333-3333-4333-8333-333333333333';
const event = '44444444-4444-4444-8444-444444444444';
const migrationPath = path.join(__dirname, '../drizzle/0027_credit_settle_release.sql');
const sweepMigrationPath = path.join(__dirname, '../drizzle/0028_credit_settlement_sweep.sql');

function fakePool({ allowed = true, prior = null, eventId = event, failure = null, balances = { available: '7', reserved: '0' } } = {}) {
    const calls = [];
    const client = {
        async query(text) {
            calls.push(text);
            if (text.startsWith('SELECT current_user')) return { rows: [{ allowed }] };
            if (text.startsWith('SELECT kind, event_id')) return { rows: prior ? [prior] : [] };
            if (text.includes('public.credit_finalize_task')) {
                if (failure) {
                    const error = new Error(failure.message);
                    error.code = failure.code;
                    throw error;
                }
                return { rows: [{ event_id: eventId }] };
            }
            if (text.startsWith('SELECT available_tenths')) return { rows: [balances] };
            return { rows: [] };
        },
        release() { calls.push('RELEASE'); },
    };
    return { calls, connect: async () => client };
}

test('终态裁决要求连接池', () => {
    assert.throws(() => createCreditSettlementStore(), /pool is required/);
    assert.throws(() => createCreditSettlementStore({ pool: {} }), /pool is required/);
});

test('终态裁决拒绝非法入参，且不创建事务', async () => {
    const pool = fakePool();
    const store = createCreditSettlementStore({ pool });
    for (const args of [
        {}, { ownerId: user, taskId: task }, { ownerId: 'not-a-uuid', taskId: task, outcome: 'settle' },
        { ownerId: user, taskId: task, outcome: 'refund' },
    ]) {
        await assert.rejects(store.finalize(args), error => error instanceof SettlementError && error.reason === 'INPUT_INVALID');
    }
    assert.deepEqual(pool.calls, []);
});

test('非 ledger owner 调用 fail closed，并回滚事务', async () => {
    const pool = fakePool({ allowed: false });
    const store = createCreditSettlementStore({ pool });
    await assert.rejects(store.finalize({ ownerId: user, taskId: task, outcome: 'settle' }),
        error => error.reason === 'SETTLEMENT_EXECUTOR_REQUIRED');
    assert.deepEqual(pool.calls.slice(0, 3), [
        'BEGIN ISOLATION LEVEL READ COMMITTED',
        `SELECT current_user = 'pt_ledger_owner_' ||\n                substr(md5(current_database()), 1, 16) AS allowed`,
        'ROLLBACK',
    ]);
    assert.equal(pool.calls.at(-1), 'RELEASE');
    assert.equal(pool.calls.some(text => text.includes('credit_finalize_task') || text === 'COMMIT'), false);
});

test('结算与释放走同一个受限函数，并在提交后返回余额', async () => {
    for (const outcome of ['settle', 'release']) {
        const pool = fakePool({ balances: outcome === 'settle' ? { available: '7', reserved: '0' } : { available: '14', reserved: '0' } });
        const store = createCreditSettlementStore({ pool });
        const result = await store.finalize({ ownerId: user.toUpperCase(), taskId: task.toUpperCase(), outcome });
        assert.equal(result.eventId, event);
        assert.equal(result.outcome, outcome);
        assert.equal(result.replayed, false);
        assert.equal(result.taskId, task);
        assert.deepEqual(pool.calls.slice(0, 2), [
            'BEGIN ISOLATION LEVEL READ COMMITTED',
            `SELECT current_user = 'pt_ledger_owner_' ||\n                substr(md5(current_database()), 1, 16) AS allowed`,
        ]);
        assert.ok(pool.calls.includes('SELECT public.credit_finalize_task($1,$2,$3) AS event_id'));
        assert.equal(pool.calls.at(-2), 'COMMIT');
        assert.equal(pool.calls.at(-1), 'RELEASE');
    }
});

test('已存在的裁决标记为重放，仍由数据库函数复核冲突', async () => {
    const pool = fakePool({ prior: { kind: 'settle', event_id: event } });
    const store = createCreditSettlementStore({ pool });
    const replay = await store.finalize({ ownerId: user, taskId: task, outcome: 'settle' });
    assert.equal(replay.replayed, true);
    assert.equal(replay.eventId, event);
    assert.equal(pool.calls.filter(text => text.includes('credit_finalize_task')).length, 1);

    const conflictPool = fakePool({ prior: { kind: 'settle', event_id: event }, failure: { code: '23505', message: 'CREDIT_SETTLE_CONFLICT' } });
    const conflicting = createCreditSettlementStore({ pool: conflictPool });
    await assert.rejects(conflicting.finalize({ ownerId: user, taskId: task, outcome: 'release' }),
        error => error.reason === 'SETTLE_CONFLICT');
    assert.ok(conflictPool.calls.includes('ROLLBACK'));
    assert.equal(conflictPool.calls.includes('COMMIT'), false);
});

test('数据库拒绝按固定理由回传，不泄露 SQL 细节', async () => {
    const cases = [
        ['CREDIT_TASK_NOT_TERMINAL', 'TASK_NOT_TERMINAL'],
        ['CREDIT_RESERVE_NOT_FOUND', 'RESERVE_NOT_FOUND'],
        ['CREDIT_TASK_NOT_FOUND', 'TASK_NOT_FOUND'],
        ['CREDIT_RESERVED_UNDERFLOW', 'RESERVED_UNDERFLOW'],
        ['CREDIT_OUTCOME_INVALID', 'INPUT_INVALID'],
    ];
    for (const [message, reason] of cases) {
        const pool = fakePool({ failure: { code: '55000', message } });
        const store = createCreditSettlementStore({ pool });
        await assert.rejects(store.finalize({ ownerId: user, taskId: task, outcome: 'settle' }), error => {
            assert.equal(error.reason, reason);
            assert.equal(error.message, 'SETTLEMENT_UNAVAILABLE');
            assert.doesNotMatch(error.message, /table|constraint|credit_/i);
            return true;
        });
        assert.ok(pool.calls.includes('ROLLBACK'));
        assert.equal(pool.calls.includes('COMMIT'), false);
    }
    // 未登记的错误原样抛出，不能被误判为已裁决。
    const unknown = fakePool({ failure: { code: '57014', message: 'canceling statement' } });
    await assert.rejects(createCreditSettlementStore({ pool: unknown }).finalize({ ownerId: user, taskId: task, outcome: 'settle' }),
        error => error.message === 'canceling statement');
});

test('0027 迁移只向专用 owner 开放终态裁决', () => {
    const source = fs.readFileSync(migrationPath, 'utf8');
    assert.match(source, /CREATE FUNCTION public\.credit_finalize_task\(p_user_id uuid, p_task_id uuid, p_outcome text\)/);
    assert.match(source, /REVOKE ALL ON FUNCTION public\.credit_finalize_task\(uuid, uuid, text\) FROM PUBLIC/);
    assert.match(source, /REVOKE ALL ON public\.credit_settlements FROM PUBLIC/);
    assert.match(source, /CREATE TRIGGER credit_settlements_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public\.credit_settlements/);
    // 只有 owner 得到 EXECUTE；迁移身份与运行身份都不在其中。
    const grants = source.split('\n').filter(line => /GRANT EXECUTE/.test(line));
    assert.equal(grants.length, 1);
    assert.match(grants[0], /credit_finalize_task\(uuid,uuid,text\) TO %I/);
    assert.doesNotMatch(source, /GRANT (?:SELECT|INSERT|UPDATE|DELETE|ALL)[^;]*TO (?:PUBLIC|pt_runtime|pt_web|pt_worker|pt_cleanup)/i);
    // 事件形状收紧为三种 kind，且每个任务每种 kind 至多一条。
    assert.match(source, /"kind" IN \('reserve', 'settle', 'release'\)/);
    assert.match(source, /CREATE UNIQUE INDEX "credit_ledger_events_task_kind_unique"/);
    // 不允许部分结算：函数只读 reservation 金额，不接受调用方传入的金额。
    assert.doesNotMatch(source, /p_credit_tenths/);
    assert.doesNotMatch(source, /FOR UPDATE|FOR SHARE/);
    assert.match(source, /CREDIT_TASK_NOT_TERMINAL/);
    assert.match(source, /CREDIT_RESERVED_UNDERFLOW/);
});

// 扫描候选来自数据库函数：JS 不自行推断结局，只按返回的 outcome 逐笔裁决。
function sweepPool({ allowed = true, candidates = [], failures = {} } = {}) {
    const calls = [];
    const client = {
        async query(text, values) {
            calls.push(text);
            if (text.startsWith('SELECT current_user')) return { rows: [{ allowed }] };
            if (text.startsWith('SELECT task_id, user_id')) return { rows: candidates };
            if (text.startsWith('SELECT kind, event_id')) return { rows: [] };
            if (text.includes('public.credit_finalize_task')) {
                const failure = failures[values[1]];
                if (failure) throw new Error(failure);
                return { rows: [{ event_id: `event-${values[1]}` }] };
            }
            if (text.startsWith('SELECT available_tenths')) return { rows: [{ available: '1', reserved: '0' }] };
            return { rows: [] };
        },
        release() { calls.push('RELEASE'); },
    };
    return { calls, connect: async () => client };
}

test('扫描与批量收敛拒绝越界 limit，且不创建事务', async () => {
    for (const limit of [0, -1, 1.5, String(SWEEP_MAX_LIMIT + 1), SWEEP_MAX_LIMIT + 1]) {
        const pool = sweepPool();
        const store = createCreditSettlementStore({ pool });
        await assert.rejects(store.sweep({ limit }), error => error.reason === 'INPUT_INVALID');
        await assert.rejects(store.pending({ limit }), error => error.reason === 'INPUT_INVALID');
        assert.deepEqual(pool.calls, []);
    }
});

test('扫描只读列出候选，结局由数据库给出', async () => {
    const candidates = [
        { task_id: task, user_id: user, credit_tenths: '7', outcome: 'settle' },
    ];
    const pool = sweepPool({ candidates });
    const store = createCreditSettlementStore({ pool });
    const rows = await store.pending();
    assert.deepEqual(rows, [{ taskId: task, ownerId: user, creditTenths: '7', outcome: 'settle' }]);
    assert.equal(pool.calls.some(text => text.includes('credit_finalize_task')), false);
    assert.ok(pool.calls.some(text => text.includes('FROM public.credit_pending_settlements($1)')));
    assert.equal(pool.calls.at(-2), 'COMMIT');
    assert.equal(pool.calls.at(-1), 'RELEASE');
});

test('批量收敛逐笔裁决，单笔已知拒绝记录后继续', async () => {
    const second = '55555555-5555-4555-8555-555555555555';
    const third = '66666666-6666-4666-8666-666666666666';
    const pool = sweepPool({
        candidates: [
            { task_id: task, user_id: user, credit_tenths: '7', outcome: 'settle' },
            { task_id: second, user_id: user, credit_tenths: '7', outcome: 'release' },
            { task_id: third, user_id: user, credit_tenths: '7', outcome: 'release' },
        ],
        failures: { [second]: 'CREDIT_RESERVED_UNDERFLOW' },
    });
    const store = createCreditSettlementStore({ pool });
    const result = await store.sweep({ limit: 3 });
    assert.equal(result.examined, 3);
    assert.deepEqual(result.finalized.map(item => item.taskId), [task, third]);
    assert.equal(result.finalized[0].eventId, `event-${task}`);
    assert.deepEqual(result.failed, [{ taskId: second, outcome: 'release', reason: 'RESERVED_UNDERFLOW' }]);
    // 三笔候选各开一次独立事务，失败一笔不回滚已提交的另一笔。
    assert.equal(pool.calls.filter(text => text === 'COMMIT').length, 3);
    assert.equal(pool.calls.filter(text => text.includes('credit_finalize_task')).length, 3);
});

test('批量收敛遇到未知错误必须上抛，不当作已裁决', async () => {
    const pool = sweepPool({
        candidates: [{ task_id: task, user_id: user, credit_tenths: '7', outcome: 'settle' }],
        failures: { [task]: 'canceling statement due to statement timeout' },
    });
    const store = createCreditSettlementStore({ pool });
    await assert.rejects(store.sweep(), error => error.message === 'canceling statement due to statement timeout');
});

test('批量收敛同时要求 ledger owner 身份，候选为空时不发起裁决', async () => {
    const denied = sweepPool({ allowed: false });
    await assert.rejects(createCreditSettlementStore({ pool: denied }).sweep(),
        error => error.reason === 'SETTLEMENT_EXECUTOR_REQUIRED');
    assert.equal(denied.calls.some(text => text.includes('credit_finalize_task')), false);

    const empty = sweepPool();
    const result = await createCreditSettlementStore({ pool: empty }).sweep();
    assert.deepEqual({ examined: result.examined, finalized: result.finalized, failed: result.failed },
        { examined: 0, finalized: [], failed: [] });
    assert.equal(empty.calls.some(text => text.includes('credit_finalize_task')), false);
});

test('0028 迁移只新增只读扫描，不放开写权限', () => {
    const source = fs.readFileSync(sweepMigrationPath, 'utf8');
    assert.match(source, /CREATE FUNCTION public\.credit_pending_settlements\(p_limit integer\)/);
    assert.match(source, /REVOKE ALL ON FUNCTION public\.credit_pending_settlements\(integer\) FROM PUBLIC/);
    assert.match(source, /LANGUAGE plpgsql STABLE SECURITY DEFINER/);
    // 结局由任务状态唯一决定，且只接受三种终态。
    assert.match(source, /WHEN t\.status = 'succeeded' THEN 'settle' ELSE 'release'/);
    assert.match(source, /t\.status IN \('succeeded', 'failed', 'cancelled'\)/);
    assert.match(source, /LEFT JOIN public\.credit_settlements s ON s\.task_id = r\.task_id/);
    // 扫描只读：不得出现任何 INSERT/UPDATE/DELETE 授权或新建写函数。
    assert.doesNotMatch(source, /GRANT[^;]*(?:INSERT|UPDATE|DELETE|TRUNCATE)/);
    assert.doesNotMatch(source, /CREATE (?:OR REPLACE )?FUNCTION (?!public\.credit_pending_settlements)/);
    assert.doesNotMatch(source, /CREATE TRIGGER|CREATE TABLE|ALTER TABLE/);
    // 冻结表只补列级 SELECT，仍然没有改/删路径。
    const grants = source.split('\n').filter(line => /GRANT SELECT/.test(line));
    assert.equal(grants.length, 1);
    assert.match(grants[0], /SELECT\(task_id,user_id,credit_tenths,reserve_event_id\) ON public\.credit_reservations TO %I/);
    // 扫描必须接入真实 PG 验收，且迁移计数同步到当前 0031 链。
    const acceptance = fs.readFileSync(path.join(__dirname, '../scripts/accept-database-local.js'), 'utf8');
    assert.match(acceptance, /runFixture\('credit-settlement-sweep-postgres'/);
    assert.match(acceptance, /before0021\.length \+ 11/);
});
