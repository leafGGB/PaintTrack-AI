const { randomBytes } = require('node:crypto');
const { sql } = require('drizzle-orm');
const { validateInput, tokenDigest, RegistrationError } = require('./registration');
const { verifyPassword } = require('./passwords');
const { emitAuditEvent } = require('./observability');
const SESSION_SECONDS = 8 * 60 * 60;
const COOKIE_NAME = 'painttrack_session';
function canonicalToken(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
        && Buffer.from(value, 'base64url').toString('base64url') === value ? value : null;
}
function sessionCookie(request) {
    const header = request.headers.get('cookie') || '';
    if (header.length > 8192) return null;
    const entries = header.split(';').map((part) => part.trim()).filter((part) => part.split('=')[0] === COOKIE_NAME);
    return entries.length === 1 ? canonicalToken(entries[0].slice(COOKIE_NAME.length + 1)) : null;
}
function cookieValue(token, secure, expiresAt) {
    return `${COOKIE_NAME}=${token || ''}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}; Max-Age=${token ? SESSION_SECONDS : 0}; Expires=${token ? toTimestamp(expiresAt).toUTCString() : 'Thu, 01 Jan 1970 00:00:00 GMT'}`;
}
// drizzle 的 raw execute 在 node-postgres 会话层把 timestamptz 解析器换成原样返回，
// 因此这里可能拿到 PostgreSQL 文本（如 "2026-11-10 16:54:51.954875+08"）而不是 Date。
// 直接外泄会让 /api/auth/me 的时间字段变成非 ISO 文本，Cookie 的 Expires 也会是 Invalid Date。
// 统一归一化成 Date：毫秒截断、时区补齐为 ±HH:MM（JS 不接受 +08 这种两位偏移）。
function toTimestamp(value) {
    if (value === null || value === undefined || value instanceof Date) return value;
    if (typeof value === 'number') return new Date(value);
    let text = String(value).trim().replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1');
    if (/\d{2}:\d{2}:\d{2}/.test(text) && !/Z$/i.test(text)) {
        text = text.replace(/([+-]\d{2})$/, '$1:00').replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
    }
    return new Date(text);
}
async function loginRateLimit(database) {
    const result = await database.execute(sql`INSERT INTO auth_rate_limits(bucket, window_start, hits)
        VALUES ('login', clock_timestamp(), 1) ON CONFLICT (bucket) DO UPDATE SET
        hits = CASE WHEN auth_rate_limits.window_start <= clock_timestamp() - interval '1 minute' THEN 1 ELSE auth_rate_limits.hits + 1 END,
        window_start = CASE WHEN auth_rate_limits.window_start <= clock_timestamp() - interval '1 minute' THEN clock_timestamp() ELSE auth_rate_limits.window_start END
        WHERE auth_rate_limits.window_start <= clock_timestamp() - interval '1 minute' OR auth_rate_limits.hits < 30 RETURNING hits`);
    if (!result.rows.length) throw new RegistrationError('RATE_LIMITED', 429);
}
function createSessionService({ database, sink = console }) {
    return {
        async login(input, { oldToken, requestId } = {}) {
            const { email, password } = validateInput('register', input);
            await loginRateLimit(database);
            const found = await database.execute(sql`SELECT id,password_hash,email_verified_at FROM users WHERE email=${email}`);
            const user = found.rows[0];
            const matches = await verifyPassword(password, user?.password_hash);
            if (!matches || !user?.email_verified_at) {
                emitAuditEvent({ action: 'session.login', outcome: 'rejected', requestId }, sink);
                throw new RegistrationError('INVALID_CREDENTIALS', 401);
            }
            const token = randomBytes(32).toString('base64url');
            const result = await database.transaction(async (tx) => {
                // 再检查用户并锁行，防止凭据或验证状态在 KDF 期间改变。
                const current = await tx.execute(sql`SELECT u.id,COALESCE(to_jsonb(u)->>'role','user') AS role FROM users u WHERE id=${user.id}
                    AND password_hash=${user.password_hash} AND email_verified_at IS NOT NULL FOR SHARE`);
                if (!current.rows.length) throw new RegistrationError('INVALID_CREDENTIALS', 401);
                if (canonicalToken(oldToken)) await tx.execute(sql`UPDATE auth_sessions SET revoked_at=clock_timestamp()
                    WHERE token_hash=${tokenDigest(oldToken)} AND revoked_at IS NULL`);
                const inserted = await tx.execute(sql`INSERT INTO auth_sessions(user_id,token_hash,expires_at)
                    VALUES (${user.id},${tokenDigest(token)},clock_timestamp()+interval '8 hours') RETURNING expires_at`);
                return { user: { id: current.rows[0].id, role: current.rows[0].role }, expiresAt: toTimestamp(inserted.rows[0].expires_at) };
            });
            emitAuditEvent({ action: 'session.login', outcome: 'accepted', requestId }, sink);
            return { ...result, token };
        },
        async me(token) {
            if (!canonicalToken(token)) return { user: null };
            const result = await database.execute(sql`SELECT u.id,u.email,u.created_at,u.email_verified_at,
                COALESCE(to_jsonb(u)->>'role','user') AS role,s.auth_level,s.mfa_verified_at,s.step_up_verified_at
                FROM auth_sessions s JOIN users u ON u.id=s.user_id
                WHERE s.token_hash=${tokenDigest(token)} AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()
                AND u.email_verified_at IS NOT NULL`);
            const row = result.rows[0];
            return { user: row ? {
                id: row.id,
                email: row.email,
                role: row.role,
                authLevel: row.auth_level || 'password',
                mfaVerifiedAt: toTimestamp(row.mfa_verified_at),
                stepUpVerifiedAt: toTimestamp(row.step_up_verified_at),
                emailVerified: Boolean(row.email_verified_at),
                createdAt: toTimestamp(row.created_at),
            } : null };
        },
        async elevateMfa(token, { requestId } = {}) {
            if (!canonicalToken(token)) throw new RegistrationError('UNAUTHENTICATED', 401);
            const result = await database.execute(sql`UPDATE auth_sessions AS s SET auth_level='mfa', mfa_verified_at=clock_timestamp(), step_up_verified_at=NULL
                FROM users AS u WHERE s.user_id=u.id AND s.token_hash=${tokenDigest(token)} AND s.revoked_at IS NULL
                AND s.expires_at>clock_timestamp() AND u.role='admin' AND u.email_verified_at IS NOT NULL
                RETURNING s.user_id`);
            if (!result.rows.length) throw new RegistrationError('MFA_REQUIRED', 403);
            emitAuditEvent({ action: 'admin.mfa.session_elevated', actorId: result.rows[0].user_id, outcome: 'accepted', requestId }, sink);
            return { status: 'elevated' };
        },
        async logout(token, { requestId } = {}) {
            if (canonicalToken(token)) await database.transaction(async (tx) => {
                await tx.execute(sql`UPDATE auth_sessions SET revoked_at=clock_timestamp()
                    WHERE token_hash=${tokenDigest(token)} AND revoked_at IS NULL`);
            });
            emitAuditEvent({ action: 'session.logout', outcome: 'accepted', requestId }, sink);
        },
    };
}
module.exports = { createSessionService, loginRateLimit, SESSION_SECONDS, COOKIE_NAME, canonicalToken, sessionCookie, cookieValue };
