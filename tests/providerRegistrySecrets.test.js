'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveWorkerProviderWithSecrets: resolve } = require('../lib/server/providers/providerRegistry');
const { createSyntheticSecretBoundary } = require('../lib/server/providers/secretBoundary');
const { createMyVignaImageProvider } = require('../lib/server/providers/myvignaImageProvider');
const binding = Object.freeze({ providerInstanceId: 'synthetic-instance', credentialRef: 'synthetic-ref',
    credentialVersion: 1, adapterType: 'myvigna-image', baseUrl: 'https://provider.example.test/v1', upstreamModel: 'gpt-image-2' });
const reference = { providerInstanceId: binding.providerInstanceId, credentialRef: binding.credentialRef, credentialVersion: 1 };
const secret = 'synthetic-registry-token';
const options = () => ({ descriptor: { ...binding }, approvedBindings: [{ ...binding }] });
const errorCode = (code) => (error) => {
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.ok(!error.stack.includes(secret));
    assert.ok(!JSON.stringify(error).includes(secret));
    return true;
};

test('IPC resolver to actual adapter reaches injected in-memory transport with only synthetic Authorization', async () => {
    const boundary = await createSyntheticSecretBoundary({ principal: 'worker', entries: [{ reference, value: secret }], allowed: [reference] });
    let requests = 0;
    try {
        const provider = await resolve({ ...options(), secretResolver: boundary.resolve,
            adapterFactory: (configuration) => createMyVignaImageProvider({ ...configuration, fetchImpl: async (url, request) => {
                requests++;
                assert.equal(String(url), `${binding.baseUrl}/images/tasks`);
                assert.equal(request.headers.Authorization, `Bearer ${secret}`);
                assert.equal(request.redirect, 'error');
                assert.ok(!request.body.includes(secret));
                return new Response(JSON.stringify({ task_id: 'synthetic-job', status: 'queued' }), { status: 202,
                    headers: { 'content-type': 'application/json' } });
            } }),
        });
        const result = await provider.submit({ idempotencyKey: 'synthetic-idempotency',
            input: { logicalModelId: 'gpt-image-2', prompt: 'synthetic', size: '1024x1024' } });
        assert.equal(result.providerJobId, 'synthetic-job');
        assert.equal(requests, 1);
        assert.ok(!JSON.stringify(result).includes(secret));
        assert.ok(!JSON.stringify(provider).includes(secret));
    } finally { await boundary.close(); }
});

test('显式 resolver 缺失或失败不读取 env；成功时只把解析结果交给 Adapter', async () => {
    const legacySecret = 'synthetic-retired-env-not-resolver-secret';
    const original = process.env;
    const previous = original.PAINTTRACK_PROVIDER_CREDENTIAL;
    original.PAINTTRACK_PROVIDER_CREDENTIAL = legacySecret;
    let reads = 0;
    let constructions = 0;
    process.env = new Proxy(original, {
        get(target, key) {
            if (key === 'PAINTTRACK_PROVIDER_CREDENTIAL') { reads++; throw new Error(legacySecret); }
            return Reflect.get(target, key);
        },
    });
    const marker = { name: 'explicit-resolver-provider' };
    const adapterFactory = (configuration) => {
        constructions++;
        assert.equal(configuration.credential, secret);
        assert.equal(configuration.baseUrl, binding.baseUrl);
        assert.equal(configuration.upstreamModel, binding.upstreamModel);
        return marker;
    };
    const safeError = (code) => (error) => {
        errorCode(code)(error);
        assert.ok(!error.stack.includes(legacySecret));
        assert.ok(!JSON.stringify(error).includes(legacySecret));
        return true;
    };
    try {
        await assert.rejects(resolve({ ...options(), adapterFactory }), safeError('PROVIDER_SECRET_RESOLVER_REQUIRED'));
        await assert.rejects(resolve({ ...options(), adapterFactory, secretResolver: async () => {
            throw Object.assign(new Error(legacySecret), { cause: new Error(legacySecret) });
        } }), safeError('PROVIDER_SECRET_UNAVAILABLE'));
        assert.equal(constructions, 0);
        let resolutions = 0;
        assert.equal(await resolve({ ...options(), adapterFactory, secretResolver: async (requested) => {
            resolutions++;
            assert.deepEqual(requested, reference);
            return secret;
        } }), marker);
        assert.equal(resolutions, 1);
        assert.equal(constructions, 1);
        assert.equal(reads, 0);
        assert.ok(!JSON.stringify(marker).includes(secret));
        assert.ok(!JSON.stringify(marker).includes(legacySecret));
    } finally {
        process.env = original;
        if (previous === undefined) delete original.PAINTTRACK_PROVIDER_CREDENTIAL;
        else original.PAINTTRACK_PROVIDER_CREDENTIAL = previous;
    }
});

test('unapproved identity version adapter model or destination is rejected before secret access', async () => {
    let reads = 0;
    for (const patch of [{ providerInstanceId: 'other' }, { credentialRef: 'other' }, { credentialVersion: 2 },
        { adapterType: 'other' }, { upstreamModel: 'other' }, { baseUrl: 'https://attacker.example.test/v1' },
        { baseUrl: 'http://127.0.0.1/v1' }, { baseUrl: 'https://provider.example.test/v1?token=x' }, { role: 'worker' }]) {
        await assert.rejects(resolve({ ...options(), descriptor: { ...binding, ...patch },
            secretResolver: async () => { reads++; return secret; } }));
    }
    assert.equal(reads, 0);
});

test('resolver and adapter errors are reduced to stable codes without secret causes', async () => {
    await assert.rejects(resolve({ ...options(), secretResolver: async () => {
        throw Object.assign(new Error(secret), { code: secret, cause: new Error(secret) });
    } }), errorCode('PROVIDER_SECRET_UNAVAILABLE'));
    await assert.rejects(resolve({ ...options(), secretResolver: async () => secret,
        adapterFactory: () => { throw new Error(secret); } }), errorCode('PROVIDER_CONFIG_INVALID'));
    for (const value of [null, '', ' ', 'x\r\nAuthorization: injected', 'x'.repeat(4097)]) {
        await assert.rejects(resolve({ ...options(), secretResolver: async () => value }), errorCode('PROVIDER_SECRET_INVALID'));
    }
});

test('descriptor mutation during secret lookup cannot redirect the credential', async () => {
    const descriptor = { ...binding };
    const provider = await resolve({ ...options(), descriptor, secretResolver: async () => {
        descriptor.baseUrl = 'https://attacker.example.test/v1';
        descriptor.upstreamModel = 'other';
        return secret;
    }, adapterFactory: (configuration) => configuration });
    assert.equal(provider.baseUrl, binding.baseUrl);
    assert.equal(provider.upstreamModel, binding.upstreamModel);
});

test('web denied and revoked IPC secrets prevent adapter construction', async () => {
    for (const principal of ['web', 'worker']) {
        const boundary = await createSyntheticSecretBoundary({ principal, entries: [{ reference, value: secret }], allowed: [reference] });
        let constructions = 0;
        try {
            if (principal === 'worker') await boundary.revoke(reference);
            await assert.rejects(resolve({ ...options(), secretResolver: boundary.resolve,
                adapterFactory: () => { constructions++; } }), errorCode('PROVIDER_SECRET_UNAVAILABLE'));
            assert.equal(constructions, 0);
        } finally { await boundary.close(); }
    }
});
