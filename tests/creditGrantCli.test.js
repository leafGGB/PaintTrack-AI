'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    CreditGrantError, assertAmount, assertUuid, main, parseArguments, shortFailure,
} = require('../lib/server/tasks/creditGrantCli');
const { ledgerOwnerRole } = require('../lib/server/db/migrate');

const database = 'painttrack_grant_test';
const role = ledgerOwnerRole(database);
const USER = '3f1c8d2e-1a4b-4c6d-8e0f-1a2b3c4d5e6f';
const SOURCE = '9a8b7c6d-5e4f-4a3b-9c1d-2e3f4a5b6c7d';
const EVENT = '11111111-2222-3333-4444-555555555555';
const env = (extra = {}) => ({
    LEDGER_DATABASE_URL: `postgres://ledger_admin:pw@127.0.0.1:5433/${database}`,
    DATABASE_URL: `postgres://pt_app:pw@127.0.0.1:5433/${database}`,
    ...extra,
});

// 只注入连接装配，不触网：断言全部落在 SQL 序列与输出上。
// PoolImpl 交给 createOwnerSessionPool，于是 SET LOCAL ROLE 的真实装配也一并被覆盖。
function fakePool({ currentUser = role, canGrant = true, canWritePricing = true, existingEvent = null, accountRow = null } = {}) {
    const calls = [];
    const state = { connects: 0, ended: false };
    function PoolImpl() {
        this.connect = async () => {
            state.connects += 1;
            return client;
        };
        this.end = async () => { state.ended = true; };
    }
    const client = {
        async query(sql, values) {
            calls.push({ sql, values });
            if (sql.includes('FROM pg_catalog.pg_roles')) {
                return { rows: [{ rolcanlogin: false, rolinherit: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false }] };
            }
            if (sql.includes('has_table_privilege')) return { rows: [{ allowed: canWritePricing }] };
            if (sql.includes('has_function_privilege')) return { rows: [{ allowed: canGrant }] };
            if (sql === 'SELECT current_user AS current_user') return { rows: [{ current_user: currentUser }] };
            if (sql.includes('FROM public.credit_ledger_events WHERE idempotency_key')) {
                return { rows: existingEvent ? [{ id: existingEvent }] : [] };
            }
            if (sql.includes('public.credit_grant(')) return { rows: [{ event_id: EVENT }] };
            if (sql.includes('FROM public.credit_accounts WHERE user_id')) return { rows: accountRow ? [accountRow] : [] };
            return { rows: [] };
        },
        release() { calls.push({ sql: 'RELEASE' }); },
    };
    return { calls, state, PoolImpl };
}

test('参数只接受 grant/balance，未知、重复、缺值与非选项标记一律拒绝', () => {
    assert.deepEqual(parseArguments(['grant', '--user-id', USER, '--amount', '1000', '--source-id', SOURCE]),
        { action: 'grant', options: { 'user-id': USER, amount: '1000', 'source-id': SOURCE } });
    assert.deepEqual(parseArguments([`balance`, `--user-id=${USER}`]), { action: 'balance', options: { 'user-id': USER } });
    for (const [argv, reason] of [
        [[], 'ACTION_INVALID'],
        [['publish'], 'ACTION_INVALID'],
        [['balance'], 'ARGUMENT_REQUIRED'],
        [['balance', '--user-id'], 'ARGUMENT_VALUE_REQUIRED'],
        [['balance', '--user-id', USER, '--user-id', USER], 'ARGUMENT_DUPLICATED'],
        // 未知参数先于取值校验：打错参数名要报"不接受"，而不是"缺少取值"。
        [['balance', '--user-id', USER, '--amount', '1'], 'ARGUMENT_UNKNOWN'],
        [['grant', '--user-id', USER, '--amount', '1000'], 'ARGUMENT_REQUIRED'],
        [['grant', 'user-id', USER], 'ARGUMENT_INVALID'],
    ]) assert.throws(() => parseArguments(argv), (error) => error.reason === reason, `${argv.join(' ')} -> ${reason}`);
});

test('用户与来由必须是 UUID，金额只接受正整数的 credit_tenths', () => {
    assert.equal(assertUuid(USER.toUpperCase(), 'USER_ID_INVALID'), USER);
    for (const value of ['', 'not-a-uuid', USER.slice(1), `${USER}x`, undefined]) {
        assert.throws(() => assertUuid(value, 'USER_ID_INVALID'), (error) => error.reason === 'USER_ID_INVALID');
    }
    assert.equal(assertAmount('1'), '1');
    assert.equal(assertAmount('9223372036854775807'), '9223372036854775807');
    // 0、负数、小数、指数、前导零与超长边界都不进入数据库。
    for (const value of ['0', '-1', '0.5', '1.5', '1e3', '01', '', '9223372036854775808', undefined, 1000]) {
        assert.throws(() => assertAmount(value), (error) => error.reason === 'AMOUNT_INVALID', String(value));
    }
});

test('grant 会话顺序固定：BEGIN → SET LOCAL ROLE → 身份回读 → 权限校验 → 幂等探测 → 函数 → COMMIT', async () => {
    const { calls, state, PoolImpl } = fakePool();
    let out = '';
    const result = await main({
        argv: ['grant', '--user-id', USER, '--amount', '1000', '--source-id', SOURCE],
        env: env(),
        output: { write: (chunk) => { out += chunk; } },
        errorOutput: { write: () => {} },
        PoolImpl,
    });
    assert.equal(result.eventId, EVENT);
    assert.equal(result.replayed, false);
    assert.equal(result.sourceType, 'manual');
    assert.equal(result.creditTenths, '1000');
    assert.equal(state.ended, true);

    const sqls = calls.map((call) => call.sql);
    assert.match(sqls[0], /^BEGIN ISOLATION LEVEL READ COMMITTED$/);
    assert.match(sqls[1], /^SET LOCAL ROLE "pt_ledger_owner_[0-9a-f]{16}"$/);
    assert.equal(sqls[2], 'SELECT current_user AS current_user');
    const probe = sqls.findIndex((sql) => sql.includes('FROM public.credit_ledger_events WHERE idempotency_key'));
    const fn = sqls.findIndex((sql) => sql.includes('public.credit_grant('));
    assert.ok(probe !== -1 && fn > probe, '幂等探测必须先于函数调用');
    assert.equal(sqls.at(-2), 'COMMIT');
    assert.equal(calls.at(-1).sql, 'RELEASE');
});

test('同一来由重复发放按重放返回，金额以字符串传入并派生出 grant:<来源>:<来由> 幂等键', async () => {
    const { calls, PoolImpl } = fakePool({ existingEvent: EVENT });
    const result = await main({
        argv: ['grant', '--user-id', USER, '--amount', '1000', '--source-id', SOURCE, '--source-type', 'signup'],
        env: env(), output: { write: () => {} }, errorOutput: { write: () => {} }, PoolImpl,
    });
    assert.equal(result.replayed, true);
    assert.equal(result.sourceType, 'signup');
    const fnCall = calls.find((call) => call.sql.includes('public.credit_grant('));
    assert.deepEqual(fnCall.values, [USER, '1000', 'signup', SOURCE]);
    const probeCall = calls.find((call) => call.sql.includes('FROM public.credit_ledger_events WHERE idempotency_key'));
    assert.deepEqual(probeCall.values, [`grant:signup:${SOURCE}`]);
});

test('owner 缺少发放执行权时回滚并失败，不会调用发放函数', async () => {
    const originalExitCode = process.exitCode;
    const { calls, PoolImpl } = fakePool({ canGrant: false });
    let out = '';
    let err = '';
    const result = await main({
        argv: ['grant', '--user-id', USER, '--amount', '1000', '--source-id', SOURCE],
        env: env(), output: { write: (chunk) => { out += chunk; } }, errorOutput: { write: (chunk) => { err += chunk; } }, PoolImpl,
    });
    assert.equal(result, null);
    assert.equal(err.trim(), 'LEDGER_OWNER_NOT_PREPARED');
    assert.match(out, /缺少发放权限/);
    assert.equal(calls.some((call) => call.sql.includes('public.credit_grant(')), false);
    assert.equal(calls.at(-2).sql, 'ROLLBACK');
    process.exitCode = originalExitCode;
});

test('balance 只读：账户缺失返回 exists=false，存在则透传可用与冻结额', async () => {
    const missing = fakePool();
    let out = '';
    const absent = await main({
        argv: ['balance', '--user-id', USER], env: env(),
        output: { write: (chunk) => { out += chunk; } }, errorOutput: { write: () => {} }, PoolImpl: missing.PoolImpl,
    });
    assert.deepEqual(absent, { action: 'balance', userId: USER, exists: false, availableTenths: null, reservedTenths: null });
    // 账户不存在时不能伪造 0，必须显式给出 exists=false。
    assert.match(out, /"exists": false/);
    assert.equal(missing.calls.some((call) => call.sql.includes('UPDATE')), false);

    const present = fakePool({ accountRow: { available_tenths: '1000', reserved_tenths: '70' } });
    const found = await main({
        argv: ['balance', '--user-id', USER], env: env(),
        output: { write: () => {} }, errorOutput: { write: () => {} }, PoolImpl: present.PoolImpl,
    });
    assert.deepEqual(found, { action: 'balance', userId: USER, exists: true, availableTenths: '1000', reservedTenths: '70' });
});

test('参数或环境错误在连库前失败，输出不含连接串且退出码为 1', async () => {
    const originalExitCode = process.exitCode;
    const cases = [
        [[], env(), /操作：grant 或 balance/, 'ACTION_INVALID'],
        [['grant', '--user-id', 'bad', '--amount', '10', '--source-id', SOURCE], env(), /用户标识必须是 UUID/, 'USER_ID_INVALID'],
        [['grant', '--user-id', USER, '--amount', '0', '--source-id', SOURCE], env(), /正整数的 credit_tenths/, 'AMOUNT_INVALID'],
        [['grant', '--user-id', USER, '--amount', '10', '--source-id', SOURCE, '--source-type', 'promo'], env(), /signup 或 manual/, 'SOURCE_TYPE_INVALID'],
        [['balance', '--user-id', USER], { DATABASE_URL: env().DATABASE_URL }, /LEDGER_DATABASE_URL/, 'LEDGER_DATABASE_URL_REQUIRED'],
        [['balance', '--user-id', USER], env({ LEDGER_DATABASE_URL: 'postgres://a:b@10.0.0.5:5433/painttrack_grant' }), /本机回环/, 'LEDGER_TARGET_NOT_LOOPBACK'],
        [['balance', '--user-id', USER], env({ DATABASE_URL: `postgres://ledger_admin:pw@127.0.0.1:5433/${database}` }), /身份不同/, 'LEDGER_IDENTITY_MUST_DIFFER'],
    ];
    for (const [argv, environment, pattern, code] of cases) {
        let out = '';
        let err = '';
        const result = await main({
            argv, env: environment,
            output: { write: (chunk) => { out += chunk; } },
            errorOutput: { write: (chunk) => { err += chunk; } },
            PoolImpl: function PoolImpl() { throw new Error('不应建立连接'); },
        });
        assert.equal(result, null, `${code} 应失败`);
        assert.match(out, pattern, code);
        assert.equal(err.trim(), code);
        assert.doesNotMatch(out, /pw@|postgres:\/\//);
    }
    process.exitCode = originalExitCode;
});

test('数据库侧拒绝码映射到稳定错误码，且不回显连接串', () => {
    assert.deepEqual(shortFailure(Object.assign(new Error('CREDIT_GRANT_CONFLICT'), { code: '23505' })),
        { message: '同一发放来由已存在且金额或用户不同，拒绝覆盖。', code: 'CREDIT_GRANT_CONFLICT' });
    assert.deepEqual(shortFailure(Object.assign(new Error('CREDIT_USER_NOT_FOUND'), { code: '55000' })),
        { message: '目标用户不存在。', code: 'CREDIT_USER_NOT_FOUND' });
    assert.deepEqual(shortFailure(Object.assign(new Error('CREDIT_BALANCE_OVERFLOW'), { code: '22003' })),
        { message: '发放后余额将超出允许上限，已拒绝。', code: 'CREDIT_BALANCE_OVERFLOW' });
    assert.deepEqual(shortFailure(Object.assign(new Error('permission denied'), { code: '42501' })),
        { message: '数据库拒绝了该操作：当前身份不能执行该账务写操作。', code: 'LEDGER_SET_ROLE_DENIED' });
    assert.deepEqual(shortFailure(new CreditGrantError('AMOUNT_INVALID')),
        { message: '发放额度必须是正整数的 credit_tenths（0.1 额度）数量。', code: 'AMOUNT_INVALID' });
    assert.equal(shortFailure(new Error('boom')).code, 'CREDIT_GRANT_FAILED');
});
