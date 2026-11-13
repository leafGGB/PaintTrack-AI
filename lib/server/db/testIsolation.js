const { isIP } = require('node:net');

function parseDatabaseTarget(value) {
    try {
        const url = new URL(value);
        if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.hash) {
            throw new Error();
        }
        const host = decodeURIComponent(url.hostname).toLowerCase().replace(/\.$/, '');
        const database = decodeURIComponent(url.pathname.slice(1));
        const username = decodeURIComponent(url.username);
        decodeURIComponent(url.password);
        const port = Number(url.port || 5432);
        if (!database || /[/\\\x00-\x1f]/.test(database) || !username
            || !Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error();
        }
        const seen = new Set();
        for (const [key, parameter] of url.searchParams) {
            if (!['application_name', 'sslmode'].includes(key) || seen.has(key)
                || (key === 'sslmode' && !['disable', 'require', 'verify-ca', 'verify-full', 'prefer', 'no-verify'].includes(parameter))) {
                throw new Error();
            }
            seen.add(key);
        }
        const address = host.replace(/^\[|\]$/g, '');
        const loopback = host === 'localhost' || address === '::1'
            || (isIP(address) === 4 && address.startsWith('127.'));
        return { host: address, port, database, username, loopback };
    } catch {
        throw new Error('Invalid PostgreSQL target; connection overrides are not permitted');
    }
}

function sameDatabaseTarget(firstUrl, secondUrl) {
    if (!firstUrl || !secondUrl) return false;
    const first = parseDatabaseTarget(firstUrl);
    const second = parseDatabaseTarget(secondUrl);
    return first.host === second.host && first.port === second.port && first.database === second.database;
}

function assertDistinctRuntimeIdentity(runtimeDatabaseUrl, workerDatabaseUrl) {
    if (!runtimeDatabaseUrl || !workerDatabaseUrl) throw new Error('DATABASE_URL and PAINTTRACK_WORKER_DATABASE_URL are required');
    const runtime = parseDatabaseTarget(runtimeDatabaseUrl);
    const worker = parseDatabaseTarget(workerDatabaseUrl);
    if (!sameDatabaseTarget(runtimeDatabaseUrl, workerDatabaseUrl)) {
        throw new Error('Web and Worker database targets must match');
    }
    if (runtime.username === worker.username) {
        throw new Error('Web and Worker database identities must differ');
    }
    return { runtime, worker };
}

function assertMigrationIdentity(migrationDatabaseUrl, databaseUrl) {
    if (!migrationDatabaseUrl) throw new Error('MIGRATION_DATABASE_URL is required; runtime credentials are never used for migrations');
    const migration = parseDatabaseTarget(migrationDatabaseUrl);
    if (databaseUrl) {
        const runtime = parseDatabaseTarget(databaseUrl);
        if (!sameDatabaseTarget(migrationDatabaseUrl, databaseUrl)) {
            throw new Error('Migration and runtime database targets must match');
        }
        if (migration.username === runtime.username) {
            throw new Error('Migration and runtime identities must differ');
        }
    }
    return migration;
}

function assertIsolatedTestTarget({ testDatabaseUrl, databaseUrl, migrationDatabaseUrl, testMigrationDatabaseUrl }) {
    const target = parseDatabaseTarget(testDatabaseUrl);
    if (!target.loopback || !/(^|_)(test|acceptance)(_|$)/i.test(target.database)) {
        throw new Error('Tests require an explicitly named loopback test/acceptance database');
    }
    for (const protectedUrl of [databaseUrl, migrationDatabaseUrl].filter(Boolean)) {
        const protectedTarget = parseDatabaseTarget(protectedUrl);
        if (target.database === protectedTarget.database || sameDatabaseTarget(testDatabaseUrl, protectedUrl)) {
            throw new Error('Test database must differ from runtime and migration database targets');
        }
    }
    if (testMigrationDatabaseUrl) {
        assertMigrationIdentity(testMigrationDatabaseUrl, testDatabaseUrl);
    }
    return target;
}

module.exports = { assertDistinctRuntimeIdentity, assertIsolatedTestTarget, assertMigrationIdentity, parseDatabaseTarget, sameDatabaseTarget };
