const test = require('node:test');
const assert = require('node:assert/strict');
const {
    ProviderError,
    createMockProvider,
} = require('../lib/server/providers/mockProvider');

function request(inputOverrides = {}, requestOverrides = {}) {
    return {
        taskId: 'task-1',
        idempotencyKey: 'task-1-attempt-1',
        input: { model: 'mock-image', ...inputOverrides },
        ...requestOverrides,
    };
}

test('mock provider exposes capabilities and completes synchronous jobs', async () => {
    const provider = createMockProvider();

    assert.deepEqual(provider.capabilities, {
        modes: ['sync', 'async'],
        mediaTypes: ['image', 'video'],
        operations: { submit: true, query: true, cancel: true },
        idempotency: { submit: 'provider-key' },
    });

    const submitted = await provider.submit(request({ mock: { mode: 'sync' } }));
    assert.equal(submitted.kind, 'completed');
    assert.equal(submitted.providerState, 'succeeded');
    assert.equal(submitted.result.mediaType, 'image');
    assert.equal(submitted.result.mimeType, 'image/png');
    assert.ok(Buffer.isBuffer(submitted.result.bytes));
    assert.equal(submitted.result.bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.ok(submitted.result.bytes.length > 40);
    assert.ok(Buffer.isBuffer(provider._testing.getJob(submitted.providerJobId).result.bytes));
    assert.equal(provider._testing.jobCount(), 1);
});

test('mock provider supports asynchronous query lifecycle and submit idempotency', async () => {
    const provider = createMockProvider();
    const input = request({ mock: { mode: 'async' } });

    const accepted = await provider.submit(input);
    assert.equal(accepted.kind, 'accepted');
    assert.equal((await provider.query({ providerJobId: accepted.providerJobId })).state, 'running');
    const completed = await provider.query({ providerJobId: accepted.providerJobId });
    assert.equal(completed.state, 'succeeded');
    assert.equal(completed.result.mediaType, 'image');
    assert.ok(Buffer.isBuffer(completed.result.bytes));

    const duplicate = await provider.submit(input);
    assert.deepEqual(duplicate, accepted);
    assert.equal(provider._testing.jobCount(), 1);
});

test('mock provider handles cancellation and unsupported cancellation', async () => {
    const provider = createMockProvider();
    const accepted = await provider.submit(request({ mock: { mode: 'async' } }));
    const cancelled = await provider.cancel({ providerJobId: accepted.providerJobId });
    assert.deepEqual(cancelled, {
        providerJobId: accepted.providerJobId,
        state: 'cancelled',
    });
    assert.equal((await provider.query({ providerJobId: accepted.providerJobId })).state, 'cancelled');

    const noCancel = await provider.submit(request(
        { mock: { mode: 'async', cancelSupported: false } },
        { idempotencyKey: 'task-1-attempt-2' },
    ));
    await assert.rejects(
        provider.cancel({ providerJobId: noCancel.providerJobId }),
        (error) => error instanceof ProviderError && error.code === 'CANCEL_UNSUPPORTED' && !error.retryable,
    );
});

test('mock provider returns controlled error classifications and preserves unknown submit boundary', async () => {
    const provider = createMockProvider();
    await assert.rejects(
        provider.submit(request({ mock: { error: 'RATE_LIMITED' } })),
        (error) => error instanceof ProviderError && error.code === 'RATE_LIMITED' && error.retryable,
    );

    const unknown = await provider.submit(request(
        { mock: { mode: 'async', unknownSubmit: true } },
        { idempotencyKey: 'task-1-unknown' },
    ));
    assert.equal(unknown.kind, 'unknown');
    assert.equal(unknown.providerJobId, null);
    assert.equal(unknown.providerMetadata.recovery, 'reuse-idempotency-key');

    const recovered = await provider.submit(request(
        { mock: { mode: 'async', unknownSubmit: true } },
        { idempotencyKey: 'task-1-unknown' },
    ));
    assert.equal(recovered.kind, 'accepted');
    assert.match(recovered.providerJobId, /^mock_/);
});

test('mock provider cooperates with AbortSignal and rejects malformed requests', async () => {
    const provider = createMockProvider();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
        provider.submit(request(), { signal: controller.signal }),
        (error) => error instanceof ProviderError && error.code === 'ABORTED',
    );
    await assert.rejects(
        provider.submit({ taskId: 'task-1', input: {} }),
        (error) => error instanceof ProviderError && error.code === 'INVALID_REQUEST' && !error.retryable,
    );
});
