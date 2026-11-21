const test = require('node:test');
const assert = require('node:assert/strict');
const { createModelRouteResolver } = require('../lib/server/tasks/modelRouteResolver');
const { createTaskSubmissionService } = require('../lib/server/tasks/taskService');
const model = () => ({ id: '00000000-0000-4000-8000-000000000011', logicalModelId: 'image-alpha', catalogVersion: 1, enabled: true, mediaType: 'image', supportedOperations: ['image.generate'], bindings: [{ id: 'binding-a', enabled: true, isPrimary: true, bindingVersion: 1, providerInstance: { id: 'provider-a', enabled: true, configVersion: 1, credentialVersion: 1, adapterType: 'synthetic', secret: 'must-not-copy', baseUrl: 'https://example.test' }, providerModel: { id: 'model-a', enabled: true, validationState: 'verified', mediaType: 'image', capabilities: { operations: ['image.generate'] }, upstreamModelName: 'upstream-a', adapterVersion: '1', operationProfile: 'image.generate', requestMappingVersion: 1, responseMappingVersion: 1 } }] });
const request = { taskType: 'image.generate', payload: { logicalModelId: 'image-alpha', prompt: 'synthetic', aspectRatio: '1:1', size: '1024x1024', outputCount: 1 } };
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
function videoModel() {
    const entry = model();
    entry.logicalModelId = 'video-synthetic';
    entry.mediaType = 'video';
    entry.supportedOperations = ['video.generate'];
    entry.parameterSchemaVersion = 1;
    // 合成参数域只服务于契约测试，不代表真实模型档位。
    const parameters = { durationMs: { type: 'integer', minimum: 1000, maximum: 4000, multipleOf: 1000 }, fps: { type: 'integer', enum: [1, 2] } };
    entry.parameterSchema = { type: 'object', required: ['durationMs', 'fps'], properties: structuredClone(parameters) };
    entry.bindings[0].providerInstance.adapterType = 'mock';
    Object.assign(entry.bindings[0].providerModel, { mediaType: 'video', operationProfile: 'video.generate',
        capabilities: { operations: ['video.generate'], parameters: structuredClone(parameters) } });
    return entry;
}
const videoRequest = { taskType: 'video.generate', payload: { logicalModelId: 'video-synthetic', prompt: 'synthetic', durationMs: 1000, fps: 1 } };

function resolverFor(entry) {
    return createModelRouteResolver({ catalog: { async getLogicalModel() { return entry; } } });
}

test('计价参数结构错误在读取可信目录之前拒绝', async () => {
    let reads = 0;
    const resolver = createModelRouteResolver({ catalog: { async getLogicalModel() { reads++; assert.fail('不得读取目录'); } } });
    for (const outputCount of [undefined, 0, 2, Number.MAX_SAFE_INTEGER + 1]) {
        await assert.rejects(resolver.resolve({ ...request, payload: { ...request.payload, outputCount } }), { code: 'MODEL_PARAMETERS_UNSUPPORTED' });
    }
    for (const key of ['durationMs', 'fps']) {
        for (const value of [undefined, 0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
            await assert.rejects(resolver.resolve({ ...videoRequest, payload: { ...videoRequest.payload, [key]: value } }), { code: 'MODEL_PARAMETERS_UNSUPPORTED' });
        }
    }
    await assert.rejects(resolver.resolve({ taskType: 'image.generate', payload: { outputCount: 1 } }), { code: 'LOGICAL_MODEL_REQUIRED' });
    assert.equal(reads, 0);
});

test('图片不能以模型声明绕过单结果限制，已有 schema 必须显式支持单张', async () => {
    const entry = model();
    entry.parameterSchemaVersion = 1;
    entry.parameterSchema = { type: 'object', properties: { outputCount: { type: 'integer', enum: [1, 2] } } };
    await resolverFor(entry).resolve(request);
    await assert.rejects(resolverFor(entry).resolve({ ...request, payload: { ...request.payload, outputCount: 2 } }), { code: 'MODEL_PARAMETERS_UNSUPPORTED' });
    for (const schema of [{ type: 'integer', enum: [2] }, { type: 'integer' }, { type: 'integer', enum: [1], not: { const: 1 } }]) {
        entry.parameterSchema.properties.outputCount = schema;
        await assert.rejects(resolverFor(entry).resolve(request), { code: 'MODEL_PARAMETERS_UNSUPPORTED' });
    }
});

test('视频取模型 schema 与已验证路由参数交集，帧率精确匹配且时长不取整', async () => {
    const entry = videoModel();
    entry.bindings[0].providerModel.capabilities.parameters.durationMs.maximum = 2000;
    entry.bindings[0].providerModel.capabilities.parameters.fps.enum = [1];
    await resolverFor(entry).resolve(videoRequest);
    await resolverFor(entry).resolve({ ...videoRequest, payload: { ...videoRequest.payload, durationMs: 2000 } });
    for (const change of [{ durationMs: 999 }, { durationMs: 1001 }, { durationMs: 3000 }, { fps: 2 }, { fps: 3 }]) {
        await assert.rejects(resolverFor(entry).resolve({ ...videoRequest, payload: { ...videoRequest.payload, ...change } }), { code: 'MODEL_PARAMETERS_UNSUPPORTED' });
    }
});

test('视频缺能力、未知 schema 约束及未实现真实适配器一律 fail closed', async () => {
    const mutations = [
        e => { delete e.parameterSchema; },
        e => { delete e.parameterSchemaVersion; },
        e => { e.parameterSchemaVersion = 0; },
        e => { delete e.bindings[0].providerModel.capabilities.parameters; },
        e => { delete e.bindings[0].providerModel.capabilities.parameters.fps; },
        e => { e.bindings[0].providerInstance.adapterType = 'myvigna-image'; },
        e => { e.parameterSchema.required = ['durationMs']; },
        e => { e.parameterSchema.required.push('missing'); },
        e => { e.parameterSchema.oneOf = []; },
        e => { e.parameterSchema.additionalProperties = false; },
        e => { e.parameterSchema.properties.fps = { type: 'integer', minimum: 1, maximum: 2 }; },
        e => { e.parameterSchema.properties.fps.enum = [1, 1.5]; },
        e => { e.parameterSchema.properties.durationMs.minimum = 2000; },
        e => { e.parameterSchema.properties.durationMs.maximum = 500; },
        e => { e.parameterSchema.properties.durationMs.multipleOf = 0; },
        e => { e.parameterSchema.properties.durationMs.exclusiveMaximum = 2000; },
        e => { e.bindings[0].providerModel.capabilities.parameters.durationMs.type = 'number'; },
    ];
    for (const mutate of mutations) {
        const entry = videoModel();
        mutate(entry);
        await assert.rejects(resolverFor(entry).resolve(videoRequest), { code: 'MODEL_PARAMETERS_UNSUPPORTED' });
    }
});

test('视频幂等重放保留原路由，时长或帧率改变必须冲突', async () => {
    let row;
    let reads = 0;
    const entry = videoModel();
    const resolver = createModelRouteResolver({ catalog: { async getLogicalModel() { reads++; return entry.enabled ? entry : null; } } });
    const pool = { async connect() { return { release() {}, async query(sql, args) {
        if (/SELECT/.test(sql)) return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
        if (/INSERT/.test(sql)) {
            row = { id: '00000000-0000-4000-8000-000000000012', task_type: args[3], payload: args[4], status: 'queued', request_fingerprint: args[2], route_snapshot_hash: args[10] };
            return { rowCount: 1, rows: [row] };
        }
        return { rowCount: 0, rows: [] };
    } }; } };
    const service = createTaskSubmissionService({ pool, routeResolver: resolver });
    const input = { ...videoRequest, ownerId: '00000000-0000-4000-8000-000000000013', idempotencyKey: 'video-route-test' };
    await service.submit(input);
    const originalHash = row.route_snapshot_hash;
    entry.enabled = false;
    assert.equal((await service.submit(input)).replayed, true);
    for (const change of [{ durationMs: 2000 }, { fps: 2 }]) {
        await assert.rejects(service.submit({ ...input, payload: { ...input.payload, ...change } }), { code: 'IDEMPOTENCY_KEY_REUSED' });
    }
    assert.equal(reads, 1);
    assert.equal(row.route_snapshot_hash, originalHash);
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
