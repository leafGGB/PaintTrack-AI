const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseEnvironment } = require('../lib/server/env');
const { assertDistinctRuntimeIdentity, assertIsolatedTestTarget, assertMigrationIdentity, sameDatabaseTarget } = require('../lib/server/db/testIsolation');
const { migrateDatabase, migrationConfig } = require('../lib/server/db/migrate');

const runtime = 'postgres://runtime:secret@127.0.0.1:5433/painttrack_dev';
const migration = 'postgres://migrator:secret@127.0.0.1:5433/painttrack_dev';
const isolated = 'postgres://runtime:secret@127.0.0.1:5433/painttrack_test';

test('Web、Worker 与 Migration 必须使用同目标下彼此独立的身份', () => {
    const worker = 'postgres://worker:secret@127.0.0.1:5433/painttrack_dev';
    assert.deepEqual(assertDistinctRuntimeIdentity(runtime, worker).worker.username, 'worker');
    assert.throws(() => assertDistinctRuntimeIdentity(runtime, runtime), /identities must differ/);
    assert.throws(() => assertDistinctRuntimeIdentity(runtime, worker.replace('painttrack_dev', 'other')), /targets must match/);
    assert.throws(() => assertDistinctRuntimeIdentity(undefined, worker), /required/);
    assert.throws(() => assertDistinctRuntimeIdentity(runtime, undefined), /required/);
});

test('迁移必须显式使用同目标的独立身份，不能回退运行凭据', () => {
    assert.throws(() => assertMigrationIdentity(undefined, runtime), /MIGRATION_DATABASE_URL/);
    assert.throws(() => assertMigrationIdentity(runtime, runtime), /identities must differ/);
    assert.throws(() => assertMigrationIdentity(isolated, runtime), /targets must match/);
    assert.throws(() => assertMigrationIdentity(migration.replace('migrator', '%72untime'), runtime), /identities must differ/);
    assert.equal(assertMigrationIdentity(migration, runtime).database, 'painttrack_dev');
});

test('隔离守卫保留 loopback 实例地址并校验 URL 编码与连接参数', () => {
    assert.equal(sameDatabaseTarget(runtime, `postgres://other:other@127.0.0.1:5433/%70ainttrack_dev`), true);
    for (const host of ['localhost', 'localhost.', '127.0.0.2', '[::1]']) {
        assert.equal(sameDatabaseTarget(runtime, `postgres://other:other@${host}:5433/painttrack_dev`), false);
        assert.throws(() => assertIsolatedTestTarget({ testDatabaseUrl: isolated.replace('127.0.0.1', host), databaseUrl: isolated }), /must differ/);
    }
    for (const query of ['host=example.test', 'port=5555', 'database=other', 'user=admin', 'options=-csearch_path=evil', 'sslmode=disable&sslmode=require', 'application_name=x&host=localhost']) {
        assert.equal(parseEnvironment({ TEST_DATABASE_URL: `${isolated}?${query}` }).success, false);
        assert.throws(() => assertIsolatedTestTarget({ testDatabaseUrl: `${isolated}?${query}` }), /Invalid PostgreSQL/);
    }
    for (const value of ['not-a-url', isolated.replace('127.0.0.1', 'example.test'), isolated.replace('painttrack_test', 'painttrack_dev')]) {
        assert.throws(() => assertIsolatedTestTarget({ testDatabaseUrl: value }));
    }
    assert.throws(() => assertIsolatedTestTarget({ testDatabaseUrl: isolated, databaseUrl: 'broken' }));
    assert.throws(() => assertIsolatedTestTarget({ testDatabaseUrl: isolated, migrationDatabaseUrl: isolated }), /must differ/);
    assert.throws(() => assertIsolatedTestTarget({ testDatabaseUrl: isolated, databaseUrl: isolated.replace('127.0.0.1:5433', 'db.internal:6432') }), /must differ/);
    assert.throws(() => assertIsolatedTestTarget({ testDatabaseUrl: isolated, testMigrationDatabaseUrl: isolated }), /identities/);
});

test('本地验收连接入口拒绝远端、覆盖参数及历史端口以外的目标', () => {
    const { localAdminUrl, localUrl } = require('../scripts/accept-database-local');
    assert.equal(new URL(localUrl(isolated)).hostname, '127.0.0.1');
    assert.equal(new URL(localUrl(isolated.replace('127.0.0.1', 'localhost'))).hostname, '127.0.0.1');
    assert.equal(new URL(localAdminUrl('postgres://admin:secret@127.0.0.1:5433/postgres')).pathname, '/postgres');
    for (const value of [isolated.replace('5433', '5432'), isolated.replace('127.0.0.1', 'remote.test'), `${isolated}?host=remote.test`]) {
        assert.throws(() => localUrl(value));
    }
    for (const value of [isolated, 'postgres://admin:secret@127.0.0.1:5433/template1', 'postgres://admin:secret@127.0.0.1:5433/%70ainttrack_dev']) {
        assert.throws(() => localAdminUrl(value), /postgres/);
    }
});

test('迁移配置缺失时 CLI 安全失败且无连接凭据输出', () => {
    const { spawnSync } = require('node:child_process');
    const env = { ...process.env, DATABASE_URL: runtime };
    delete env.MIGRATION_DATABASE_URL;
    const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/migrate.js')], { env, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /dedicated migration identity/);
    assert.doesNotMatch(result.stderr, /secret|postgres:\/\//);
});

test('所有数据库 URL 校验不回显凭据，新增迁移配置保持独立', () => {
    const result = parseEnvironment({ DATABASE_URL: runtime, MIGRATION_DATABASE_URL: migration, TEST_MIGRATION_DATABASE_URL: migration.replace('painttrack_dev', 'painttrack_test') });
    assert.equal(result.success, true);
    assert.equal(result.data.migrationDatabaseUrl, migration);
    for (const key of ['DATABASE_URL', 'TEST_DATABASE_URL', 'MIGRATION_DATABASE_URL', 'TEST_MIGRATION_DATABASE_URL']) {
        const invalid = parseEnvironment({ [key]: 'postgres://user:highly-secret@localhost/db?host=remote' });
        assert.equal(invalid.success, false);
        assert.doesNotMatch(invalid.errors.join(' '), /highly-secret/);
    }
});

for (const failure of ['none', 'connect', 'migration', 'unlock']) {
    test(`迁移连接与 advisory lock 在 ${failure} 分支可靠关闭`, async () => {
        const events = [];
        class Client {
            constructor(options) { this.admin = options.application_name === 'painttrack-ledger-owner-preparation'; }
            async connect() { events.push(this.admin ? 'admin-connect' : 'connect'); if (failure === 'connect' && !this.admin) throw new Error('连接失败'); }
            async query(text) {
                events.push(text);
                if (failure === 'unlock' && text.includes('unlock')) throw new Error('解锁失败');
                if (text.startsWith('SELECT current_database()')) return { rows: [{ database: 'painttrack_dev', username: 'migrator' }] };
                if (text.includes('FROM pg_catalog.pg_roles WHERE rolname = $1') && !text.includes('pg_auth_members')) {
                    return { rows: [{ rolcanlogin: false, rolinherit: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false }] };
                }
                return { rows: [] };
            }
            async end() { events.push(this.admin ? 'admin-end' : 'end'); }
        }
        const action = migrateDatabase({ migrationDatabaseUrl: migration, databaseUrl: runtime, localDatabaseAdminUrl: 'postgres://admin:secret@127.0.0.1:5433/postgres' }, {
            Client,
            migrate: async (_db, config) => {
                assert.equal(config, migrationConfig);
                assert.ok(path.isAbsolute(config.migrationsFolder));
                events.push('migration');
                if (failure === 'migration') throw new Error('迁移失败');
            },
        });
        if (failure === 'none') await action;
        else await assert.rejects(action);
        assert.equal(events.at(-1), 'end');
        assert.equal(events.filter((value) => value === 'end').length, 1);
        assert.equal(events.some((value) => value.includes('unlock')), failure !== 'connect');
    });
}

test('最新 snapshot 与两个 schema 完整一致，历史迁移未被改写', async () => {
    const { generateDrizzleJson, generateMigration } = require('drizzle-kit/api');
    const journal = require('../drizzle/meta/_journal.json');
    const latest = journal.entries.at(-1);
    // snapshot 文件名跟随迁移的 tag 前缀，不能用 journal 下标推断：历史迁移 0009 已归档后，
    // idx 与 tag 编号不再相等（idx 10 对应 0011_provider_calls）。
    const latestSnapshotFile = latest.tag.split('_')[0];
    const snapshot = require(`../drizzle/meta/${latestSnapshotFile}_snapshot.json`);
    for (const name of ['schema.js', 'schema.cjs']) {
        const current = generateDrizzleJson(require(`../lib/server/db/${name}`), snapshot.id);
        current.id = snapshot.id;
        current.prevId = snapshot.prevId;
        assert.deepEqual(await generateMigration(snapshot, current), []);
    }
    // 从 journal 定位紧邻前驱，不能用 idx 推断含历史编号空洞的 snapshot 文件名。
    const previousPrefix = journal.entries.at(-2).tag.split('_')[0];
    const previousSnapshot = require(`../drizzle/meta/${previousPrefix}_snapshot.json`);
    assert.notEqual(snapshot.id, previousSnapshot.id);
    assert.equal(snapshot.prevId, previousSnapshot.id);
    const expectedSnapshot = generateDrizzleJson(require('../lib/server/db/schema.js'), previousSnapshot.id);
    expectedSnapshot.id = snapshot.id;
    expectedSnapshot.prevId = previousSnapshot.id;
    const generatedStatements = await generateMigration(previousSnapshot, expectedSnapshot);
    const migrationStatements = fs.readFileSync(path.join(migrationConfig.migrationsFolder, `${latest.tag}.sql`), 'utf8')
        .split('--> statement-breakpoint')
        .map((statement) => statement.replace(/^\s*--[^\n]*(?:\n|$)/gm, '').trim())
        .filter(Boolean);
    const schemaStatements = migrationStatements.filter((statement) => /^(?:CREATE TABLE|ALTER TABLE|CREATE (?:UNIQUE )?INDEX|DROP INDEX)\b/.test(statement));
    const extensionStatements = migrationStatements.filter((statement) => !schemaStatements.includes(statement));
    // 安全扩展（函数、触发器、授权）无法由 drizzle 生成器比对，只能逐条声明数量并由专项门禁与真实PG夹具覆盖。
    const expectedExtensions = { '0027_credit_settle_release': 8, '0028_credit_settlement_sweep': 4, '0029_credit_grant': 8, '0030_charged_task_submission': 6, '0031_verified_charge_amount': 3, '0032_admin_model_binding_projection': 4 };
    assert.equal(extensionStatements.length, expectedExtensions[latest.tag],
        `${latest.tag} 的安全扩展数量变化必须同步更新门禁与真实 PG fixture`);
    const normalizeStatement = (statement) => statement
        .replace(/;\s*$/, '')
        .replace(/"public"\."(logical_models|generation_tasks|pricing_quotes)"/g, '$1')
        .replace(/\bpublic\.(logical_models|generation_tasks|pricing_quotes)\b/g, '$1')
        .replace(/"(logical_models|generation_tasks|pricing_quotes)"/g, '$1')
        .replace(/"(?:logical_models|generation_tasks|pricing_quotes)"\."([a-z_]+)"/g, '"$1"')
        .replace(/\s+WHERE (?:pricing_quotes\.)?"?task_id"? IS NOT NULL\s*$/, '');
    assert.deepEqual(
        generatedStatements.map(normalizeStatement).sort(),
        schemaStatements.map(normalizeStatement).sort(),
    );
    const crypto = require('node:crypto');
    const original = {
        '0000_initial.sql': 'b4e0497804e46e0a0b0b8c31975b062152d551bac49c3c2e80932567b4085dcd',
        '0001_generation_tasks.sql': '480ca5ffc3bcb280e9e5ddb3ec1f9f60ba4828736c343a359994a48914ec2747',
        '0002_assets.sql': '96b33e8f7d2a4014b9981744de43b11ed2af66a11a0dd49ceb879cabb4d91106',
    };
    // 迁移链必须单调递增，且 migrations 目录里的 SQL 与 journal 记录一一对应，不能有孤儿文件或漏记。
    const migrationFiles = fs.readdirSync(migrationConfig.migrationsFolder)
        .filter((name) => name.endsWith('.sql'))
        .sort();
    assert.deepEqual(
        journal.entries.map((entry) => `${entry.tag}.sql`).sort(),
        migrationFiles,
    );
    for (let i = 0; i < journal.entries.length; i++) {
        const entry = journal.entries[i];
        assert.equal(entry.idx, i);
        if (i) assert.ok(entry.when > journal.entries[i - 1].when);
        assert.ok(fs.existsSync(path.join(migrationConfig.migrationsFolder, `${entry.tag}.sql`)));
    }
    for (const [name, hash] of Object.entries(original)) {
        assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(migrationConfig.migrationsFolder, name))).digest('hex'), hash);
    }
    assert.equal(Object.keys(snapshot.tables['public.assets'].checkConstraints).length, 9);
    assert.equal(Object.keys(snapshot.tables['public.generation_tasks'].checkConstraints).length, 13);
    assert.equal(Object.keys(require('../drizzle/meta/0015_snapshot.json').tables['public.generation_tasks'].checkConstraints).length, 10);
    assert.match(snapshot.tables['public.logical_models'].checkConstraints.logical_models_template_pair_check.value, /capability_template_version.*IS NOT NULL/);
    assert.match(snapshot.tables['public.logical_models'].checkConstraints.logical_models_schema_pair_check.value, /parameter_schema_version.*IS NOT NULL/);
    assert.match(snapshot.tables['public.generation_tasks'].checkConstraints.generation_tasks_route_snapshot_consistency_check.value, /route_snapshot_version.*IS NOT NULL.*route_snapshot_hash.*IS NOT NULL.*logical_model_pk.*IS NOT NULL/);
    assert.ok(snapshot.tables['public.__painttrack_schema_version']);
});

test('运行连接关闭可重入，关闭期间不新建连接，失败不泄露环境', async () => {
    const vm = require('node:vm');
    let created = 0;
    let ended = 0;
    let finish;
    class Pool {
        constructor() { created++; }
        end() { ended++; return new Promise((resolve) => { finish = resolve; }); }
    }
    const sandboxModule = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../lib/server/db/index.js'), 'utf8'), {
        module: sandboxModule,
        require(name) {
            if (name === 'pg') return { Pool };
            if (name === 'drizzle-orm/node-postgres') return { drizzle: (pool) => ({ pool, execute: async () => { throw new Error('secret'); } }) };
            if (name === 'drizzle-orm') return { sql: () => 'select 1' };
            if (name === '../env') return { getEnvironment: () => ({ databaseUrl: runtime }) };
            throw new Error('意外依赖');
        },
    });
    const db = sandboxModule.exports;
    assert.equal((await db.checkDatabaseHealth()).status, 'unavailable');
    const first = db.closeDatabase();
    const second = db.closeDatabase();
    assert.throws(() => db.getDatabase(), /closing/);
    assert.equal(ended, 1);
    finish();
    await Promise.all([first, second]);
    db.getDatabase();
    assert.equal(created, 2);
    const third = db.closeDatabase();
    finish();
    await third;
    await db.closeDatabase();
    assert.equal(ended, 2);
});
