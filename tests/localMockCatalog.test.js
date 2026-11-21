const test = require('node:test');
const assert = require('node:assert/strict');
const { createLocalMockCatalog } = require('../lib/server/tasks/localMockCatalog');
const { createModelRouteResolver } = require('../lib/server/tasks/modelRouteResolver');
const { createNextEnvironment, createWorkerEnvironment, prepareLocalMockRouting } = require('../scripts/local-registration');
const enabled = { NODE_ENV: 'development', PAINTTRACK_LOCAL_INTERNAL_GUARD: '1', PAINTTRACK_LOCAL_MOCK_ROUTING: '1' };
test('local mock catalog requires all explicit isolation guards', () => {
    for (const env of [{}, { ...enabled, NODE_ENV: 'production' }, { ...enabled, PAINTTRACK_LOCAL_INTERNAL_GUARD: '0' }, { ...enabled, PAINTTRACK_LOCAL_MOCK_ROUTING: undefined }]) assert.throws(() => createLocalMockCatalog(env));
});
test('image and video synthetic catalog resolves distinct immutable snapshots without secrets or targets', async () => {
    const catalog = createLocalMockCatalog(enabled);
    const resolver = createModelRouteResolver({ catalog });
    for (const media of ['image', 'video']) {
        const route = await resolver.resolve({ taskType: `${media}.generate`, payload: { logicalModelId: `local-mock-${media}`, ...(media === 'image' ? { outputCount: 1 } : { durationMs: 1000, fps: 1 }) } });
        assert.equal(route.routeSnapshot.adapterType, 'mock');
        assert.equal(route.routeSnapshot.capabilitySnapshot.mediaType, media);
        assert.ok(Object.isFrozen(route.routeSnapshot));
        const first = await catalog.getLogicalModel(`local-mock-${media}`);
        first.enabled = false;
        assert.equal((await catalog.getLogicalModel(`local-mock-${media}`)).enabled, true);
        assert.ok(!JSON.stringify(route).includes('baseUrl'));
    }
    assert.equal(await catalog.getLogicalModel('unapproved'), null);
});
test('launcher does not inherit mock routing or charged submission flags and only passes explicit options', () => {
    const config = { runtimeUrl: 'unused', internalPort: 3001, origin: 'http://127.0.0.1:3000', secret: 'synthetic', suffix: 'test', heapMb: 3072 };
    assert.equal(createNextEnvironment(config, { ...enabled, PAINTTRACK_CHARGED_SUBMISSION: '1' }).PAINTTRACK_LOCAL_MOCK_ROUTING, undefined);
    assert.equal(createNextEnvironment(config, { ...enabled, PAINTTRACK_CHARGED_SUBMISSION: '1' }).PAINTTRACK_CHARGED_SUBMISSION, undefined);
    const env = createNextEnvironment({ ...config, mockRouting: true, chargedSubmission: true }, {});
    assert.equal(env.PAINTTRACK_LOCAL_MOCK_ROUTING, '1');
    assert.equal(env.PAINTTRACK_CHARGED_SUBMISSION, '1');
    assert.equal(createNextEnvironment({ ...config, mockRouting: true }, {}).PAINTTRACK_CHARGED_SUBMISSION, undefined);
});
test('Worker mock selector environment requires explicit launcher option', async () => {
    const { createLocalMockProviderSelector } = require('../lib/server/tasks/localMockCatalog');
    const { createMockProvider } = require('../lib/server/providers/mockProvider');
    assert.equal(createWorkerEnvironment('synthetic', enabled).PAINTTRACK_LOCAL_MOCK_ROUTING, undefined);
    const env = createWorkerEnvironment('synthetic', {}, { mockRouting: true });
    assert.equal(env.PAINTTRACK_LOCAL_MOCK_ROUTING, '1');
    assert.equal(env.PAINTTRACK_LOCAL_INTERNAL_GUARD, '1');
    await assert.rejects(createLocalMockProviderSelector({ environment: { ...env, NODE_ENV: 'production' }, provider: createMockProvider() }));
    await assert.rejects(createLocalMockProviderSelector({ environment: env, provider: { name: 'external' } }));
});
test('local fixtures grant only snapshot INSERT to a fresh local Web role', async () => {
    const calls = [];
    await prepareLocalMockRouting({ async query(sql, values) { calls.push({ sql, values }); } }, 'pt_local_runtime_abcdef012345');
    assert.equal(calls.length, 3);
    for (const [index, media] of ['image', 'video'].entries()) {
        assert.match(calls[index].sql, /INSERT INTO logical_models/);
        assert.match(calls[index].sql, /false\)/);
        // 复用同一本地库时准备会重复执行，固定 ID 必须幂等。
        assert.match(calls[index].sql, /ON CONFLICT \(id\) DO NOTHING/);
        assert.equal(calls[index].values[1], `local-mock-${media}`);
        assert.equal(calls[index].values[3], media);
    }
    assert.equal(calls[2].sql, 'GRANT INSERT(logical_model_pk,route_snapshot,route_snapshot_version,route_snapshot_hash) ON generation_tasks TO "pt_local_runtime_abcdef012345"');
    // 复用模式的固定角色名也必须是合法输入。
    const reuseCalls = [];
    await prepareLocalMockRouting({ async query(sql) { reuseCalls.push(sql); } }, 'pt_local_runtime_000000000000');
    assert.equal(reuseCalls.length, 3);
    assert.equal(reuseCalls[2], 'GRANT INSERT(logical_model_pk,route_snapshot,route_snapshot_version,route_snapshot_hash) ON generation_tasks TO "pt_local_runtime_000000000000"');
    for (const role of ['painttrack_dev', 'pt_local_worker_abcdef012345', 'pt_local_runtime_abcdef012345"; GRANT ALL', 'pt_local_runtime_', undefined]) {
        await assert.rejects(prepareLocalMockRouting({ async query() { assert.fail('invalid role must not issue SQL'); } }, role), /INVALID_LOCAL_MOCK_ROLE/);
    }
});
test('synthetic source identities and nested catalog replies cannot mutate later routes', async () => {
    const { models } = require('../lib/server/tasks/localMockCatalog');
    assert.ok(models.every(Object.isFrozen));
    const catalog = createLocalMockCatalog(enabled);
    const first = await catalog.getLogicalModel('local-mock-image');
    first.bindings[0].providerInstance.adapterType = 'external';
    first.bindings[0].providerModel.capabilities.operations.length = 0;
    const resolved = await createModelRouteResolver({ catalog }).resolve({ taskType: 'image.generate', payload: { logicalModelId: 'local-mock-image', outputCount: 1 } });
    assert.equal(resolved.routeSnapshot.adapterType, 'mock');
});
