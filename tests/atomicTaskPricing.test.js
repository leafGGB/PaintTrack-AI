const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createAtomicTaskPricingStore } = require('../lib/server/tasks/atomicTaskPricing');
const { stableStringify } = require('../lib/server/tasks/taskSubmission');

const user = '11111111-1111-4111-8111-111111111111';
const modelPk = '22222222-2222-4222-8222-222222222222';
const request = {
    taskType: 'image.generate',
    payload: { logicalModelId: 'unit-model', prompt: '原子事务测试', aspectRatio: '1:1', size: '1024x1024', outputCount: 1 },
};

function routeFor({ snapshot = {}, route = {} } = {}) {
    const routeSnapshot = {
        snapshotVersion: 1,
        logicalModelId: 'unit-model',
        logicalModelVersion: 1,
        capabilitySnapshot: { operation: 'image.generate', mediaType: 'image' },
        ...snapshot,
    };
    return {
        logicalModelPk: modelPk,
        routeSnapshot,
        routeSnapshotVersion: 1,
        routeSnapshotHash: createHash('sha256').update(stableStringify(routeSnapshot)).digest('hex'),
        ...route,
    };
}

function resolverOf(route) {
    return { resolves: 0, async resolve() { this.resolves += 1; return route; } };
}

function fakePool({ allowed = false } = {}) {
    const calls = [];
    const client = {
        async query(text) {
            calls.push(text);
            if (text.startsWith('SELECT current_user')) return { rows: [{ allowed }] };
            return { rows: [] };
        },
        release() { calls.push('RELEASE'); },
    };
    return { calls, connect: async () => client };
}

test('原子协调器要求构造期可信路由解析器，缺省即拒绝', () => {
    assert.throws(() => createAtomicTaskPricingStore(), /pool is required/);
    assert.throws(() => createAtomicTaskPricingStore({ pool: fakePool() }), /trusted routeResolver required/);
    assert.throws(() => createAtomicTaskPricingStore({ pool: fakePool(), routeResolver: {} }), /trusted routeResolver required/);
});

test('原子协调器在非 ledger owner 下 fail closed，并回滚事务', async () => {
    const pool = fakePool();
    const store = createAtomicTaskPricingStore({ pool, routeResolver: resolverOf(routeFor()) });
    await assert.rejects(store.submit({ ownerId: user, idempotencyKey: 'atomic-unit-1', request }), error => error.reason === 'PRICING_EXECUTOR_REQUIRED');
    assert.deepEqual(pool.calls.slice(0, 3), [
        'BEGIN ISOLATION LEVEL READ COMMITTED',
        `SELECT current_user = 'pt_ledger_owner_' ||\n                substr(md5(current_database()), 1, 16) AS allowed`,
        'ROLLBACK',
    ]);
    assert.equal(pool.calls.at(-1), 'RELEASE');
    assert.equal(pool.calls.some(text => /INSERT INTO public\.(generation_tasks|pricing_quotes)|credit_reserve_task|^COMMIT$/.test(text)), false);
});

test('原子协调器拒绝非法请求，不创建事务也不解析路由', async () => {
    const pool = fakePool({ allowed: true });
    const resolver = resolverOf(routeFor());
    const store = createAtomicTaskPricingStore({ pool, routeResolver: resolver });
    await assert.rejects(store.submit({ ownerId: user, idempotencyKey: 'atomic-unit-2', request: { taskType: 'image.generate', payload: {} } }), error => error.reason === 'LOGICAL_MODEL_REQUIRED' || error.code === 'INVALID_TASK_PAYLOAD');
    assert.deepEqual(pool.calls, []);
    assert.equal(resolver.resolves, 0);
});

test('可信路由缺失、被篡改或与请求不一致时拒绝，且不创建事务', async () => {
    const pool = fakePool({ allowed: true });
    const missing = createAtomicTaskPricingStore({ pool, routeResolver: resolverOf(null) });
    await assert.rejects(missing.submit({ ownerId: user, idempotencyKey: 'atomic-unit-3', request }), error => error.reason === 'MODEL_ROUTE_REQUIRED');
    const tampered = routeFor();
    tampered.routeSnapshot.providerModelId = 'tampered-after-hash';
    const store = createAtomicTaskPricingStore({ pool, routeResolver: resolverOf(tampered) });
    await assert.rejects(store.submit({ ownerId: user, idempotencyKey: 'atomic-unit-4', request }), error => error.reason === 'MODEL_ROUTE_HASH_MISMATCH');
    const mismatched = createAtomicTaskPricingStore({ pool, routeResolver: resolverOf(routeFor({ snapshot: { logicalModelId: 'other-model' } })) });
    await assert.rejects(mismatched.submit({ ownerId: user, idempotencyKey: 'atomic-unit-5', request }), error => error.reason === 'MODEL_ROUTE_INVALID');
    assert.deepEqual(pool.calls, []);
});
