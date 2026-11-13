const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { createAuthRecordCleanupService } = require('../../lib/server/authRecordCleanup');

const TOKEN_HASH = () => randomBytes(32).toString('hex');

async function checkAuthRecordCleanup(pool, record) {
    const userId = randomUUID();
    const verificationUserId = randomUUID();
    const email = `cleanup-${randomBytes(6).toString('hex')}@example.test`;
    const verificationEmail = `cleanup-verification-${randomBytes(6).toString('hex')}@example.test`;
    const passwordHash = `scrypt:32768:8:3:${randomBytes(16).toString('hex')}:${randomBytes(64).toString('hex')}`;
    await pool.query(
        'INSERT INTO users (id, email, password_hash, email_verified_at) VALUES ($1, $2, $3, now()), ($4, $5, $3, now())',
        [userId, email, passwordHash, verificationUserId, verificationEmail],
    );

    const oldTokenHash = TOKEN_HASH();
    const recentTokenHash = TOKEN_HASH();
    const oldResetHash = TOKEN_HASH();
    const recentResetHash = TOKEN_HASH();
    const oldSessionHash = TOKEN_HASH();
    const recentRevokedSessionHash = TOKEN_HASH();
    const activeSessionHash = TOKEN_HASH();

    await pool.query(
        `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at, consumed_at, created_at)
         VALUES
            ($1, $2, now() - interval '8 days', NULL, now() - interval '9 days'),
            ($3, $4, now() - interval '1 day', NULL, now() - interval '2 days')`,
        [userId, oldTokenHash, verificationUserId, recentTokenHash],
    );
    await pool.query(
        `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, consumed_at, created_at)
         VALUES
            ($1, $2, now() - interval '10 days', now() - interval '8 days', now() - interval '11 days'),
            ($1, $3, now() + interval '20 minutes', NULL, now())`,
        [userId, oldResetHash, recentResetHash],
    );
    await pool.query(
        `INSERT INTO auth_sessions (user_id, token_hash, expires_at, revoked_at, created_at)
         VALUES
            ($1, $2, now() - interval '40 days', NULL, now() - interval '41 days'),
            ($1, $3, now() + interval '1 hour', now() - interval '2 days', now() - interval '5 days'),
            ($1, $4, now() + interval '1 hour', NULL, now())`,
        [userId, oldSessionHash, recentRevokedSessionHash, activeSessionHash],
    );

    const service = createAuthRecordCleanupService({ pool, sink: { info() {}, error() {} } });
    const dryRun = await service.cleanup();
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.candidates.emailVerificationTokens, 1);
    assert.equal(dryRun.candidates.passwordResetTokens, 1);
    assert.equal(dryRun.candidates.authSessions, 1);
    const dryRunRows = await pool.query(
        `SELECT
            (SELECT count(*)::integer FROM email_verification_tokens WHERE token_hash = $1) AS old_email_token,
            (SELECT count(*)::integer FROM password_reset_tokens WHERE token_hash = $2) AS old_reset_token,
            (SELECT count(*)::integer FROM auth_sessions WHERE token_hash = $3) AS old_session`,
        [oldTokenHash, oldResetHash, oldSessionHash],
    );
    assert.deepEqual(dryRunRows.rows[0], { old_email_token: 1, old_reset_token: 1, old_session: 1 });

    const applied = await service.cleanup({ dryRun: false, batchSize: 1, maxBatches: 2 });
    assert.deepEqual(applied.deleted, { emailVerificationTokens: 1, passwordResetTokens: 1, authSessions: 1 });
    const retainedRows = await pool.query(
        `SELECT
            (SELECT count(*)::integer FROM email_verification_tokens WHERE token_hash = $1) AS recent_email_token,
            (SELECT count(*)::integer FROM password_reset_tokens WHERE token_hash = $2) AS active_reset_token,
            (SELECT count(*)::integer FROM auth_sessions WHERE token_hash = $3) AS recently_revoked_session,
            (SELECT count(*)::integer FROM auth_sessions WHERE token_hash = $4) AS active_session`,
        [recentTokenHash, recentResetHash, recentRevokedSessionHash, activeSessionHash],
    );
    assert.deepEqual(retainedRows.rows[0], {
        recent_email_token: 1,
        active_reset_token: 1,
        recently_revoked_session: 1,
        active_session: 1,
    });

    const beforeConcurrent = await pool.query('SELECT count(*)::integer AS count FROM password_reset_tokens WHERE token_hash = $1', [recentResetHash]);
    assert.equal(beforeConcurrent.rows[0].count, 1);
    const concurrent = await Promise.all([
        service.cleanup({ dryRun: false, tokenRetentionDays: 1, sessionRetentionDays: 1, batchSize: 1, maxBatches: 1 }),
        service.cleanup({ dryRun: false, tokenRetentionDays: 1, sessionRetentionDays: 1, batchSize: 1, maxBatches: 1 }),
    ]);
    assert.equal(concurrent.reduce((sum, item) => sum + item.deleted.emailVerificationTokens, 0), 1);
    assert.equal(concurrent.reduce((sum, item) => sum + item.deleted.authSessions, 0), 1);
    const afterConcurrent = await pool.query(
        `SELECT
            (SELECT count(*)::integer FROM password_reset_tokens WHERE token_hash = $1) AS active_reset,
            (SELECT count(*)::integer FROM auth_sessions WHERE token_hash = $2) AS active_session`,
        [recentResetHash, activeSessionHash],
    );
    assert.deepEqual(afterConcurrent.rows[0], { active_reset: 1, active_session: 1 });

    record('认证记录清理 dry-run 只报告不删除；按数据库时钟和保留期删除过期/已撤销数据，保留有效 token/session；并发互斥及批次上限通过', 'passed');
}

module.exports = { checkAuthRecordCleanup };
