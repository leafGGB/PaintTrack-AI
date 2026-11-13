const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { Client, Pool } = require('pg');
const { drizzle } = require('drizzle-orm/node-postgres');
const { sql } = require('drizzle-orm');
const { fork } = require('node:child_process');
const queue = require('../lib/server/worker/taskQueue');
const { parseDatabaseTarget, assertDistinctRuntimeIdentity, assertIsolatedTestTarget } = require('../lib/server/db/testIsolation');
const { migrateDatabase } = require('../lib/server/db/migrate');
// 本地 mock 路由 fixture 需要真实的 objectStore 才能走完归档路径；
// 用内存实现即可，验收结束后随进程释放，不落盘。
const { MemoryObjectStore } = require('../lib/server/storage/memoryObjectStore');

const root = path.resolve(__dirname, '..');
const quote = (value) => `"${value.replaceAll('"', '""')}"`;
const safeCode = (error) => /^[0-9A-Z]{5}$/.test(error.code || '') ? error.code : 'LOCAL_CHECK_FAILED';
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
// 权限清单比对失败时，把差异写进断言首行。只包含表名/列名/权限名，不含任何凭据。
const privilegeDelta = (actual, expected) => {
    const actualSet = new Set(actual);
    const expectedSet = new Set(expected);
    return {
        missing: expected.filter((item) => !actualSet.has(item)),
        extra: actual.filter((item) => !expectedSet.has(item)),
    };
};
// 断言失败时回写"脱敏后的差异摘要"，便于定位；邮箱、URL、长令牌/哈希一律替换为占位符。
// 只保留表名、列名、字段名、布尔值和数字等结构信息。
const safeAssertionHint = (error) => {
    if (error?.name !== 'AssertionError') return undefined;
    const text = String(error.message || '')
        .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
        .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>')
        .replace(/[A-Za-z0-9_-]{24,}/g, '<redacted>')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 600);
    if (!text) return undefined;
    return text;
};
// 只回写受控的源码位置（fixture 或验收脚本），不输出异常正文，避免凭据或 SQL 参数落盘。
const sourceLocation = (error) => {
    const match = error?.stack?.match(/((?:tests[\\/]fixtures[\\/][a-z-]+\.cjs|scripts[\\/]accept-database-local\.js)):(\d+):/);
    return match ? { file: match[1].replaceAll('\\', '/'), line: match[2] } : undefined;
};

function localUrl(value) {
    const target = parseDatabaseTarget(value);
    if (!target.loopback || target.port !== 5433) throw new Error('只允许 loopback:5433');
    const url = new URL(value);
    url.hostname = url.hostname === '[::1]' ? '[::1]' : '127.0.0.1';
    return url.href;
}

function localAdminUrl(value) {
    const url = new URL(localUrl(value));
    if (decodeURIComponent(url.pathname.slice(1)) !== 'postgres') {
        throw new Error('管理员连接只允许指向本机 postgres 管理数据库');
    }
    return url.href;
}

function makeDatabaseUrl(template, role, password, database) {
    const url = new URL(template);
    url.username = role;
    url.password = password;
    url.pathname = `/${database}`;
    url.search = '';
    return url.href;
}

async function withClient(url, callback) {
    const client = new Client({ connectionString: localUrl(url), connectionTimeoutMillis: 3000 });
    try {
        await client.connect();
        const { rows } = await client.query('SELECT inet_server_addr()::text AS address, inet_server_port() AS port');
        assert.ok(rows[0].address === '::1' || rows[0].address.startsWith('127.'));
        assert.equal(rows[0].port, 5433);
        return await callback(client);
    } finally {
        await client.end();
    }
}

async function seedLegacyRows(databaseUrl) {
    const tasks = ['queued', 'running', 'succeeded', 'failed', 'cancelled'].map((status) => ({
        id: crypto.randomUUID(),
        status,
        idempotencyKey: `legacy:${status}:${crypto.randomBytes(8).toString('hex')}`,
        leaseToken: status === 'running' ? crypto.randomUUID() : null,
        result: status === 'succeeded' ? { legacy_fixture: true } : null,
    }));
    const calls = ['submitting', 'unknown', 'accepted', 'succeeded', 'failed'].map((status, index) => ({
        taskId: tasks[index].id,
        status,
        providerJobId: ['accepted', 'succeeded'].includes(status) ? `legacy-job-${index}` : null,
    }));
    await withClient(databaseUrl, async (client) => {
        for (const task of tasks) {
            await client.query(
                `INSERT INTO generation_tasks (
                    id, task_type, payload, status, attempts, max_attempts, available_at,
                    lease_token, lease_expires_at, worker_id, created_at, updated_at, completed_at,
                    owner_id, idempotency_key, request_fingerprint, result
                ) VALUES (
                    $1, 'legacy-acceptance', '{"legacy_fixture":true}'::jsonb, $2,
                    $3, 3, now(), $4, CASE WHEN $2='running' THEN now() + interval '1 hour' ELSE NULL END,
                    CASE WHEN $2='running' THEN 'legacy-worker' ELSE NULL END, now(), now(),
                    CASE WHEN $2 IN ('succeeded','failed','cancelled') THEN now() ELSE NULL END,
                    $5, $6, $7, CASE WHEN $2='succeeded' THEN $8::jsonb ELSE NULL END
                )`,
                [task.id, task.status, task.status === 'running' ? 1 : 0, task.leaseToken,
                    crypto.randomUUID(), task.idempotencyKey,
                    crypto.createHash('sha256').update(task.id).digest('hex'), task.result === null ? null : JSON.stringify(task.result)],
            );
        }
        for (const [index, call] of calls.entries()) {
            await client.query(
                `INSERT INTO provider_calls (
                    task_id, attempt_no, provider_name, idempotency_key, provider_job_id, status
                ) VALUES ($1, 1, 'legacy-provider', $2, $3, $4)`,
                [call.taskId, `legacy-call:${index}:${crypto.randomBytes(8).toString('hex')}`, call.providerJobId, call.status],
            );
        }
    });
    return { tasks, calls, counts: { tasks: tasks.length, providerCalls: calls.length } };
}

async function assertLegacyRowsRemainUnrouted(databaseUrl, legacy) {
    await withClient(databaseUrl, async (client) => {
        for (const task of legacy.tasks) {
            const { rows } = await client.query(
                `SELECT id, status, task_type, payload, result, cancel_requested_at,
                        logical_model_pk, route_snapshot, route_snapshot_version, route_snapshot_hash
                 FROM generation_tasks WHERE id=$1`,
                [task.id],
            );
            assert.equal(rows.length, 1);
            assert.equal(rows[0].status, task.status);
            assert.equal(rows[0].task_type, 'legacy-acceptance');
            assert.deepEqual(rows[0].payload, { legacy_fixture: true });
            assert.deepEqual(rows[0].result, task.result);
            assert.equal(rows[0].logical_model_pk, null);
            assert.equal(rows[0].route_snapshot, null);
            assert.equal(rows[0].route_snapshot_version, null);
            assert.equal(rows[0].route_snapshot_hash, null);
        }
        // 0015 结构下、0016 应用前已存在的任务同样必须保持未路由状态：
        // 它是"迁移不改写历史行"的直接证据。
        const pre = await client.query(
            `SELECT status, task_type, payload, logical_model_pk, route_snapshot,
                    route_snapshot_version, route_snapshot_hash
             FROM generation_tasks WHERE id=$1`,
            [legacy.pre0016TaskId],
        );
        assert.equal(pre.rows.length, 1, '0016前的夹具任务在升级后必须仍存在');
        assert.equal(pre.rows[0].status, 'queued');
        assert.equal(pre.rows[0].task_type, 'legacy-acceptance');
        assert.deepEqual(pre.rows[0].payload, { legacy_fixture: true });
        for (const key of ['logical_model_pk', 'route_snapshot', 'route_snapshot_version', 'route_snapshot_hash']) {
            assert.equal(pre.rows[0][key], null, `0016前任务 ${key} 必须保持 NULL`);
        }
        for (const call of legacy.calls) {
            const { rows } = await client.query(
                `SELECT status, provider_instance_id, provider_config_version, credential_ref_version,
                        provider_model_id, logical_model_id, binding_id, binding_version, adapter_type,
                        adapter_version, upstream_model_name, operation_profile, route_snapshot_hash
                 FROM provider_calls WHERE task_id=$1`,
                [call.taskId],
            );
            assert.equal(rows.length, 1);
            assert.equal(rows[0].status, call.status);
            for (const [key, value] of Object.entries(rows[0])) {
                if (key !== 'status') assert.equal(value, null, `legacy provider_calls.${key} must remain NULL`);
            }
        }
    });
}

async function clearLegacyRows(databaseUrl, legacy) {
    // 只在“历史记录保持 NULL”的证据已经记录之后清理合成夹具：
    // 后面的 Worker 验收断言起始任务表为空、最终恰好 15 个任务，遗留夹具会让它假失败。
    // 清理范围必须覆盖 0016 应用前插入的任务，因此按登记过的 ID 精确删除，
    // 不用 task_type 模糊匹配（避免误删同类型但非本轮夹具的行）。
    await withClient(databaseUrl, async (client) => {
        const callIds = legacy.calls.map((call) => call.taskId);
        const taskIds = [...legacy.tasks.map((task) => task.id), legacy.pre0016TaskId];
        const calls = await client.query('DELETE FROM provider_calls WHERE task_id = ANY($1::uuid[])', [callIds]);
        const tasks = await client.query('DELETE FROM generation_tasks WHERE id = ANY($1::uuid[])', [taskIds]);
        assert.equal(calls.rowCount, callIds.length, '合成历史 provider_calls 应全部清除');
        assert.equal(tasks.rowCount, taskIds.length, '合成历史任务应全部清除（含 0016 前夹具）');
        const remaining = await client.query("SELECT count(*)::int AS count FROM generation_tasks WHERE task_type='legacy-acceptance'");
        assert.equal(remaining.rows[0].count, 0);
        const remainingCalls = await client.query("SELECT count(*)::int AS count FROM provider_calls WHERE provider_name='legacy-provider'");
        assert.equal(remainingCalls.rows[0].count, 0);
    });
}

async function checkDatabase({ runtimeUrl, workerUrl, migrationUrl, runtimeRole, workerRole, cleanupRole, migrationRole, bootstrapRole, record }) {
    assertIsolatedTestTarget({ testDatabaseUrl: runtimeUrl, testMigrationDatabaseUrl: migrationUrl,
        databaseUrl: process.env.DATABASE_URL, migrationDatabaseUrl: process.env.MIGRATION_DATABASE_URL });
    await withClient(migrationUrl, async (client) => {
        const tables = await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
        assert.deepEqual(tables.rows, []);
    });
    record('空库确认', 'passed');
    const config = { databaseUrl: runtimeUrl, migrationDatabaseUrl: migrationUrl };
    await migrateDatabase(config, { migrate: async (database, settings) => {
        const { readMigrationFiles } = require('drizzle-orm/migrator');
        await database.dialect.migrate(readMigrationFiles(settings).slice(0, 6), database.session, settings);
    } });
    await withClient(migrationUrl, async (client) => {
        await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON users TO ${quote(runtimeRole)}`);
    });
    await migrateDatabase(config, { migrate: async (database, settings) => {
        const { readMigrationFiles } = require('drizzle-orm/migrator');
        await database.dialect.migrate(readMigrationFiles(settings).slice(0, 15), database.session, settings);
    } });
    await withClient(migrationUrl, async (client) => {
        const result = await client.query("SELECT has_column_privilege($1,'users','role','INSERT') AS insert_role, has_column_privilege($1,'users','role','UPDATE') AS update_role, has_column_privilege($1,'users','email_verified_at','UPDATE') AS verify", [runtimeRole]);
        assert.deepEqual(result.rows[0], { insert_role: false, update_role: false, verify: true });
    });
    record('空库至0005再增量0006，历史users整表写授权收紧且邮箱验证列仍可写', 'passed');
    await migrateDatabase(config, { migrate: async (database, settings) => {
        const { readMigrationFiles } = require('drizzle-orm/migrator');
        await database.dialect.migrate(readMigrationFiles(settings).slice(0, 15), database.session, settings);
    } });
    // 在 0015 结构下写入历史任务和调用，然后单独验收 0016 不回填路由身份；
    // 之后再单独应用 0017，确保视图迁移也不会改写这些历史记录。
    const pre0016TaskId = crypto.randomUUID();
    await withClient(migrationUrl, async (client) => {
        await client.query(`INSERT INTO generation_tasks (
            id, task_type, payload, status, attempts, max_attempts, available_at,
            lease_token, lease_expires_at, worker_id, created_at, updated_at,
            owner_id, idempotency_key, request_fingerprint
        ) VALUES (
            $1, 'legacy-acceptance', '{"legacy_fixture":true}'::jsonb, 'queued',
            0, 3, now(), NULL, NULL, NULL, now(), now(), $2, $3, $4
        )`, [pre0016TaskId, crypto.randomUUID(), `legacy:pre0016:${crypto.randomBytes(8).toString('hex')}`, 'c'.repeat(64)]);
    });
    const legacy = await seedLegacyRows(migrationUrl);
    legacy.pre0016TaskId = pre0016TaskId;
    legacy.counts = { ...legacy.counts, tasks: legacy.counts.tasks + 1 };
    record('在0015结构下写入待0016迁移的历史任务与调用记录', 'passed', legacy.counts);

    const { readMigrationFiles } = require('drizzle-orm/migrator');
    await withClient(migrationUrl, async (client) => {
        const before0016 = await client.query('SELECT id, hash, created_at FROM public.__drizzle_migrations ORDER BY id');
        await migrateDatabase(config, { migrate: async (database, settings) => {
            const files = readMigrationFiles(settings);
            const routingMigrationIndex = files.findIndex((file) => file.folderMillis === 1794293000000);
            assert.notEqual(routingMigrationIndex, -1, '0016 model catalog routing migration must exist');
            await database.dialect.migrate(files.slice(0, routingMigrationIndex + 1), database.session, settings);
        } });
        const after0016 = await client.query('SELECT id, hash, created_at FROM public.__drizzle_migrations ORDER BY id');
        assert.equal(after0016.rows.length, before0016.rows.length + 1, '非空 0015→0016 升级应仅追加 0016 migration 记录');
        assert.deepEqual(after0016.rows.slice(0, before0016.rows.length), before0016.rows, '0016 升级不得改写既有 migration 记录');
        await assertLegacyRowsRemainUnrouted(migrationUrl, legacy);
        record('非空0015→0016升级保留历史任务与provider_calls且不伪造路由身份', 'passed');

        const journal = require('../drizzle/meta/_journal.json');
        const before0017 = after0016.rows;
        await migrateDatabase(config, { migrate: async (database, settings) => {
            const files = readMigrationFiles(settings);
            const publicCatalogIndex = files.findIndex((file) => file.folderMillis === 1794304485607);
            assert.notEqual(publicCatalogIndex, -1, '0017 public catalog migration must exist');
            await database.dialect.migrate(files.slice(0, publicCatalogIndex + 1), database.session, settings);
        } });
        const after0017 = await client.query('SELECT id, hash, created_at FROM public.__drizzle_migrations ORDER BY id');
        assert.equal(after0017.rows.length, before0017.length + 1, '非空 0016→0017 升级应仅追加 0017 migration 记录');
        assert.deepEqual(after0017.rows.slice(0, before0017.length), before0017, '0017 升级不得改写既有 migration 记录');
        await assertLegacyRowsRemainUnrouted(migrationUrl, legacy);
        record('非空0016→0017目录视图升级保持历史路由字段不变', 'passed');

        const beforeMfa = after0017.rows;
        await migrateDatabase(config, { migrate: async (database, settings) => {
            const files = readMigrationFiles(settings);
            const totpMigrationIndex = files.findIndex((file) => file.folderMillis === 1794363000000);
            assert.notEqual(totpMigrationIndex, -1, '0020 TOTP replay protection migration must exist');
            await database.dialect.migrate(files.slice(0, totpMigrationIndex + 1), database.session, settings);
        } });
        const after0020 = await client.query('SELECT id, hash, created_at FROM public.__drizzle_migrations ORDER BY id');
        assert.equal(after0020.rows.length, beforeMfa.length + 3, '非空0017→0020升级应只追加0018→0020三条迁移');
        assert.deepEqual(after0020.rows.slice(0, beforeMfa.length), beforeMfa, 'MFA 迁移不得改写既有迁移记录');
        const before0021 = after0020.rows;
        await migrateDatabase(config);
        const after = await client.query('SELECT id, hash, created_at FROM public.__drizzle_migrations ORDER BY id');
        assert.equal(after.rows.length, journal.entries.length, '0023 应应用全部剩余迁移');
        assert.equal(after.rows.length, before0021.length + 3, '非空0020→0023升级应追加0021约束、0022清理列与0023孤儿列三条迁移');
        assert.deepEqual(after.rows.slice(0, before0021.length), before0021, '0021/0022/0023 迁移不得改写既有迁移记录');
        await require('../tests/fixtures/route-snapshot-constraints-postgres.cjs').checkRouteSnapshotConstraints(client, record);
        const totpColumn = await client.query(`SELECT data_type, is_nullable FROM information_schema.columns
            WHERE table_schema='public' AND table_name='admin_mfa_factors' AND column_name='last_totp_counter'`);
        assert.deepEqual(totpColumn.rows, [{ data_type: 'bigint', is_nullable: 'YES' }]);
        record('非空0017→0020 MFA迁移保留历史记录并新增TOTP重放保护列', 'passed', { migrationsApplied: after0020.rows.length - beforeMfa.length });
        record('非空0020→0023约束、清理列与孤儿回收列迁移仅追加三条记录并保留历史快照字段', 'passed');
        assert.equal(after.rows.length, journal.entries.length);
        for (let i = 0; i < journal.entries.length; i++) {
            const entry = journal.entries[i];
            const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'drizzle', `${entry.tag}.sql`))).digest('hex');
            assert.equal(after.rows[i].hash, hash);
            assert.equal(String(after.rows[i].created_at), String(entry.when));
        }
        record('重复迁移和 journal/hash', 'passed');
        await clearLegacyRows(migrationUrl, legacy);
        record('保留升级证据后清理合成历史夹具', 'passed', legacy.counts);
        const latestEntry = journal.entries.at(-1);
        const snapshotPrefix = latestEntry.tag.match(/^\d{4}/)?.[0];
        if (!snapshotPrefix) throw new Error('迁移快照编号无效');
        const snapshot = require(`../drizzle/meta/${snapshotPrefix}_snapshot.json`);
        const tables = await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
        assert.deepEqual(tables.rows.map((row) => row.tablename), ['__drizzle_migrations', ...Object.values(snapshot.tables).map((table) => table.name)].sort());
        for (const table of Object.values(snapshot.tables)) {
            const columns = await client.query(`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
                WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [table.name]);
            const actualColumnNames = columns.rows.map((row) => row.column_name).sort(compareText);
            const expectedColumnNames = Object.keys(table.columns).sort(compareText);
            assert.deepEqual(actualColumnNames, expectedColumnNames, `public.${table.name} 列集合与迁移快照不符`);
            for (const column of columns.rows) {
                const expected = table.columns[column.column_name];
                assert.equal(column.data_type, expected.type);
                assert.equal(column.is_nullable, expected.notNull ? 'NO' : 'YES');
                assert.equal(column.column_default !== null, expected.default !== undefined);
            }
            const checks = await client.query(`SELECT conname, convalidated FROM pg_constraint
                WHERE conrelid=$1::regclass AND contype='c' ORDER BY conname`, [`public.${table.name}`]);
            assert.deepEqual(checks.rows.map((row) => row.conname), Object.keys(table.checkConstraints).sort());
            assert.ok(checks.rows.every((row) => row.convalidated));
            const indexes = await client.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND tablename=$1`, [table.name]);
            for (const index of Object.values(table.indexes)) {
                const found = indexes.rows.find((row) => row.indexname === index.name);
                assert.ok(found);
                assert.equal(found.indexdef.startsWith('CREATE UNIQUE INDEX'), index.isUnique);
                assert.ok(found.indexdef.includes(`(${index.columns.map((column) => column.expression).join(', ')})`));
            }
            assert.ok(indexes.rows.some((row) => row.indexname === `${table.name}_pkey` && row.indexdef.includes('UNIQUE')));
        }
        record('全部迁移表列/主键/CHECK/索引与最新snapshot', 'passed', { tables: Object.keys(snapshot.tables).length });
        const views = await client.query("SELECT table_name FROM information_schema.views WHERE table_schema='public' ORDER BY table_name");
        assert.deepEqual(views.rows.map((row) => row.table_name), Object.values(snapshot.views).map((view) => view.name).sort());
        const publicCatalogColumns = await client.query(`SELECT column_name FROM information_schema.columns
            WHERE table_schema='public' AND table_name='model_catalog_public' ORDER BY ordinal_position`);
        assert.deepEqual(publicCatalogColumns.rows.map((row) => row.column_name), Object.keys(snapshot.views['public.model_catalog_public'].columns));
        record('目录视图列和snapshot一致', 'passed');
        await client.query(`GRANT CONNECT ON DATABASE ${quote(new URL(runtimeUrl).pathname.slice(1))} TO ${quote(runtimeRole)}, ${quote(workerRole)}, ${quote(cleanupRole)}, ${quote(bootstrapRole)}`);
        await client.query(`GRANT USAGE ON SCHEMA public TO ${quote(runtimeRole)}, ${quote(workerRole)}, ${quote(cleanupRole)}, ${quote(bootstrapRole)}`);
        const permissions = require('../lib/server/db/runtimePermissions');
        await permissions.grantWebRuntimePermissions(client, runtimeRole);
        await permissions.grantWorkerRuntimePermissions(client, workerRole);
        await permissions.grantCleanupRuntimePermissions(client, cleanupRole);
        await client.query(`GRANT SELECT ON public.users TO ${quote(bootstrapRole)}`);
        await client.query(`GRANT INSERT (email,password_hash,email_verified_at,role) ON public.users TO ${quote(bootstrapRole)}`);
    });

    await withClient(runtimeUrl, async (client) => {
        const privileges = await client.query(`SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname=current_user`);
        assert.ok(Object.values(privileges.rows[0]).every((value) => value === false));
        // 逐表逐权限类型用 has_table_privilege 断言，而不是比较 information_schema 的结果数组：
        // 列级 GRANT 会使 role_table_grants/column_privileges 出现重复行或按列展开，
        // 直接比数组既不稳定也没覆盖 TRUNCATE/REFERENCES/TRIGGER。
        const fullDmlTables = ['admin_mfa_factors', 'admin_recovery_codes', 'auth_rate_limits', 'auth_sessions', 'email_verification_tokens', 'password_reset_tokens'];
        const tableSelectTables = ['assets', 'generation_tasks'];
        const tablePrivileges = await client.query(`
            SELECT t.tablename, p.priv,
                   has_table_privilege(current_user, format('public.%I', t.tablename), p.priv) AS granted
            FROM pg_tables t
            CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) AS p(priv)
            WHERE t.schemaname='public' AND t.tablename <> '__drizzle_migrations'`);
        const expectedTablePrivileges = [
            ...fullDmlTables.flatMap((tablename) => ['DELETE', 'INSERT', 'SELECT', 'UPDATE'].map((priv) => `${tablename}:${priv}`)),
            ...tableSelectTables.map((tablename) => `${tablename}:SELECT`),
            'email_outbox:INSERT', 'provider_config_audit_events:INSERT',
            'users:DELETE', 'users:SELECT',
        ].sort(compareText);
        const actualTablePrivileges = tablePrivileges.rows.filter((row) => row.granted)
            .map((row) => `${row.tablename}:${row.priv}`).sort(compareText);
        assert.deepEqual(actualTablePrivileges, expectedTablePrivileges,
            `Web角色表级权限与最小权限清单不符 ${JSON.stringify(privilegeDelta(actualTablePrivileges, expectedTablePrivileges))}`);
        // 目录配置表（provider_instances/provider_models/model_provider_bindings）只给列级 SELECT，
        // 不得出现表级授权；上面整体清单已覆盖，这里显式失败信息便于定位越权。
        for (const table of ['model_provider_bindings', 'provider_instances', 'provider_models']) {
            assert.ok(tablePrivileges.rows.filter((row) => row.tablename === table).every((row) => !row.granted), `public.${table} 不应有表级权限`);
        }
        const userColumns = await client.query(`
            SELECT a.attname AS column_name, p.priv,
                   has_column_privilege(current_user, 'public.users', a.attname, p.priv) AS granted
            FROM pg_attribute a
            CROSS JOIN (VALUES ('INSERT'),('UPDATE')) AS p(priv)
            WHERE a.attrelid='public.users'::regclass AND a.attnum > 0 AND NOT a.attisdropped`);
        const expectedUserColumns = [
            'created_at:INSERT', 'email:INSERT', 'email_verified_at:INSERT', 'id:INSERT', 'password_hash:INSERT',
            'email_verified_at:UPDATE', 'password_hash:UPDATE',
        ].sort(compareText);
        const actualUserColumns = userColumns.rows.filter((row) => row.granted)
            .map((row) => `${row.column_name}:${row.priv}`).sort(compareText);
        assert.deepEqual(actualUserColumns, expectedUserColumns,
            `runtime 的 users 写权限必须是列级最小集 ${JSON.stringify(privilegeDelta(actualUserColumns, expectedUserColumns))}`);
        record('运行角色表级最小权限与users列级写权限符合清单', 'passed');
        // assets 的写权限必须是列级最小集：软删除只需要 status/deleted_at/updated_at。
        // 上面的表级清单依赖 has_table_privilege，列级 GRANT 不会让它变 true，
        // 因此必须单独比对，否则将来误加 storage_key/mime_type 的写权限不会被任何断言发现。
        const assetColumns = await client.query(`
            SELECT a.attname AS column_name, p.priv,
                   has_column_privilege(current_user, 'public.assets', a.attname, p.priv) AS granted
            FROM pg_attribute a
            CROSS JOIN (VALUES ('INSERT'),('UPDATE')) AS p(priv)
            WHERE a.attrelid='public.assets'::regclass AND a.attnum > 0 AND NOT a.attisdropped`);
        const expectedAssetColumns = ['deleted_at:UPDATE', 'status:UPDATE', 'updated_at:UPDATE'].sort(compareText);
        const actualAssetColumns = assetColumns.rows.filter((row) => row.granted)
            .map((row) => `${row.column_name}:${row.priv}`).sort(compareText);
        assert.deepEqual(actualAssetColumns, expectedAssetColumns,
            `runtime 的 assets 写权限必须是列级最小集 ${JSON.stringify(privilegeDelta(actualAssetColumns, expectedAssetColumns))}`);
        record('runtime的assets列级写权限仅为软删除三列', 'passed');
        for (const text of ["UPDATE users SET role='admin'", "UPDATE users SET email='forbidden@example.test'", "INSERT INTO users(email,password_hash,role) VALUES('forbidden@example.test','invalid','admin')",
            "INSERT INTO users(email,password_hash,role) VALUES('forbidden@example.test','invalid','user')"]) {
            await assert.rejects(client.query(text), (error) => error.code === '42501');
        }
        record('users列级权限禁止runtime更新role及显式INSERT role，包括user值', 'passed');
        await client.query('BEGIN');
        try {
            const marker = "'); DROP TABLE assets; --";
            const { rows: [task] } = await client.query(
                `INSERT INTO generation_tasks(owner_id,idempotency_key,request_fingerprint,task_type,payload)
                 VALUES($1,$2,$3,$4,$5::jsonb) RETURNING id`,
                [crypto.randomUUID(), `accept:web:${crypto.randomUUID()}`, 'a'.repeat(64), marker, JSON.stringify({ marker })],
            );
            assert.equal((await client.query('SELECT task_type FROM generation_tasks WHERE id=$1', [task.id])).rows[0].task_type, marker);
            assert.equal((await client.query('SELECT payload FROM generation_tasks WHERE id=$1', [task.id])).rows[0].payload.marker, marker);
            await client.query("UPDATE generation_tasks SET status='cancelled' WHERE id=$1", [task.id]);
            assert.equal((await client.query('SELECT status FROM generation_tasks WHERE id=$1', [task.id])).rows[0].status, 'cancelled');
            record('Web建任务参数化SQL注入往返及取消列正例', 'passed');
            for (const text of [
                `INSERT INTO assets(owner_id,media_type) VALUES('${crypto.randomUUID()}','image')`,
                'UPDATE assets SET mime_type=\'image/png\'',
                'DELETE FROM assets',
                `UPDATE generation_tasks SET result='{}'::jsonb WHERE id='${task.id}'`,
                `UPDATE generation_tasks SET attempts=1 WHERE id='${task.id}'`,
                `DELETE FROM generation_tasks WHERE id='${task.id}'`,
                'CREATE TABLE public.forbidden_table(id integer)',
                'CREATE SCHEMA forbidden_schema',
                'CREATE TEMP TABLE forbidden_temp(id integer)',
                'ALTER TABLE public.assets ADD COLUMN forbidden integer',
                'DROP TABLE public.assets',
                'TRUNCATE public.assets',
                'SELECT * FROM public.__drizzle_migrations',
                'UPDATE public.__painttrack_schema_version SET version=1',
                `SET ROLE ${quote(migrationRole)}`,
            ]) {
                await client.query('SAVEPOINT web_denied');
                await assert.rejects(client.query(text), (error) => error.code === '42501');
                await client.query('ROLLBACK TO SAVEPOINT web_denied');
            }
            record('Web资产写入/任务执行列及删除/DDL/迁移记录/身份升级权限负例', 'passed');
        } finally {
            await client.query('ROLLBACK');
        }
    });

    // 结构约束由隔离 migration 身份探测；运行身份使用各自独立连接。
    // 每项失败均回滚到 savepoint，不能让权限错误冒充 CHECK 约束命中。
    await withClient(migrationUrl, async (client) => {
        await client.query('BEGIN');
        try {
            const marker = "'); DROP TABLE assets; --";
            const asset = await client.query(`INSERT INTO assets(owner_id, media_type, metadata) VALUES($1,'image',$2::jsonb) RETURNING id`,
                [crypto.randomUUID(), JSON.stringify({ marker })]);
            const task = await client.query(
                `INSERT INTO generation_tasks(owner_id,idempotency_key,request_fingerprint,task_type,payload)
                 VALUES($1::uuid,$2,$3,$4,$5::jsonb) RETURNING id`,
                [crypto.randomUUID(), `accept:mutation:${crypto.randomUUID()}`, 'd'.repeat(64), marker, JSON.stringify({ marker })],
            );
            const assetId = asset.rows[0].id;
            const taskId = task.rows[0].id;
            assert.equal((await client.query('SELECT metadata FROM assets WHERE id=$1', [assetId])).rows[0].metadata.marker, marker);
            assert.equal((await client.query('SELECT task_type FROM generation_tasks WHERE id=$1', [taskId])).rows[0].task_type, marker);
            await client.query("UPDATE assets SET mime_type=$2 WHERE id=$1", [assetId, marker]);
            record('Migration身份资产及任务参数化SQL注入往返', 'passed');
            // 约束名与快照一致只能证明"名字对"，不能证明新增状态值真的可写。这里做一次正向探测，
            // 并用 SAVEPOINT 回滚，避免把 cancelled 再改回 queued 这种业务上非法的转换留在夹具里。
            await client.query('SAVEPOINT status_probe');
            await client.query("UPDATE generation_tasks SET status='cancelled' WHERE id=$1", [taskId]);
            assert.equal((await client.query('SELECT status FROM generation_tasks WHERE id=$1', [taskId])).rows[0].status, 'cancelled');
            await client.query('ROLLBACK TO SAVEPOINT status_probe');
            record('generation_tasks接受cancelled终态写入（状态机迁移正向证据）', 'passed');
            // 成功终态必须带结果描述符：只加约束不验证等于没验证。
            await client.query('SAVEPOINT result_probe');
            await client.query(
                `UPDATE generation_tasks SET status='succeeded', result='{"kind":"probe","archive":"not_configured"}'::jsonb WHERE id=$1`,
                [taskId],
            );
            assert.equal((await client.query("SELECT result->>'kind' AS kind FROM generation_tasks WHERE id=$1", [taskId])).rows[0].kind, 'probe');
            await client.query('ROLLBACK TO SAVEPOINT result_probe');
            record('generation_tasks成功终态可写入结果描述符（0014约束正向证据）', 'passed');
            // 0023 的 abandoned_at 只允许落在「从未落盘」的两个状态上，且不能早于 created_at。
            // 先做正向写入再回滚，证明该列真的可写，而不是只有名字进了快照。
            await client.query('SAVEPOINT abandoned_probe');
            await client.query('UPDATE assets SET abandoned_at=clock_timestamp() WHERE id=$1', [assetId]);
            const abandonedProbe = await client.query('SELECT status, abandoned_at FROM assets WHERE id=$1', [assetId]);
            assert.equal(abandonedProbe.rows[0].status, 'pending');
            assert.ok(abandonedProbe.rows[0].abandoned_at instanceof Date);
            await client.query('ROLLBACK TO SAVEPOINT abandoned_probe');
            record('assets.abandoned_at可写在pending行上（0023约束正向证据）', 'passed');
            const violations = [
                ["UPDATE assets SET media_type='invalid' WHERE id=$1", assetId, 'assets_media_type_check'],
                ['UPDATE assets SET size_bytes=-1 WHERE id=$1', assetId, 'assets_size_bytes_check'],
                ["UPDATE assets SET status='invalid' WHERE id=$1", assetId, 'assets_status_check'],
                ["UPDATE assets SET status='ready' WHERE id=$1", assetId, 'assets_status_storage_consistency_check'],
                ['UPDATE assets SET deleted_at=now() WHERE id=$1', assetId, 'assets_deleted_at_consistency_check'],
                ["UPDATE assets SET checksum_sha256='BAD' WHERE id=$1", assetId, 'assets_checksum_sha256_format_check'],
                ["UPDATE assets SET abandoned_at=clock_timestamp()-interval '1 hour' WHERE id=$1", assetId, 'assets_abandoned_state_check'],
                ["UPDATE generation_tasks SET status='invalid' WHERE id=$1", taskId, 'generation_tasks_status_check'],
                ["UPDATE generation_tasks SET status='cancelling' WHERE id=$1", taskId, 'generation_tasks_status_check'],
                ['UPDATE generation_tasks SET attempts=-1 WHERE id=$1', taskId, 'generation_tasks_attempts_check'],
                ['UPDATE generation_tasks SET max_attempts=0 WHERE id=$1', taskId, 'generation_tasks_max_attempts_check'],
                ['UPDATE generation_tasks SET attempts=4 WHERE id=$1', taskId, 'generation_tasks_attempt_limit_check'],
                ["UPDATE generation_tasks SET status='running' WHERE id=$1", taskId, 'generation_tasks_lease_consistency_check'],
                ["UPDATE generation_tasks SET idempotency_key='short' WHERE id=$1", taskId, 'generation_tasks_idempotency_key_check'],
                ["UPDATE generation_tasks SET request_fingerprint='not-a-digest' WHERE id=$1", taskId, 'generation_tasks_request_fingerprint_check'],
                ["UPDATE generation_tasks SET status='succeeded' WHERE id=$1", taskId, 'generation_tasks_result_consistency_check'],
            ];
            for (const [text, id, constraint] of violations) {
                await client.query('SAVEPOINT negative');
                await assert.rejects(client.query(text, [id]), (error) => error.code === '23514' && error.constraint === constraint);
                await client.query('ROLLBACK TO SAVEPOINT negative');
            }
            for (const [text, code] of [
                ['UPDATE assets SET owner_id=NULL WHERE id=$1', '23502'],
                ['INSERT INTO assets SELECT * FROM assets WHERE id=$1', '23505'],
            ]) {
                await client.query('SAVEPOINT negative');
                await assert.rejects(client.query(text, [assetId]), (error) => error.code === code);
                await client.query('ROLLBACK TO SAVEPOINT negative');
            }
            record('15项CHECK和NOT NULL/主键负例', 'passed');
            // 清理由本事务回滚完成，不向 Web/Worker 追加资产或任务 DELETE 权限。
        } finally {
            await client.query('ROLLBACK');
        }
        assert.equal((await client.query('SELECT count(*)::int AS count FROM assets')).rows[0].count, 0);
        record('事务回滚且连接可复用', 'passed');
    });

    // 先由 migration 建立已提交夹具，使独立 Worker 登录连接可见；最后由 owner 清理。
    const workerProbeId = crypto.randomUUID();
    try {
        await withClient(migrationUrl, (client) => client.query(
            `INSERT INTO generation_tasks(id,owner_id,idempotency_key,request_fingerprint,task_type,payload)
             VALUES($1,$2,$3,$4,'worker-result-probe','{}'::jsonb)`,
            [workerProbeId, crypto.randomUUID(), `accept:worker-result:${workerProbeId}`, 'b'.repeat(64)],
        ));
        await withClient(workerUrl, async (client) => {
            await client.query('BEGIN');
            try {
                const result = await client.query(
                    `UPDATE generation_tasks SET status='succeeded', result='{"kind":"probe","archive":"not_configured"}'::jsonb
                     WHERE id=$1 RETURNING result`, [workerProbeId],
                );
                assert.equal(result.rowCount, 1);
                assert.equal(result.rows[0].result.kind, 'probe');
                record('Worker独立连接成功终态与结果描述符写入正例', 'passed');
            } finally {
                await client.query('ROLLBACK');
            }
        });
    } finally {
        await withClient(migrationUrl, (client) => client.query('DELETE FROM generation_tasks WHERE id=$1', [workerProbeId]));
    }

    const pool = new Pool({ connectionString: runtimeUrl, connectionTimeoutMillis: 3000, application_name: `pt_accept_${runtimeRole}` });
    try {
        const database = drizzle(pool);
        await assert.rejects(database.transaction(async (tx) => {
            await tx.execute(sql`INSERT INTO generation_tasks(owner_id,idempotency_key,request_fingerprint,task_type,payload)
                VALUES ('00000000-0000-4000-8000-000000000010','accept:rollback:1','eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee','rollback-proof','{}'::jsonb)`);
            throw new Error('预期回滚');
        }), /预期回滚/);
        assert.equal((await pool.query("SELECT count(*)::int AS count FROM generation_tasks WHERE task_type='rollback-proof'")).rows[0].count, 0);
        const commitProbeId = crypto.randomUUID();
        try {
            await database.transaction(async (tx) => {
                await tx.execute(sql`INSERT INTO generation_tasks(idempotency_key,owner_id,request_fingerprint,task_type,payload)
                    VALUES (${`accept:commit:${commitProbeId}`},'00000000-0000-4000-8000-000000000010','ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff','commit-proof','{}'::jsonb)`);
            });
            assert.equal((await pool.query('SELECT count(*)::int AS count FROM generation_tasks WHERE idempotency_key=$1', [`accept:commit:${commitProbeId}`])).rows[0].count, 1);
            record('Drizzle真实事务提交与异常回滚（Web连接）', 'passed');
        } finally {
            await withClient(migrationUrl, (client) => client.query('DELETE FROM generation_tasks WHERE idempotency_key=$1', [`accept:commit:${commitProbeId}`]));
        }
    } finally {
        await pool.end();
    }
    await assert.rejects(pool.query('SELECT 1'));
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = runtimeUrl;
    const application = require('../lib/server/db');
    try {
        assert.equal((await application.checkDatabaseHealth()).status, 'ok');
        await Promise.all([application.closeDatabase(), application.closeDatabase()]);
        assert.equal((await application.checkDatabaseHealth()).status, 'ok');
    } finally {
        await application.closeDatabase();
        if (previous === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = previous;
    }
    record('连接池关闭/重复关闭/重新连接', 'passed');
}

function launchPostgresWorker(workerUrl, mode, children) {
    const url = new URL(workerUrl);
    const applicationName = `pt_worker_accept_${crypto.randomBytes(8).toString('hex')}`;
    url.searchParams.set('application_name', applicationName);
    // 不继承管理员凭据、PG*、NODE_OPTIONS 或其他应用配置。
    const env = {};
    for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'HOME', 'LANG']) {
        if (process.env[key]) env[key] = process.env[key];
    }
    env.PAINTTRACK_WORKER_DATABASE_URL = url.href;
    env.PAINTTRACK_POSTGRES_WORKER_MODE = mode;
    const child = fork(path.join(root, 'tests/fixtures/worker-postgres.cjs'), [], {
        env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const messages = [];
    let output = '';
    let closed = false;
    let spawnFailed = false;
    child.stdout.on('data', (data) => { output = (output + data).slice(-8192); });
    // 子进程错误内容不进入报告或终端。
    child.stderr.resume();
    child.on('message', (message) => { messages.push(message); });
    child.on('error', () => { spawnFailed = true; });
    const exit = new Promise((resolve) => child.once('close', (code, signal) => {
        closed = true;
        resolve({ code, signal });
    }));
    const handle = {
        child, applicationName, messages, exit,
        get closed() { return closed; },
        get output() { return output; },
        async wait(event, occurrence = 1) {
            let found;
            await waitFor(async () => {
                found = messages.filter((message) => message.event === event)[occurrence - 1];
                if (!found && (closed || spawnFailed)) throw new Error('Worker 提前退出');
                return Boolean(found);
            });
            return found;
        },
        async waitExit() {
            await waitFor(async () => closed);
            return exit;
        },
    };
    children.push(handle);
    return handle;
}

async function waitFor(check, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() >= deadline) throw new Error('Worker 验收等待超时');
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

async function checkPostgresWorkers({ runtimeUrl, workerUrl, migrationUrl, record }) {
    if (!runtimeUrl || !workerUrl) throw new Error('Web and Worker database URLs are required');
    const target = parseDatabaseTarget(localUrl(runtimeUrl));
    const workerTarget = parseDatabaseTarget(localUrl(workerUrl));
    assert.match(target.database, /^pt_acceptance_[a-z0-9]+_[a-f0-9]{6}$/);
    assert.equal(target.username, target.database.replace(/^pt_acceptance_/, 'pt_runtime_'));
    assertDistinctRuntimeIdentity(runtimeUrl, workerUrl);
    assert.equal(workerTarget.username, target.database.replace(/^pt_acceptance_/, 'pt_worker_'));
    const pool = new Pool({ connectionString: localUrl(runtimeUrl), max: 2,
        connectionTimeoutMillis: 3000, query_timeout: 5000 });
    const executionPool = new Pool({ connectionString: localUrl(workerUrl), max: 2,
        connectionTimeoutMillis: 3000, query_timeout: 5000 });
    const children = [];
    const row = async (id) => (await pool.query('SELECT * FROM generation_tasks WHERE id=$1', [id])).rows[0];
    let taskSeq = 0;
    const newTask = () => queue.createTask(pool, {
        ownerId: '00000000-0000-4000-8000-0000000000aa',
        idempotencyKey: `accept:worker:${process.pid}:${++taskSeq}`,
        requestFingerprint: '1'.repeat(64),
        taskType: 'postgres-worker-acceptance',
        payload: {},
    }).then((created) => created.task);
    const start = async (mode) => {
        const child = launchPostgresWorker(workerUrl, mode, children);
        await child.wait('ready');
        child.child.send('start');
        const identity = await child.wait('identity');
        assert.equal(identity.username, workerTarget.username);
        return child;
    };
    const noConnections = async (workers) => {
        await waitFor(async () => (await pool.query(
            'SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND application_name=ANY($1::text[])',
            [workers.map((worker) => worker.applicationName)],
        )).rows[0].count === 0);
    };
    const stop = async (child) => {
        child.child.send('stop');
        assert.equal((await child.waitExit()).code, 0);
        assert.match(child.output, /"status":"stopped"/);
        await noConnections([child]);
    };
    const expired = async (id) => {
        // 以 PostgreSQL 时钟观察自然过期；不改写租约或任务状态。
        await waitFor(async () => (await pool.query(
            'SELECT lease_expires_at <= clock_timestamp() AS expired FROM generation_tasks WHERE id=$1', [id],
        )).rows[0].expired === true);
    };
    const fenced = async (taskId, leaseToken) => {
        const client = await executionPool.connect();
        try {
            await client.query('BEGIN');
            // 锁住当前行，排除有效 Worker 心跳对逐字段快照比较的干扰。
            const before = (await client.query('SELECT * FROM generation_tasks WHERE id=$1 FOR UPDATE', [taskId])).rows[0];
            for (const operation of [queue.heartbeatTask, queue.completeTask, queue.failTask]) {
                await assert.rejects(operation(client, {
                    taskId,
                    leaseToken,
                    errorMessage: 'stale-worker',
                    result: { kind: 'stale-probe' },
                }), (error) => error instanceof queue.TaskQueueError && error.code === 'LEASE_LOST');
                assert.deepEqual((await client.query('SELECT * FROM generation_tasks WHERE id=$1', [taskId])).rows[0], before);
            }
        } finally {
            try {
                await client.query('ROLLBACK');
            } finally {
                client.release();
            }
        }
    };
    const finish = async (child, id) => {
        child.child.send('finish');
        await waitFor(async () => (await row(id)).status === 'succeeded');
        const completed = await row(id);
        assert.equal(completed.lease_token, null);
        assert.equal(completed.lease_expires_at, null);
        assert.equal(completed.worker_id, null);
        assert.ok(completed.completed_at);
        assert.equal(completed.last_error, null);
    };
    try {
        assert.equal((await pool.query('SELECT count(*)::int AS count FROM generation_tasks')).rows[0].count, 0);
        // 并发同键提交必须收敛成一个任务：唯一索引负责决胜，事务内读回负责让失败方拿到同一结果。
        const idempotentInput = {
            ownerId: '00000000-0000-4000-8000-0000000000aa',
            idempotencyKey: `accept:idempotent:${process.pid}:${Date.now()}`,
            requestFingerprint: '2'.repeat(64),
            taskType: 'postgres-worker-acceptance',
            payload: { concurrent: true },
        };
        const [firstCreate, secondCreate] = await Promise.all([
            queue.createTask(pool, idempotentInput),
            queue.createTask(pool, idempotentInput),
        ]);
        assert.equal(firstCreate.task.id, secondCreate.task.id);
        assert.equal([firstCreate.inserted, secondCreate.inserted].filter(Boolean).length, 1);
        assert.equal((await pool.query(
            'SELECT count(*)::int AS count FROM generation_tasks WHERE owner_id=$1::uuid AND idempotency_key=$2',
            [idempotentInput.ownerId, idempotentInput.idempotencyKey],
        )).rows[0].count, 1);
        // 同一个键在另一个 owner 下必须是一次全新的提交，不能跨用户复用任务或泄露旧任务。
        const otherOwner = await queue.createTask(pool, {
            ...idempotentInput, ownerId: '00000000-0000-4000-8000-0000000000ab',
        });
        assert.equal(otherOwner.inserted, true);
        assert.notEqual(otherOwner.task.id, firstCreate.task.id);
        assert.equal((await pool.query(
            'SELECT count(*)::int AS count FROM generation_tasks WHERE owner_id=$1::uuid AND idempotency_key=$2',
            ['00000000-0000-4000-8000-0000000000ab', idempotentInput.idempotencyKey],
        )).rows[0].count, 1);
        await withClient(migrationUrl, (owner) => owner.query('DELETE FROM generation_tasks WHERE id = ANY($1::uuid[])',
            [[firstCreate.task.id, otherOwner.task.id]]));
        record('同一owner并发同键提交收敛为一个任务且不同owner互不影响', 'passed');
        record('真实PostgreSQL Worker验收开始', 'running');
        const tasks = [];
        for (let i = 0; i < 12; i++) tasks.push(await newTask());
        const concurrent = Array.from({ length: 3 }, () => launchPostgresWorker(workerUrl, 'hold', children));
        await Promise.all(concurrent.map((child) => child.wait('ready')));
        for (const child of concurrent) child.child.send('start');
        const claimedIds = [];
        for (let round = 1; round <= 4; round++) {
            const claims = await Promise.all(concurrent.map((child) => child.wait('started', round)));
            for (const [index, claim] of claims.entries()) {
                assert.ok(tasks.some((task) => task.id === claim.taskId));
                assert.equal(claim.attempts, 1);
                claimedIds.push(claim.taskId);
                const persisted = await row(claim.taskId);
                assert.equal(persisted.status, 'running');
                assert.equal(persisted.lease_token, claim.token);
                assert.equal(persisted.worker_id, `postgres-child-${concurrent[index].child.pid}`);
            }
            // 从服务器确认三个独立后端均使用本次运行角色，领取事务已释放。
            await waitFor(async () => {
                const sessions = await pool.query(
                    `SELECT pid, usename, application_name, xact_start FROM pg_stat_activity
                     WHERE datname=current_database() AND application_name=ANY($1::text[])`,
                    [concurrent.map((child) => child.applicationName)],
                );
                assert.ok(sessions.rows.every((session) => session.usename === workerTarget.username));
                return sessions.rowCount === 3
                    && new Set(sessions.rows.map((session) => session.pid)).size === 3
                    && new Set(sessions.rows.map((session) => session.application_name)).size === 3
                    && sessions.rows.every((session) => session.xact_start === null);
            });
            assert.equal(new Set(claimedIds).size, claimedIds.length);
            await Promise.all(concurrent.map((child, index) => finish(child, claims[index].taskId)));
        }
        assert.equal(claimedIds.length, tasks.length);
        assert.equal((await pool.query("SELECT count(*)::int AS count FROM generation_tasks WHERE status='succeeded' AND attempts=1")).rows[0].count, 12);
        await Promise.all(concurrent.map(stop));
        assert.ok(concurrent.every((child) => child.messages.filter((message) => message.event === 'started').length === 4));
        record('真实多Worker并发12任务无重复领取及空闲停止连接释放', 'passed', {
            workers: 3, tasks: 12, rounds: 4, distinctPostgresBackends: 3, attemptsPerTask: 1,
        });

        record('真实Node终止/过期/重领/fencing验收开始', 'running');
        const crashTask = await newTask();
        const original = await start('crash');
        const originalClaim = await original.wait('started');
        assert.equal(originalClaim.taskId, crashTask.id);
        assert.equal(originalClaim.attempts, 1);
        assert.ok(original.child.kill('SIGKILL'));
        const killed = await original.waitExit();
        assert.ok(killed.signal || killed.code !== 0);
        await noConnections([original]);
        assert.equal((await row(crashTask.id)).status, 'running');
        await expired(crashTask.id);
        await fenced(crashTask.id, originalClaim.token);
        const replacement = await start('hold');
        const reclaimed = await replacement.wait('started');
        assert.equal(reclaimed.taskId, crashTask.id);
        assert.equal(reclaimed.attempts, 2);
        assert.notEqual(reclaimed.token, originalClaim.token);
        const beforeHeartbeat = await row(crashTask.id);
        await waitFor(async () => (await row(crashTask.id)).lease_expires_at > beforeHeartbeat.lease_expires_at);
        await fenced(crashTask.id, originalClaim.token);
        await finish(replacement, crashTask.id);
        await stop(replacement);
        assert.equal((await row(crashTask.id)).attempts, 2);
        record('真实Node强制终止后自然租约过期和重启恢复', 'passed');
        record('真实过期及重领后旧token heartbeat/complete/fail fencing与有效心跳', 'passed');

        for (const mode of ['cooperative', 'uncooperative']) {
            record(mode === 'cooperative' ? '真实Worker协作停止验收开始' : '真实Worker非协作停止验收开始', 'running');
            const task = await newTask();
            const child = await start(mode);
            const claim = await child.wait('started');
            assert.equal(claim.taskId, task.id);
            child.child.send('stop');
            if (mode === 'cooperative') await child.wait('aborted');
            assert.equal((await child.waitExit()).code, mode === 'cooperative' ? 0 : 1);
            assert.match(child.output, mode === 'cooperative' ? /"status":"stopped"/ : /"status":"cancellation-timeout"/);
            if (mode === 'uncooperative') assert.doesNotMatch(child.output, /"status":"stopped"/);
            await noConnections([child]);
            const abandoned = await row(task.id);
            assert.equal(abandoned.status, 'running');
            assert.equal(abandoned.attempts, 1);
            assert.equal(abandoned.lease_token, claim.token);
            assert.equal(abandoned.last_error, null);
            assert.equal(abandoned.completed_at, null);
            await expired(task.id);
            const recovery = await start('hold');
            const recovered = await recovery.wait('started');
            assert.equal(recovered.taskId, task.id);
            assert.equal(recovered.attempts, 2);
            assert.notEqual(recovered.token, claim.token);
            await finish(recovery, task.id);
            await stop(recovery);
            record(mode === 'cooperative' ? '真实Worker协作停止无成功/失败写入且连接释放及恢复' : '真实Worker非协作停止非零退出且连接释放及恢复', 'passed');
        }
        assert.equal((await pool.query('SELECT count(*)::int AS count FROM generation_tasks')).rows[0].count, 15);
        assert.equal((await pool.query("SELECT count(*)::int AS count FROM generation_tasks WHERE status<>'succeeded' OR lease_token IS NOT NULL OR lease_expires_at IS NOT NULL")).rows[0].count, 0);
    } finally {
        // 只终止本次验收创建的子进程，不触碰任何已有进程或数据库资源。
        try {
            for (const child of children) if (!child.closed) child.child.kill('SIGKILL');
            await Promise.all(children.map((child) => child.waitExit()));
            await noConnections(children);
        } finally {
            await Promise.all([pool.end(), executionPool.end()]);
        }
    }
}

// Web 角色的取消权限必须是列级：能写取消意图，不能写租约/执行状态。
// 迁移角色是 NOCREATEROLE，无法自建探针角色，因此这一步用管理员连接执行，
// 建一个与真实 Web 进程同权限的临时角色做正负例，验完立即删除。
async function checkWorkerRolePrivileges({ adminUrl, database, record }) {
    const url = new URL(adminUrl);
    url.pathname = `/${database}`;
    const role = `pt_worker_probe_${crypto.randomBytes(3).toString('hex')}`;
    await withClient(url.href, async (client) => {
        await client.query(`CREATE ROLE ${quote(role)} NOLOGIN`);
        try {
            await client.query(`GRANT USAGE ON SCHEMA public TO ${quote(role)}`);
            await require('../lib/server/db/runtimePermissions').grantWorkerRuntimePermissions(client, role);
            const columns = await client.query(`SELECT table_name,column_name,privilege_type
                FROM information_schema.column_privileges WHERE grantee=$1 ORDER BY table_name,column_name,privilege_type`, [role]);
            const actual = columns.rows.map((row) => `${row.table_name}.${row.column_name}:${row.privilege_type}`).sort(compareText);
            const expected = [
                ...['id','task_type','payload','status','attempts','max_attempts','available_at','lease_token','lease_expires_at','worker_id','last_error','created_at','updated_at','completed_at','owner_id','idempotency_key','request_fingerprint','result','cancel_requested_at','logical_model_pk','route_snapshot','route_snapshot_version','route_snapshot_hash'].map((column) => `generation_tasks.${column}:SELECT`),
                ...['status','attempts','available_at','lease_token','lease_expires_at','worker_id','last_error','updated_at','completed_at','result'].map((column) => `generation_tasks.${column}:UPDATE`),
                ...['id','task_id','attempt_no','provider_name','idempotency_key','provider_job_id','status','worker_id','lease_token','lease_expires_at','last_error_code','created_at','updated_at','recovery_attempts','available_at','provider_instance_id','provider_config_version','credential_ref_version','provider_model_id','logical_model_id','binding_id','binding_version','adapter_type','adapter_version','upstream_model_name','operation_profile','route_snapshot_hash'].map((column) => `provider_calls.${column}:SELECT`),
                // 15.1 当前边界为表级 INSERT；显式列全，避免从授权实现同源生成期望。
                ...['id','task_id','attempt_no','provider_name','idempotency_key','provider_job_id','status','worker_id','lease_token','lease_expires_at','last_error_code','created_at','updated_at','recovery_attempts','available_at','provider_instance_id','provider_config_version','credential_ref_version','provider_model_id','logical_model_id','binding_id','binding_version','adapter_type','adapter_version','upstream_model_name','operation_profile','route_snapshot_hash'].map((column) => `provider_calls.${column}:INSERT`),
                ...['status','provider_job_id','worker_id','lease_token','lease_expires_at','available_at','last_error_code','recovery_attempts','updated_at'].map((column) => `provider_calls.${column}:UPDATE`),
                ...['id','owner_id','status'].map((column) => `assets.${column}:SELECT`),
                ...['owner_id','media_type','mime_type','size_bytes','metadata','status'].map((column) => `assets.${column}:INSERT`),
                ...['status','storage_key','thumbnail_storage_key','checksum_sha256','updated_at','deleted_at'].map((column) => `assets.${column}:UPDATE`),
                // email_outbox 为表级 SELECT/UPDATE，logical_models 为表级 SELECT。
                ...['id','idempotency_key','kind','recipient_email','payload_ciphertext','payload_nonce','payload_tag','status','attempts','available_at','locked_at','locked_by','last_error_code','created_at','updated_at','sent_at'].map((column) => `email_outbox.${column}:SELECT`),
                ...['id','idempotency_key','kind','recipient_email','payload_ciphertext','payload_nonce','payload_tag','status','attempts','available_at','locked_at','locked_by','last_error_code','created_at','updated_at','sent_at'].map((column) => `email_outbox.${column}:UPDATE`),
                ...['id','logical_model_id','display_name','provider_display_name','media_type','supported_operations','capability_template_key','capability_template_version','parameter_schema','parameter_schema_version','description','icon_key','enabled','sort_order','catalog_version','created_at','updated_at','disabled_at'].map((column) => `logical_models.${column}:SELECT`),
                ...['id','slug','display_name','adapter_type','base_url','credential_ref','credential_version','enabled','health_state','config_version','created_at','updated_at','disabled_at'].map((column) => `provider_instances.${column}:SELECT`),
                ...['id','provider_instance_id','upstream_model_name','media_type','operation_profile','capabilities','parameter_mapping','request_mapping_version','response_mapping_version','validation_state','enabled','created_at','updated_at','disabled_at'].map((column) => `provider_models.${column}:SELECT`),
                ...['id','logical_model_pk','provider_model_id','priority','is_primary','enabled','binding_version','created_by','updated_by','created_at','updated_at','disabled_at'].map((column) => `model_provider_bindings.${column}:SELECT`),
            ].sort(compareText);
            assert.deepEqual(actual, expected, `Worker 列级权限不符 ${JSON.stringify(privilegeDelta(actual, expected))}`);
            const tableRights = await client.query(`SELECT
                has_table_privilege($1,'public.generation_tasks','INSERT') AS task_insert,
                has_table_privilege($1,'public.generation_tasks','DELETE') AS task_delete,
                has_table_privilege($1,'public.provider_calls','DELETE') AS call_delete,
                has_table_privilege($1,'public.provider_config_audit_events','INSERT') AS audit_insert,
                has_table_privilege($1,'public.provider_config_audit_events','UPDATE') AS audit_update,
                has_table_privilege($1,'public.provider_config_audit_events','DELETE') AS audit_delete,
                has_table_privilege($1,'public.assets','INSERT') AS asset_insert,
                has_table_privilege($1,'public.assets','SELECT') AS asset_select,
                has_table_privilege($1,'public.assets','UPDATE') AS asset_update,
                has_table_privilege($1,'public.assets','DELETE') AS asset_delete`, [role]);
            assert.deepEqual(tableRights.rows[0], { task_insert: false, task_delete: false, call_delete: false, audit_insert: false, audit_update: false, audit_delete: false, asset_insert: false, asset_select: false, asset_update: false, asset_delete: false });
            await client.query(`SET ROLE ${quote(role)}`);
            try {
                await assert.rejects(client.query("INSERT INTO generation_tasks(owner_id,idempotency_key,request_fingerprint,task_type,payload) VALUES('00000000-0000-4000-8000-000000000010','worker:forbidden:1',$1,'worker-probe','{}')", ['a'.repeat(64)]), (error) => error.code === '42501');
                await assert.rejects(client.query("UPDATE generation_tasks SET route_snapshot='{}'::jsonb"), (error) => error.code === '42501');
                await assert.rejects(client.query("UPDATE provider_calls SET idempotency_key='forbidden'"), (error) => error.code === '42501');
                await assert.rejects(client.query("INSERT INTO provider_config_audit_events(resource_type,resource_id,action,outcome) VALUES('provider_instance','00000000-0000-4000-8000-000000000010','create','succeeded')"), (error) => error.code === '42501');
            } finally {
                await client.query('RESET ROLE');
            }
            record('Worker独立角色仅有执行所需列权限；不能创建任务、改路由/调用身份或追加/篡改审计', 'passed');
        } finally {
            await client.query(`DROP OWNED BY ${quote(role)}`).catch(() => {});
            await client.query(`DROP ROLE ${quote(role)}`).catch(() => {});
        }
    });
}

async function checkCleanupRolePrivileges({ adminUrl, database, record }) {
    const url = new URL(adminUrl);
    url.pathname = `/${database}`;
    const role = `pt_cleanup_probe_${crypto.randomBytes(3).toString('hex')}`;
    await withClient(url.href, async (client) => {
        await client.query(`CREATE ROLE ${quote(role)} NOLOGIN`);
        try {
            await client.query(`GRANT USAGE ON SCHEMA public TO ${quote(role)}`);
            await require('../lib/server/db/runtimePermissions').grantCleanupRuntimePermissions(client, role);
            const columns = await client.query(`SELECT table_name,column_name,privilege_type
                FROM information_schema.column_privileges WHERE grantee=$1 ORDER BY table_name,column_name,privilege_type`, [role]);
            const actual = columns.rows.map((row) => `${row.table_name}.${row.column_name}:${row.privilege_type}`).sort(compareText);
            const expected = [
                ...['id', 'owner_id', 'status', 'storage_key', 'thumbnail_storage_key', 'deleted_at', 'purged_at', 'purge_attempts', 'created_at', 'abandoned_at'].map((column) => `assets.${column}:SELECT`),
                ...['purged_at', 'purge_attempts', 'last_purge_error', 'updated_at', 'abandoned_at'].map((column) => `assets.${column}:UPDATE`),
            ].sort(compareText);
            assert.deepEqual(actual, expected, `cleanup 列级权限不符 ${JSON.stringify(privilegeDelta(actual, expected))}`);
            const tableRights = await client.query(`SELECT
                has_table_privilege($1,'public.assets','SELECT') AS asset_select,
                has_table_privilege($1,'public.assets','INSERT') AS asset_insert,
                has_table_privilege($1,'public.assets','UPDATE') AS asset_update,
                has_table_privilege($1,'public.assets','DELETE') AS asset_delete,
                has_table_privilege($1,'public.users','SELECT') AS user_select,
                has_table_privilege($1,'public.generation_tasks','SELECT') AS task_select`, [role]);
            assert.deepEqual(tableRights.rows[0], {
                asset_select: false, asset_insert: false, asset_update: false, asset_delete: false,
                user_select: false, task_select: false,
            });
            await client.query(`SET ROLE ${quote(role)}`);
            try {
                for (const sql of [
                    'SELECT email FROM users LIMIT 1',
                    'SELECT count(*) FROM generation_tasks',
                    'SELECT mime_type FROM assets LIMIT 1',
                    "UPDATE assets SET status='ready'",
                    "UPDATE assets SET storage_key='users/x/assets/y'",
                    'DELETE FROM assets',
                ]) {
                    await assert.rejects(client.query(sql), (error) => error.code === '42501', `cleanup 不应能执行：${sql}`);
                }
                // 正例：只读定位键与生命周期时间、只写清理进度列必须可用，否则清理进程无法工作。
                const readable = await client.query('SELECT id,storage_key,thumbnail_storage_key,purge_attempts,created_at,abandoned_at FROM assets LIMIT 1');
                assert.ok(Array.isArray(readable.rows));
                await client.query('UPDATE assets SET purge_attempts=purge_attempts WHERE false');
                await client.query('UPDATE assets SET abandoned_at=abandoned_at WHERE false');
            } finally {
                await client.query('RESET ROLE');
            }
            record('cleanup独立角色仅可读定位键与生命周期时间、写清理进度五列；不能改status/storage_key或读用户与任务', 'passed');
        } finally {
            await client.query(`DROP OWNED BY ${quote(role)}`).catch(() => {});
            await client.query(`DROP ROLE ${quote(role)}`).catch(() => {});
        }
    });
}

async function checkWebRolePrivileges({ adminUrl, database, record }) {
    const url = new URL(adminUrl);
    url.pathname = `/${database}`;
    const role = `pt_runtime_webprobe_${crypto.randomBytes(3).toString('hex')}`;
    await withClient(url.href, async (client) => {
        await client.query(`CREATE ROLE ${quote(role)} NOLOGIN`);
        try {
            await client.query(`GRANT USAGE ON SCHEMA public TO ${quote(role)}`);
            await require('../lib/server/db/runtimePermissions').grantRuntimePermissions(client, role, {});
            const privileges = await client.query(
                `SELECT has_column_privilege($1,'generation_tasks','status','UPDATE') AS status_update,
                        has_column_privilege($1,'generation_tasks','cancel_requested_at','UPDATE') AS cancel_update,
                        has_column_privilege($1,'generation_tasks','worker_id','UPDATE') AS worker_update,
                        has_column_privilege($1,'generation_tasks','result','UPDATE') AS result_update,
                        has_table_privilege($1,'generation_tasks','UPDATE') AS table_update,
                        has_table_privilege($1,'provider_calls','UPDATE') AS provider_calls_update`,
                [role],
            );
            assert.deepEqual(privileges.rows[0], {
                status_update: true,
                cancel_update: true,
                worker_update: false,
                result_update: false,
                table_update: false,
                provider_calls_update: false,
            }, `Web角色列级写权限不符 ${JSON.stringify(privileges.rows[0])}`);
            await client.query(`SET ROLE ${quote(role)}`);
            let workerWriteCode = null;
            try {
                const emptyCatalog = await client.query('SELECT * FROM public.model_catalog_public');
                assert.deepEqual(emptyCatalog.rows, []);
                // 取消服务用 SELECT ... FOR UPDATE 串行化"领取"与"取消"；
                // 列级 UPDATE 授权下行锁必须可用，否则取消会在生产角色下直接 42501。
                await client.query('SELECT id FROM generation_tasks LIMIT 1 FOR UPDATE');
                try {
                    await client.query("UPDATE generation_tasks SET worker_id='forbidden'");
                } catch (error) {
                    workerWriteCode = error.code;
                }
            } finally {
                await client.query('RESET ROLE');
            }
            assert.equal(workerWriteCode, '42501');
            record('Web运行角色仅获任务取消列级写权限，无法写租约或结果', 'passed');
            // Web 只能读逻辑目录安全投影，读不到 Provider 上游配置。该结论只能在独立 Web 角色上验证：
            // 验收库的合并 Web+Worker 角色按设计能读 base_url/upstream_model_name。
            const catalogPrivileges = await client.query(
                `SELECT has_table_privilege($1,'public.logical_models','SELECT') AS logical_models_select,
                        has_table_privilege($1,'public.model_catalog_public','SELECT') AS model_catalog_public_select,
                        has_table_privilege($1,'public.provider_instances','SELECT') AS provider_instances_select,
                        has_table_privilege($1,'public.provider_models','SELECT') AS provider_models_select,
                        has_table_privilege($1,'public.model_provider_bindings','SELECT') AS bindings_select,
                        has_column_privilege($1,'public.logical_models','logical_model_id','SELECT') AS logical_model_id_select,
                        has_column_privilege($1,'public.logical_models','supported_operations','SELECT') AS supported_operations_select,
                        has_column_privilege($1,'public.provider_instances','base_url','SELECT') AS base_url_select,
                        has_column_privilege($1,'public.provider_instances','credential_ref','SELECT') AS credential_ref_select,
                        has_column_privilege($1,'public.provider_models','upstream_model_name','SELECT') AS upstream_name_select,
                        has_column_privilege($1,'public.provider_models','parameter_mapping','SELECT') AS parameter_mapping_select,
                        has_column_privilege($1,'public.model_provider_bindings','provider_model_id','SELECT') AS binding_provider_model_select`,
                [role],
            );
            assert.deepEqual(catalogPrivileges.rows[0], {
                logical_models_select: false,
                model_catalog_public_select: true,
                provider_instances_select: false,
                provider_models_select: false,
                bindings_select: false,
                logical_model_id_select: true,
                supported_operations_select: true,
                base_url_select: false,
                credential_ref_select: false,
                upstream_name_select: false,
                parameter_mapping_select: false,
                binding_provider_model_select: false,
            }, `Web角色目录投影权限不符 ${JSON.stringify(catalogPrivileges.rows[0])}`);
            const auditId = crypto.randomUUID();
            const auditRequestId = `web-audit-${crypto.randomBytes(8).toString('hex')}`;
            await client.query(`SET ROLE ${quote(role)}`);
            try {
                const auditPrivilege = await client.query(
                    `SELECT has_table_privilege(current_user,'public.provider_config_audit_events','INSERT') AS insert_allowed,
                            has_table_privilege(current_user,'public.provider_config_audit_events','UPDATE') AS update_allowed,
                            has_table_privilege(current_user,'public.provider_config_audit_events','DELETE') AS delete_allowed`);
                assert.deepEqual(auditPrivilege.rows[0], { insert_allowed: true, update_allowed: false, delete_allowed: false });
                await client.query(`INSERT INTO provider_config_audit_events(id,resource_type,resource_id,action,request_id,outcome)
                    VALUES ($1,'provider_instance',$2,'create',$3,'succeeded')`, [auditId, crypto.randomUUID(), auditRequestId]);
                await assert.rejects(client.query("UPDATE provider_config_audit_events SET action='update'"), (error) => error.code === '42501');
                await assert.rejects(client.query('DELETE FROM provider_config_audit_events'), (error) => error.code === '42501');
            } finally {
                await client.query('RESET ROLE');
            }
            const persistedAudit = await client.query('SELECT id,action FROM provider_config_audit_events WHERE request_id=$1', [auditRequestId]);
            assert.deepEqual(persistedAudit.rows, [{ id: auditId, action: 'create' }]);
            await client.query('DELETE FROM provider_config_audit_events WHERE id=$1', [auditId]);
            record('Web可追加审计但真实UPDATE/DELETE遭42501拒绝', 'passed');

            const providerId = crypto.randomUUID();
            const verifiedProviderModelId = crypto.randomUUID();
            const unverifiedProviderModelId = crypto.randomUUID();
            const verifiedLogicalModelId = crypto.randomUUID();
            const unverifiedLogicalModelId = crypto.randomUUID();
            const verifiedBindingId = crypto.randomUUID();
            const unverifiedBindingId = crypto.randomUUID();
            try {
                await client.query(`INSERT INTO provider_instances (
                    id,slug,display_name,adapter_type,base_url,credential_ref,enabled
                ) VALUES ($1,$2,'Catalog probe provider','openai-compatible','https://catalog-secret.invalid/v1','catalog-secret-reference',true)`,
                [providerId, `catalog-probe-${crypto.randomBytes(4).toString('hex')}`]);
                await client.query(`INSERT INTO provider_models (
                    id,provider_instance_id,upstream_model_name,media_type,operation_profile,capabilities,
                    parameter_mapping,request_mapping_version,response_mapping_version,validation_state,enabled
                ) VALUES
                    ($1,$3,'catalog-secret-upstream-model','image','image.generate','{}','{}',1,1,'verified',true),
                    ($2,$3,'catalog-unverified-model','image','image.generate','{}','{}',1,1,'unverified',true)`,
                [verifiedProviderModelId, unverifiedProviderModelId, providerId]);
                await client.query(`INSERT INTO logical_models (
                    id,logical_model_id,display_name,provider_display_name,media_type,supported_operations,
                    enabled,sort_order,catalog_version
                ) VALUES
                    ($1,'catalog-probe-model','Catalog Probe','Probe Publisher','image','["image.generate"]',true,1,1),
                    ($2,'catalog-unverified-model','Must Stay Hidden','Probe Publisher','image','["image.generate"]',true,2,1)`,
                [verifiedLogicalModelId, unverifiedLogicalModelId]);
                await client.query(`INSERT INTO model_provider_bindings (
                    id,logical_model_pk,provider_model_id,priority,is_primary,enabled
                ) VALUES ($1,$3,$4,1,true,true),($2,$5,$6,1,true,true)`,
                [verifiedBindingId, unverifiedBindingId, verifiedLogicalModelId, verifiedProviderModelId, unverifiedLogicalModelId, unverifiedProviderModelId]);

                await client.query(`SET ROLE ${quote(role)}`);
                try {
                    const publicRows = await client.query('SELECT * FROM public.model_catalog_public');
                    assert.equal(publicRows.rowCount, 1);
                    assert.deepEqual(Object.keys(publicRows.rows[0]).sort(), [
                        'logical_model_id', 'display_name', 'provider_display_name', 'media_type',
                        'supported_operations', 'capability_template_key', 'capability_template_version',
                        'parameter_schema_version', 'description', 'icon_key', 'sort_order', 'catalog_version',
                    ].sort());
                    assert.equal(publicRows.rows[0].logical_model_id, 'catalog-probe-model');
                    assert.deepEqual(publicRows.rows[0].supported_operations, ['image.generate']);
                    assert.doesNotMatch(JSON.stringify(publicRows.rows), /catalog-secret|upstream_model_name|base_url|credential_ref|parameter_mapping/);
                    let secretReadCode = null;
                    try {
                        await client.query('SELECT base_url FROM provider_instances WHERE id=$1', [providerId]);
                    } catch (error) {
                        secretReadCode = error.code;
                    }
                    assert.equal(secretReadCode, '42501');
                } finally {
                    await client.query('RESET ROLE');
                }
                record('真实Web运行角色可查询安全目录视图，未验证路由及上游敏感配置均不可见', 'passed');
            } finally {
                await client.query('DELETE FROM model_provider_bindings WHERE id = ANY($1::uuid[])', [[verifiedBindingId, unverifiedBindingId]]);
                await client.query('DELETE FROM provider_models WHERE id = ANY($1::uuid[])', [[verifiedProviderModelId, unverifiedProviderModelId]]);
                await client.query('DELETE FROM logical_models WHERE id = ANY($1::uuid[])', [[verifiedLogicalModelId, unverifiedLogicalModelId]]);
                await client.query('DELETE FROM provider_instances WHERE id=$1', [providerId]);
            }
            record('Web运行角色只能读取逻辑目录安全投影，读不到Provider上游配置', 'passed');
        } finally {
            await client.query(`DROP OWNED BY ${quote(role)}`).catch(() => {});
            await client.query(`DROP ROLE ${quote(role)}`).catch(() => {});
        }
    });
}

async function main() {
    // 只使用调用方显式提供的环境；验收入口不得隐式读取 .env。
    const suffix = `${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
    const names = { database: `pt_acceptance_${suffix}`, migrationRole: `pt_migrate_${suffix}`, runtimeRole: `pt_runtime_${suffix}`, workerRole: `pt_worker_${suffix}`, cleanupRole: `pt_cleanup_${suffix}`, bootstrapRole: `pt_bootstrap_${suffix}` };
    const log = path.join(root, '.workbuddy', `database-acceptance-${suffix}.json`);
    assert.ok(fs.statSync(path.dirname(log)).isDirectory());
    const report = { startedAt: new Date().toISOString(), endpoint: 'loopback:5433', proposed: names, created: [], checks: [], status: 'running' };
    const record = (name, status, extra = {}) => {
        report.checks.push({ name, status, ...extra });
        fs.writeFileSync(log, `${JSON.stringify(report, null, 2)}\n`);
    };
    try {
        if (!process.env.LOCAL_DATABASE_ADMIN_URL) {
            report.status = 'blocked';
            record('新建隔离数据库与角色', 'blocked', { reason: '未提供 LOCAL_DATABASE_ADMIN_URL；未连接 DATABASE_URL 或 TEST_DATABASE_URL，未尝试猜测管理员密码，未变更现有库或角色。' });
            process.exitCode = 2;
            return;
        }
        const adminUrl = localAdminUrl(process.env.LOCAL_DATABASE_ADMIN_URL);
        const allowed = await withClient(adminUrl, async (client) => {
            const { rows } = await client.query("SELECT rolsuper, rolcreatedb, rolcreaterole, current_setting('server_version_num')::int AS server_version_num FROM pg_roles WHERE rolname=current_user");
            record('LOCAL_DATABASE_ADMIN_URL创建权限只读检查', 'passed', rows[0]);
            return rows[0].rolsuper || (rows[0].rolcreatedb && rows[0].rolcreaterole);
        });
        if (!allowed) {
            report.status = 'blocked';
            record('新建隔离数据库与角色', 'blocked', { reason: '本机 postgres 管理身份缺少 CREATEDB/CREATEROLE；未连接既有业务库，未变更现有库或角色。' });
            process.exitCode = 2;
            return;
        }
        const migrationPassword = crypto.randomBytes(32).toString('hex');
        const runtimePassword = crypto.randomBytes(32).toString('hex');
        const workerPassword = crypto.randomBytes(32).toString('hex');
        const cleanupPassword = crypto.randomBytes(32).toString('hex');
        const bootstrapPassword = crypto.randomBytes(32).toString('hex');
        const migrationUrl = makeDatabaseUrl(adminUrl, names.migrationRole, migrationPassword, names.database);
        const runtimeUrl = makeDatabaseUrl(adminUrl, names.runtimeRole, runtimePassword, names.database);
        const workerUrl = makeDatabaseUrl(adminUrl, names.workerRole, workerPassword, names.database);
        const cleanupUrl = makeDatabaseUrl(adminUrl, names.cleanupRole, cleanupPassword, names.database);
        const bootstrapUrl = makeDatabaseUrl(adminUrl, names.bootstrapRole, bootstrapPassword, names.database);
        await withClient(adminUrl, async (client) => {
            for (const [role, password] of [[names.migrationRole, migrationPassword], [names.runtimeRole, runtimePassword], [names.workerRole, workerPassword], [names.cleanupRole, cleanupPassword], [names.bootstrapRole, bootstrapPassword]]) {
                await client.query(`CREATE ROLE ${quote(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
                report.created.push({ role });
                record('新建独立角色', 'passed', { role });
            }
            await client.query(`CREATE DATABASE ${quote(names.database)} OWNER ${quote(names.migrationRole)} TEMPLATE template0`);
            report.created.push({ database: names.database });
            await client.query(`REVOKE ALL ON DATABASE ${quote(names.database)} FROM PUBLIC`);
            record('新建唯一空隔离库', 'passed', { database: names.database });
        });
        await withClient(migrationUrl, async (client) => {
            await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
            await client.query('REVOKE USAGE ON SCHEMA public FROM PUBLIC');
        });
        await checkDatabase({ runtimeUrl, workerUrl, migrationUrl, bootstrapUrl, ...names, record });
        await checkWebRolePrivileges({ adminUrl, database: names.database, record });
        await checkWorkerRolePrivileges({ adminUrl, database: names.database, record });
        await checkCleanupRolePrivileges({ adminUrl, database: names.database, record });
        // 各 fixture 单项失败后继续执行，让一次运行暴露全部剩余问题，避免"修一处、下一处再失败"的反复重跑。
        // 隔离验收库本身是一次性资源，继续执行不会污染任何既有数据库；最终状态仍为 failed。
        const fixtureFailures = [];
        const runFixture = async (name, run) => {
            try {
                await run();
            } catch (error) {
                fixtureFailures.push({ name, code: safeCode(error) });
                record(`${name} 验收失败`, 'failed', { code: safeCode(error), ...sourceLocation(error), hint: safeAssertionHint(error) });
            }
        };
        const bootstrapPool = new Pool({ connectionString: bootstrapUrl, max: 8, connectionTimeoutMillis: 3000 });
        const registrationPool = new Pool({ connectionString: runtimeUrl, max: 6, connectionTimeoutMillis: 3000 });
        const workerPool = new Pool({ connectionString: workerUrl, max: 6, connectionTimeoutMillis: 3000 });
        const cleanupPool = new Pool({ connectionString: cleanupUrl, max: 2, connectionTimeoutMillis: 3000 });
        try {
            await runFixture('admin-bootstrap-postgres', async () => {
                const bootstrapFixture = require('../tests/fixtures/admin-bootstrap-postgres.cjs');
                const owner = new Client({ connectionString: migrationUrl, connectionTimeoutMillis: 3000 });
                await owner.connect();
                try {
                    await bootstrapFixture.checkAdminBootstrap(bootstrapPool, registrationPool, owner, bootstrapUrl, runtimeUrl, migrationUrl, record);
                } finally {
                    await owner.end();
                }
            });
            await runFixture('registration-postgres', () => require('../tests/fixtures/registration-postgres.cjs').checkRegistration(registrationPool, record));
            await runFixture('session-postgres', () => require('../tests/fixtures/session-postgres.cjs').checkSessions(registrationPool, record));
            if (process.env.RUN_ADMIN_MFA_PG_ACCEPTANCE === '1') {
                await runFixture('admin-mfa-postgres', () => withClient(migrationUrl, (owner) => require('../tests/fixtures/admin-mfa-postgres.cjs').checkAdminMfa(registrationPool, owner, record)));
            } else {
                record('admin-mfa-postgres', 'skipped', { reason: '需要显式设置 RUN_ADMIN_MFA_PG_ACCEPTANCE=1；只在本脚本新建的隔离验收库中运行。' });
            }
            await runFixture('password-reset-postgres', () => require('../tests/fixtures/password-reset-postgres.cjs').checkPasswordReset(registrationPool, record));
            await runFixture('auth-record-cleanup-postgres', () => require('../tests/fixtures/auth-record-cleanup-postgres.cjs').checkAuthRecordCleanup(registrationPool, record));
            await runFixture('email-outbox-postgres', () => withClient(migrationUrl, (owner) => require('../tests/fixtures/email-outbox-postgres.cjs').checkEmailOutboxWorker(workerPool, record, { owner })));
            await runFixture('provider-call-ledger-postgres', () => withClient(migrationUrl, (owner) => require('../tests/fixtures/provider-call-ledger-postgres.cjs').checkProviderCallLedger(workerPool, record, { webPool: registrationPool, owner })));
            await runFixture('task-executor-postgres', () => withClient(migrationUrl, (owner) => require('../tests/fixtures/task-executor-postgres.cjs').checkTaskExecutor(workerPool, record, { webPool: registrationPool, owner })));
            await runFixture('local-mock-route-postgres', () => withClient(migrationUrl, (owner) => require('../tests/fixtures/local-mock-route-postgres.cjs').checkLocalMockRoute(workerPool, record, { webPool: registrationPool, owner, ...names, objectStore: new MemoryObjectStore() })));
            await runFixture('task-cancel-postgres', () => withClient(migrationUrl, (owner) => require('../tests/fixtures/task-cancel-postgres.cjs').checkTaskCancellation(registrationPool, record, { workerPool, owner })));
            await runFixture('authorization-postgres', () => withClient(migrationUrl, (owner) => require('../tests/fixtures/authorization-postgres.cjs').checkAuthorization(registrationPool, owner, record)));
            await runFixture('asset-purge-postgres', () => withClient(migrationUrl, (owner) => require('../tests/fixtures/asset-purge-postgres.cjs').checkAssetPurge(cleanupPool, record, { owner })));
        } finally {
            await bootstrapPool.end();
            await registrationPool.end();
            await workerPool.end();
            await cleanupPool.end();
        }
        if (fixtureFailures.length) {
            record('Fixture子项失败汇总', 'failed', { count: fixtureFailures.length, fixtures: fixtureFailures.map((item) => item.name) });
            throw new Error(`Fixture 子项未通过：${fixtureFailures.map((item) => item.name).join('、')}`);
        }
        await checkPostgresWorkers({ runtimeUrl, workerUrl, migrationUrl, record });
        await withClient(adminUrl, async (client) => {
            const result = await client.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1', [names.database]);
            assert.equal(result.rows[0].count, 0);
        });
        record('验收目标无遗留连接/事务', 'passed');
        report.status = 'passed';
    } catch (error) {
        report.status = 'failed';
        // 仅记录受控源码位置，不输出可能包含密码、token或SQL参数的异常正文。
        record('本地验收终止', 'failed', { code: safeCode(error), ...sourceLocation(error), hint: safeAssertionHint(error) });
        process.exitCode = 1;
    } finally {
        report.finishedAt = new Date().toISOString();
        report.retention = '新建成功的数据库和角色全部保留；随机凭据不落盘、不打印；管理员可按报告名称管理。';
        fs.writeFileSync(log, `${JSON.stringify(report, null, 2)}\n`);
        console.log(JSON.stringify({ status: report.status, created: report.created, log }));
    }
}

if (require.main === module) main().catch(() => { console.error('本地验收初始化失败（未输出连接凭据）'); process.exitCode = 1; });
module.exports = {
    checkAuthRecordCleanup: require('../tests/fixtures/auth-record-cleanup-postgres.cjs').checkAuthRecordCleanup,
    checkAdminMfa: require('../tests/fixtures/admin-mfa-postgres.cjs').checkAdminMfa,
    checkDatabase,
    checkPostgresWorkers,
    checkTaskExecutor: require('../tests/fixtures/task-executor-postgres.cjs').checkTaskExecutor,
    checkTaskCancellation: require('../tests/fixtures/task-cancel-postgres.cjs').checkTaskCancellation,
    localAdminUrl,
    localUrl,
};
