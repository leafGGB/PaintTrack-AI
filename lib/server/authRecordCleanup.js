const DEFAULT_TOKEN_RETENTION_DAYS = 7;
const DEFAULT_SESSION_RETENTION_DAYS = 30;
const DEFAULT_BATCH_SIZE = 500;
const MAX_BATCH_SIZE = 5000;
const CLEANUP_LOCK_ID = 724196232;

function assertInteger(value, name, min, max) {
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new TypeError(`${name} must be an integer between ${min} and ${max}`);
    }
}

function createAuthRecordCleanupService({ pool, sink = console }) {
    if (!pool || typeof pool.connect !== 'function') throw new TypeError('pool is required');

    async function countCandidates(client, tokenRetentionDays, sessionRetentionDays) {
        const result = await client.query(
            `SELECT
                (SELECT count(*)::integer FROM email_verification_tokens
                 WHERE (consumed_at IS NOT NULL AND consumed_at <= now() - ($1::text || ' days')::interval)
                    OR (consumed_at IS NULL AND expires_at <= now() - ($1::text || ' days')::interval)) AS email_verification_tokens,
                (SELECT count(*)::integer FROM password_reset_tokens
                 WHERE (consumed_at IS NOT NULL AND consumed_at <= now() - ($1::text || ' days')::interval)
                    OR (consumed_at IS NULL AND expires_at <= now() - ($1::text || ' days')::interval)) AS password_reset_tokens,
                (SELECT count(*)::integer FROM auth_sessions
                 WHERE (revoked_at IS NOT NULL AND revoked_at <= now() - ($2::text || ' days')::interval)
                    OR (revoked_at IS NULL AND expires_at <= now() - ($2::text || ' days')::interval)) AS auth_sessions`,
            [tokenRetentionDays, sessionRetentionDays],
        );
        return result.rows[0];
    }

    async function cleanup({
        dryRun = true,
        tokenRetentionDays = DEFAULT_TOKEN_RETENTION_DAYS,
        sessionRetentionDays = DEFAULT_SESSION_RETENTION_DAYS,
        batchSize = DEFAULT_BATCH_SIZE,
        maxBatches = 10,
    } = {}) {
        if (typeof dryRun !== 'boolean') throw new TypeError('dryRun must be a boolean');
        assertInteger(tokenRetentionDays, 'tokenRetentionDays', 1, 3650);
        assertInteger(sessionRetentionDays, 'sessionRetentionDays', 1, 3650);
        assertInteger(batchSize, 'batchSize', 1, MAX_BATCH_SIZE);
        assertInteger(maxBatches, 'maxBatches', 1, 1000);

        const client = await pool.connect();
        let transactionOpen = false;
        try {
            await client.query('BEGIN');
            transactionOpen = true;
            await client.query("SET LOCAL statement_timeout = '30s'");
            await client.query('SELECT pg_advisory_xact_lock($1)', [CLEANUP_LOCK_ID]);
            const candidates = await countCandidates(client, tokenRetentionDays, sessionRetentionDays);
            const summary = {
                dryRun,
                retentionDays: { tokens: tokenRetentionDays, sessions: sessionRetentionDays },
                candidates: {
                    emailVerificationTokens: candidates.email_verification_tokens,
                    passwordResetTokens: candidates.password_reset_tokens,
                    authSessions: candidates.auth_sessions,
                },
                deleted: { emailVerificationTokens: 0, passwordResetTokens: 0, authSessions: 0 },
                batches: 0,
                truncated: false,
            };

            if (!dryRun) {
                const targets = [
                    ['emailVerificationTokens', 'email_verification_tokens', 'consumed_at', tokenRetentionDays],
                    ['passwordResetTokens', 'password_reset_tokens', 'consumed_at', tokenRetentionDays],
                    ['authSessions', 'auth_sessions', 'revoked_at', sessionRetentionDays],
                ];
                for (const [key, table, terminalColumn, retentionDays] of targets) {
                    for (let batch = 0; batch < maxBatches; batch += 1) {
                        const result = await client.query(
                            `WITH candidates AS (
                                SELECT id FROM ${table}
                                WHERE (${terminalColumn} IS NOT NULL AND ${terminalColumn} <= now() - ($1::text || ' days')::interval)
                                   OR (${terminalColumn} IS NULL AND expires_at <= now() - ($1::text || ' days')::interval)
                                ORDER BY COALESCE(${terminalColumn}, expires_at), id
                                FOR UPDATE SKIP LOCKED
                                LIMIT $2
                             )
                             DELETE FROM ${table} AS target
                             USING candidates
                             WHERE target.id = candidates.id
                             RETURNING target.id`,
                            [retentionDays, batchSize],
                        );
                        summary.deleted[key] += result.rowCount;
                        summary.batches += 1;
                        if (result.rowCount < batchSize) break;
                        if (batch === maxBatches - 1) summary.truncated = true;
                    }
                }
            }

            await client.query('COMMIT');
            transactionOpen = false;
            if (sink && typeof sink.info === 'function') {
                sink.info({
                    action: 'auth_record_cleanup',
                    outcome: dryRun ? 'dry_run' : 'completed',
                    ...summary,
                });
            }
            return summary;
        } catch (error) {
            if (transactionOpen) await client.query('ROLLBACK').catch(() => {});
            if (sink && typeof sink.error === 'function') {
                sink.error({ action: 'auth_record_cleanup', outcome: 'failed', errorCode: /^[0-9A-Z]{5}$/.test(error.code || '') ? error.code : 'INTERNAL' });
            }
            throw error;
        } finally {
            client.release();
        }
    }

    return { cleanup };
}

module.exports = {
    CLEANUP_LOCK_ID,
    DEFAULT_BATCH_SIZE,
    DEFAULT_SESSION_RETENTION_DAYS,
    DEFAULT_TOKEN_RETENTION_DAYS,
    MAX_BATCH_SIZE,
    createAuthRecordCleanupService,
};
