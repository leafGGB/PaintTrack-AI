const { sql } = require('drizzle-orm');

const KINDS = new Set(['verification', 'password-reset']);
const B64URL = /^[A-Za-z0-9_-]+$/;

function assertText(value, name, { max = 512, pattern } = {}) {
    if (typeof value !== 'string' || value.length === 0 || value.length > max || (pattern && !pattern.test(value))) {
        throw new TypeError(`${name} is invalid`);
    }
}

function validateRequest({ idempotencyKey, kind, recipientEmail, payloadCiphertext, payloadNonce, payloadTag }) {
    assertText(idempotencyKey, 'idempotencyKey', { max: 256 });
    if (!KINDS.has(kind)) throw new TypeError('kind is invalid');
    assertText(recipientEmail, 'recipientEmail', { max: 254 });
    assertText(payloadCiphertext, 'payloadCiphertext', { max: 1024 * 1024, pattern: B64URL });
    assertText(payloadNonce, 'payloadNonce', { max: 64, pattern: B64URL });
    assertText(payloadTag, 'payloadTag', { max: 64, pattern: B64URL });
}

async function enqueueEmailOutbox(tx, request) {
    if (!tx || typeof tx.execute !== 'function') throw new TypeError('transaction is required');
    validateRequest(request);
    const result = await tx.execute(sql`
        INSERT INTO email_outbox (
            idempotency_key, kind, recipient_email,
            payload_ciphertext, payload_nonce, payload_tag
        ) VALUES (
            ${request.idempotencyKey}, ${request.kind}, ${request.recipientEmail},
            ${request.payloadCiphertext}, ${request.payloadNonce}, ${request.payloadTag}
        )
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING id, status, created_at
    `);
    return result.rows[0] || null;
}

module.exports = { enqueueEmailOutbox, validateRequest };
