const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createChargedSubmissionService } = require('../lib/server/tasks/chargedSubmission');
const { preparePricingVersion } = require('../lib/server/tasks/pricingQuote');
const { requestFingerprint, stableStringify } = require('../lib/server/tasks/taskSubmission');

const user = '11111111-1111-4111-8111-111111111111';
const modelPk = '22222222-2222-4222-8222-222222222222';
const modelId = 'unit-model';
const request = { taskType: 'image.generate', payload: {
    logicalModelId: modelId, prompt: '收费入口单测', aspectRatio: '1:1', size: '1024x1024', outputCount: 1 } };

function configOf(unitPriceTenths = '7') {
    return {
        modelId, modelVersion: 1, pricingVersion: 'unit-v1', enabled: true,
        templateType: 'image_resolution_quantity', currencyUnit: 'credit_tenths',
        roundingMode: 'ceil_to_atom', precisionVersion: 'integer_rational_ms_v1',
        roundingModeVersion: 'ceil_to_atom_v1', quantityMode: 'per_unit', maxOutputCount: 1,
        resolutions: [{ resolutionKey: '1024x1024', enabled: true, unitPriceTenths }],
    };
}

function versionRow(config = configOf()) {
    const prepared = preparePricingVersion({ config, publishedAtUs: null, effectiveFromUs: '1799999000000000',
        revokedAtUs: null, cancelledAtUs: null });
    return { id: 'version-1', pricing_version: 'unit-v1', config, config_hash: prepared.configHash,
        effective_from_us: '1799999000000000', published_at_us: '1799999000000000', revoked_at_us: null, cancelled_at_us: null };
}

function routeFor({ snapshot = {}, route = {} } = {}) {
    const routeSnapshot = { snapshotVersion: 1, logicalModelId: modelId, logicalModelVersion: 1,
        capabilitySnapshot: { operation: 'image.generate', mediaType: 'image' }, ...snapshot };
    return { logicalModelPk: modelPk, routeSnapshot, routeSnapshotVersion: 1,
        routeSnapshotHash: createHash('sha256').update(stableStringify(routeSnapshot)).digest('hex'), ...route };
}

function resolverOf(route) {
    return { resolves: 0, async resolve() { this.resolves += 1; return route; } };
}

// 账单式假连接：按语句特征返回固定结果，同时保留调用顺序供断言。
function fakePool(script = {}) {
    const calls = [];
    const client = {
        async query(text, values) {
            calls.push({ text, values });
            for (const [needle, handler] of Object.entries(script)) {
                if (text.includes(needle)) {
                    const result = typeof handler === 'function' ? handler({ text, values }) : handler;
                    if (result instanceof Error) throw result;
                    return result ?? { rows: [] };
                }
            }
            return { rows: [] };
        },
        release() { calls.push({ text: 'RELEASE' }); },
    };
    return { calls, connect: async () => client };
}

const modelRow = { id: modelPk, logical_model_id: modelId, catalog_version: 1, enabled: true,
    media_type: 'image', supported_operations: ['image.generate'] };
const baseScript = (overrides = {}) => ({
    'SELECT id FROM public.logical_models': { rows: [{ id: modelPk }] },
    'SELECT id, logical_model_id, catalog_version': { rows: [modelRow] },
    'pricing_versions_for_submission': { rows: [versionRow()] },
    'clock_timestamp()) * 1000000': { rows: [{ us: '1800000000000000' }] },
    'INSERT INTO public.generation_tasks': { rows: [{ id: 'task-1', owner_id: user, task_type: 'image.generate', status: 'queued' }] },
    'credit_charge_task': { rows: [{ quote_id: 'quote-1', credit_tenths: '7', event_id: 'event-1', replayed: false }] },
    ...overrides,
});

test('收费提交要求构造期可信解析器与连接池', () => {
    assert.throws(() => createChargedSubmissionService(), /pool is required/);
    assert.throws(() => createChargedSubmissionService({ pool: fakePool() }), /trusted routeResolver required/);
    assert.throws(() => createChargedSubmissionService({ pool: fakePool(), routeResolver: {} }), /trusted routeResolver required/);
});

test('非法请求在连库前拒绝，不占用事务', async () => {
    const pool = fakePool();
    const service = createChargedSubmissionService({ pool, routeResolver: resolverOf(routeFor()) });
    await assert.rejects(service.submit({ ownerId: 'not-a-uuid', idempotencyKey: 'charged-unit-1', ...request }),
        (error) => error.code === 'INVALID_TASK_REQUEST' && error.status === 400);
    await assert.rejects(service.submit({ ownerId: user, idempotencyKey: 'short', ...request }),
        (error) => error.code === 'INVALID_TASK_REQUEST');
    assert.equal(pool.calls.length, 0);
});

test('路由哈希不自洽时拒绝建任务与冻结', async () => {
    const pool = fakePool();
    const service = createChargedSubmissionService({ pool, routeResolver: resolverOf(routeFor({ route: { routeSnapshotHash: 'f'.repeat(64) } })) });
    await assert.rejects(service.submit({ ownerId: user, idempotencyKey: 'charged-unit-2', ...request }),
        (error) => error.code === 'MODEL_ROUTE_HASH_MISMATCH' && error.status === 409);
    assert.equal(pool.calls.length, 0);
});

test('收费提交：报价、建任务与冻结在同一事务内完成，并返回本单费用', async () => {
    const pool = fakePool(baseScript());
    const service = createChargedSubmissionService({ pool, routeResolver: resolverOf(routeFor()) });
    const result = await service.submit({ ownerId: user, idempotencyKey: 'charged-unit-3', ...request });
    assert.equal(result.replayed, false);
    assert.deepEqual(result.credit, { tenths: '7', quoteId: 'quote-1', reserved: true });
    const texts = pool.calls.map((call) => call.text);
    assert.equal(texts[0], 'BEGIN ISOLATION LEVEL READ COMMITTED');
    assert.equal(texts.at(-1), 'RELEASE');
    assert.ok(texts.includes('COMMIT'));
    const charge = pool.calls.find((call) => call.text.includes('credit_charge_task'));
    assert.equal(charge.text, 'SELECT * FROM public.credit_charge_task_verified($1,$2,$3,$4::jsonb,$5,$6,$7,$8)');
    assert.deepEqual(charge.values.slice(0, 3), [user, 'task-1', 'version-1']);
    assert.equal(charge.values[5], '7');
    assert.equal(pool.calls.some((call) => call.text === 'ROLLBACK'), false);
});

test('免费档位照常落报价，但不返回冻结标记', async () => {
    const pool = fakePool(baseScript({
        'pricing_versions_for_submission': { rows: [versionRow(configOf('0'))] },
        'credit_charge_task': { rows: [{ quote_id: 'quote-free', credit_tenths: '0', event_id: null, replayed: false }] },
    }));
    const service = createChargedSubmissionService({ pool, routeResolver: resolverOf(routeFor()) });
    const result = await service.submit({ ownerId: user, idempotencyKey: 'charged-unit-4', ...request });
    assert.deepEqual(result.credit, { tenths: '0', quoteId: 'quote-free', reserved: false });
    assert.ok(pool.calls.some((call) => call.text.includes('credit_charge_task')));
});

test('余额不足由数据库裁决并回滚，映射为 402', async () => {
    const pool = fakePool(baseScript({
        'credit_charge_task': Object.assign(new Error('CREDIT_INSUFFICIENT'), { code: '23514' }),
    }));
    const service = createChargedSubmissionService({ pool, routeResolver: resolverOf(routeFor()) });
    await assert.rejects(service.submit({ ownerId: user, idempotencyKey: 'charged-unit-5', ...request }),
        (error) => error.code === 'CREDIT_INSUFFICIENT' && error.status === 402);
    assert.equal(pool.calls.at(-2).text, 'ROLLBACK');
    assert.equal(pool.calls.at(-1).text, 'RELEASE');
});

test('幂等重放只读既有报价，不重算价格也不再扣费', async () => {
    const fingerprint = requestFingerprint({ taskType: request.taskType, payload: request.payload });
    const pool = fakePool(baseScript({
        'SELECT * FROM public.generation_tasks': { rows: [{ id: 'task-prior', owner_id: user, request_fingerprint: fingerprint }] },
        'credit_charge_task': { rows: [{ quote_id: 'quote-prior', credit_tenths: '7', event_id: 'event-prior', replayed: true }] },
    }));
    const service = createChargedSubmissionService({ pool, routeResolver: resolverOf(routeFor()) });
    const result = await service.submit({ ownerId: user, idempotencyKey: 'charged-unit-6', ...request });
    assert.equal(result.replayed, true);
    assert.deepEqual(result.credit, { tenths: '7', quoteId: 'quote-prior', reserved: true });
    const charge = pool.calls.find((call) => call.text.includes('credit_charge_task'));
    assert.equal(charge.text, 'SELECT * FROM public.credit_charge_task_verified($1,$2)');
    assert.equal(pool.calls.some((call) => call.text.includes('INSERT INTO public.generation_tasks')), false);
    assert.equal(pool.calls.some((call) => call.text.includes('pricing_versions_for_submission')), false);
});

test('同一幂等键换请求内容按冲突拒绝，不建新任务', async () => {
    const pool = fakePool(baseScript({
        'SELECT * FROM public.generation_tasks': { rows: [{ id: 'task-prior', owner_id: user, request_fingerprint: 'f'.repeat(64) }] },
    }));
    const service = createChargedSubmissionService({ pool, routeResolver: resolverOf(routeFor()) });
    await assert.rejects(service.submit({ ownerId: user, idempotencyKey: 'charged-unit-7', ...request }),
        (error) => error.code === 'IDEMPOTENCY_KEY_REUSED' && error.status === 409);
    assert.equal(pool.calls.some((call) => call.text.includes('INSERT INTO public.generation_tasks')), false);
    assert.equal(pool.calls.at(-2).text, 'ROLLBACK');
});

test('重放未启用收费的旧任务时显式失败，不静默补收费', async () => {
    const fingerprint = requestFingerprint({ taskType: request.taskType, payload: request.payload });
    const pool = fakePool(baseScript({
        'SELECT * FROM public.generation_tasks': { rows: [{ id: 'task-legacy', owner_id: user, request_fingerprint: fingerprint }] },
        'credit_charge_task': Object.assign(new Error('CREDIT_CHARGE_INVALID'), { code: '22023' }),
    }));
    const service = createChargedSubmissionService({ pool, routeResolver: resolverOf(routeFor()) });
    await assert.rejects(service.submit({ ownerId: user, idempotencyKey: 'charged-unit-8', ...request }),
        (error) => error.code === 'TASK_REPLAY_UNCHARGED' && error.status === 409);
    assert.equal(pool.calls.at(-2).text, 'ROLLBACK');
});

test('没有生效价格时按 409 拒绝，不插入任何任务', async () => {
    const pool = fakePool(baseScript({ 'pricing_versions_for_submission': { rows: [] } }));
    const service = createChargedSubmissionService({ pool, routeResolver: resolverOf(routeFor()) });
    await assert.rejects(service.submit({ ownerId: user, idempotencyKey: 'charged-unit-9', ...request }),
        (error) => error.code === 'NO_ACTIVE_VERSION' && error.status === 409);
    assert.equal(pool.calls.some((call) => call.text.includes('INSERT INTO public.generation_tasks')), false);
    assert.equal(pool.calls.at(-2).text, 'ROLLBACK');
});
