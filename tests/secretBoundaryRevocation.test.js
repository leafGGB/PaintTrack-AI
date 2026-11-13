'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createSyntheticSecretBoundary } = require('../lib/server/providers/secretBoundary');
const { resolveWorkerProviderWithSecrets } = require('../lib/server/providers/providerRegistry');
const { createMyVignaImageProvider } = require('../lib/server/providers/myvignaImageProvider');
const { createWorker } = require('../lib/server/worker');
const queue = require('../lib/server/worker/taskQueue');

const canary = 'synthetic-revocation-canary-not-a-real-token';
const binding = Object.freeze({
    providerInstanceId: 'synthetic-revoke-worker',
    credentialRef: 'synthetic-revoke-credential',
    credentialVersion: 1,
    adapterType: 'myvigna-image',
    baseUrl: 'https://provider.example.test/v1',
    upstreamModel: 'gpt-image-2',
});
const reference = Object.freeze({
    providerInstanceId: binding.providerInstanceId,
    credentialRef: binding.credentialRef,
    credentialVersion: binding.credentialVersion,
});

function deferred() {
    let resolve;
    const promise = new Promise((res) => { resolve = res; });
    return { promise, resolve };
}

function response(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function forbidExternalIO(t) {
    const originalFetch = globalThis.fetch;
    const originalConnect = Pool.prototype.connect;
    const originalQuery = Pool.prototype.query;
    let forbiddenCalls = 0;
    const forbidden = () => { forbiddenCalls++; throw new Error('unexpected external IO'); };
    globalThis.fetch = forbidden;
    Pool.prototype.connect = forbidden;
    Pool.prototype.query = forbidden;
    t.after(() => {
        globalThis.fetch = originalFetch;
        Pool.prototype.connect = originalConnect;
        Pool.prototype.query = originalQuery;
        assert.equal(forbiddenCalls, 0, '测试链路不得尝试默认网络或数据库入口');
    });
}

async function withQueueStubs(t, stubs, run) {
    const originals = Object.fromEntries(Object.keys(stubs).map((key) => [key, queue[key]]));
    Object.assign(queue, stubs);
    try {
        return await run();
    } finally {
        Object.assign(queue, originals);
    }
}

async function makeFixture(fetchImpl) {
    const boundary = await createSyntheticSecretBoundary({
        principal: 'worker',
        entries: [{ reference, value: canary }],
        allowed: [reference],
    });
    const adapter = await resolveWorkerProviderWithSecrets({
        descriptor: { ...binding },
        approvedBindings: [{ ...binding }],
        secretResolver: boundary.resolve,
        adapterFactory: (configuration) => createMyVignaImageProvider({ ...configuration, fetchImpl }),
    });
    return { boundary, adapter };
}

test('撤销只阻止新解析，已构造 Adapter 在 boundary 关闭后仍持有可用凭据', async (t) => {
    forbidExternalIO(t);
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push({ url, method: options.method, authorization: options.headers.Authorization });
        return options.method === 'POST'
            ? response({ task_id: 'synthetic-job', status: 'queued' }, 202)
            : response({ status: 'running' });
    };
    const { boundary, adapter } = await makeFixture(fetchImpl);
    t.after(() => boundary.close());

    await boundary.revoke(reference);
    await assert.rejects(resolveWorkerProviderWithSecrets({
        descriptor: { ...binding },
        approvedBindings: [{ ...binding }],
        secretResolver: boundary.resolve,
        adapterFactory: (configuration) => createMyVignaImageProvider({ ...configuration, fetchImpl }),
    }), (error) => {
        assert.equal(error.code, 'PROVIDER_SECRET_UNAVAILABLE');
        assert.ok(!String(error).includes(canary));
        assert.ok(!error.stack.includes(canary));
        assert.ok(!JSON.stringify(error).includes(canary));
        return true;
    });

    assert.equal((await adapter.submit({
        input: { logicalModelId: 'gpt-image-2', prompt: 'synthetic', size: '1024x1024' },
        idempotencyKey: 'synthetic-revoke-submit',
    })).providerJobId, 'synthetic-job');
    assert.equal((await adapter.query({ providerJobId: 'synthetic-job' })).state, 'running');

    await boundary.close();
    assert.equal((await adapter.query({ providerJobId: 'synthetic-job' })).state, 'running');
    assert.equal(calls.length, 3);
    assert.ok(calls.every((call) => call.authorization === `Bearer ${canary}`));
    assert.ok(!JSON.stringify({ calls: calls.map(({ url, method }) => ({ url, method })) }).includes(canary));
    assert.ok(!JSON.stringify({ boundary, adapter }).includes(canary));
});

test('worker.stop 阻止下一次 claim，宽限内完成当前请求且停止后宿主不再调用旧 Adapter', { timeout: 10000 }, async (t) => {
    forbidExternalIO(t);
    const requestSent = deferred();
    const querySent = deferred();
    const releaseResponse = deferred();
    const queryResponse = deferred();
    const networkCalls = [];
    const fetchImpl = async (url, options) => {
        networkCalls.push({ url, method: options.method, authorization: options.headers.Authorization });
        if (options.method === 'POST') {
            requestSent.resolve();
            return releaseResponse.promise;
        }
        const queryCount = networkCalls.filter((call) => call.method === 'GET').length;
        if (queryCount === 1) {
            querySent.resolve();
            return queryResponse.promise;
        }
        return response({ status: 'running' });
    };
    const { boundary, adapter } = await makeFixture(fetchImpl);
    t.after(() => boundary.close());

    let claims = 0;
    const writes = [];
    const task = { id: 'synthetic-task', lease_token: 'synthetic-lease', payload: {} };
    await withQueueStubs(t, {
        claimNextTask: async () => { claims++; return task; },
        heartbeatTask: async () => {},
        completeTask: async (_pool, args) => { writes.push({ type: 'complete', args }); },
        failTask: async (_pool, args) => { writes.push({ type: 'fail', args }); },
        cancelClaimedTask: async (_pool, args) => { writes.push({ type: 'cancel', args }); },
    }, async () => {
        const worker = createWorker({
            pool: {}, workerId: 'synthetic-revoke-worker', shutdownGraceMs: 1000,
            processTask: async () => {
                await adapter.submit({
                    input: { logicalModelId: 'gpt-image-2', prompt: 'synthetic', size: '1024x1024' },
                    idempotencyKey: 'synthetic-worker-submit',
                });
                await adapter.query({ providerJobId: 'synthetic-job' });
            },
        });
        const running = worker.run();
        await requestSent.promise;
        await boundary.revoke(reference);
        await assert.rejects(boundary.resolve(reference), { code: 'SECRET_VERSION_REVOKED' });
        worker.stop();
        assert.equal(networkCalls.length, 1);
        releaseResponse.resolve(response({ task_id: 'synthetic-job', status: 'queued' }, 202));
        await querySent.promise;
        assert.equal(networkCalls.length, 2);
        queryResponse.resolve(response({ status: 'running' }));
        assert.deepEqual(await running, { status: 'stopped' });
    });

    assert.equal(claims, 1);
    assert.deepEqual(writes.map((write) => write.type), ['complete']);
    const requestsAfterStop = networkCalls.length;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(networkCalls.length, requestsAfterStop);
    assert.ok(networkCalls.every((call) => call.authorization === `Bearer ${canary}`));
    assert.ok(!JSON.stringify({ claims, writes, urls: networkCalls.map(({ url, method }) => ({ url, method })) }).includes(canary));
});
