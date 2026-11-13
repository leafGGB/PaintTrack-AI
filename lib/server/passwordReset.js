const { randomBytes } = require('node:crypto');
const { sql } = require('drizzle-orm');
const { hashPassword } = require('./passwords');
const { tokenDigest, RegistrationError } = require('./registration');
const { emitAuditEvent } = require('./observability');

const RESET_TOKEN_SECONDS = 30 * 60;
const RESET_BUCKET = 'password-reset';
const RESET_RATE_LIMIT = 10;
const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

function validateEmail(value) {
    if (typeof value !== 'string' || value.length > 320) throw new RegistrationError('INVALID_INPUT', 400);
    const email = value.trim().toLowerCase();
    const local = email.split('@')[0];
    const domain = email.split('@')[1] || '';
    if (Buffer.byteLength(email) > 254 || !EMAIL.test(email) || local.length > 64
        || local.startsWith('.') || local.endsWith('.') || local.includes('..')
        || domain.split('.').some((label) => label.length > 63)) throw new RegistrationError('INVALID_INPUT', 400);
    return email;
}
function validateRequest(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).length !== 1 || typeof input.email !== 'string') throw new RegistrationError('INVALID_INPUT', 400);
    return { email: validateEmail(input.email) };
}
function validateConsume(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).length !== 2 || typeof input.token !== 'string' || typeof input.password !== 'string') {
        throw new RegistrationError('INVALID_INPUT', 400);
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(input.token)
        || Buffer.from(input.token, 'base64url').toString('base64url') !== input.token
        || input.password.length < 12 || Buffer.byteLength(input.password) > 128
        || /[\u0000-\u001f\u007f]/.test(input.password)) throw new RegistrationError('INVALID_INPUT', 400);
    return { token: input.token, password: input.password };
}

function createPasswordResetService({ database, mailer, sink = console }) {
    if (!database || typeof database.transaction !== 'function') throw new TypeError('需要数据库事务接口');
    if (mailer && (process.env.NODE_ENV === 'production' || mailer.kind !== 'test-memory-outbox'
        || typeof mailer.sendPasswordReset !== 'function')) throw new TypeError('仅允许非生产测试邮件注入');
    async function rateLimit() {
        const result = await database.execute(sql`
            INSERT INTO auth_rate_limits(bucket, window_start, hits) VALUES (${RESET_BUCKET}, clock_timestamp(), 1)
            ON CONFLICT (bucket) DO UPDATE SET
                hits = CASE WHEN auth_rate_limits.window_start <= clock_timestamp() - interval '1 minute'
                    THEN 1 ELSE auth_rate_limits.hits + 1 END,
                window_start = CASE WHEN auth_rate_limits.window_start <= clock_timestamp() - interval '1 minute'
                    THEN clock_timestamp() ELSE auth_rate_limits.window_start END
            WHERE auth_rate_limits.window_start <= clock_timestamp() - interval '1 minute' OR auth_rate_limits.hits < ${RESET_RATE_LIMIT}
            RETURNING hits`);
        if (!result.rows.length) throw new RegistrationError('RATE_LIMITED', 429);
    }
    return {
        async request(input, { requestId } = {}) {
            const { email } = validateRequest(input);
            if (!mailer) throw new RegistrationError('MAIL_UNAVAILABLE', 503);
            await rateLimit();
            const token = randomBytes(32).toString('base64url');
            await database.transaction(async (tx) => {
                const found = await tx.execute(sql`SELECT id FROM users WHERE email=${email} AND email_verified_at IS NOT NULL`);
                if (!found.rows.length) return;
                const userId = found.rows[0].id;
                await tx.execute(sql`UPDATE password_reset_tokens SET consumed_at=clock_timestamp()
                    WHERE user_id=${userId} AND consumed_at IS NULL`);
                await tx.execute(sql`INSERT INTO password_reset_tokens(user_id, token_hash, expires_at)
                    VALUES (${userId}, ${tokenDigest(token)}, clock_timestamp() + interval '30 minutes')`);
                await mailer.sendPasswordReset({ email, token });
            });
            emitAuditEvent({ action: 'password_reset.requested', outcome: 'accepted', requestId }, sink);
            return { status: 'accepted' };
        },
        async consume(input, { requestId } = {}) {
            const { token, password } = validateConsume(input);
            const passwordHash = await hashPassword(password);
            await database.transaction(async (tx) => {
                const consumed = await tx.execute(sql`UPDATE password_reset_tokens SET consumed_at=clock_timestamp()
                    WHERE token_hash=${tokenDigest(token)} AND consumed_at IS NULL AND expires_at > clock_timestamp()
                    RETURNING user_id`);
                if (!consumed.rows.length) throw new RegistrationError('INVALID_RESET_TOKEN', 400);
                const userId = consumed.rows[0].user_id;
                await tx.execute(sql`UPDATE users SET password_hash=${passwordHash} WHERE id=${userId}`);
                await tx.execute(sql`UPDATE auth_sessions SET revoked_at=clock_timestamp()
                    WHERE user_id=${userId} AND revoked_at IS NULL`);
            });
            emitAuditEvent({ action: 'password_reset.completed', outcome: 'accepted', requestId }, sink);
            return { status: 'accepted' };
        },
    };
}
module.exports = { createPasswordResetService, validateEmail, validateRequest, validateConsume, RESET_TOKEN_SECONDS, RESET_BUCKET };
