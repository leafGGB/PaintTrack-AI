const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEnvironment } = require('../lib/server/env');
const { sameDatabaseTarget } = require('../lib/server/db/testIsolation');
const { getTableConfig } = require('drizzle-orm/pg-core');
const { checkPostgresWorkers, localUrl } = require('../scripts/accept-database-local');

test('本地真实 Worker 验收拒绝远端、错误端口和非本次生成格式的运行目标', async () => {
    const urls = [
        'postgres://runtime:unused@remote.invalid:5433/pt_acceptance_local_abcdef',
        'postgres://runtime:unused@127.0.0.1:5432/pt_acceptance_local_abcdef',
        'postgres://pt_runtime_local_abcdef:unused@127.0.0.1:5433/painttrack_dev',
        'postgres://admin:unused@127.0.0.1:5433/pt_acceptance_local_abcdef',
        'postgres://pt_runtime_other_abcdef:unused@127.0.0.1:5433/pt_acceptance_local_abcdef',
    ];
    for (const runtimeUrl of urls) {
        await assert.rejects(checkPostgresWorkers({ runtimeUrl, record() { assert.fail('禁止目标不应启动验收'); } }));
    }
    assert.equal(new URL(localUrl('postgres://runtime:unused@localhost:5433/painttrack_test')).hostname, '127.0.0.1');
});

for (const entry of ['schema.js', 'schema.cjs']) {
    test(`${entry} resolves table configurations and asset checks without a database`, () => {
        const schema = require(`../lib/server/db/${entry}`);
        const assets = getTableConfig(schema.assets);

        assert.equal(assets.name, 'assets');
        assert.deepEqual(assets.checks.map((constraint) => constraint.name).sort(), [
            'assets_abandoned_state_check',
            'assets_checksum_sha256_format_check',
            'assets_deleted_at_consistency_check',
            'assets_media_type_check',
            'assets_purge_attempts_check',
            'assets_purge_state_check',
            'assets_size_bytes_check',
            'assets_status_check',
            'assets_status_storage_consistency_check',
        ]);
        assert.equal(getTableConfig(schema.generationTasks).name, 'generation_tasks');
        assert.equal(getTableConfig(schema.providerCalls).name, 'provider_calls');
        assert.equal(getTableConfig(schema.providerInstances).name, 'provider_instances');
        assert.equal(getTableConfig(schema.providerModels).name, 'provider_models');
        assert.equal(getTableConfig(schema.logicalModels).name, 'logical_models');
        assert.equal(getTableConfig(schema.modelProviderBindings).name, 'model_provider_bindings');
        assert.equal(getTableConfig(schema.providerConfigAuditEvents).name, 'provider_config_audit_events');
        assert.equal(getTableConfig(schema.authSessions).name, 'auth_sessions');
        assert.equal(getTableConfig(schema.adminMfaFactors).name, 'admin_mfa_factors');
        assert.equal(getTableConfig(schema.adminRecoveryCodes).name, 'admin_recovery_codes');
        assert.equal(getTableConfig(schema.schemaVersion).name, '__painttrack_schema_version');
    });
}

const validDatabaseUrl = 'postgresql://painttrack:local-only@127.0.0.1:5432/painttrack_dev';

test('database URLs are optional at startup and accept PostgreSQL schemes', () => {
    const result = parseEnvironment({
        DATABASE_URL: validDatabaseUrl,
        TEST_DATABASE_URL: 'postgres://painttrack_test:local-only@127.0.0.1:5432/painttrack_test',
    });

    assert.equal(result.success, true);
    assert.equal(result.data.databaseUrl, validDatabaseUrl);
    assert.match(result.data.testDatabaseUrl, /^postgres:/);
});

test('rejects non-PostgreSQL and malformed database URLs without echoing credentials', () => {
    const result = parseEnvironment({ DATABASE_URL: 'https://user:secret@example.test/db' });

    assert.equal(result.success, false);
    assert.match(result.errors[0], /DATABASE_URL must use postgres or postgresql/);
    assert.doesNotMatch(result.errors.join(' '), /secret|user/);
});

test('database target isolation ignores credential and query-string differences', () => {
    assert.equal(
        sameDatabaseTarget(
            'postgresql://dev:secret@localhost:5432/painttrack?sslmode=disable',
            'postgres://test:other@localhost/painttrack?application_name=integration'
        ),
        true
    );
    assert.equal(
        sameDatabaseTarget(validDatabaseUrl, 'postgresql://painttrack_test:local-only@127.0.0.1:5432/painttrack_test'),
        false
    );
    assert.equal(sameDatabaseTarget(undefined, validDatabaseUrl), false);
});

test('database URL validation remains independent from the other server settings', () => {
    const result = parseEnvironment({
        NODE_ENV: 'test',
        PORT: '4000',
        DATABASE_URL: validDatabaseUrl,
    });

    assert.equal(result.success, true);
    assert.equal(result.data.port, 4000);
    assert.equal(result.data.databaseUrl, validDatabaseUrl);
});
