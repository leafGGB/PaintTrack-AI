const { randomBytes, createHash } = require('node:crypto');
const { hashPassword } = require('./passwords');
const { sql } = require('drizzle-orm');
const { emitAuditEvent } = require('./observability');

const ACCEPTED = Object.freeze({ status: 'accepted' });
const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
class RegistrationError extends Error {
    constructor(code, status) { super(code); this.code = code; this.status = status; }
}
function invalid() { throw new RegistrationError('INVALID_INPUT', 400); }
function validateInput(action, input) {
    const keys = action === 'register' ? ['email', 'password'] : ['token'];
    if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).length !== keys.length || keys.some((key) => !Object.hasOwn(input, key))) invalid();
    if (action !== 'register') {
        if (typeof input.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.token)) invalid();
        // 拒绝相同字节的非规范 base64url 表示。
        if (Buffer.from(input.token, 'base64url').toString('base64url') !== input.token) invalid();
        return { token: input.token };
    }
    if (typeof input.email !== 'string' || input.email.length > 320 || typeof input.password !== 'string') invalid();
    const email = input.email.trim().toLowerCase();
    const local = email.split('@')[0];
    if (Buffer.byteLength(email) > 254 || !EMAIL.test(email) || local.length > 64
        || local.startsWith('.') || local.endsWith('.') || local.includes('..')
        || email.split('@')[1].split('.').some((label) => label.length > 63)) invalid();
    if (input.password.length < 12 || Buffer.byteLength(input.password) > 128 || /[\u0000-\u001f\u007f]/.test(input.password)) invalid();
    return { email, password: input.password };
}
const tokenDigest = (token) => createHash('sha256').update(token).digest('hex');

function createRegistrationService({ database, mailer, auditSink = console }) {
    if (!database || typeof database.transaction !== 'function') throw new TypeError('需要数据库事务接口');
    // 本步骤不提供任何默认邮件发送器，也不从环境变量启用测试替身。
    if (mailer && (process.env.NODE_ENV === 'production' || mailer.kind !== 'test-memory-outbox'
        || typeof mailer.sendVerification !== 'function')) throw new TypeError('仅允许非生产测试邮件注入');
    async function rateLimit(action) {
        const result = await database.execute(sql`
            INSERT INTO auth_rate_limits(bucket, window_start, hits) VALUES (${action}, clock_timestamp(), 1)
            ON CONFLICT (bucket) DO UPDATE SET
                hits = CASE WHEN auth_rate_limits.window_start <= clock_timestamp() - interval '1 minute'
                    THEN 1 ELSE auth_rate_limits.hits + 1 END,
                window_start = CASE WHEN auth_rate_limits.window_start <= clock_timestamp() - interval '1 minute'
                    THEN clock_timestamp() ELSE auth_rate_limits.window_start END
            WHERE auth_rate_limits.window_start <= clock_timestamp() - interval '1 minute' OR auth_rate_limits.hits < 60
            RETURNING hits`);
        if (!result.rows.length) throw new RegistrationError('RATE_LIMITED', 429);
    }
    function audit(action, requestId) {
        emitAuditEvent({ action, outcome: 'accepted', requestId }, auditSink);
    }
    return {
        async register(input, { requestId } = {}) {
            const { email, password } = validateInput('register', input);
            if (!mailer) throw new RegistrationError('MAIL_UNAVAILABLE', 503);
            await rateLimit('register');
            // 所有合法注册（含重复邮箱）均执行相同成本的 KDF。
            const passwordHash = await hashPassword(password);
            const token = randomBytes(32).toString('base64url');
            await database.transaction(async (tx) => {
                const inserted = await tx.execute(sql`INSERT INTO users(email, password_hash) VALUES (${email}, ${passwordHash})
                    ON CONFLICT (email) DO NOTHING RETURNING id`);
                if (!inserted.rows.length) return;
                const userId = inserted.rows[0].id;
                await tx.execute(sql`INSERT INTO email_verification_tokens(user_id, token_hash, expires_at)
                    VALUES (${userId}, ${tokenDigest(token)}, clock_timestamp() + interval '15 minutes')`);
                // 仅测试通道；拒绝时事务回滚。真实邮件需后续持久投递协议，不能直接替换本替身。
                await mailer.sendVerification({ email, token });
            });
            audit('registration.requested', requestId);
            return ACCEPTED;
        },
        async verifyEmail(input, { requestId } = {}) {
            const { token } = validateInput('verify-email', input);
            await rateLimit('verify-email');
            await database.transaction(async (tx) => {
                const consumed = await tx.execute(sql`UPDATE email_verification_tokens SET consumed_at = clock_timestamp()
                    WHERE token_hash = ${tokenDigest(token)} AND consumed_at IS NULL AND expires_at > clock_timestamp()
                    RETURNING user_id`);
                if (consumed.rows.length) {
                    await tx.execute(sql`UPDATE users SET email_verified_at = clock_timestamp()
                        WHERE id = ${consumed.rows[0].user_id} AND email_verified_at IS NULL`);
                }
            });
            audit('email_verification.requested', requestId);
            return ACCEPTED;
        },
    };
}
module.exports = { createRegistrationService, RegistrationError, validateInput, hashPassword, tokenDigest };
