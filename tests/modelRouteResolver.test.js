const test = require('node:test');
const assert = require('node:assert/strict');
const { createModelRouteResolver } = require('../lib/server/tasks/modelRouteResolver');
const { createTaskSubmissionService } = require('../lib/server/tasks/taskService');
const model = () => ({ id: '00000000-0000-4000-8000-000000000011', logicalModelId: 'image-alpha', catalogVersion: 1, enabled: true, mediaType: 'image', supportedOperations: ['image.generate'], bindings: [{ id: 'binding-a', enabled: true, isPrimary: true, bindingVersion: 1, providerInstance: { id: 'provider-a', enabled: true, configVersion: 1, credentialVersion: 1, adapterType: 'synthetic', secret: 'must-not-copy', baseUrl: 'https://example.test' }, providerModel: { id: 'model-a', enabled: true, validationState: 'verified', mediaType: 'image', capabilities: { operations: ['image.generate'] }, upstreamModelName: 'upstream-a', adapterVersion: '1', operationProfile: 'image.generate', requestMappingVersion: 1, responseMappingVersion: 1 } }] });
const request = { taskType: 'image.generate', payload: { logicalModelId: 'image-alpha', prompt: 'synthetic', aspectRatio: '1:1', size: '1024x1024' } };
test('snapshot copies only approved identity fields, freezes deeply and hashes deterministically', async () => {
    const entry = model();
    const resolver = createModelRouteResolver({ catalog: { async getLogicalModel() { return entry; } } });
    const first = await resolver.resolve(request);
    assert.deepEqual(await resolver.resolve(request), first);
    assert.ok(Object.isFrozen(first.routeSnapshot.capabilitySnapshot));
    assert.match(first.routeSnapshotHash, /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(first).includes('must-not-copy'));
    assert.ok(!JSON.stringify(first).includes('https://'));
    entry.bindings[0].providerInstance.configVersion++;
    const next = await resolver.resolve(request);
    assert.notEqual(next.routeSnapshotHash, first.routeSnapshotHash);
    assert.equal(first.routeSnapshot.providerConfigVersion, 1);
});
test('disabled, unverified, wrong identity and ambiguous routes fail closed', async () => {
    for (const mutate of [e => { e.enabled = false; }, e => { e.bindings[0].providerInstance.enabled = false; }, e => { e.bindings[0].providerModel.validationState = 'pending'; }, e => { e.logicalModelId = 'wrong-model'; }, e => { e.bindings.push(structuredClone(e.bindings[0])); }]) {
        const entry = model(); mutate(entry);
        const resolver = createModelRouteResolver({ catalog: { async getLogicalModel() { return entry; } } });
        await assert.rejects(resolver.resolve(request));
    }
});
test('injected resolver persists snapshot; replay after route removal does not resolve or replace original', async () => {
    let row; let resolves = 0; let inserts = 0;
    const entry = model();
    const resolver = createModelRouteResolver({ catalog: { async getLogicalModel() { resolves++; return entry.enabled ? entry : null; } } });
    const pool = { async connect() { return { release() {}, async query(sql, args) {
        if (/SELECT/.test(sql)) return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
        if (/INSERT/.test(sql)) { inserts++; row = { id: '00000000-0000-4000-8000-000000000012', task_type: args[3], payload: args[4], status: 'queued', request_fingerprint: args[2], route_snapshot: JSON.parse(args[8]), route_snapshot_hash: args[10] }; return { rowCount: 1, rows: [row] }; }
        return { rows: [], rowCount: 0 };
    } }; } };
    const service = createTaskSubmissionService({ pool, routeResolver: resolver });
    const input = { ...request, ownerId: '00000000-0000-4000-8000-000000000013', idempotencyKey: 'route-test-key' };
    await service.submit(input);
    const original = row.route_snapshot_hash;
    entry.enabled = false;
    assert.equal((await service.submit(input)).replayed, true);
    assert.equal(row.route_snapshot_hash, original);
    assert.equal(resolves, 1); assert.equal(inserts, 1);
    await assert.rejects(service.submit({ ...input, payload: { ...input.payload, prompt: 'changed' } }), { code: 'IDEMPOTENCY_KEY_REUSED' });
});
