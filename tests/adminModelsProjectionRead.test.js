'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PgDialect } = require('drizzle-orm/pg-core');
const {
    CONTRACT_VERSION,
    createAdminModelsProjectionRead,
    parseQuery,
    projectBinding,
    projectModel,
    projectionQuery,
} = require('../lib/server/adminModelsProjectionRead');

const dialect = new PgDialect();
const modelPk = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const providerModelId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const providerInstanceId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function model(overrides = {}) {
    return {
        id: modelPk, logical_model_id: 'demo.image', display_name: 'Demo image', media_type: 'image',
        supported_operations: ['image.generate', 'unsupported.future'], capability_template_key: null,
        capability_template_version: null, parameter_schema_version: null, enabled: false, catalog_version: 2, ...overrides,
    };
}
function binding(overrides = {}) {
    return {
        logical_model_pk: modelPk, provider_instance_id: providerInstanceId, provider_model_id: providerModelId,
        route_role: 'primary', route_order: 101, binding_version: 3, active: false, ...overrides,
    };
}
function stub(rows = [model()], bindingRows = [binding()]) {
    const calls = [];
    const transactions = [];
    const database = { async transaction(run, config) {
        transactions.push(config);
        return run({ async execute(query) {
            const compiled = dialect.sqlToQuery(query);
            calls.push(compiled);
            if (compiled.sql.startsWith('SET LOCAL')) return { rows: [] };
            if (compiled.sql.startsWith('SELECT to_char')) return { rows: [{ as_of: '2026-11-20T01:30:00.123456Z' }] };
            if (compiled.sql.startsWith('SELECT lm.id')) return { rows: [...rows] };
            return { rows: bindingRows };
        } });
    } };
    return { database, calls, transactions };
}

test('模型投影只保留安全目录字段、版本相等映射和价格未授权三态', () => {
    const value = projectModel(model());
    assert.deepEqual(value, {
        logicalModelId: 'demo.image', logicalModelPk: modelPk, logicalModelVersion: 2, catalogVersion: 2,
        displayName: 'Demo image', type: 'image', capabilities: ['image.generate'], capabilitiesState: 'known',
        enabled: false, capabilityTemplate: null, parameterSchemaVersion: null, bindings: null,
        pricing: { readable: false, reason: 'NOT_AUTHORIZED', data: null },
    });
});

test('绑定投影保留disabled、secondary和大于100的priority，不暴露内部字段', () => {
    assert.deepEqual(projectBinding(binding({ route_role: 'secondary', route_order: 101, active: false })), {
        providerInstanceId, providerModelId, routeRole: 'secondary', routeOrder: 101, bindingVersion: 3, active: false,
    });
});

test('查询白名单、默认分页和cursor筛选绑定', () => {
    assert.deepEqual(parseQuery(new URLSearchParams('q=demo&type=image&enabled=false&limit=50')), {
        q: 'demo', type: 'image', enabled: 'false', limit: 50, cursor: null,
    });
    assert.throws(() => parseQuery(new URLSearchParams('limit=51')), error => error.code === 'INVALID_ADMIN_MODEL_QUERY');
    assert.throws(() => parseQuery(new URLSearchParams('includeSecrets=true')), error => error.code === 'INVALID_ADMIN_MODEL_QUERY');
    const query = parseQuery(new URLSearchParams('q=a%25_b'));
    const compiled = dialect.sqlToQuery(projectionQuery(query));
    assert.match(compiled.sql, /ILIKE/);
    assert.match(compiled.sql, /ESCAPE/);
});

test('只读服务使用repeatable read/read only、按本页PK批量读取绑定且返回统一API能力元数据', async () => {
    const database = stub();
    const service = createAdminModelsProjectionRead({ database: database.database, readBindings: async (tx, ids) => {
        assert.equal(ids.length, 1);
        assert.equal(ids[0], modelPk);
        return [binding()];
    } });
    const result = await service.read();
    assert.equal(result.ok, true);
    assert.equal(result.meta.contractVersion, CONTRACT_VERSION);
    assert.deepEqual(result.data.models[0].bindings, { readable: true, data: [projectBinding(binding())] });
    assert.equal(result.data.models[0].pricing.reason, 'NOT_AUTHORIZED');
    assert.equal(result.meta.writesAvailable, false);
    assert.deepEqual(database.transactions[0], { isolationLevel: 'repeatable read', accessMode: 'read only' });
    assert.equal(database.calls.filter(call => call.sql.startsWith('SELECT lm.id')).length, 1);
    assert.equal(database.calls.filter(call => call.sql.startsWith('SELECT to_char')).length, 1);
});

test('默认绑定查询把多个 UUID 编译为单一数组参数，游标只接受原筛选', async () => {
    const rows = [model(), model({ id: providerModelId, logical_model_id: 'demo.next' }), model({ id: providerInstanceId, logical_model_id: 'demo.tail' })];
    const db = stub(rows, [binding()]);
    const service = createAdminModelsProjectionRead({ database: db.database });
    const q = '模'.repeat(128);
    const params = new URLSearchParams({ q, type: 'image', enabled: 'false', limit: '2' });
    const result = await service.read(params);
    const call = db.calls.find(entry => entry.sql.includes('admin_model_bindings_read'));
    assert.match(call.sql, /admin_model_bindings_read\(\$1::uuid\[\]\)/);
    assert.deepEqual(call.params, [[modelPk, providerModelId]]);
    params.set('cursor', result.data.nextCursor);
    assert.equal(parseQuery(params).cursor.id, 'demo.next');
    for (const [key, value] of [['q', 'other'], ['type', 'video'], ['enabled', 'true']]) {
        const changed = new URLSearchParams(params);
        changed.set(key, value);
        await assert.rejects(service.read(changed), error => error.code === 'INVALID_ADMIN_MODEL_QUERY');
    }
    assert.equal(db.transactions.length, 1);
});

test('绑定函数返回未知模型PK或超过50条时失败关闭', async () => {
    const unknown = stub();
    const service = createAdminModelsProjectionRead({ database: unknown.database, readBindings: async () => [binding({ logical_model_pk: providerModelId })] });
    await assert.rejects(service.read(), error => error.code === 'ADMIN_MODELS_DATA_INVALID');
    const tooMany = stub();
    const many = Array.from({ length: 51 }, (_, index) => binding({ providerModelId: `${String(index + 1).padStart(8, '0')}-bbbb-4bbb-8bbb-bbbbbbbbbbbb` }));
    const limited = createAdminModelsProjectionRead({ database: tooMany.database, readBindings: async () => many });
    await assert.rejects(limited.read(), error => error.code === 'ADMIN_MODELS_DATA_INVALID');
});
