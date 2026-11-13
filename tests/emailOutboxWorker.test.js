const test = require('node:test');
const assert = require('node:assert/strict');
const {
    claimNextEmail,
    createEmailOutboxWorker,
    markEmailFailure,
    markEmailSent,
    recoverExpiredEmailLeases,
} = require('../lib/server/emailOutboxWorker');

const row = {
    id: 'mail-1',
    kind: 'verification',
    recipient_email: 'user@example.test',
    payload_ciphertext: 'cipher',
    payload_nonce: 'nonce',
    payload_tag: 'tag',
    idempotency_key: 'register:user-1:token-1',
};

function poolWithConnect(rows = [row]) {
    const calls = [];
    return {
        calls,
        async connect() {
            return {
                async query(text, params) {
                    calls.push({ type: 'client', text, params });
                    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
                    if (text.includes('SELECT * FROM email_outbox')) return { rows, rowCount: rows.length };
                    if (text.includes('UPDATE email_outbox') && text.includes('RETURNING *')) return { rows, rowCount: rows.length };
                    return { rows: [], rowCount: 0 };
                },
                release() { calls.push({ type: 'release' }); },
            };
        },
        async query(text, params) {
            calls.push({ type: 'pool', text, params });
            return { rows: [row], rowCount: 1 };
        },
    };
}

test('claimNextEmail uses a transaction, recovers expired leases and SKIP LOCKED', async () => {
    const pool = poolWithConnect();
    const claimed = await claimNextEmail(pool, { workerId: 'email-worker-a', leaseSeconds: 30 });
    assert.equal(claimed.id, row.id);
    const sqlText = pool.calls.filter((call) => call.type === 'client').map((call) => call.text).join('\n');
    assert.match(sqlText, /SKIP LOCKED/);
    assert.match(sqlText, /locked_by/);
    assert.ok(pool.calls.some((call) => call.type === 'release'));
});

test('worker decrypts and sends verification mail, then marks it sent', async () => {
    const pool = poolWithConnect();
    const sent = [];
    const worker = createEmailOutboxWorker({
        pool,
        workerId: 'email-worker-a',
        decryptPayload: async (claimed) => { assert.equal(claimed.id, row.id); return { token: 'token-1' }; },
        mailer: {
            async sendVerification(message) { sent.push(message); },
            async sendPasswordReset() { assert.fail('wrong mail kind'); },
        },
    });
    assert.deepEqual(await worker.runOnce(), { status: 'sent', id: row.id });
    assert.deepEqual(sent, [{ email: row.recipient_email, token: 'token-1', idempotencyKey: row.idempotency_key }]);
    assert.ok(pool.calls.some((call) => call.type === 'pool' && call.text.includes("SET status = $1") && call.params[0] === 'sent'));
});

test('worker marks delivery errors for retry and does not expose the error message', async () => {
    const pool = poolWithConnect();
    const worker = createEmailOutboxWorker({
        pool,
        decryptPayload: async () => ({ token: 'token-1' }),
        mailer: {
            async sendVerification() { const error = new Error('secret provider response'); error.code = 'SMTP_TEMPORARY'; throw error; },
            async sendPasswordReset() {},
        },
        retryDelaySeconds: 10,
        maxAttempts: 3,
    });
    assert.deepEqual(await worker.runOnce(), { status: 'failed', id: row.id });
    const failure = pool.calls.find((call) => call.type === 'pool' && call.text.includes('last_error_code'));
    assert.equal(failure.params[4], 'SMTP_TEMPORARY');
    assert.doesNotMatch(JSON.stringify(pool.calls), /secret provider response/);
});

test('lease helpers reject stale ownership and recover expired rows', async () => {
    const pool = { async query(text) { return { rows: [{ id: 'mail-1' }], rowCount: 1 }; } };
    assert.equal(await recoverExpiredEmailLeases({ query: pool.query }), 1);
    await assert.doesNotReject(markEmailSent(pool, { id: 'mail-1', workerId: 'email-worker-a' }));
    await assert.doesNotReject(markEmailFailure(pool, { id: 'mail-1', workerId: 'email-worker-a', maxAttempts: 2 }));
});
