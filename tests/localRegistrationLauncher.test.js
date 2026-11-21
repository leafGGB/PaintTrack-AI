const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DEFAULT_LOCAL_DATABASE, assertNoNextEnvironmentFiles, createCleanupEnvironment, createLocalSecrets, createNextEnvironment, createSettlementEnvironment, createWorkerEnvironment, localAdminUrl, localAssetStorageRoot, localDatabasePlan, localRoleUrl, localRolesFromOwner, validRequest } = require('../scripts/local-registration');
const { spawnSync } = require('node:child_process');
const { localExecutionOptions, controlledImageLaunch } = require('../scripts/local-registration');

test('controlled image launcher requires explicit isolated mode and does not reuse the seeded database', () => {
    const environment = { PAINTTRACK_CONTROLLED_IMAGE_PASSWORD: 'synthetic-test-password' };
    const fixture = controlledImageLaunch(['--controlled-image'], environment);
    assert.equal(fixture.fixtureEmail, 'controlled-image@example.test');
    assert.equal(controlledImageLaunch([], environment), null);
    assert.throws(() => controlledImageLaunch([], { ...environment, PAINTTRACK_LOCAL_CONTROLLED_IMAGE: '1' }));
    assert.throws(() => controlledImageLaunch(['--controlled-image'], {}));
    for (const option of ['--mock', '--worker', '--fresh', '--prune', '--authorization-fixtures']) {
        assert.throws(() => controlledImageLaunch(['--controlled-image', option], environment), /MODE_CONFLICT/);
    }
    for (const flag of ['PAINTTRACK_LOCAL_DATABASE', 'PAINTTRACK_ASSET_STORAGE_ROOT', 'PAINTTRACK_LOCAL_MOCK_ROUTING',
        'PAINTTRACK_WORKER_PROVIDER', 'PAINTTRACK_CHARGED_SUBMISSION', 'PAINTTRACK_LOCAL_SETTLEMENT']) {
        assert.throws(() => controlledImageLaunch(['--controlled-image'], { ...environment, [flag]: 'true' }), /MODE_CONFLICT/);
    }
    const plan = localDatabasePlan({ controlledImage: true, randomSuffix: 'aabb00112233' });
    assert.equal(plan.database, 'pt_local_auth_ci_aabb00112233');
    assert.equal(plan.runtimeRole, 'pt_local_runtime_ci_aabb00112233');
    assert.equal(plan.workerRole, 'pt_local_worker_ci_aabb00112233');
    assert.equal(plan.reuse, false);
    assert.throws(() => localDatabasePlan({ environment: { PAINTTRACK_LOCAL_DATABASE: plan.database } }), /DATABASE_NAME_INVALID/);
    assert.equal(require('../package.json').scripts['dev:controlled-image'], 'node scripts/local-registration.js --controlled-image');
});

test('受控启动器生成的隔离角色可通过实际授权函数的角色名校验', async () => {
    const plan = localDatabasePlan({ controlledImage: true, randomSuffix: 'aabb00112233' });
    const permissions = require('../lib/server/db/runtimePermissions');
    const statements = [];
    const client = { async query(sql, params) { statements.push([sql, params]); return { rows: [{ allowed: true }] }; } };
    await permissions.grantWebRuntimePermissions(client, plan.runtimeRole);
    await permissions.grantWorkerRuntimePermissions(client, plan.workerRole);
    await permissions.grantCleanupRuntimePermissions(client, plan.cleanupRole);
    await permissions.grantAdminModelsProjectionPermission(client, plan.runtimeRole);
    for (const role of [plan.runtimeRole, plan.workerRole, plan.cleanupRole]) {
        assert.ok(statements.some(([sql]) => sql.includes(`TO "${role}"`)));
    }
    assert.deepEqual(statements.at(-1)[1], [plan.runtimeRole]);
    const before = statements.length;
    await assert.rejects(permissions.grantAdminModelsProjectionPermission(client, plan.workerRole));
    await assert.rejects(permissions.grantWebRuntimePermissions(client, `${plan.runtimeRole}0`));
    assert.equal(statements.length, before);
});

test('受控快照绑定单图与本人，合成适配器返回可解码 PNG', async () => {
    const controlled = require('../lib/server/tasks/controlledImageDevelopment');
    const { createModelRouteResolver } = require('../lib/server/tasks/modelRouteResolver');
    const ownerId = '55555555-5555-4555-8555-555555555555';
    const environment = { NODE_ENV: 'development', PAINTTRACK_LOCAL_INTERNAL_GUARD: '1',
        PAINTTRACK_LOCAL_CONTROLLED_IMAGE: '1', PAINTTRACK_CONTROLLED_IMAGE_OWNER: ownerId };
    const url = 'postgres://pt_local_worker_ci_aabb00112233:fixture@127.0.0.1:5433/pt_local_auth_ci_aabb00112233';
    assert.equal(controlled.controlledImageOwner(environment, url, 'worker'), ownerId);
    for (const target of [url.replace('127.0.0.1', 'remote.example'), url.replaceAll('ci_', '')]) {
        assert.throws(() => controlled.controlledImageOwner(environment, target, 'worker'));
    }
    assert.throws(() => controlled.controlledImageOwner(environment, url, 'runtime'));
    const input = { taskType: 'image.generate', payload: { logicalModelId: controlled.logicalModelId, outputCount: 1 } };
    controlled.assertControlledImageSubmission({ user: { id: ownerId }, input }, ownerId);
    assert.throws(() => controlled.assertControlledImageSubmission({ user: { id: 'other' }, input }, ownerId), { code: 'FORBIDDEN' });
    assert.throws(() => controlled.assertControlledImageSubmission({ user: { id: ownerId }, input: { ...input, taskType: 'video.generate' } }, ownerId), { code: 'MODEL_UNAVAILABLE' });
    const snapshot = await createModelRouteResolver({ catalog: controlled.catalog }).resolve(input);
    assert.equal(snapshot.logicalModelPk, controlled.modelPk);
    assert.match(snapshot.routeSnapshotHash, /^[0-9a-f]{64}$/);
    const { result } = await controlled.createSyntheticImageAdapter().submit({ taskId: ownerId });
    assert.equal(result.mimeType, 'image/png');
    const bytes = result.bytes;
    assert.equal(bytes.readUInt32BE(16), 128);
    assert.equal(bytes.readUInt32BE(20), 96);
    const { crc32, inflateSync } = require('node:zlib');
    for (let start = 8; start < bytes.length;) {
        const end = start + 8 + bytes.readUInt32BE(start);
        assert.equal(crc32(bytes.subarray(start + 4, end)), bytes.readUInt32BE(end));
        if (bytes.toString('ascii', start + 4, start + 8) === 'IDAT') {
            assert.equal(inflateSync(bytes.subarray(start + 8, end)).length, 96 * (128 * 3 + 1));
        }
        start = end + 4;
    }
});

test('explicit Mock launcher options default closed and preserve exact environment opt-in', () => {
    assert.deepEqual(localExecutionOptions([], {}), { mockRouting: false, localWorker: false });
    assert.deepEqual(localExecutionOptions(['--mock', '--worker'], {}), { mockRouting: true, localWorker: true });
    assert.deepEqual(localExecutionOptions(['--mock'], {}), { mockRouting: true, localWorker: false });
    assert.deepEqual(localExecutionOptions(['--worker'], {}), { mockRouting: false, localWorker: true });
    assert.deepEqual(localExecutionOptions([], { PAINTTRACK_LOCAL_MOCK_ROUTING: '1', PAINTTRACK_LOCAL_WORKER: '1' }), { mockRouting: true, localWorker: true });
    assert.deepEqual(localExecutionOptions([], { PAINTTRACK_LOCAL_MOCK_ROUTING: 'true', PAINTTRACK_LOCAL_WORKER: '1 ' }), { mockRouting: false, localWorker: false });
});

test('dev:mock explicitly enables both options and passes Mock capability to both child environments', () => {
    assert.equal(require('../package.json').scripts['dev:mock'], 'node scripts/local-registration.js --mock --worker');
    const source = require('node:fs').readFileSync(path.resolve(__dirname, '../scripts/local-registration.js'), 'utf8');
    assert.match(source, /const \{ mockRouting, localWorker \} = localExecutionOptions\(process\.argv\.slice\(2\), process\.env\)/);
    assert.match(source, /if \(mockRouting\) \{\s*await prepareLocalMockRouting\(owner, runtimeRole\)/);
    assert.match(source, /const workerProcess = localWorker/);
    assert.match(source, /createWorkerEnvironment\(workerUrl, process\.env, \{ mockRouting, assetStorageRoot \}\)/);
    assert.match(source, /const nextEnv = createNextEnvironment\(\{[\s\S]*?\bmockRouting,/);
    const options = localExecutionOptions(['--mock', '--worker'], {});
    const next = createNextEnvironment({ runtimeUrl: 'postgres://synthetic', internalPort: 3001,
        origin: 'http://127.0.0.1:3000', secret: 'a'.repeat(64), mfaEncryptionKey: 'b'.repeat(64),
        suffix: 'test', heapMb: 3072, mockRouting: options.mockRouting }, {});
    const worker = createWorkerEnvironment('postgres://synthetic-worker', {}, options);
    for (const env of [next, worker]) {
        assert.equal(env.PAINTTRACK_LOCAL_MOCK_ROUTING, '1');
        assert.equal(env.PAINTTRACK_LOCAL_INTERNAL_GUARD, '1');
        assert.equal(env.NODE_ENV, 'development');
    }
});

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

test('settlement host receives only explicit ledger and target connections', () => {
    const env = createSettlementEnvironment('postgres://ledger:secret@127.0.0.1:5433/isolated', 'postgres://web:secret@127.0.0.1:5433/isolated', {
        PATH: 'system-path', DATABASE_URL: 'postgres://inherited', LEDGER_DATABASE_URL: 'postgres://inherited-ledger',
        PAINTTRACK_WORKER_DATABASE_URL: 'postgres://worker:leaked', PAINTTRACK_SETTLEMENT_INTERVAL_MS: '5000',
    });
    assert.equal(env.LEDGER_DATABASE_URL, 'postgres://ledger:secret@127.0.0.1:5433/isolated');
    assert.equal(env.DATABASE_URL, 'postgres://web:secret@127.0.0.1:5433/isolated');
    assert.equal(env.PAINTTRACK_SETTLEMENT_INTERVAL_MS, '5000');
    assert.equal(env.PAINTTRACK_WORKER_DATABASE_URL, undefined);
    assert.equal(env.PATH, 'system-path');
    assert.throws(() => createSettlementEnvironment('', 'postgres://web'), /ledgerUrl is required/);
    assert.throws(() => createSettlementEnvironment('postgres://ledger', ''), /targetUrl is required/);
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
