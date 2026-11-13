const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { claimNextEmail, markEmailFailure, markEmailSent } = require('../../lib/server/emailOutboxWorker');

const encoded = () => randomBytes(12).toString('base64url');

async function insert(pool, overrides = {}) {
    const key = `fixture:${randomBytes(8).toString('hex')}`;
    const result = await pool.query(
        `INSERT INTO email_outbox
            (idempotency_key, kind, recipient_email, payload_ciphertext, payload_nonce, payload_tag)
         VALUES ($1, 'verification', 'worker@example.test', $2, $3, $4)
         RETURNING id`,
        [overrides.idempotencyKey || key, encoded(), encoded(), encoded()],
    );
    return result.rows[0].id;
}

async function checkEmailOutboxWorker(pool, record, { owner }) {
    // INSERT RETURNING 需要读回权限；夹具由 migration 创建，邮件执行使用 Worker。
    const concurrentId = await insert(owner);
    const [first, second] = await Promise.all([
        claimNextEmail(pool, { workerId: 'fixture-worker-a', leaseSeconds: 30 }),
        claimNextEmail(pool, { workerId: 'fixture-worker-b', leaseSeconds: 30 }),
    ]);
    const claimed = [first, second].filter(Boolean);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].id, concurrentId);
    await markEmailSent(pool, { id: concurrentId, workerId: claimed[0].locked_by });

    const recoverId = await insert(owner);
    await pool.query(
        `UPDATE email_outbox SET status='processing', locked_at=now() - interval '1 minute', locked_by='dead-worker' WHERE id=$1`,
        [recoverId],
    );
    const recovered = await claimNextEmail(pool, { workerId: 'recovery-worker', leaseSeconds: 30 });
    assert.equal(recovered.id, recoverId);
    assert.equal(recovered.locked_by, 'recovery-worker');
    await markEmailFailure(pool, { id: recoverId, workerId: 'recovery-worker', retryDelaySeconds: 0, maxAttempts: 2 });
    const retry = await claimNextEmail(pool, { workerId: 'retry-worker', leaseSeconds: 30 });
    assert.equal(retry.id, recoverId);
    await markEmailFailure(pool, { id: recoverId, workerId: 'retry-worker', retryDelaySeconds: 0, maxAttempts: 2 });
    const terminal = await pool.query('SELECT status, attempts, locked_by, last_error_code FROM email_outbox WHERE id=$1', [recoverId]);
    assert.deepEqual(terminal.rows[0], { status: 'failed', attempts: 2, locked_by: null, last_error_code: 'DELIVERY_FAILED' });

    record('email outbox worker并发领取互斥、过期租约恢复、失败重试及上限状态通过', 'passed');
}

module.exports = { checkEmailOutboxWorker };
