const test = require('node:test');
const assert = require('node:assert/strict');

const { getEnvironment, parseEnvironment } = require('../lib/server/env');

test('uses local-safe defaults when optional values are absent', () => {
    assert.deepEqual(getEnvironment({}), {
        nodeEnv: 'development',
        port: 3000,
        appBaseUrl: undefined,
        databaseUrl: undefined,
        workerDatabaseUrl: undefined,
        testDatabaseUrl: undefined,
        migrationDatabaseUrl: undefined,
        testMigrationDatabaseUrl: undefined,
    });
});

test('parses valid runtime settings', () => {
    const result = parseEnvironment({
        NODE_ENV: 'test',
        PORT: '4310',
        APP_BASE_URL: 'http://localhost:4310',
    });

    assert.equal(result.success, true);
    assert.deepEqual(result.data, {
        nodeEnv: 'test',
        port: 4310,
        appBaseUrl: 'http://localhost:4310',
        databaseUrl: undefined,
        workerDatabaseUrl: undefined,
        testDatabaseUrl: undefined,
        migrationDatabaseUrl: undefined,
        testMigrationDatabaseUrl: undefined,
    });
});

test('rejects invalid environment, port, and base URL', () => {
    const result = parseEnvironment({
        NODE_ENV: 'staging',
        PORT: '70000',
        APP_BASE_URL: 'not a url',
    });

    assert.equal(result.success, false);
    assert.equal(result.errors.length, 3);
});

test('throws a readable validation error from the startup accessor', () => {
    assert.throws(
        () => getEnvironment({ PORT: '0' }),
        /PORT must be an integer between 1 and 65535/
    );
});
