const { Pool } = require('pg');
const { getEnvironment } = require('../lib/server/env');
const { assertIsolatedTestTarget, assertMigrationIdentity, parseDatabaseTarget } = require('../lib/server/db/testIsolation');
const { createAuthRecordCleanupService } = require('../lib/server/authRecordCleanup');

function parseArgs(args) {
    const options = { dryRun: true };
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === '--apply') options.dryRun = false;
        else if (arg === '--dry-run') options.dryRun = true;
        else if (['--token-retention-days', '--session-retention-days', '--batch-size', '--max-batches'].includes(arg)) {
            const rawValue = args[index + 1];
            const value = Number(rawValue);
            if (typeof rawValue !== 'string' || rawValue.trim() === '' || !Number.isInteger(value)) throw new TypeError(`Invalid value for ${arg}`);
            index += 1;
            if (arg === '--token-retention-days') options.tokenRetentionDays = value;
            if (arg === '--session-retention-days') options.sessionRetentionDays = value;
            if (arg === '--batch-size') options.batchSize = value;
            if (arg === '--max-batches') options.maxBatches = value;
        } else {
            throw new TypeError(`Unknown option: ${arg}`);
        }
    }
    return options;
}

function assertCleanupTarget(environment) {
    if (!environment.databaseUrl || !environment.migrationDatabaseUrl) throw new Error('DATABASE_URL and MIGRATION_DATABASE_URL are required');
    assertMigrationIdentity(environment.migrationDatabaseUrl, environment.databaseUrl);
    const target = parseDatabaseTarget(environment.databaseUrl);
    if (!target.loopback || !/(^|_)(test|acceptance)(_|$)/i.test(target.database)) {
        throw new Error('Authentication record cleanup is limited to explicitly named loopback test/acceptance databases in this implementation');
    }
    assertIsolatedTestTarget({
        testDatabaseUrl: environment.databaseUrl,
        databaseUrl: undefined,
        migrationDatabaseUrl: undefined,
        testMigrationDatabaseUrl: environment.migrationDatabaseUrl,
    });
    return target;
}

async function main(args = process.argv.slice(2), dependencies = {}) {
    const options = parseArgs(args);
    const environment = (dependencies.getEnvironment || getEnvironment)();
    assertCleanupTarget(environment);
    const PoolClass = dependencies.Pool || Pool;
    const pool = new PoolClass({
        connectionString: environment.databaseUrl,
        max: 1,
        connectionTimeoutMillis: 3000,
        application_name: 'painttrack-auth-cleanup',
    });
    try {
        const service = createAuthRecordCleanupService({ pool, sink: dependencies.sink || console });
        return await service.cleanup(options);
    } finally {
        await pool.end();
    }
}

if (require.main === module) {
    main().then((result) => {
        console.log(JSON.stringify(result));
    }).catch((error) => {
        const code = /^[0-9A-Z]{5}$/.test(error.code || '') ? ` (${error.code})` : '';
        console.error(`Authentication record cleanup failed${code}; verify the isolated target and dedicated runtime/migration identities.`);
        process.exitCode = 1;
    });
}

module.exports = { assertCleanupTarget, main, parseArgs };
