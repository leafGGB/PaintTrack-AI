const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const migrationPath = path.join(root, 'drizzle/0024_credit_ledger_foundation.sql');
const source = fs.readFileSync(migrationPath, 'utf8');
const statements = source.split('--> statement-breakpoint').map((statement) => statement.replace(/^\s*--[^\n]*(?:\n|$)/gm, '').trim()).filter(Boolean);
const { adminModelsOwnerRole, ledgerOwnerRole, migrateDatabase, prepareLedgerOwner } = require('../lib/server/db/migrate');
const functions = [...source.matchAll(/CREATE FUNCTION public\.(\w+)\([^]*?\$fn\$;/g)].map((match) => match[0]);

// 这里仅验证离线结构与授权棘轮；数据库行为由真实 PG fixture 验证，不能互相替代。
test('0024 保持 LF、连续journal编号和snapshot前驱，不改写历史快照', () => {
    assert.equal(fs.readFileSync(migrationPath).includes(13), false);
    const journal = require('../drizzle/meta/_journal.json');
    const entry = journal.entries.find(entry => entry.tag === '0024_credit_ledger_foundation');
    assert.equal(entry.idx, journal.entries[journal.entries.indexOf(entry) - 1].idx + 1);
    assert.equal(require('../drizzle/meta/0024_snapshot.json').prevId, require('../drizzle/meta/0023_snapshot.json').id);
    const identityIndex = statements.findIndex((sql) => sql.startsWith('CREATE UNIQUE INDEX "credit_ledger_events_identity_unique"'));
    const identityFk = statements.findIndex((sql) => sql.includes('ADD CONSTRAINT "credit_reservations_event_identity_fk"'));
    assert.ok(identityIndex >= 0 && identityIndex < identityFk, '复合外键依赖的唯一索引必须先创建');
});

test('内部函数全部固定安全路径、对象限定、PUBLIC撤权且专用owner无事件/余额写权限', () => {
    assert.deepEqual(functions.map((sql) => sql.match(/public\.(\w+)\(/)[1]).sort(), [
        'credit_assert_reservation_replay', 'credit_check_task_owner', 'credit_initialize_zero_account', 'credit_reject_mutation',
    ]);
    for (const sql of functions) {
        assert.match(sql, /SECURITY DEFINER SET search_path = pg_catalog, pg_temp/);
        assert.match(sql, /END;\s*\$fn\$;$/);
        assert.doesNotMatch(sql, /\bEXECUTE\b|\bFROM credit_|\bINTO credit_/);
    }
    const revoke = statements.find((sql) => sql.startsWith('REVOKE ALL ON FUNCTION'));
    for (const sql of functions) assert.ok(revoke.includes(sql.match(/public\.(\w+)\(/)[1]));
    assert.match(revoke, /FROM PUBLIC/);
    assert.match(source, /NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb/);
    assert.match(source, /NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls AND NOT rolinherit/);
    assert.doesNotMatch(source, /GRANT EXECUTE|GRANT (?:ALL|UPDATE|DELETE|TRUNCATE)|CREATE ROLE/);
    assert.match(source, /REVOKE CREATE ON SCHEMA public/);
    assert.match(source, /GRANT SELECT\(user_id\), INSERT\(user_id\) ON public.credit_accounts/);
    assert.doesNotMatch(source, /GRANT .*ON public.credit_ledger_events TO/);
});

test('没有创建reserve/通用加钱函数，重放核验缺记录明确拒绝且异额冲突', () => {
    const initialize = functions.find((sql) => sql.includes('credit_initialize_zero_account('));
    assert.match(initialize, /INSERT INTO public.credit_accounts \(user_id\) VALUES \(p_user_id\) ON CONFLICT \(user_id\) DO NOTHING/);
    assert.doesNotMatch(initialize, /available_tenths|reserved_tenths|UPDATE|credit_ledger_events/);
    const replay = functions.find((sql) => sql.includes('credit_assert_reservation_replay('));
    assert.doesNotMatch(replay, /INSERT|UPDATE|DELETE|p_owner|p_user/);
    assert.match(replay, /CREDIT_RESERVE_NOT_CONNECTED/);
    assert.match(replay, /existing.credit_tenths <> p_credit_tenths/);
    assert.match(replay, /ERRCODE = '23505', MESSAGE = 'CREDIT_REPLAY_AMOUNT_CONFLICT'/);
    assert.match(replay, /pg_catalog.trunc\(p_credit_tenths\)/);
    assert.equal((source.match(/BEFORE UPDATE OR DELETE OR TRUNCATE/g) || []).length, 2);
    assert.equal((source.match(/BEFORE INSERT ON public.credit_/g) || []).length, 2);
});

test('金额使用无预取整numeric加整数/上界CHECK，不接受小数被类型隐式舍入', () => {
    const snapshot = require('../drizzle/meta/0024_snapshot.json');
    for (const table of ['credit_accounts', 'credit_ledger_events', 'credit_reservations']) {
        const definition = snapshot.tables[`public.${table}`];
        const amountColumns = Object.values(definition.columns).filter((column) => column.name.endsWith('tenths'));
        assert.ok(amountColumns.length > 0);
        for (const column of amountColumns) {
            assert.equal(column.type, 'numeric');
            assert.ok(Object.values(definition.checkConstraints).some((check) => check.value.includes(column.name) && check.value.includes('trunc(') && check.value.includes('9223372036854775807')));
        }
    }
    assert.match(source, /idempotency_key" = 'reserve:' \|\|/);
    assert.match(source, /FOREIGN KEY \("reserve_event_id","user_id","task_id","credit_tenths"\)/);
});

test('账户页仅获得账务投影只读列，Worker与cleanup不涉及账务，隔离PG入口预建NOLOGIN角色并撤回DDL成员关系', async () => {
    const permissions = require('../lib/server/db/runtimePermissions');
    const cases = [
        { grant: permissions.grantWebRuntimePermissions, role: 'pt_runtime_check_aabbcc', kind: 'web' },
        { grant: permissions.grantWorkerRuntimePermissions, role: 'pt_worker_check_aabbcc', kind: 'worker' },
        { grant: permissions.grantCleanupRuntimePermissions, role: 'pt_cleanup_check_aabbcc', kind: 'cleanup' },
    ];
    for (const { grant, role, kind } of cases) {
        const calls = [];
        await grant({ query: async (sql) => calls.push(sql) }, role);
        assert.ok(calls.length > 0);
        const joined = calls.join('\n');
        if (kind === 'web') {
            // 账户中心需要余额/账单投影；只允许明确的列级 SELECT，禁止账务写入、函数执行和宽泛授权。
            assert.match(joined, /GRANT SELECT \(user_id,available_tenths,reserved_tenths,unit_version\) ON credit_accounts TO/);
            assert.match(joined, /GRANT SELECT \(id,user_id,task_id,kind,credit_tenths,source_type,created_at\) ON credit_ledger_events TO/);
            assert.doesNotMatch(joined, /GRANT (?:INSERT|UPDATE|DELETE|TRUNCATE|ALL|REFERENCES).*credit_/i);
            assert.doesNotMatch(joined, /GRANT .*ON .*credit_.* TO .* WITH GRANT OPTION/i);
            assert.doesNotMatch(joined, /EXECUTE/i);
        } else {
            assert.doesNotMatch(joined, /credit_|ledger|EXECUTE/);
        }
    }
    const acceptance = fs.readFileSync(path.join(root, 'scripts/accept-database-local.js'), 'utf8');
    assert.match(acceptance, /await prepareLedgerOwner\(client, names.database\)/);
    assert.match(acceptance, /localDatabaseAdminUrl: adminUrl/);
    assert.doesNotMatch(acceptance, /GRANT \$\{quote\(names.ledgerOwnerRole\)\}/);
    assert.match(acceptance, /runFixture\('credit-foundation-postgres'/);
    const fixture = require('./fixtures/credit-foundation-postgres.cjs');
    assert.equal(typeof fixture.checkCreditFoundation, 'function');
});

const safeOwner = () => ({ rolcanlogin: false, rolinherit: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
const migrationSettings = {
    databaseUrl: 'postgres://runtime:synthetic@127.0.0.1:5433/pt_local_auth_owner_test',
    migrationDatabaseUrl: 'postgres://migrator:synthetic@127.0.0.1:5433/pt_local_auth_owner_test',
    localDatabaseAdminUrl: 'postgres://admin:synthetic@127.0.0.1:5433/postgres',
};

function migrationHarness({ failures = [], attrs = safeOwner(), memberships = [], exists = true, identity } = {}) {
    const events = [];
    const granted = new Set();
    const existing = new Set();
    const fault = (stage) => { if (failures.includes(stage)) throw new Error(stage); };
    class Client {
        constructor(options) { this.kind = options.application_name === 'painttrack-migrator' ? 'migration' : 'admin'; events.push({ stage: `${this.kind}-construct`, options }); }
        async connect() { const stage = `${this.kind}-connect`; events.push({ stage }); fault(stage); }
        async query(sql, values) {
            events.push({ stage: 'query', kind: this.kind, sql, values });
            if (sql.startsWith('SELECT current_database()')) return { rows: [identity || { database: 'pt_local_auth_owner_test', username: 'migrator' }] };
            if (sql.startsWith('SELECT rolcanlogin')) { fault('inspect'); return { rows: exists || existing.has(values[0]) ? [attrs] : [] }; }
            if (sql.startsWith('SELECT 1 FROM pg_catalog.pg_auth_members')) return { rows: granted.has(values[0]) ? [{ member: 'migrator' }] : memberships };
            const role = sql.match(/"([^"]+)"/)?.[1];
            if (sql.startsWith('CREATE ROLE')) { fault('create'); existing.add(role); }
            // 模拟服务端已经提交 GRANT、客户端却收到错误；仍必须尝试撤权。
            if (sql.startsWith('GRANT')) { granted.add(role); fault('grant'); if (role.startsWith('pt_admin_models_owner_')) fault('projection-grant'); }
            if (sql.startsWith('REVOKE')) { fault('revoke'); if (!failures.includes('revoke-noop')) granted.delete(role); }
            if (sql.includes('pg_advisory_unlock')) fault('unlock');
            return { rows: [] };
        }
        async end() { const stage = `${this.kind}-end`; events.push({ stage }); fault(stage); }
    }
    return {
        events,
        run: (settings = migrationSettings) => migrateDatabase(settings, {
            Client,
            migrate: async (database) => {
                assert.equal(database.$client.kind, 'migration');
                assert.deepEqual([...granted], [ledgerOwnerRole('pt_local_auth_owner_test'), adminModelsOwnerRole('pt_local_auth_owner_test')]);
                events.push({ stage: 'apply' });
                fault('apply');
            },
        }),
    };
}

test('ledger owner 名称按数据库 UTF-8 MD5 稳定推导，与0024一致且不依赖登录角色', () => {
    const crypto = require('node:crypto');
    assert.match(source, /'pt_ledger_owner_' \|\| pg_catalog.substr\(pg_catalog.md5\(pg_catalog.current_database\(\)\), 1, 16\)/);
    for (const database of ['pt_local_auth_000000000000', 'pt_acceptance_test_abcdef', '测试库']) {
        assert.equal(ledgerOwnerRole(database), `pt_ledger_owner_${crypto.createHash('md5').update(database, 'utf8').digest('hex').slice(0, 16)}`);
        assert.match(ledgerOwnerRole(database), /^pt_ledger_owner_[a-f0-9]{16}$/);
    }
    assert.notEqual(ledgerOwnerRole('one'), ledgerOwnerRole('two'));
});

test('owner准备首次严格创建、再次仅校验，保持幂等且绝不ALTER未知角色', async () => {
    const queries = [];
    let exists = false;
    const admin = { query: async (sql, values) => {
        queries.push({ sql, values });
        if (sql.startsWith('SELECT rolcanlogin')) return { rows: exists ? [safeOwner()] : [] };
        if (sql.startsWith('CREATE ROLE')) exists = true;
        return { rows: [] };
    } };
    const first = await prepareLedgerOwner(admin, 'pt_local_auth_owner_test');
    assert.equal(await prepareLedgerOwner(admin, 'pt_local_auth_owner_test'), first);
    assert.deepEqual(queries.filter(({ sql }) => sql.startsWith('CREATE ROLE')).map(({ sql }) => sql), [
        `CREATE ROLE "${first}" NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
    ]);
    assert.doesNotMatch(queries.map(({ sql }) => sql).join('\n'), /ALTER ROLE|GRANT|PASSWORD/);
});

for (const attribute of Object.keys(safeOwner())) {
    test(`已有owner ${attribute}异常时fail closed，不修复、不迁移、不授权`, async () => {
        const harness = migrationHarness({ attrs: { ...safeOwner(), [attribute]: true } });
        await assert.rejects(harness.run(), /LEDGER_OWNER_ATTRIBUTES_INVALID/);
        assert.ok(!harness.events.some(({ sql, stage }) => /^(?:ALTER|CREATE|GRANT|REVOKE)/.test(sql || '') || stage === 'apply'));
        assert.equal(harness.events.at(-1).stage, 'migration-end');
    });
}

for (const membership of [{ roleid: 'unrelated', member: 'owner' }, { roleid: 'owner', member: 'runtime' }, { roleid: 'owner', member: 'migrator' }]) {
    test(`已有owner成员关系异常 ${membership.member} 时拒绝，不能继承身份或接纳运行成员`, async () => {
        const harness = migrationHarness({ memberships: [membership] });
        await assert.rejects(harness.run(), /LEDGER_OWNER_MEMBERSHIP_INVALID/);
        assert.ok(!harness.events.some(({ sql, stage }) => /^GRANT/.test(sql || '') || stage === 'apply'));
    });
}

test('普通迁移仅锁内临时授migration SET能力，重复运行均撤回且owner不进入连接', async () => {
    const harness = migrationHarness({ exists: false });
    await harness.run();
    await harness.run();
    const owner = ledgerOwnerRole('pt_local_auth_owner_test');
    const queries = harness.events.filter(({ stage }) => stage === 'query');
    const projection = adminModelsOwnerRole('pt_local_auth_owner_test');
    assert.equal(queries.filter(({ sql }) => sql.startsWith('CREATE ROLE')).length, 2);
    const cycle = [
        `GRANT "${owner}" TO "migrator" WITH INHERIT FALSE, SET TRUE`,
        `GRANT "${projection}" TO "migrator" WITH INHERIT FALSE, SET TRUE`,
        `REVOKE "${projection}" FROM "migrator"`, `REVOKE "${owner}" FROM "migrator"`,
    ];
    assert.deepEqual(queries.filter(({ sql }) => /^(?:GRANT|REVOKE)/.test(sql)).map(({ sql }) => sql), [...cycle, ...cycle]);
    const firstGrant = harness.events.findIndex(({ sql }) => sql?.startsWith('GRANT'));
    const firstRevoke = harness.events.findIndex(({ sql }) => sql?.startsWith('REVOKE'));
    assert.ok(harness.events.findIndex(({ sql }) => sql?.includes('pg_advisory_lock')) < firstGrant);
    assert.ok(firstGrant < harness.events.findIndex(({ stage }) => stage === 'apply'));
    assert.ok(firstRevoke < harness.events.findIndex(({ sql }) => sql?.includes('pg_advisory_unlock')));
    for (const { options } of harness.events.filter(({ options }) => options)) {
        assert.ok(!options.connectionString.includes(owner));
        assert.ok([migrationSettings.migrationDatabaseUrl, migrationSettings.localDatabaseAdminUrl].includes(options.connectionString));
    }
});

for (const failure of ['migration-connect', 'admin-connect', 'inspect', 'create', 'grant', 'projection-grant', 'apply', 'revoke', 'revoke-noop', 'unlock', 'admin-end', 'migration-end']) {
    test(`迁移准备 ${failure} 分支拒绝且可靠关闭，授权已尝试则finally撤回`, async () => {
        const harness = migrationHarness({ failures: [failure], exists: failure !== 'create' });
        await assert.rejects(harness.run());
        const roles = prefix => harness.events.filter(({ sql }) => sql?.startsWith(prefix)).map(({ sql }) => sql.split('"')[1]);
        assert.deepEqual(roles('REVOKE'), roles('GRANT').reverse());
        assert.equal(harness.events.filter(({ stage }) => stage === 'admin-end').length, 1);
        assert.equal(harness.events.filter(({ stage }) => stage === 'migration-end').length, 1);
        if (failure === 'revoke-noop') assert.ok(harness.events.some(({ sql }) => sql?.startsWith('REVOKE')));
    });
}

test('迁移失败、撤权失败及关闭失败同时保留，不允许清理错误掩盖撤权错误', async () => {
    const harness = migrationHarness({ failures: ['apply', 'revoke', 'unlock', 'admin-end', 'migration-end'] });
    await assert.rejects(harness.run(), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors.map(({ message }) => message), ['apply', 'revoke', 'revoke', 'unlock', 'admin-end', 'migration-end']);
        return true;
    });
});

test('管理员连接缺失、目标错误或owner混入登录身份时，连接构造前拒绝', async () => {
    const owner = ledgerOwnerRole('pt_local_auth_owner_test');
    for (const settings of [
        { ...migrationSettings, localDatabaseAdminUrl: undefined },
        { ...migrationSettings, localDatabaseAdminUrl: migrationSettings.localDatabaseAdminUrl.replace('5433', '5432') },
        { ...migrationSettings, localDatabaseAdminUrl: migrationSettings.localDatabaseAdminUrl.replace('127.0.0.1', 'remote.test') },
        { ...migrationSettings, localDatabaseAdminUrl: migrationSettings.localDatabaseAdminUrl.replace('/postgres', '/business') },
        { ...migrationSettings, localDatabaseAdminUrl: migrationSettings.localDatabaseAdminUrl.replace('admin:', 'migrator:') },
        { ...migrationSettings, localDatabaseAdminUrl: migrationSettings.localDatabaseAdminUrl.replace('admin:', 'runtime:') },
        { ...migrationSettings, migrationDatabaseUrl: migrationSettings.migrationDatabaseUrl.replace('migrator:', `${owner}:`) },
        { ...migrationSettings, databaseUrl: migrationSettings.databaseUrl.replace('runtime:', `${owner}:`) },
        { ...migrationSettings, localDatabaseAdminUrl: `${migrationSettings.localDatabaseAdminUrl}?options=-crole=owner` },
    ]) {
        const harness = migrationHarness();
        await assert.rejects(harness.run(settings));
        assert.deepEqual(harness.events, []);
    }
    const harness = migrationHarness({ identity: { database: 'other', username: 'migrator' } });
    await assert.rejects(harness.run(), /MIGRATION_IDENTITY_MISMATCH/);
    assert.ok(!harness.events.some(({ stage }) => stage === 'admin-connect'));
});

test('本地启动沿用历史owner派生登录角色，业务子进程环境不带准备连接或owner', () => {
    const launcher = require('../scripts/local-registration');
    const adminUrl = migrationSettings.localDatabaseAdminUrl;
    const owner = ledgerOwnerRole('pt_local_auth_owner_test');
    assert.throws(() => launcher.localRoleUrl(adminUrl, owner, 'synthetic', 'pt_local_auth_owner_test'), /LEDGER_OWNER_RUNTIME_IDENTITY_FORBIDDEN/);
    assert.deepEqual(launcher.localRolesFromOwner('pt_local_migrate_history'), {
        migrationRole: 'pt_local_migrate_history', runtimeRole: 'pt_local_runtime_history', workerRole: 'pt_local_worker_history', cleanupRole: 'pt_local_cleanup_history',
    });
    const source = { LOCAL_DATABASE_ADMIN_URL: adminUrl, MIGRATION_DATABASE_URL: migrationSettings.migrationDatabaseUrl, LEDGER_OWNER_ROLE: owner };
    const environments = [
        launcher.createNextEnvironment({ runtimeUrl: migrationSettings.databaseUrl, internalPort: 3001, origin: 'http://127.0.0.1:3000', secret: 'synthetic', mfaEncryptionKey: 'synthetic', suffix: 'test', heapMb: 3072 }, source),
        launcher.createWorkerEnvironment('postgres://worker:synthetic@127.0.0.1:5433/pt_local_auth_owner_test', source),
        launcher.createCleanupEnvironment('postgres://cleanup:synthetic@127.0.0.1:5433/pt_local_auth_owner_test', source),
    ];
    for (const environment of environments) assert.doesNotMatch(JSON.stringify(environment), /LOCAL_DATABASE_ADMIN_URL|MIGRATION_DATABASE_URL|LEDGER_OWNER_ROLE|pt_ledger_owner_|admin:|migrator:/);
    const startup = fs.readFileSync(path.join(root, 'scripts/local-registration.js'), 'utf8');
    assert.match(startup, /await migrateDatabase\(\{ databaseUrl: runtimeUrl, migrationDatabaseUrl: migrationUrl, localDatabaseAdminUrl: adminUrl \}\)/);
    const cli = fs.readFileSync(path.join(root, 'scripts/migrate.js'), 'utf8');
    assert.match(cli, /localDatabaseAdminUrl: process.env.LOCAL_DATABASE_ADMIN_URL/);
});
