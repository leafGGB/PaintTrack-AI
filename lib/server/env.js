const { parseDatabaseTarget } = require('./db/testIsolation');

const VALID_NODE_ENVS = new Set(['development', 'production', 'test']);

function parseEnvironment(source = process.env) {
    const errors = [];
    const nodeEnv = source.NODE_ENV || 'development';
    const portValue = source.PORT || '3000';
    const baseUrl = source.APP_BASE_URL || '';
    const databaseUrl = source.DATABASE_URL || '';
    const workerDatabaseUrl = source.PAINTTRACK_WORKER_DATABASE_URL || '';
    const testDatabaseUrl = source.TEST_DATABASE_URL || '';
    const migrationDatabaseUrl = source.MIGRATION_DATABASE_URL || '';
    const testMigrationDatabaseUrl = source.TEST_MIGRATION_DATABASE_URL || '';

    if (!VALID_NODE_ENVS.has(nodeEnv)) {
        errors.push('NODE_ENV must be development, production, or test');
    }

    const port = Number(portValue);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        errors.push('PORT must be an integer between 1 and 65535');
    }

    if (baseUrl) {
        try {
            const parsedUrl = new URL(baseUrl);
            if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
                errors.push('APP_BASE_URL must use http or https');
            }
        } catch {
            errors.push('APP_BASE_URL must be a valid absolute URL');
        }
    }

    for (const [name, value] of [
        ['DATABASE_URL', databaseUrl], ['PAINTTRACK_WORKER_DATABASE_URL', workerDatabaseUrl], ['TEST_DATABASE_URL', testDatabaseUrl],
        ['MIGRATION_DATABASE_URL', migrationDatabaseUrl], ['TEST_MIGRATION_DATABASE_URL', testMigrationDatabaseUrl],
    ]) {
        if (value) {
            try {
                const parsedUrl = new URL(value);
                if (parsedUrl.protocol !== 'postgres:' && parsedUrl.protocol !== 'postgresql:') {
                    errors.push(`${name} must use postgres or postgresql`);
                } else {
                    parseDatabaseTarget(value);
                }
            } catch {
                errors.push(`${name} must be a valid absolute URL without connection overrides`);
            }
        }
    }

    if (errors.length > 0) {
        return { success: false, errors };
    }

    return {
        success: true,
        data: Object.freeze({
            nodeEnv,
            port,
            appBaseUrl: baseUrl || undefined,
            databaseUrl: databaseUrl || undefined,
            workerDatabaseUrl: workerDatabaseUrl || undefined,
            testDatabaseUrl: testDatabaseUrl || undefined,
            migrationDatabaseUrl: migrationDatabaseUrl || undefined,
            testMigrationDatabaseUrl: testMigrationDatabaseUrl || undefined,
        }),
    };
}

function getEnvironment(source = process.env) {
    const result = parseEnvironment(source);
    if (!result.success) {
        throw new Error(`Invalid server environment configuration:\n- ${result.errors.join('\n- ')}`);
    }
    return result.data;
}

module.exports = { getEnvironment, parseEnvironment };
