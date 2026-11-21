const path = require('node:path');
const crypto = require('node:crypto');
const { Client } = require('pg');
const { drizzle } = require('drizzle-orm/node-postgres');
const { migrate } = require('drizzle-orm/node-postgres/migrator');
const { assertMigrationIdentity, parseDatabaseTarget } = require('./testIsolation');

const migrationConfig = Object.freeze({
    migrationsFolder: path.resolve(__dirname, '../../../drizzle'),
    migrationsSchema: 'public',
    migrationsTable: '__drizzle_migrations',
});

const quote = (value) => `"${value.replaceAll('"', '""')}"`;
const ownerAttributes = ['rolcanlogin', 'rolinherit', 'rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolreplication', 'rolbypassrls'];

function ledgerOwnerRole(database) {
    return `pt_ledger_owner_${crypto.createHash('md5').update(database, 'utf8').digest('hex').slice(0, 16)}`;
}

function adminModelsOwnerRole(database) {
    return `pt_admin_models_owner_${crypto.createHash('md5').update(database, 'utf8').digest('hex').slice(0, 16)}`;
}

async function inspectNoLoginOwner(client, role, invalidCode) {
    const { rows } = await client.query(`SELECT ${ownerAttributes.join(', ')} FROM pg_catalog.pg_roles WHERE rolname = $1`, [role]);
    if (!rows.length) return false;
    if (rows.length !== 1 || ownerAttributes.some((key) => rows[0][key] !== false)) throw new Error(invalidCode);
    const memberships = await client.query(`SELECT 1 FROM pg_catalog.pg_auth_members
        WHERE roleid = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1)
           OR member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1)`, [role]);
    if (memberships.rows.length) throw new Error(invalidCode);
    return true;
}

async function prepareAdminModelsOwner(client, database) {
    const role = adminModelsOwnerRole(database);
    if (!await inspectNoLoginOwner(client, role, 'ADMIN_MODELS_OWNER_ATTRIBUTES_INVALID')) {
        await client.query(`CREATE ROLE ${quote(role)} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
        if (!await inspectNoLoginOwner(client, role, 'ADMIN_MODELS_OWNER_NOT_PREPARED')) throw new Error('ADMIN_MODELS_OWNER_NOT_PREPARED');
    }
    return role;
}

async function inspectLedgerOwner(client, role) {
    const { rows } = await client.query(`SELECT ${ownerAttributes.join(', ')} FROM pg_catalog.pg_roles WHERE rolname = $1`, [role]);
    if (!rows.length) return false;
    if (rows.length !== 1 || ownerAttributes.some((key) => rows[0][key] !== false)) {
        throw new Error('LEDGER_OWNER_ATTRIBUTES_INVALID');
    }
    const memberships = await client.query(`SELECT 1 FROM pg_catalog.pg_auth_members
        WHERE roleid = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1)
           OR member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1)`, [role]);
    if (memberships.rows.length) throw new Error('LEDGER_OWNER_MEMBERSHIP_INVALID');
    return true;
}

async function prepareLedgerOwner(client, database) {
    const role = ledgerOwnerRole(database);
    if (!await inspectLedgerOwner(client, role)) {
        await client.query(`CREATE ROLE ${quote(role)} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
        if (!await inspectLedgerOwner(client, role)) throw new Error('LEDGER_OWNER_NOT_PREPARED');
    }
    return role;
}

async function migrateDatabase({ migrationDatabaseUrl, databaseUrl, localDatabaseAdminUrl }, dependencies = {}) {
    const target = assertMigrationIdentity(migrationDatabaseUrl, databaseUrl);
    if (!localDatabaseAdminUrl) throw new Error('LOCAL_DATABASE_ADMIN_URL_REQUIRED');
    const adminTarget = parseDatabaseTarget(localDatabaseAdminUrl);
    const role = ledgerOwnerRole(target.database);
    const adminModelsRole = adminModelsOwnerRole(target.database);
    if (!target.loopback || target.port !== 5433 || !adminTarget.loopback || adminTarget.database !== 'postgres'
        || target.host !== adminTarget.host || target.port !== adminTarget.port
        || [target.username, databaseUrl && parseDatabaseTarget(databaseUrl).username, adminTarget.username].some(name => name === role || name === adminModelsRole)
        || adminTarget.username === target.username
        || (databaseUrl && adminTarget.username === parseDatabaseTarget(databaseUrl).username)) {
        throw new Error('LOCAL_MIGRATION_ADMIN_TARGET_INVALID');
    }
    const DatabaseClient = dependencies.Client || Client;
    const apply = dependencies.migrate || migrate;
    const client = new DatabaseClient({
        connectionString: migrationDatabaseUrl,
        connectionTimeoutMillis: 3000,
        application_name: 'painttrack-migrator',
    });
    const admin = new DatabaseClient({
        connectionString: localDatabaseAdminUrl,
        connectionTimeoutMillis: 3000,
        application_name: 'painttrack-ledger-owner-preparation',
    });
    let locked = false;
    let grantAttempted = false;
    let adminModelsGrantAttempted = false;
    const errors = [];
    try {
        await client.connect();
        await client.query("SET lock_timeout = '5s'");
        await client.query("SET statement_timeout = '60s'");
        await client.query('SELECT pg_advisory_lock(724196231)');
        locked = true;
        const identity = (await client.query('SELECT current_database() AS database, current_user AS username')).rows[0];
        if (identity?.database !== target.database || identity?.username !== target.username) throw new Error('MIGRATION_IDENTITY_MISMATCH');
        await admin.connect();
        await prepareLedgerOwner(admin, target.database);
        await prepareAdminModelsOwner(admin, target.database);
        // 在目标库迁移锁内授予，finally 撤回；不构造 owner 连接，不把管理员带入 Drizzle。
        grantAttempted = true;
        await admin.query(`GRANT ${quote(role)} TO ${quote(target.username)} WITH INHERIT FALSE, SET TRUE`);
        adminModelsGrantAttempted = true;
        await admin.query(`GRANT ${quote(adminModelsRole)} TO ${quote(target.username)} WITH INHERIT FALSE, SET TRUE`);
        await apply(drizzle(client), migrationConfig);
    } catch (error) {
        errors.push(error);
    } finally {
        const cleanup = async (run) => { try { await run(); } catch (error) { errors.push(error); } };
        if (adminModelsGrantAttempted) await cleanup(async () => {
            await admin.query(`REVOKE ${quote(adminModelsOwnerRole(target.database))} FROM ${quote(target.username)}`);
            if (!await inspectNoLoginOwner(admin, adminModelsOwnerRole(target.database), 'ADMIN_MODELS_OWNER_NOT_PREPARED')) throw new Error('ADMIN_MODELS_OWNER_NOT_PREPARED');
        });
        if (grantAttempted) await cleanup(async () => {
            await admin.query(`REVOKE ${quote(role)} FROM ${quote(target.username)}`);
            if (!await inspectLedgerOwner(admin, role)) throw new Error('LEDGER_OWNER_NOT_PREPARED');
        });
        if (locked) await cleanup(() => client.query('SELECT pg_advisory_unlock(724196231)'));
        await cleanup(() => admin.end());
        await cleanup(() => client.end());
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, 'MIGRATION_OR_LEDGER_OWNER_CLEANUP_FAILED');
}

module.exports = { adminModelsOwnerRole, ledgerOwnerRole, migrateDatabase, migrationConfig, prepareAdminModelsOwner, prepareLedgerOwner };
