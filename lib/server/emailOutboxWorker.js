const OUTBOX_STATUS = Object.freeze({
    QUEUED: 'queued',
    PROCESSING: 'processing',
    SENT: 'sent',
    FAILED: 'failed',
});

function assertPositiveInteger(value, name) {
    if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
}

function assertNonNegativeInteger(value, name) {
    if (!Number.isInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer`);
}

async function withTransaction(pool, callback) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

async function recoverExpiredEmailLeases(client) {
    const result = await client.query(
        `UPDATE email_outbox
         SET status = $1, locked_at = NULL, locked_by = NULL, available_at = now(), updated_at = now()
         WHERE status = $2 AND locked_at <= now()
         RETURNING id`,
        [OUTBOX_STATUS.QUEUED, OUTBOX_STATUS.PROCESSING],
    );
    return result.rowCount;
}

async function claimNextEmail(pool, { workerId, leaseSeconds = 60 } = {}) {
    if (!pool || typeof pool.connect !== 'function') throw new TypeError('pool is required');
    if (typeof workerId !== 'string' || workerId.trim() === '') throw new TypeError('workerId is required');
    assertPositiveInteger(leaseSeconds, 'leaseSeconds');
    return withTransaction(pool, async (client) => {
        await recoverExpiredEmailLeases(client);
        const selected = await client.query(
            `SELECT * FROM email_outbox
             WHERE status = $1 AND available_at <= now()
             ORDER BY available_at ASC, created_at ASC
             FOR UPDATE SKIP LOCKED
             LIMIT 1`,
            [OUTBOX_STATUS.QUEUED],
        );
        if (!selected.rowCount) return null;
        const row = selected.rows[0];
        const updated = await client.query(
            `UPDATE email_outbox
             SET status = $1, attempts = attempts + 1,
                 locked_at = now() + ($2::text || ' seconds')::interval,
                 locked_by = $3, updated_at = now()
             WHERE id = $4 AND status = $5
             RETURNING *`,
            [OUTBOX_STATUS.PROCESSING, leaseSeconds, workerId.trim(), row.id, OUTBOX_STATUS.QUEUED],
        );
        return updated.rows[0] || null;
    });
}

async function markEmailSent(pool, { id, workerId }) {
    const result = await pool.query(
        `UPDATE email_outbox
         SET status = $1, locked_at = NULL, locked_by = NULL, sent_at = now(), last_error_code = NULL, updated_at = now()
         WHERE id = $2 AND status = $3 AND locked_by = $4
         RETURNING *`,
        [OUTBOX_STATUS.SENT, id, OUTBOX_STATUS.PROCESSING, workerId],
    );
    if (result.rowCount !== 1) throw new Error('EMAIL_LEASE_LOST');
    return result.rows[0];
}

async function markEmailFailure(pool, { id, workerId, errorCode = 'DELIVERY_FAILED', retryDelaySeconds = 60, maxAttempts = 5 }) {
    assertNonNegativeInteger(retryDelaySeconds, 'retryDelaySeconds');
    assertPositiveInteger(maxAttempts, 'maxAttempts');
    const result = await pool.query(
        `UPDATE email_outbox
         SET status = CASE WHEN attempts < $1 THEN $2 ELSE $3 END,
             available_at = CASE WHEN attempts < $1 THEN now() + ($4::text || ' seconds')::interval ELSE available_at END,
             locked_at = NULL, locked_by = NULL, last_error_code = $5, updated_at = now()
         WHERE id = $6 AND status = $7 AND locked_by = $8
         RETURNING *`,
        [maxAttempts, OUTBOX_STATUS.QUEUED, OUTBOX_STATUS.FAILED, retryDelaySeconds, String(errorCode).slice(0, 64), id, OUTBOX_STATUS.PROCESSING, workerId],
    );
    if (result.rowCount !== 1) throw new Error('EMAIL_LEASE_LOST');
    return result.rows[0];
}

function createEmailOutboxWorker({ pool, workerId = `email-worker-${process.pid}`, leaseSeconds = 60, maxAttempts = 5, retryDelaySeconds = 60, decryptPayload, mailer } = {}) {
    if (!pool) throw new TypeError('pool is required');
    if (typeof decryptPayload !== 'function') throw new TypeError('decryptPayload is required');
    if (!mailer || typeof mailer.sendVerification !== 'function' || typeof mailer.sendPasswordReset !== 'function') {
        throw new TypeError('mailer must support verification and password reset delivery');
    }
    assertPositiveInteger(maxAttempts, 'maxAttempts');
    assertNonNegativeInteger(retryDelaySeconds, 'retryDelaySeconds');
    let stopped = false;

    return {
        stop() { stopped = true; },
        async runOnce() {
            if (stopped) return { status: 'stopped' };
            const row = await claimNextEmail(pool, { workerId, leaseSeconds });
            if (!row) return { status: 'idle' };
            try {
                const payload = await decryptPayload(row);
                const send = row.kind === 'verification' ? mailer.sendVerification : mailer.sendPasswordReset;
                await send.call(mailer, { email: row.recipient_email, ...payload, idempotencyKey: row.idempotency_key });
                await markEmailSent(pool, { id: row.id, workerId });
                return { status: 'sent', id: row.id };
            } catch (error) {
                await markEmailFailure(pool, {
                    id: row.id,
                    workerId,
                    maxAttempts,
                    retryDelaySeconds,
                    errorCode: error && error.code ? error.code : 'DELIVERY_FAILED',
                });
                return { status: 'failed', id: row.id };
            }
        },
    };
}

module.exports = {
    OUTBOX_STATUS,
    claimNextEmail,
    createEmailOutboxWorker,
    markEmailFailure,
    markEmailSent,
    recoverExpiredEmailLeases,
};
