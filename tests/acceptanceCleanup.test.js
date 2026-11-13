'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { parseTargets, runCleanup } = require('../scripts/cleanup-acceptance-databases.js');

const suffix = 'mweb19lu_3c31d4';
const database = `pt_acceptance_${suffix}`;

test('只接受本脚本新建的隔离库名，角色名由后缀推导', () => {
    assert.deepEqual(parseTargets([database]), [{
        database,
        roles: [`pt_bootstrap_${suffix}`, `pt_worker_${suffix}`, `pt_runtime_${suffix}`, `pt_migrate_${suffix}`],
    }]);
    assert.equal(parseTargets([database, database]).length, 1, '重复参数只清理一次');
    for (const rejected of [
        'painttrack_dev', 'painttrack_test', 'painttrack_production', 'postgres', 'template0',
        'pt_acceptance_', 'pt_acceptance_short', `pt_acceptance_${suffix}x`, 'pt_local_runtime_abcdef012345',
        `pt_acceptance_${suffix}"; DROP DATABASE postgres; --`, '', null, undefined, 42,
    ]) assert.throws(() => parseTargets([rejected]), /只接受|至少需要/, `应拒绝 ${String(rejected)}`);
    assert.throws(() => parseTargets([]), /至少需要/);
});

test('有活动连接时跳过该库且不删除任何角色', async () => {
    const statements = [];
    const client = { async query(sql, values) {
        statements.push({ sql, values });
        if (/pg_stat_activity/.test(sql)) return { rows: [{ count: 2 }] };
        throw new Error(`不应执行：${sql}`);
    } };
    const [entry] = await runCleanup({ client, targets: parseTargets([database]) });
    assert.equal(entry.database_status, 'skipped_active_connections:2');
    assert.deepEqual(entry.roles, {});
    assert.equal(statements.length, 1);
});

test('库不存在时只探测角色，不执行 DROP DATABASE', async () => {
    const statements = [];
    const client = { async query(sql, values) {
        statements.push({ sql, values });
        if (/pg_stat_activity/.test(sql)) return { rows: [{ count: 0 }] };
        if (/pg_database/.test(sql)) return { rowCount: 0 };
        if (/pg_roles/.test(sql)) return { rowCount: 0 };
        throw new Error(`不应执行：${sql}`);
    } };
    const [entry] = await runCleanup({ client, targets: parseTargets([database]) });
    assert.equal(entry.database_status, 'absent');
    assert.deepEqual(Object.values(entry.roles), ['absent', 'absent', 'absent', 'absent']);
    assert.equal(statements.filter(entry => /^DROP/.test(entry.sql)).length, 0);
});

test('存在时先删库再按 bootstrap/worker/runtime/migrate 顺序删角色，标识符全部加引号', async () => {
    const statements = [];
    const client = { async query(sql, values) {
        statements.push({ sql, values });
        if (/pg_stat_activity/.test(sql)) return { rows: [{ count: 0 }] };
        if (/pg_database/.test(sql)) return { rowCount: 1 };
        if (/pg_roles/.test(sql)) return { rowCount: 1 };
        return { rowCount: 1 };
    } };
    const [entry] = await runCleanup({ client, targets: parseTargets([database]) });
    assert.equal(entry.database_status, 'dropped');
    const drops = statements.filter(item => /^DROP/.test(item.sql)).map(item => item.sql);
    assert.deepEqual(drops, [
        `DROP DATABASE IF EXISTS "${database}"`,
        `DROP ROLE IF EXISTS "pt_bootstrap_${suffix}"`,
        `DROP ROLE IF EXISTS "pt_worker_${suffix}"`,
        `DROP ROLE IF EXISTS "pt_runtime_${suffix}"`,
        `DROP ROLE IF EXISTS "pt_migrate_${suffix}"`,
    ]);
    // 必须先 DROP DATABASE 再 DROP ROLE，且全程不得包裹事务（PostgreSQL 不允许事务内 DROP DATABASE）。
    assert.ok(
        statements.findIndex(item => /^DROP DATABASE/.test(item.sql)) < statements.findIndex(item => /^DROP ROLE/.test(item.sql)),
        'DROP DATABASE 必须早于 DROP ROLE',
    );
    assert.equal(statements.filter(item => /^(BEGIN|COMMIT|ROLLBACK)/.test(item.sql)).length, 0);
});

test('角色仍有依赖对象时记录为受阻而不伪装成功', async () => {
    const client = { async query(sql) {
        if (/pg_stat_activity/.test(sql)) return { rows: [{ count: 0 }] };
        if (/pg_database/.test(sql)) return { rowCount: 1 };
        if (/pg_roles/.test(sql)) return { rowCount: 1 };
        if (/DROP ROLE/.test(sql)) { const error = new Error('dependent objects'); error.code = '2BP01'; throw error; }
        return { rowCount: 1 };
    } };
    const [entry] = await runCleanup({ client, targets: parseTargets([database]) });
    assert.deepEqual(Object.values(entry.roles), Array(4).fill('blocked_dependent_objects'));
});

test('缺少管理员变量时在连接前退出且不读取.env', async () => {
    const script = path.resolve(__dirname, '../scripts/cleanup-acceptance-databases.js');
    const code = fs.readFileSync(script, 'utf8');
    const localRequire = createRequire(script);
    const output = [];
    const sandboxModule = { exports: {} };
    const sandboxRequire = (name) => {
        if (name === 'pg') return { Client: class { constructor() { assert.fail('未提供管理员变量不得连接DB'); } } };
        return localRequire(name);
    };
    sandboxRequire.main = sandboxModule;
    const sandboxProcess = {
        env: new Proxy({}, { get(_object, key) {
            assert.equal(key, 'LOCAL_DATABASE_ADMIN_URL', '缺少管理员变量时只检查其存在性');
            return undefined;
        } }),
        argv: ['node', script, '--database', database],
        loadEnvFile() { assert.fail('禁止加载.env'); },
    };
    vm.runInNewContext(code, {
        require: sandboxRequire, module: sandboxModule, __dirname: path.dirname(script),
        process: sandboxProcess, URL, console: { log() { assert.fail('不应输出成功结果'); }, error(text) { output.push(text); } },
    }, { filename: script });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sandboxProcess.exitCode, 2);
    assert.match(output[0], /缺少 LOCAL_DATABASE_ADMIN_URL/);
    assert.doesNotMatch(code, /loadEnvFile|\.env['"]/);
});
