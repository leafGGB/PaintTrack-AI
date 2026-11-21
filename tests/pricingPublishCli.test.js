'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
    assertPublishEnvironment, createOwnerSessionPool, main, parseArguments,
    readConfigFile, readTimeline, resolveEffectiveFromUs, shortFailure,
} = require('../lib/server/tasks/pricingPublishCli');
const { ledgerOwnerRole } = require('../lib/server/db/migrate');

const database = 'painttrack_cli_test';
const role = ledgerOwnerRole(database);
const env = () => ({
    PUBLISH_DATABASE_URL: `postgres://publish_admin:pw@127.0.0.1:5433/${database}`,
    DATABASE_URL: `postgres://pt_app:pw@127.0.0.1:5433/${database}`,
});
// 只注入连接装配，不触网：所有断言都落在 SQL 序列与输出上。
function fakePool({ currentUser = role, roleRow, canWrite = true, rows = [] } = {}) {
    const calls = [];
    const state = { rows, currentUser, closed: false, connects: 0 };
    const client = {
        async query(sql, values) {
            calls.push({ sql, values });
            if (sql.includes('FROM pg_catalog.pg_roles')) {
                return { rows: [roleRow || { rolcanlogin: false, rolinherit: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false }] };
            }
            if (sql.includes('has_table_privilege')) return { rows: [{ allowed: canWrite }] };
            if (sql === 'SELECT current_user AS current_user') return { rows: [{ current_user: state.currentUser }] };
            if (sql.includes('FROM public.pricing_versions pv')) return { rows: state.rows };
            return { rows: [] };
        },
        release() { calls.push({ sql: 'RELEASE' }); },
    };
    function PoolImpl() {
        this.connect = async () => { state.connects += 1; return client; };
        this.end = async () => { state.closed = true; };
    }
    return { calls, state, PoolImpl };
}

test('参数只接受登记动作与登记开关，重复/未知/缺值一律拒绝', () => {
    assert.deepEqual(parseArguments(['timeline', '--model-id', 'm1']), { action: 'timeline', options: { 'model-id': 'm1' } });
    assert.deepEqual(parseArguments(['publish', '--config=a.json', '--effective-from', '@1800000000', '--dry-run']),
        { action: 'publish', options: { config: 'a.json', 'effective-from': '@1800000000', 'dry-run': 'true' } });
    // --dry-run 是布尔开关，不能吞掉后面的参数值。
    assert.equal(parseArguments(['publish', '--dry-run', '--config=a.json', '--effective-from=@1800000000']).options.config, 'a.json');
    for (const [argv, reason] of [
        [[], 'ACTION_INVALID'],
        [['delete'], 'ACTION_INVALID'],
        [['timeline', '--model-id'], 'ARGUMENT_VALUE_REQUIRED'],
        [['timeline', '--model-id', 'm1', '--model-id', 'm2'], 'ARGUMENT_DUPLICATED'],
        [['timeline', '--model-id', 'm1', '--force'], 'ARGUMENT_UNKNOWN'],
        [['timeline', 'm1'], 'ARGUMENT_INVALID'],
        [['publish', '--config', 'a.json'], 'ARGUMENT_REQUIRED'],
        [['publish', '--config=', '--effective-from=@1'], 'ARGUMENT_VALUE_REQUIRED'],
    ]) assert.throws(() => parseArguments(argv), (error) => error.reason === reason, `${argv.join(' ')} -> ${reason}`);
});

test('生效时间只接受整秒，ISO 与 @秒等价且不做本地时区猜测', () => {
    assert.equal(resolveEffectiveFromUs('@1800000000'), '1800000000000000');
    assert.equal(resolveEffectiveFromUs('2027-01-15T08:00:00Z'), '1800000000000000');
    assert.equal(resolveEffectiveFromUs('2027-01-15T16:00:00+08:00'), '1800000000000000');
    for (const [text, reason] of [
        ['', 'EFFECTIVE_FROM_REQUIRED'],
        ['not-a-time', 'EFFECTIVE_FROM_INVALID'],
        ['@1.5', 'EFFECTIVE_FROM_INVALID'],
        ['@-1', 'EFFECTIVE_FROM_INVALID'],
        ['@0', 'EFFECTIVE_FROM_INVALID'],
        ['2027-01-15T08:00:00.500Z', 'EFFECTIVE_FROM_NOT_WHOLE_SECOND'],
    ]) assert.throws(() => resolveEffectiveFromUs(text), (error) => error.reason === reason, `${text} -> ${reason}`);
});

test('价格配置必须是可读的小体积 JSON 对象', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-pricing-'));
    try {
        const good = path.join(dir, 'good.json');
        fs.writeFileSync(good, JSON.stringify({ modelId: 'm1' }));
        assert.deepEqual(readConfigFile(good), { modelId: 'm1' });
        const array = path.join(dir, 'array.json');
        fs.writeFileSync(array, '[]');
        assert.throws(() => readConfigFile(array), (error) => error.reason === 'CONFIG_INVALID');
        const broken = path.join(dir, 'broken.json');
        fs.writeFileSync(broken, '{');
        assert.throws(() => readConfigFile(broken), (error) => error.reason === 'CONFIG_INVALID_JSON');
        const big = path.join(dir, 'big.json');
        fs.writeFileSync(big, JSON.stringify({ padding: 'x'.repeat(70 * 1024) }));
        assert.throws(() => readConfigFile(big), (error) => error.reason === 'CONFIG_TOO_LARGE');
        assert.throws(() => readConfigFile(path.join(dir, 'missing.json')), (error) => error.reason === 'CONFIG_UNREADABLE');
        assert.throws(() => readConfigFile(dir), (error) => error.reason === 'CONFIG_UNREADABLE');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('发布身份必须独立、本机回环、同一业务库且不指向维护库', () => {
    const environment = assertPublishEnvironment(env());
    assert.deepEqual(environment, {
        connectionString: env().PUBLISH_DATABASE_URL, database, role,
    });
    assert.match(environment.role, /^pt_ledger_owner_[0-9a-f]{16}$/);
    const cases = [
        [{ ...env(), PUBLISH_DATABASE_URL: undefined }, 'PUBLISH_DATABASE_URL_REQUIRED'],
        [{ ...env(), DATABASE_URL: undefined }, 'PUBLISH_TARGET_CONFIRMATION_REQUIRED'],
        [{ ...env(), PUBLISH_DATABASE_URL: `postgres://publish_admin:pw@db.example.com:5432/${database}` }, 'PUBLISH_TARGET_NOT_LOOPBACK'],
        [{ ...env(), PUBLISH_DATABASE_URL: 'postgres://publish_admin:pw@127.0.0.1:5433/postgres', DATABASE_URL: 'postgres://pt_app:pw@127.0.0.1:5433/postgres' }, 'PUBLISH_TARGET_INVALID'],
        [{ ...env(), DATABASE_URL: 'postgres://pt_app:pw@127.0.0.1:5433/other_db' }, 'PUBLISH_TARGET_MUST_MATCH'],
        [{ ...env(), DATABASE_URL: `postgres://publish_admin:pw@127.0.0.1:5433/${database}` }, 'PUBLISH_IDENTITY_MUST_DIFFER'],
        [{ ...env(), PAINTTRACK_WORKER_DATABASE_URL: `postgres://publish_admin:pw@127.0.0.1:5433/${database}` }, 'PUBLISH_IDENTITY_MUST_DIFFER'],
    ];
    for (const [input, reason] of cases) assert.throws(() => assertPublishEnvironment(input), (error) => error.reason === reason, reason);
});

test('事务外语句被拒绝，BEGIN 后必须真的切换到 owner 且回读一致', async () => {
    const outside = fakePool();
    const outsidePool = createOwnerSessionPool({ connectionString: 'postgres://x@127.0.0.1:5433/d', role, PoolImpl: outside.PoolImpl });
    const client = await outsidePool.connect();
    await assert.rejects(client.query('SELECT 1'), (error) => error.reason === 'PRICING_SESSION_UNBOUND');
    assert.equal(outside.calls.length, 0, '事务外语句不得发出');
    client.release();
    await outsidePool.end();

    const wrong = fakePool({ currentUser: 'pt_app' });
    const wrongPool = createOwnerSessionPool({ connectionString: 'postgres://x@127.0.0.1:5433/d', role, PoolImpl: wrong.PoolImpl });
    const wrongClient = await wrongPool.connect();
    await assert.rejects(wrongClient.query('BEGIN ISOLATION LEVEL READ COMMITTED'), (error) => error.reason === 'PRICING_EXECUTOR_REQUIRED');
    assert.deepEqual(wrong.calls.slice(0, 3).map((call) => call.sql), [
        'BEGIN ISOLATION LEVEL READ COMMITTED', `SET LOCAL ROLE "${role}"`, 'SELECT current_user AS current_user',
    ]);
    assert.equal(wrong.calls.at(-1).sql, 'ROLLBACK', '切角色失败必须回滚事务');
    wrongClient.release();
    await wrongPool.end();

    const ok = fakePool();
    const okPool = createOwnerSessionPool({ connectionString: 'postgres://x@127.0.0.1:5433/d', role, PoolImpl: ok.PoolImpl });
    const okClient = await okPool.connect();
    await okClient.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    assert.deepEqual(ok.calls.slice(0, 3).map((call) => call.sql), [
        'BEGIN ISOLATION LEVEL READ COMMITTED', `SET LOCAL ROLE "${role}"`, 'SELECT current_user AS current_user',
    ]);
    okClient.release();
    await okPool.end();
});

test('只读时间轴在 owner 事务内执行，并回滚掉被掉包的 owner 角色', async () => {
    const ok = fakePool({ rows: [{ id: 'v1', pricing_version: 'v1', config_hash: 'a'.repeat(64), effective_from_us: '1800000000000000', published_at_us: '1799999999000000', revoked_at_us: null, cancelled_at_us: null }] });
    const okPool = createOwnerSessionPool({ connectionString: 'postgres://x@127.0.0.1:5433/d', role, PoolImpl: ok.PoolImpl });
    const versions = await readTimeline(okPool, role, 'm1');
    assert.deepEqual(versions, [{ id: 'v1', pricingVersion: 'v1', configHash: 'a'.repeat(64), effectiveFromUs: '1800000000000000', publishedAtUs: '1799999999000000', revokedAtUs: null, cancelledAtUs: null }]);
    assert.deepEqual(ok.calls.map((call) => call.sql).filter((sql) => /^(COMMIT|ROLLBACK)$/.test(sql)), ['COMMIT']);
    await okPool.end();

    const login = fakePool({ roleRow: { rolcanlogin: true, rolinherit: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false } });
    const loginPool = createOwnerSessionPool({ connectionString: 'postgres://x@127.0.0.1:5433/d', role, PoolImpl: login.PoolImpl });
    await assert.rejects(readTimeline(loginPool, role, 'm1'), (error) => error.reason === 'LEDGER_OWNER_ATTRIBUTES_INVALID');
    assert.deepEqual(login.calls.map((call) => call.sql).filter((sql) => /^(COMMIT|ROLLBACK)$/.test(sql)), ['ROLLBACK']);
    await loginPool.end();

    const noWrite = fakePool({ canWrite: false });
    const noWritePool = createOwnerSessionPool({ connectionString: 'postgres://x@127.0.0.1:5433/d', role, PoolImpl: noWrite.PoolImpl });
    await assert.rejects(readTimeline(noWritePool, role, 'm1'), (error) => error.reason === 'LEDGER_OWNER_NOT_PREPARED');
    await noWritePool.end();
});

test('dry-run 只做本地校验，绝不建立连接', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-pricing-'));
    try {
        const file = path.join(dir, 'price.json');
        fs.writeFileSync(file, JSON.stringify({
            modelId: 'm1', modelVersion: 1, pricingVersion: 'v1', enabled: true,
            templateType: 'image_resolution_quantity', currencyUnit: 'credit_tenths', roundingMode: 'ceil_to_atom',
            precisionVersion: 'integer_rational_ms_v1', roundingModeVersion: 'ceil_to_atom_v1', quantityMode: 'per_unit',
            maxOutputCount: 1, resolutions: [{ resolutionKey: '1024x1024', enabled: true, unitPriceTenths: '7' }],
        }));
        let touched = false;
        function PoolImpl() { touched = true; throw new Error('dry-run 不得建立连接'); }
        let printed = '';
        const result = await main({
            argv: ['publish', '--config', file, '--effective-from', '@1800000000', '--dry-run'],
            env: {}, output: { write: (chunk) => { printed += chunk; } }, PoolImpl,
        });
        assert.equal(touched, false);
        assert.equal(result.dryRun, true);
        assert.equal(result.effectiveFromUs, '1800000000000000');
        assert.match(result.configHash, /^[0-9a-f]{64}$/);
        assert.equal(JSON.parse(printed).pricingVersion, 'v1');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('失败时输出稳定错误码并以非零退出码结束，不泄露连接信息', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-pricing-'));
    const originalExitCode = process.exitCode;
    try {
        let out = '';
        let err = '';
        const result = await main({
            argv: ['publish', '--config', path.join(dir, 'missing.json'), '--effective-from', '@1800000000'],
            env: env(),
            output: { write: (chunk) => { out += chunk; } },
            errorOutput: { write: (chunk) => { err += chunk; } },
            PoolImpl: function PoolImpl() { throw new Error('不应建立连接'); },
        });
        process.exitCode = originalExitCode;
        assert.equal(result, null);
        assert.match(out, /价格配置文件无法读取/);
        assert.doesNotMatch(out, /pw@|postgres:\/\//);
        assert.equal(err, 'CONFIG_UNREADABLE\n');
    } finally {
        process.exitCode = originalExitCode;
        fs.rmSync(dir, { recursive: true, force: true });
    }
    assert.equal(shortFailure(Object.assign(new Error('x'), { reason: 'EFFECTIVE_TIME_INVALID' })).code, 'EFFECTIVE_TIME_INVALID');
    assert.deepEqual(shortFailure(Object.assign(new Error('x'), { code: '42501' })), { message: '数据库拒绝了该操作：当前身份不能切换到专用账务 owner。', code: 'PUBLISH_SET_ROLE_DENIED' });
    assert.equal(shortFailure(new Error('boom')).code, 'PRICING_PUBLISH_FAILED');
});
