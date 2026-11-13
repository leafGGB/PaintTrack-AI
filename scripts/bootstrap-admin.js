const { Client } = require('pg');
const { drizzle } = require('drizzle-orm/node-postgres');
const { parseDatabaseTarget, sameDatabaseTarget } = require('../lib/server/db/testIsolation');
const { createAdminBootstrapService, AdminBootstrapError } = require('../lib/server/adminBootstrap');

function readSecret(prompt, input = process.stdin, output = process.stdout) {
    if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
        throw new Error('BOOTSTRAP_TTY_REQUIRED');
    }
    return new Promise((resolve, reject) => {
        let value = '';
        let settled = false;
        const finish = (error, result) => {
            if (settled) return;
            settled = true;
            input.setRawMode(false);
            input.pause();
            input.removeListener('data', onData);
            output.write('\n');
            if (error) reject(error);
            else resolve(result);
        };
        const onData = (chunk) => {
            for (const character of String(chunk)) {
                if (character === '\u0003') return finish(new Error('BOOTSTRAP_CANCELLED'));
                if (character === '\r' || character === '\n') return finish(null, value);
                if (character === '\u007f' || character === '\b') {
                    if (value.length) value = value.slice(0, -1);
                    continue;
                }
                if (character >= ' ' && character !== '\u007f') value += character;
            }
        };
        output.write(prompt);
        input.setEncoding('utf8');
        input.setRawMode(true);
        input.resume();
        input.on('data', onData);
    });
}

function assertBootstrapEnvironment(env = process.env) {
    const value = env.BOOTSTRAP_DATABASE_URL;
    if (!value) throw new Error('BOOTSTRAP_DATABASE_URL_REQUIRED');
    const bootstrap = parseDatabaseTarget(value);
    if (!env.DATABASE_URL || !env.MIGRATION_DATABASE_URL) throw new Error('BOOTSTRAP_CONTEXT_URLS_REQUIRED');
    const runtime = parseDatabaseTarget(env.DATABASE_URL);
    const migration = parseDatabaseTarget(env.MIGRATION_DATABASE_URL);
    if (bootstrap.username === runtime.username || bootstrap.username === migration.username
        || runtime.username === migration.username) throw new Error('BOOTSTRAP_IDENTITY_MUST_DIFFER');
    if (!sameDatabaseTarget(value, env.DATABASE_URL) || !sameDatabaseTarget(value, env.MIGRATION_DATABASE_URL)) {
        throw new Error('BOOTSTRAP_TARGET_MUST_MATCH');
    }
    return { ...bootstrap, runtimeRole: runtime.username, migrationRole: migration.username };
}

async function assertBootstrapDatabasePrivileges(client, { expectedRole, runtimeRole, migrationRole }) {
    const { rows } = await client.query(`SELECT current_user AS current_user, r.rolsuper, r.rolcreatedb, r.rolcreaterole,
        r.rolreplication, r.rolbypassrls, pg_get_userbyid(c.relowner) AS table_owner,
        pg_has_role(current_user, c.relowner, 'MEMBER') AS owns_or_inherits_table,
        has_column_privilege(current_user, 'public.users', 'role', 'SELECT') AS can_read_role,
        has_column_privilege(current_user, 'public.users', 'email', 'INSERT') AS insert_email,
        has_column_privilege(current_user, 'public.users', 'password_hash', 'INSERT') AS insert_password_hash,
        has_column_privilege(current_user, 'public.users', 'email_verified_at', 'INSERT') AS insert_email_verified_at,
        has_column_privilege(current_user, 'public.users', 'role', 'INSERT') AS insert_role,
        has_table_privilege(current_user, 'public.users', 'UPDATE') AS can_update_users,
        has_table_privilege(current_user, 'public.users', 'DELETE') AS can_delete_users,
        has_table_privilege(current_user, 'public.users', 'TRUNCATE') AS can_truncate_users,
        has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_schema_objects,
        has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_database_objects,
        pg_has_role(current_user, $1, 'MEMBER') AS member_of_runtime,
        pg_has_role(current_user, $2, 'MEMBER') AS member_of_migration
        FROM pg_roles r JOIN pg_class c ON c.oid = 'public.users'::regclass WHERE r.rolname = current_user`,
    [runtimeRole, migrationRole]);
    const state = rows[0];
    if (!state || state.current_user !== expectedRole
        || [state.rolsuper, state.rolcreatedb, state.rolcreaterole, state.rolreplication, state.rolbypassrls,
            state.owns_or_inherits_table, state.can_update_users, state.can_delete_users, state.can_truncate_users,
            state.can_create_schema_objects, state.can_create_database_objects, state.member_of_runtime, state.member_of_migration].some(Boolean)
        || ![state.can_read_role, state.insert_email, state.insert_password_hash, state.insert_email_verified_at, state.insert_role].every(Boolean)) {
        throw new Error('BOOTSTRAP_PRIVILEGES_INVALID');
    }
    return { role: state.current_user, tableOwner: state.table_owner };
}

function safeFailure(error) {
    if (error instanceof AdminBootstrapError) {
        return {
            message: {
                INVALID_INPUT: '管理员初始化输入不符合要求。',
                ADMIN_ALREADY_INITIALIZED: '管理员初始化已完成；不会覆盖或重复升权。',
                ADMIN_EMAIL_EXISTS: '该邮箱已存在；不会把既有用户直接升为管理员。',
            }[error.code] || '管理员初始化未完成。',
            code: error.code,
        };
    }
    if (error?.message === 'BOOTSTRAP_TTY_REQUIRED') return { message: '管理员初始化必须在交互式终端中执行。', code: 'BOOTSTRAP_TTY_REQUIRED' };
    if (error?.message === 'BOOTSTRAP_CANCELLED') return { message: '管理员初始化已取消。', code: 'BOOTSTRAP_CANCELLED' };
    if (error?.message === 'BOOTSTRAP_DATABASE_URL_REQUIRED') return { message: '需要单独的 BOOTSTRAP_DATABASE_URL；不会回退到运行或迁移凭据。', code: 'BOOTSTRAP_DATABASE_URL_REQUIRED' };
    if (error?.message === 'BOOTSTRAP_CONTEXT_URLS_REQUIRED') return { message: '需要同时提供 DATABASE_URL 和 MIGRATION_DATABASE_URL 作为目标确认。', code: 'BOOTSTRAP_CONTEXT_URLS_REQUIRED' };
    if (error?.message === 'BOOTSTRAP_IDENTITY_MUST_DIFFER') return { message: '管理员初始化、运行和迁移身份必须彼此不同。', code: 'BOOTSTRAP_IDENTITY_MUST_DIFFER' };
    if (error?.message === 'BOOTSTRAP_TARGET_MUST_MATCH') return { message: '管理员初始化身份必须指向与运行/迁移身份相同的数据库目标。', code: 'BOOTSTRAP_TARGET_MUST_MATCH' };
    if (error?.message === 'BOOTSTRAP_PRIVILEGES_INVALID') return { message: '管理员初始化身份权限不符合最小权限要求。', code: 'BOOTSTRAP_PRIVILEGES_INVALID' };
    return { message: '管理员初始化失败；请检查受控数据库身份、迁移状态和数据库日志。', code: 'ADMIN_BOOTSTRAP_FAILED' };
}

async function main({ env = process.env, input = process.stdin, output = process.stdout, ClientImpl = Client } = {}) {
    let client;
    try {
        const environment = assertBootstrapEnvironment(env);
        const email = await readSecret('管理员邮箱: ', input, output);
        const password = await readSecret('管理员密码: ', input, output);
        const confirmation = await readSecret('确认管理员密码: ', input, output);
        if (password !== confirmation) throw new AdminBootstrapError('INVALID_INPUT', 400);

        client = new ClientImpl({
            connectionString: env.BOOTSTRAP_DATABASE_URL,
            connectionTimeoutMillis: 3000,
            application_name: 'painttrack-admin-bootstrap',
        });
        await client.connect();
        await assertBootstrapDatabasePrivileges(client, {
            expectedRole: environment.username,
            runtimeRole: environment.runtimeRole,
            migrationRole: environment.migrationRole,
        });
        const service = createAdminBootstrapService({ database: drizzle(client) });
        const result = await service.initialize({ email, password });
        output.write(`管理员初始化完成，用户ID：${result.userId}\n`);
        return result;
    } catch (error) {
        const failure = safeFailure(error);
        output.write(`${failure.message}\n`);
        process.exitCode = 1;
        return null;
    } finally {
        if (client) await client.end().catch(() => {});
    }
}

if (require.main === module) {
    main().catch(() => {
        process.stderr.write('管理员初始化失败。\n');
        process.exitCode = 1;
    });
}

module.exports = { assertBootstrapDatabasePrivileges, assertBootstrapEnvironment, main, readSecret, safeFailure };
