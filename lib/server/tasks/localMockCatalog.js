'use strict';

// 固定合成配置，无真实目标、凭据或动态模块加载；仅本地启动器显式开启。
const models = Object.freeze([
    Object.freeze({ id: 'c1111111-1111-4111-8111-111111111111', logicalModelId: 'local-mock-image', mediaType: 'image', operation: 'image.generate' }),
    Object.freeze({ id: 'c2222222-2222-4222-8222-222222222222', logicalModelId: 'local-mock-video', mediaType: 'video', operation: 'video.generate' }),
]);
function createLocalMockCatalog(environment) {
    if (environment.NODE_ENV !== 'development' || environment.PAINTTRACK_LOCAL_INTERNAL_GUARD !== '1'
        || environment.PAINTTRACK_LOCAL_MOCK_ROUTING !== '1') throw new Error('LOCAL_MOCK_ROUTING_FORBIDDEN');
    return Object.freeze({ async getLogicalModel(id) {
        const model = models.find(entry => entry.logicalModelId === id);
        if (!model) return null;
        // 仅用于合成提交/恢复测试，不声明可播放视频或任何商业模型档位。
        const parameters = { durationMs: { type: 'integer', enum: [1000] }, fps: { type: 'integer', enum: [1] } };
        return { ...model, enabled: true, catalogVersion: 1, supportedOperations: [model.operation],
            ...(model.mediaType === 'video' ? { parameterSchemaVersion: 1,
                parameterSchema: { type: 'object', required: ['durationMs', 'fps'], properties: structuredClone(parameters) } } : {}), bindings: [{
            id: `synthetic-${model.mediaType}-binding`, enabled: true, isPrimary: true, bindingVersion: 1,
            providerInstance: { id: 'local-mock-provider', enabled: true, configVersion: 1, credentialVersion: 1, adapterType: 'mock' },
            providerModel: { id: `synthetic-${model.mediaType}-model`, enabled: true, validationState: 'verified', mediaType: model.mediaType,
                capabilities: { operations: [model.operation], ...(model.mediaType === 'video' ? { parameters } : {}) }, upstreamModelName: model.logicalModelId,
                adapterVersion: '1', operationProfile: model.operation, requestMappingVersion: 1, responseMappingVersion: 1 },
        }] };
    } });
}
async function createLocalMockProviderSelector({ environment, provider }) {
    const catalog = createLocalMockCatalog(environment);
    if (!provider || provider.name !== 'mock-provider' || typeof provider.submit !== 'function' || typeof provider.query !== 'function') {
        throw new Error('LOCAL_MOCK_PROVIDER_REQUIRED');
    }
    const { createModelRouteResolver, assertGenerationParameters, stableStringify } = require('./modelRouteResolver');
    const resolver = createModelRouteResolver({ catalog });
    const approved = new Map();
    const entries = new Map();
    for (const model of models) {
        entries.set(model.logicalModelId, await catalog.getLogicalModel(model.logicalModelId));
        approved.set(model.logicalModelId, await resolver.resolve({
            taskType: model.operation, payload: { logicalModelId: model.logicalModelId,
                ...(model.mediaType === 'image' ? { outputCount: 1 } : { durationMs: 1000, fps: 1 }) },
        }));
    }
    return Object.freeze({ select(task) {
        const expected = approved.get(task.payload?.logicalModelId);
        if (!expected || task.task_type !== expected.routeSnapshot.capabilitySnapshot.operation
            || task.logical_model_pk !== expected.logicalModelPk
            || task.route_snapshot_version !== expected.routeSnapshotVersion
            || task.route_snapshot_hash !== expected.routeSnapshotHash
            || stableStringify(task.route_snapshot) !== stableStringify(expected.routeSnapshot)) {
            throw new Error('LOCAL_MOCK_ROUTE_REJECTED');
        }
        const entry = entries.get(task.payload.logicalModelId);
        assertGenerationParameters(entry, entry.bindings[0], task.task_type, task.payload);
        return provider;
    } });
}
module.exports = { createLocalMockCatalog, createLocalMockProviderSelector, models };
