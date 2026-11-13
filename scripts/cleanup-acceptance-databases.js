'use strict';

// 只清理 accept-database-local.js 自己创建的随机隔离验收库与四个角色。
// 名称必须严格匹配 pt_acceptance_<后缀>，四个角色名由后缀推导，不接受手输角色名；
// 因此不可能碰到 painttrack_dev / painttrack_test / 生产库或任何非本轮资源。

const { Client } = require('pg');
const { parseDatabaseTarget } = require('../lib/server/db/testIsolation');

const ACCEPTANCE = /^pt_acceptance_([a-z0-9]+_[a-f0-9]{6})$/;
const ROLE_PREFIXES = ['pt_bootstrap_', 'pt_worker_', 'pt_runtime_', 'pt_migrate_'];

const quote = (value) => `"${value.replaceAll('"', '""')}"`;

function parseTargets(values) {
    const seen = new Set();
    const targets = [];
    for (const raw of values || []) {
        const name = String(raw ?? '');
        const match = ACCEPTANCE.exec(name);
        if (!match) throw new Error(`只接受本脚本新建的 pt_acceptance_<后缀> 隔离库名，拒绝：${name || '(空)'}`);
        if (seen.has(name)) continue;
        seen.add(name);
        const suffix = match[1];
        targets.push({ database: name, roles: ROLE_PREFIXES.map((prefix) => `${prefix}${suffix}`) });
    }
    if (!targets.length) throw new Error('至少需要一个 --database <pt_acceptance_...>');
    return targets;
}

function adminUrl(value) {
    const target = parseDatabaseTarget(value);
    if (!target.loopback || target.port !== 5433) throw new Error('管理员连接只允许 loopback:5433');
    if (target.database !== 'postgres') throw new Error('管理员连接只允许指向本机 postgres 管理数据库');
    const url = new URL(value);
    url.hostname = url.hostname === '[::1]' ? '[::1]' : '127.0.0.1';
    url.search = '';
    url.hash = '';
    return url.href;
}

async function runCleanup({ client, targets }) {
    const results = [];
    for (const target of targets) {
        const entry = { database: target.database, database_status: null, roles: {} };
        // 仍有连接时直接跳过：DROP DATABASE 会失败，且说明有人在用，不能强清。
        const active = await client.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1', [target.database]);
        if (active.rows[0].count > 0) {
            entry.database_status = `skipped_active_connections:${active.rows[0].count}`;
            results.push(entry);
            continue;
        }
        const existing = await client.query('SELECT 1 FROM pg_database WHERE datname=$1', [target.database]);
        if (!existing.rowCount) {
            entry.database_status = 'absent';
        } else {
            await client.query(`DROP DATABASE IF EXISTS ${quote(target.database)}`);
            entry.database_status = 'dropped';
        }
        for (const role of target.roles) {
            const present = await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role]);
            if (!present.rowCount) {
                entry.roles[role] = 'absent';
                continue;
            }
            try {
                await client.query(`DROP ROLE IF EXISTS ${quote(role)}`);
                entry.roles[role] = 'dropped';
            } catch (error) {
                entry.roles[role] = error.code === '2BP01' ? 'blocked_dependent_objects' : `failed:${error.code || 'UNKNOWN'}`;
            }
        }
        results.push(entry);
    }
    return results;
}

async function main() {
    if (!process.env.LOCAL_DATABASE_ADMIN_URL) {
        console.error('缺少 LOCAL_DATABASE_ADMIN_URL；未连接数据库，未删除任何对象。');
        process.exitCode = 2;
        return;
    }
    const wanted = [];
    const argv = process.argv.slice(2);
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index].startsWith('--database=')) wanted.push(argv[index].slice('--database='.length));
        else if (argv[index] === '--database') { wanted.push(argv[index + 1]); index += 1; }
        else if (!argv[index].startsWith('--')) wanted.push(argv[index]);
    }
    const targets = parseTargets(wanted);
    const client = new Client({ connectionString: adminUrl(process.env.LOCAL_DATABASE_ADMIN_URL), connectionTimeoutMillis: 3000 });
    await client.connect();
    try {
        const results = await runCleanup({ client, targets });
        console.log(JSON.stringify({ cleaned: results }, null, 2));
    } finally {
        await client.end();
    }
}

if (require.main === module) {
    main().catch((error) => {
        // 只输出受控原因，不回显连接串或凭据。
        console.error(`清理中止：${error.message || 'UNKNOWN'}`);
        process.exitCode = 1;
    });
}

module.exports = { parseTargets, runCleanup };
