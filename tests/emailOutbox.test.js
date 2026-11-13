const test = require('node:test');
const assert = require('node:assert/strict');
const { enqueueEmailOutbox, validateRequest } = require('../lib/server/emailOutbox');

const valid = {
    idempotencyKey: 'registration:user-1:token-1',
    kind: 'verification',
    recipientEmail: 'user@example.test',
    payloadCiphertext: 'Y2lwaGVydGV4dA',
    payloadNonce: 'bm9uY2U',
    payloadTag: 'dGFn',
};

function tx(rows = [{ id: 'outbox-1', status: 'queued', created_at: 'now' }]) {
    const calls = [];
    return { calls, async execute(query) { calls.push(query); return { rows }; } };
}

test('outbox request accepts only supported kinds and encoded ciphertext fields', () => {
    validateRequest(valid);
    for (const [field, value] of [
        ['kind', 'newsletter'],
        ['payloadCiphertext', 'token with spaces'],
        ['payloadNonce', 'nonce/with/slash'],
        ['payloadTag', 'tag='],
    ]) {
        assert.throws(() => validateRequest({ ...valid, [field]: value }), /invalid/);
    }
});

test('enqueue inserts encrypted payload metadata and returns the new row', async () => {
    const database = tx();
    const result = await enqueueEmailOutbox(database, valid);
    assert.deepEqual(result, { id: 'outbox-1', status: 'queued', created_at: 'now' });
    assert.equal(database.calls.length, 1);
    assert.ok(Array.isArray(database.calls[0].queryChunks));
    assert.ok(database.calls[0].queryChunks.length > 0);
});

test('duplicate idempotency key is a no-op', async () => {
    const database = tx([]);
    assert.equal(await enqueueEmailOutbox(database, valid), null);
});

test('database errors propagate for transaction rollback', async () => {
    const database = { async execute() { throw new Error('db failure'); } };
    await assert.rejects(enqueueEmailOutbox(database, valid), /db failure/);
});
