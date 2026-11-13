const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DEFAULT_LOCAL_DATABASE, assertNoNextEnvironmentFiles, createCleanupEnvironment, createLocalSecrets, createNextEnvironment, createWorkerEnvironment, localAdminUrl, localAssetStorageRoot, localDatabasePlan, localRoleUrl, localRolesFromOwner, validRequest } = require('../scripts/local-registration');
const { spawnSync } = require('node:child_process');

test('local admin URL is explicit, loopback:5433/postgres only, and errors never echo input', () => {
    for (const value of [undefined, '', '   ']) assert.throws(() => localAdminUrl(value), { message: 'LOCAL_DATABASE_ADMIN_URL_REQUIRED' });
    for (const value of [
        'not-a-url-secret', 'https://admin:synthetic-secret@127.0.0.1:5433/postgres',
        'postgres://admin:synthetic-secret@remote.example:5433/postgres',
        'postgres://admin:synthetic-secret@127.0.0.1:5432/postgres',
        'postgres://admin:synthetic-secret@127.0.0.1:5433/painttrack_dev',
        'postgres://admin:synthetic-secret@127.0.0.1:5433/painttrack_test',
        'postgres://admin:synthetic-secret@127.0.0.1:5433/postgres?host=remote.example',
        'postgres://admin:synthetic-secret@127.0.0.1:5433/postgres?port=5432',
        'postgres://admin:synthetic-secret@127.0.0.1:5433/postgres#secret',
        'postgres://admin:synthetic-secret@127.0.0.1:5433/postgres?sslmode=disable&sslmode=require',
    ]) assert.throws(() => localAdminUrl(value), { message: 'LOCAL_DATABASE_ADMIN_URL_INVALID' });
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
        const parsed = new URL(localAdminUrl(`postgresql://admin:synthetic-secret@${host}:5433/postgres?sslmode=disable`));
        assert.equal(parsed.hostname, host === '[::1]' ? '[::1]' : '127.0.0.1');
        assert.equal(parsed.port, '5433');
    }
});

test('derived role URL preserves approved endpoint and replaces all admin identity', () => {
    const parsed = new URL(localRoleUrl('postgres://admin:synthetic-admin@[::1]:5433/postgres?sslmode=disable',
        'pt_local_worker_test', 'synthetic-role', 'pt_local_auth_test'));
    assert.equal(parsed.hostname, '[::1]');
    assert.equal(parsed.username, 'pt_local_worker_test');
    assert.equal(parsed.password, 'synthetic-role');
    assert.equal(parsed.pathname, '/pt_local_auth_test');
    assert.equal(parsed.searchParams.get('sslmode'), 'disable');
    assert.ok(!parsed.href.includes('synthetic-admin'));
});

test('real launcher rejects missing/invalid explicit admin before port probes or database loading', () => {
    const script = path.resolve(__dirname, '../scripts/local-registration.js');
    for (const value of ['', 'postgres://admin:synthetic-secret@remote.example:5433/postgres']) {
        const env = { ...process.env, LOCAL_DATABASE_ADMIN_URL: value, NODE_ENV: 'development',
            DATABASE_URL: 'postgres://must-not-use', TEST_DATABASE_URL: 'postgres://must-not-use' };
        delete env.NODE_OPTIONS;
        const child = spawnSync(process.execPath, ['-e', `
            const Module = require('node:module');
            const original = Module._load;
            Module._load = function(name, ...args) {
                if (name === 'pg') { process.stderr.write('FORBIDDEN_PG_LOAD'); throw new Error(); }
                return original.call(this, name, ...args);
            };
            require('node:net').Server.prototype.listen = () => { process.stderr.write('FORBIDDEN_LISTEN'); throw new Error(); };
            require('node:fs').lstatSync = () => { process.stderr.write('FORBIDDEN_ENV_PROBE'); throw new Error(); };
            process.argv[1] = ${JSON.stringify(script)};
            require('node:module').runMain();
        `], { env, encoding: 'utf8', timeout: 5000 });
        assert.equal(child.status, 1);
        assert.equal(child.stdout, '');
        assert.equal(child.stderr, 'Local development startup failed. No credentials printed; created resources are retained.\n');
    }
});

function request(headers = {}, remoteAddress = '127.0.0.1') {
    return { socket: { remoteAddress }, headers: { host: '127.0.0.1:3000', ...headers } };
}

test('local launcher creates independent 32-byte mailbox and MFA secrets', () => {
    const values = [Buffer.alloc(32, 1), Buffer.alloc(32, 2)];
    const secrets = createLocalSecrets((size) => values.shift().subarray(0, size));
    assert.equal(secrets.mailboxSecret, '01'.repeat(32));
    assert.equal(secrets.mfaEncryptionKey, '02'.repeat(32));
    assert.notEqual(secrets.mailboxSecret, secrets.mfaEncryptionKey);
});

test('Worker receives its dedicated database identity without Web or migration environment', () => {
    const env = createWorkerEnvironment('postgres://worker:secret@127.0.0.1:5433/painttrack_dev', {
        PATH: 'system-path', DATABASE_URL: 'postgres://web:secret@127.0.0.1:5433/painttrack_dev',
        MIGRATION_DATABASE_URL: 'postgres://migration:secret@127.0.0.1:5433/painttrack_dev',
        PAINTTRACK_PROVIDER_CREDENTIAL: 'must-not-leak-to-local-mock',
    });
    assert.equal(env.PAINTTRACK_WORKER_DATABASE_URL, 'postgres://worker:secret@127.0.0.1:5433/painttrack_dev');
    assert.equal(env.PAINTTRACK_WORKER_PROVIDER, 'mock');
    assert.equal(env.DATABASE_URL, undefined);
    assert.equal(env.MIGRATION_DATABASE_URL, undefined);
    assert.equal(env.PAINTTRACK_PROVIDER_CREDENTIAL, undefined);
    assert.equal(env.PATH, 'system-path');
    assert.throws(() => createWorkerEnvironment('', {}), /workerUrl is required/);
});

test('asset storage root is explicitly shared with Next and Worker only when absolute', () => {
    const root = path.resolve('painttrack-private-assets');
    const next = createNextEnvironment({ runtimeUrl: 'postgres://web:secret@127.0.0.1:5433/isolated',
        internalPort: 3001, origin: 'http://127.0.0.1:3000', secret: 'a'.repeat(64), mfaEncryptionKey: 'b'.repeat(64),
        suffix: 'test', heapMb: 3072, assetStorageRoot: root }, { PAINTTRACK_ASSET_STORAGE_ROOT: 'untrusted-inherited' });
    const worker = createWorkerEnvironment('postgres://worker:secret@127.0.0.1:5433/isolated',
        { PAINTTRACK_ASSET_STORAGE_ROOT: 'untrusted-inherited' }, { assetStorageRoot: root });
    assert.equal(next.PAINTTRACK_ASSET_STORAGE_ROOT, root);
    assert.equal(worker.PAINTTRACK_ASSET_STORAGE_ROOT, root);
    assert.throws(() => localAssetStorageRoot('relative/path'), { message: 'LOCAL_ASSET_STORAGE_ROOT_INVALID' });
    assert.equal(createWorkerEnvironment('postgres://worker', {}, {}).PAINTTRACK_ASSET_STORAGE_ROOT, undefined);
});

test('cleanup 子进程只拿到 cleanup 连接，不携带 Web/Worker 身份', () => {
    const root = path.resolve('painttrack-private-assets');
    const env = createCleanupEnvironment('postgres://cleanup:secret@127.0.0.1:5433/isolated', {
        PAINTTRACK_ASSET_STORAGE_ROOT: 'untrusted-inherited',
        PAINTTRACK_WORKER_DATABASE_URL: 'postgres://worker:leaked@127.0.0.1:5433/isolated',
        DATABASE_URL: 'postgres://web:leaked@127.0.0.1:5433/isolated',
    }, { assetStorageRoot: root });
    assert.equal(env.PAINTTRACK_CLEANUP_DATABASE_URL, 'postgres://cleanup:secret@127.0.0.1:5433/isolated');
    assert.equal(env.PAINTTRACK_ASSET_STORAGE_ROOT, root);
    assert.equal(env.DATABASE_URL, undefined);
    assert.equal(env.PAINTTRACK_WORKER_DATABASE_URL, undefined);
    assert.throws(() => createCleanupEnvironment(''), TypeError);
    assert.equal(createCleanupEnvironment('postgres://cleanup', {}, {}).PAINTTRACK_ASSET_STORAGE_ROOT, undefined);
});

test('Next environment contains only system keys and explicit local runtime settings', () => {
    const env = createNextEnvironment({
        runtimeUrl: 'postgres://web:secret@127.0.0.1:5433/isolated', internalPort: 3001,
        origin: 'http://127.0.0.1:3000', secret: 'a'.repeat(64), mfaEncryptionKey: 'b'.repeat(64),
        suffix: 'test', heapMb: 3072,
    }, {
        PATH: 'system-path', DATABASE_URL: 'postgres://inherited', PAINTTRACK_PROVIDER_CREDENTIAL: 'must-not-leak',
        MIGRATION_DATABASE_URL: 'postgres://migration',
        NODE_OPTIONS: '--require parent-untrusted.cjs --inspect',
    });
    assert.equal(env.PATH, 'system-path');
    assert.equal(env.DATABASE_URL, 'postgres://web:secret@127.0.0.1:5433/isolated');
    assert.equal(env.PAINTTRACK_PROVIDER_CREDENTIAL, undefined);
    assert.equal(env.MIGRATION_DATABASE_URL, undefined);
    assert.equal(env.PORT, '3001');
    const preloadPath = path.resolve(__dirname, '../scripts/local-next-env-preload.cjs').replace(/\\/g, '/');
    assert.equal(env.NODE_OPTIONS, `--max-old-space-size=3072 --require ${JSON.stringify(preloadPath)}`);
    assert.equal(env.NODE_OPTIONS.includes('parent-untrusted'), false);
    assert.equal(env.NODE_OPTIONS.includes('--inspect'), false);
});

test('Next environment file guard rejects each env file Next loads in development', () => {
    const names = ['.env.development.local', '.env.local', '.env.development', '.env'];
    assert.doesNotThrow(() => assertNoNextEnvironmentFiles('/project', () => false));
    for (const name of names) {
        assert.throws(() => assertNoNextEnvironmentFiles('/project', (file) => file.endsWith(name)), /Next environment files are not allowed/);
    }
});

test('single-port local launcher accepts only exact loopback same-origin requests', () => { 
    assert.equal(validRequest(request(), 3000), true);
    assert.equal(validRequest(request({ origin: 'http://127.0.0.1:3000', 'sec-fetch-site': 'same-origin' }), 3000), true);
    assert.equal(validRequest(request({ host: 'evil.example' }), 3000), false);
    assert.equal(validRequest(request({ origin: 'http://localhost:3000' }), 3000), false);
    assert.equal(validRequest(request({ 'sec-fetch-site': 'cross-site' }), 3000), false);
    assert.equal(validRequest(request(), 3000, '::1'), false);
    assert.equal(validRequest(request(), 3000, '::1'), false);
});

test('single-port local launcher refuses client-supplied capability headers', () => {
    assert.equal(validRequest(request({ 'x-painttrack-local-capability': 'a'.repeat(64) }), 3000), false);
});

test('默认复用固定本地库，--fresh 才生成一次性随机库', () => {
    const reuse = localDatabasePlan({ environment: {}, randomSuffix: 'abcdef123456' });
    assert.equal(reuse.database, DEFAULT_LOCAL_DATABASE);
    assert.equal(reuse.database, 'pt_local_auth_000000000000');
    assert.equal(reuse.migrationRole, 'pt_local_migrate_000000000000');
    assert.equal(reuse.runtimeRole, 'pt_local_runtime_000000000000');
    assert.equal(reuse.workerRole, 'pt_local_worker_000000000000');
    assert.equal(reuse.cleanupRole, 'pt_local_cleanup_000000000000');
    assert.equal(reuse.reuse, true);
    // 随机后缀仍只用于一次性资源，不参与数据库命名。
    assert.equal(reuse.distSuffix, 'abcdef123456');

    const fresh = localDatabasePlan({ environment: {}, fresh: true, randomSuffix: 'abcdef123456' });
    assert.equal(fresh.database, 'pt_local_auth_abcdef123456');
    assert.equal(fresh.runtimeRole, 'pt_local_runtime_abcdef123456');
    assert.equal(fresh.cleanupRole, 'pt_local_cleanup_abcdef123456');
    assert.equal(fresh.reuse, false);
});

test('本地库名可覆盖但只接受 pt_local_auth_ 前缀，拒绝其它库与注入串', () => {
    const custom = localDatabasePlan({ environment: { PAINTTRACK_LOCAL_DATABASE: ' pt_local_auth_mydev ' }, randomSuffix: 'abc' });
    assert.equal(custom.database, 'pt_local_auth_mydev');
    assert.equal(custom.migrationRole, 'pt_local_migrate_mydev');
    assert.equal(custom.runtimeRole, 'pt_local_runtime_mydev');
    // 历史随机库可直接复用，账号保留。
    const legacy = localDatabasePlan({ environment: { PAINTTRACK_LOCAL_DATABASE: 'pt_local_auth_5fabde425ae3' }, randomSuffix: 'abc' });
    assert.equal(legacy.runtimeRole, 'pt_local_runtime_5fabde425ae3');
    for (const value of [
        'painttrack_dev', 'postgres', 'pt_local_auth_', 'pt_local_auth_dev"; DROP ROLE x',
        'pt_acceptance_abcdef123456', 'pt_local_auth_' + 'x'.repeat(25),
    ]) {
        assert.throws(
            () => localDatabasePlan({ environment: { PAINTTRACK_LOCAL_DATABASE: value }, randomSuffix: 'abc' }),
            { message: 'LOCAL_DATABASE_NAME_INVALID' },
            `应拒绝库名 ${value}`,
        );
    }
});

test('复用既有库时从 owner 派生角色名，避免 auth_ 前缀错位', () => {
    assert.deepEqual(localRolesFromOwner('pt_local_migrate_5fabde425ae3'), {
        migrationRole: 'pt_local_migrate_5fabde425ae3',
        runtimeRole: 'pt_local_runtime_5fabde425ae3',
        workerRole: 'pt_local_worker_5fabde425ae3',
        cleanupRole: 'pt_local_cleanup_5fabde425ae3',
    });
    assert.deepEqual(localRolesFromOwner('pt_local_migrate_000000000000'), {
        migrationRole: 'pt_local_migrate_000000000000',
        runtimeRole: 'pt_local_runtime_000000000000',
        workerRole: 'pt_local_worker_000000000000',
        cleanupRole: 'pt_local_cleanup_000000000000',
    });
    for (const value of ['postgres', 'pt_local_runtime_x', 'pt_local_migrate_', 'pt_local_migrate_x"; GRANT ALL', undefined, null]) {
        assert.equal(localRolesFromOwner(value), null);
    }
});
