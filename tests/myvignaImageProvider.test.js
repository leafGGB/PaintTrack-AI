'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const {
    createMyVignaImageProvider,
    normalizeBaseUrl,
    normalizeInput,
    parseResult,
} = require('../lib/server/providers/myvignaImageProvider');
const { mapProviderError } = require('../lib/server/providers/providerExecution');
const { validateProviderResult } = require('../lib/server/providers/resultBoundary');

async function withMockServer(handler, run) {
    const server = createServer((request, response) => {
        const chunks = [];
        request.on('data', (chunk) => chunks.push(chunk));
        request.on('end', () => handler(request, response, Buffer.concat(chunks).toString('utf8')));
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    try {
        await run(`http://127.0.0.1:${address.port}/v1`);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

function sendJson(response, status, value, headers = {}) {
    response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    response.end(JSON.stringify(value));
}

const input = Object.freeze({ logicalModelId: 'gpt-image-2', prompt: 'a cat', size: '1024x1024' });

test('base URL normalization requires HTTPS except explicit development loopback', () => {
    assert.equal(normalizeBaseUrl('https://api.example.test'), 'https://api.example.test/v1');
    assert.equal(normalizeBaseUrl('https://api.example.test/v1/'), 'https://api.example.test/v1');
    assert.equal(normalizeBaseUrl('http://127.0.0.1:4321', { allowInsecureLoopback: true, nodeEnv: 'test' }), 'http://127.0.0.1:4321/v1');
    for (const value of [
        'http://api.example.test',
        'https://user:pass@api.example.test/v1',
        'https://api.example.test/v1?token=x',
        'https://api.example.test/v1/v1',
    ]) assert.throws(() => normalizeBaseUrl(value));
    assert.throws(() => normalizeBaseUrl('http://127.0.0.1:4321', { allowInsecureLoopback: true, nodeEnv: 'production' }));
});

test('request mapping fixes upstream model, one output and high quality at 1K', () => {
    assert.deepEqual(normalizeInput(input, 'gpt-image-2'), {
        model: 'gpt-image-2', prompt: 'a cat', n: 1, size: '1024x1024', response_format: 'url', quality: 'high',
    });
    assert.throws(() => normalizeInput({ ...input, size: '2048x2048' }, 'gpt-image-2'), /1K bound/);
    assert.throws(() => normalizeInput({ ...input, logicalModelId: 'other' }, 'gpt-image-2'), /Only gpt-image-2/);
});

test('submit sends only the fixed async image contract and resolves task URLs against trusted origin', async () => {
    await withMockServer((request, response, rawBody) => {
        assert.equal(request.method, 'POST');
        assert.equal(request.url, '/v1/images/tasks');
        assert.equal(request.headers.authorization, 'Bearer test-server-token');
        assert.equal(request.headers['idempotency-key'], 'pt_test_001');
        assert.deepEqual(JSON.parse(rawBody), {
            model: 'gpt-image-2', prompt: 'a cat', n: 1, size: '1024x1024', response_format: 'url', quality: 'high',
        });
        sendJson(response, 202, {
            object: 'image.task', task_id: 'imgtask_001', status: 'queued',
            poll_url: '/v1/images/tasks/imgtask_001',
            result_url: '/v1/images/tasks/imgtask_001/result',
            poll_after_ms: 17,
        });
    }, async (baseUrl) => {
        const provider = createMyVignaImageProvider({
            baseUrl, credential: 'test-server-token', allowInsecureLoopback: true, nodeEnv: 'test',
        });
        const accepted = await provider.submit({ taskId: 'task-local', idempotencyKey: 'pt_test_001', input });
        assert.deepEqual(accepted, {
            kind: 'accepted', providerJobId: 'imgtask_001', providerState: 'queued', pollAfterMs: 17,
        });
        assert.equal(provider.name, 'myvigna-image');
    });
});

test('submit treats ambiguous network failure as unknown and preserves the idempotency recovery path', async () => {
    const provider = createMyVignaImageProvider({
        baseUrl: 'https://api.example.test/v1',
        credential: 'test-server-token',
        fetchImpl: async () => { throw new Error('connection reset'); },
    });
    await assert.rejects(provider.submit({ idempotencyKey: 'pt_test_001', input }), (error) => {
        const decision = mapProviderError(error, { phase: 'submit' });
        assert.equal(decision.action, 'unknown_submission');
        assert.equal(decision.errorCode, 'NETWORK_UNAVAILABLE');
        assert.doesNotMatch(error.message, /connection reset|test-server-token/);
        return true;
    });
});

test('query reads the original task and result, normalizing URL and base64 outputs', async () => {
    const calls = [];
    await withMockServer((request, response) => {
        calls.push({ url: request.url, authorization: request.headers.authorization });
        if (request.url === '/v1/images/tasks/imgtask_002') {
            sendJson(response, 200, { task_id: 'imgtask_002', status: 'success' });
            return;
        }
        if (request.url === '/v1/images/tasks/imgtask_002/result') {
            sendJson(response, 200, { data: [{ url: 'https://cdn.example.test/image.png' }] });
            return;
        }
        sendJson(response, 404, { error: 'unexpected path' });
    }, async (baseUrl) => {
        const provider = createMyVignaImageProvider({
            baseUrl, credential: 'test-server-token', allowInsecureLoopback: true, nodeEnv: 'test',
        });
        const result = await provider.query({ providerJobId: 'imgtask_002' });
        assert.deepEqual(result, {
            providerJobId: 'imgtask_002', state: 'succeeded', pollAfterMs: 0,
            result: { mediaType: 'image', resultUrl: 'https://cdn.example.test/image.png' },
        });
    });
    assert.deepEqual(calls, [
        { url: '/v1/images/tasks/imgtask_002', authorization: 'Bearer test-server-token' },
        { url: '/v1/images/tasks/imgtask_002/result', authorization: 'Bearer test-server-token' },
    ]);

    const decoded = parseResult({ data: [{ b64_json: Buffer.from('mock-image-bytes').toString('base64') }] });
    assert.equal(decoded.mediaType, 'image');
    assert.deepEqual(decoded.bytes, Buffer.from('mock-image-bytes'));
});

test('query preserves queued/running delays and returns terminal failures without creating a new task', async () => {
    await withMockServer((request, response) => {
        sendJson(response, 200, { task_id: 'imgtask_003', status: 'running', poll_after_ms: 41 });
    }, async (baseUrl) => {
        const provider = createMyVignaImageProvider({
            baseUrl, credential: 'test-server-token', allowInsecureLoopback: true, nodeEnv: 'test',
        });
        assert.deepEqual(await provider.query({ providerJobId: 'imgtask_003' }), {
            providerJobId: 'imgtask_003', state: 'running', pollAfterMs: 41, result: null,
        });
    });
});

test('malformed task URLs, unsafe result shape and non-loopback HTTP base URLs fail closed', async () => {
    await withMockServer((request, response) => {
        sendJson(response, 202, {
            task_id: 'imgtask_004', status: 'queued',
            poll_url: 'http://127.0.0.1/admin',
        });
    }, async (baseUrl) => {
        const provider = createMyVignaImageProvider({
            baseUrl, credential: 'test-server-token', allowInsecureLoopback: true, nodeEnv: 'test',
        });
        await assert.rejects(provider.submit({ idempotencyKey: 'pt_test_004', input }), (error) => {
            assert.equal(mapProviderError(error, { phase: 'submit' }).action, 'unknown_submission');
            return true;
        });
    });
    assert.throws(() => validateProviderResult(parseResult({ data: [{ url: 'http://127.0.0.1/admin' }] })), /target is not allowed/);
    assert.throws(() => createMyVignaImageProvider({ baseUrl: 'http://example.test/v1', credential: 'test-server-token' }));
});
