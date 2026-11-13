const test = require('node:test');
const assert = require('node:assert/strict');
const { ProviderError } = require('../lib/server/providers/mockProvider');
const { mapProviderError, toTaskFailureInput } = require('../lib/server/providers/providerExecution');
const { normalizeResultUrl, validateProviderResult } = require('../lib/server/providers/resultBoundary');

test('provider error mapping keeps retryable failures bounded and sanitized', () => {
    const decision = mapProviderError(
        new ProviderError('TEMPORARY_PROVIDER', 'provider secret and response body'),
        { phase: 'query', retryDelaySeconds: 5 },
    );
    assert.deepEqual(decision, {
        action: 'retry',
        errorCode: 'TEMPORARY_PROVIDER',
        retryable: true,
        retryDelaySeconds: 5,
        publicMessage: 'Provider is temporarily unavailable',
    });

    const failure = toTaskFailureInput(new ProviderError('INVALID_REQUEST', 'raw details'), { phase: 'submit' });
    assert.equal(failure.errorMessage, 'INVALID_REQUEST');
    assert.equal(failure.decision.publicMessage, 'Provider request is invalid');
    assert.doesNotMatch(failure.errorMessage, /raw details/);
});

test('unknown submit result is held for idempotent recovery instead of retrying blindly', () => {
    const decision = mapProviderError(
        new ProviderError('NETWORK_TIMEOUT', 'timeout', { submissionUnknown: true }),
        { phase: 'submit', retryDelaySeconds: 30 },
    );
    assert.deepEqual(decision, {
        action: 'unknown_submission',
        errorCode: 'NETWORK_TIMEOUT',
        retryable: false,
        retryDelaySeconds: 0,
        publicMessage: 'Provider submission result is unknown; reuse the same idempotency key before retrying',
    });
});

test('cancel and result errors are not converted into automatic task retries', () => {
    assert.equal(mapProviderError(new ProviderError('TEMPORARY_PROVIDER'), { phase: 'cancel' }).action, 'fail');
    assert.equal(mapProviderError(new ProviderError('NETWORK_TIMEOUT'), { phase: 'result' }).action, 'fail');
});

test('result boundary accepts controlled HTTPS URLs and rejects SSRF targets', () => {
    assert.equal(normalizeResultUrl('https://cdn.example.test/result.png#fragment'), 'https://cdn.example.test/result.png');
    assert.throws(() => normalizeResultUrl('http://127.0.0.1/result'), /target is not allowed/);
    assert.throws(() => normalizeResultUrl('https://example.test:8443/result'), /port is not allowed/);
    assert.throws(() => normalizeResultUrl('file:///etc/passwd'), /protocol/);
});

test('result boundary validates media, size and content source before archive', () => {
    const bytes = Buffer.from('mock-result');
    assert.deepEqual(validateProviderResult({ mediaType: 'image', bytes }), {
        mediaType: 'image',
        mimeType: null,
        sizeBytes: bytes.length,
        resultUrl: null,
        bytes,
        source: 'provider',
    });
    assert.deepEqual(validateProviderResult({
        mediaType: 'video',
        sizeBytes: 100,
        resultUrl: 'https://cdn.example.test/video.mp4',
    }), {
        mediaType: 'video',
        mimeType: null,
        sizeBytes: 100,
        resultUrl: 'https://cdn.example.test/video.mp4',
        bytes: null,
        source: 'provider',
    });
    assert.throws(() => validateProviderResult({ mediaType: 'image', sizeBytes: 101, bytes }, { maxBytes: 100 }), /exceed/);
    assert.throws(() => validateProviderResult({ mediaType: 'image' }), /URL or bytes/);
});
