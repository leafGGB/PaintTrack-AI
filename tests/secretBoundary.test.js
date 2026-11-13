'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = require('node:test');
const { createSyntheticSecretBoundary } = require('../lib/server/providers/secretBoundary');
const reference = Object.freeze({ providerInstanceId: 'synthetic-provider', credentialRef: 'synthetic-key', credentialVersion: 1 });
const secret = 'synthetic-only-secret-not-a-real-provider-key';
const options = () => ({ principal: 'worker', entries: [{ reference, value: secret }], allowed: [reference] });
const denied = (code) => (error) => {
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.ok(!JSON.stringify(error).includes(secret));
    assert.ok(!error.stack.includes(secret));
    return true;
};

test('authorized independent secret process resolves only exact instance/ref/version and supports concurrent requests', async () => {
    const boundary = await createSyntheticSecretBoundary(options());
    try {
        assert.deepEqual(await Promise.all([boundary.resolve(reference), boundary.resolve(reference)]), [secret, secret]);
        for (const patch of [{ providerInstanceId: 'other' }, { credentialRef: 'other' }, { credentialVersion: 2 }]) {
            await assert.rejects(boundary.resolve({ ...reference, ...patch }), denied('SECRET_ACCESS_DENIED'));
        }
    } finally { await boundary.close(); }
});

test('web channel cannot acquire a secret even with matching references and a seeded value', async () => {
    const boundary = await createSyntheticSecretBoundary({ ...options(), principal: 'web' });
    try {
        await assert.rejects(boundary.resolve(reference), denied('SECRET_ACCESS_DENIED'));
        await assert.rejects(boundary.resolve({ ...reference, role: 'worker' }), denied('SECRET_REQUEST_REJECTED'));
        await assert.rejects(boundary.revoke(reference), denied('SECRET_ACCESS_DENIED'));
    } finally { await boundary.close(); }
});

test('revocation is permanent for a version and never selects a different version or environment fallback', async () => {
    const next = { ...reference, credentialVersion: 2 };
    const boundary = await createSyntheticSecretBoundary({ ...options(),
        entries: [{ reference, value: secret }, { reference: next, value: 'synthetic-version-two' }], allowed: [reference, next] });
    try {
        await boundary.revoke(reference);
        await assert.rejects(boundary.resolve(reference), denied('SECRET_VERSION_REVOKED'));
        assert.equal(await boundary.resolve(next), 'synthetic-version-two');
        await boundary.revoke(reference);
        await assert.rejects(boundary.resolve(reference), denied('SECRET_VERSION_REVOKED'));
    } finally { await boundary.close(); }
});

test('authorized but missing version fails closed despite inherited credential environment', async () => {
    const old = process.env.PAINTTRACK_PROVIDER_CREDENTIAL;
    process.env.PAINTTRACK_PROVIDER_CREDENTIAL = secret;
    let boundary;
    try {
        boundary = await createSyntheticSecretBoundary({ ...options(), entries: [] });
        await assert.rejects(boundary.resolve(reference), denied('SECRET_NOT_FOUND'));
    } finally {
        if (boundary) await boundary.close();
        if (old === undefined) delete process.env.PAINTTRACK_PROVIDER_CREDENTIAL;
        else process.env.PAINTTRACK_PROVIDER_CREDENTIAL = old;
    }
});

test('invalid payloads, oversized seeds, duplicate references and invalid options produce sanitized errors', async () => {
    for (const bad of [
        { ...options(), principal: 'admin' },
        { ...options(), timeoutMs: 0 },
        { ...options(), maxPending: 0 },
        { ...options(), entries: [{ reference, value: secret.repeat(200) }] },
        { ...options(), entries: [...options().entries, ...options().entries] },
        { ...options(), entries: Array.from({ length: 32 }, (_, i) => ({ reference: { ...reference, credentialVersion: i + 1 }, value: 'x'.repeat(4096) })) },
    ]) await assert.rejects(createSyntheticSecretBoundary(bad), denied('SECRET_INITIALIZATION_REJECTED'));
    const boundary = await createSyntheticSecretBoundary(options());
    try {
        for (const value of [null, {}, { ...reference, credentialVersion: '1' }, { ...reference, credentialRef: '../key' }, { ...reference, role: 'worker' }]) {
            await assert.rejects(boundary.resolve(value), denied('SECRET_REQUEST_REJECTED'));
        }
    } finally { await boundary.close(); }
});

test('pending request bound is enforced and service close rejects outstanding and subsequent requests', async () => {
    const boundary = await createSyntheticSecretBoundary({ ...options(), maxPending: 1 });
    const pending = boundary.resolve(reference);
    const pendingCheck = assert.rejects(pending, denied('SECRET_SERVICE_UNAVAILABLE'));
    await assert.rejects(boundary.resolve(reference), denied('SECRET_REQUEST_LIMIT'));
    await boundary.close();
    await pendingCheck;
    await assert.rejects(boundary.resolve(reference), denied('SECRET_SERVICE_UNAVAILABLE'));
    await boundary.close();
});

test('request timeout rejects without fallback and late replies cannot poison the next request', async () => {
    const boundary = await createSyntheticSecretBoundary(options());
    try {
        mock.timers.enable({ apis: ['setTimeout'] });
        const checked = assert.rejects(boundary.resolve(reference), denied('SECRET_SERVICE_TIMEOUT'));
        mock.timers.tick(1001);
        await checked;
        mock.timers.reset();
        assert.equal(await boundary.resolve(reference), secret);
    } finally {
        mock.timers.reset();
        await boundary.close();
    }
});

test('startup timeout is deterministic and rejects without exposing a seed', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
        const started = createSyntheticSecretBoundary({ ...options(), timeoutMs: 100 });
        const checked = assert.rejects(started, denied('SECRET_SERVICE_TIMEOUT'));
        mock.timers.tick(101);
        await checked;
    } finally { mock.timers.reset(); }
});
