'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { assertAcceptanceIdentities, checkLocalMockRoute } = require('./fixtures/local-mock-route-postgres.cjs');

const suffix = 'local123_abcdef';
const target = { database: `pt_acceptance_${suffix}`, migrationRole: `pt_migrate_${suffix}`, runtimeRole: `pt_runtime_${suffix}`, workerRole: `pt_worker_${suffix}` };
function identities() {
    return [target.migrationRole, target.runtimeRole, target.workerRole].map(role => ({
        database: target.database, role, session_role: role, database_owner: target.migrationRole,
        address: '127.0.0.1', port: 5433, privileged: false, has_membership: false,
    }));
}

test('本地mock数据库fixture仅接受同轮随机验收库的三个独立实际身份', () => {
    assert.doesNotThrow(() => assertAcceptanceIdentities(target, identities()));
    const ipv6 = identities().map(identity => ({ ...identity, address: '::1' }));
    assert.doesNotThrow(() => assertAcceptanceIdentities(target, ipv6));
    for (const mutation of [
        { database: 'painttrack_dev' }, { database: 'painttrack_test' }, { database: 'painttrack_production' },
        { database: 'pt_acceptance_unrelated' }, { runtimeRole: target.workerRole },
        { runtimeRole: 'pt_local_runtime_abcdef012345' }, { workerRole: target.migrationRole },
        { migrationRole: 'admin' }, { runtimeRole: `${target.runtimeRole}"; GRANT ALL` },
    ]) assert.throws(() => assertAcceptanceIdentities({ ...target, ...mutation }, identities()), /TARGET_REQUIRED/);
    for (let index = 0; index < 3; index++) {
        for (const mutation of [
            { database: 'painttrack_dev' }, { role: 'admin' }, { session_role: 'admin' },
            { database_owner: 'admin' }, { address: '192.0.2.1' }, { port: 5432 },
            { privileged: true }, { has_membership: true }, { privileged: null },
        ]) {
            const altered = identities();
            altered[index] = { ...altered[index], ...mutation };
            assert.throws(() => assertAcceptanceIdentities(target, altered), /IDENTITY_REQUIRED/);
        }
    }
});

test('回环地址按验收脚本语义等价接受，非回环仍拒绝并回显真值', () => {
    for (const address of ['127.0.0.1', '::1', '127.0.1.1', '::ffff:127.0.0.1', '127.0.0.1/32']) {
        const actual = identities().map(identity => ({ ...identity, address }));
        assert.doesNotThrow(() => assertAcceptanceIdentities(target, actual), `应接受回环写法 ${address}`);
    }
    for (const address of ['192.0.2.1', '::ffff:192.0.2.1', '172.17.0.2', '10.0.0.5', '127.0.0.1.example.com', '', null]) {
        const actual = identities();
        actual[0] = { ...actual[0], address };
        assert.throws(
            () => assertAcceptanceIdentities(target, actual),
            error => error.message.startsWith('LOCAL_MOCK_ACCEPTANCE_IDENTITY_REQUIRED identity[0] fields: address('),
            `应拒绝非回环地址 ${String(address)}`,
        );
    }
});

test('身份断言只报告序号与不匹配字段，不泄露身份值', () => {
    const actual = identities();
    actual[1].database_owner = 'unexpected-owner-value';
    assert.throws(
        () => assertAcceptanceIdentities(target, actual),
        error => error.message === 'LOCAL_MOCK_ACCEPTANCE_IDENTITY_REQUIRED identity[1] fields: database_owner'
            && !error.message.includes('unexpected-owner-value'),
    );
});

test('本地mock数据库fixture在身份验证失败时不授权、不写入、不清理', async () => {
    const actual = identities();
    actual[1].role = target.workerRole;
    const clients = actual.map(identity => ({ async query(sql) {
        assert.match(sql, /^SELECT current_database\(\)/, '身份检查之前禁止其他SQL');
        return { rows: [identity] };
    } }));
    await assert.rejects(checkLocalMockRoute(clients[2], () => assert.fail('不能记录通过'), {
        ...target, owner: clients[0], webPool: clients[1],
    }), /IDENTITY_REQUIRED/);
});

test('fixture中途失败时仅migration清理本轮精确ID并撤销四列INSERT', async () => {
    const actual = identities();
    const statements = [];
    const stop = new Error('受控准备失败');
    const { models } = require('../lib/server/tasks/localMockCatalog');
    const owner = { async query(sql, values) {
        statements.push({ sql, values });
        if (/^SELECT current_database/.test(sql)) return { rows: [actual[0]] };
        if (/information_schema.column_privileges/.test(sql)) return { rows: [] };
        if (/^SELECT id FROM generation_tasks WHERE owner_id/.test(sql)) return { rows: [], rowCount: 0 };
        if (/^DELETE FROM logical_models/.test(sql)) return { rows: [], rowCount: 2 };
        return { rows: [], rowCount: 0 };
    } };
    const webPool = { async query(sql) {
        if (/^SELECT current_database/.test(sql)) return { rows: [actual[1]] };
        assert.match(sql, /^SELECT logical_model_id FROM model_catalog_public/);
        throw stop;
    }, connect() { assert.fail('准备失败不得创建任务'); } };
    const { MemoryObjectStore } = require('../lib/server/storage/memoryObjectStore');
    const workerPool = { async query(sql) {
        assert.match(sql, /^SELECT current_database/);
        return { rows: [actual[2]] };
    } };
    // 图片 mock 现在会真实归档，fixture 要求显式共享对象存储；
    // 本用例仍只验证中途失败后的精确清理，所以用内存存储满足前置条件。
    await assert.rejects(checkLocalMockRoute(workerPool, () => {}, {
        ...target, owner, webPool, objectStore: new MemoryObjectStore(),
    }), error => error === stop);
    assert.equal(statements.filter(entry => /^INSERT INTO logical_models/.test(entry.sql)).length, 2);
    assert.deepEqual(statements.find(entry => /^DELETE FROM logical_models/.test(entry.sql)).values, [models.map(model => model.id)]);
    assert.equal(statements.find(entry => /^GRANT/.test(entry.sql)).sql,
        `GRANT INSERT(logical_model_pk,route_snapshot,route_snapshot_version,route_snapshot_hash) ON generation_tasks TO "${target.runtimeRole}"`);
    assert.equal(statements.at(-1).sql,
        `REVOKE INSERT(logical_model_pk,route_snapshot,route_snapshot_version,route_snapshot_hash) ON generation_tasks FROM "${target.runtimeRole}"`);
    for (const entry of statements.filter(entry => /^DELETE FROM (generation_tasks|provider_calls)/.test(entry.sql))) {
        assert.match(entry.sql, /(?:id|task_id)=ANY\(\$1::uuid\[\]\)/);
        assert.deepEqual(entry.values, [[]]);
    }
});

test('本地随机库验收入口缺少管理员变量时不读取.env、不连接DB并记录blocked', async () => {
    const script = path.resolve(__dirname, '../scripts/accept-database-local.js');
    const code = fs.readFileSync(script, 'utf8');
    const localRequire = createRequire(script);
    const reports = [];
    const output = [];
    const sandboxModule = { exports: {} };
    const sandboxRequire = (name) => {
        if (name === 'node:fs') return {
            statSync() { return { isDirectory: () => true }; },
            existsSync() { assert.fail('入口不应探测或加载.env'); },
            readFileSync() { assert.fail('入口不应读取环境文件'); },
            writeFileSync(file, content) {
                assert.equal(path.dirname(file), path.resolve(__dirname, '../.workbuddy'));
                reports.push(JSON.parse(content));
            },
        };
        if (name === 'pg') return { Client: class { constructor() { assert.fail('未提供管理员变量不得连接DB'); } }, Pool: class { constructor() { assert.fail('不得创建DB池'); } } };
        return localRequire(name);
    };
    sandboxRequire.main = sandboxModule;
    const sandboxProcess = {
        env: new Proxy({}, { get(_object, key) {
            assert.equal(key, 'LOCAL_DATABASE_ADMIN_URL', '缺少管理员变量时只检查其存在性');
            return undefined;
        } }),
        loadEnvFile() { assert.fail('禁止加载.env'); },
    };
    vm.runInNewContext(code, {
        require: sandboxRequire, module: sandboxModule, __dirname: path.dirname(script),
        process: sandboxProcess, URL, console: { log(text) { output.push(JSON.parse(text)); }, error() { assert.fail('不应初始化失败'); } },
    }, { filename: script });
    await Promise.resolve();
    assert.equal(sandboxProcess.exitCode, 2);
    assert.equal(reports.at(-1).status, 'blocked');
    assert.equal(reports.at(-1).checks.length, 1);
    assert.equal(output[0].status, 'blocked');
    assert.deepEqual(Array.from(output[0].created), []);
    assert.match(code, /runFixture\('local-mock-route-postgres'/);
});
