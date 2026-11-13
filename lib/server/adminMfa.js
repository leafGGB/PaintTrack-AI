const {
    createCipheriv,
    createDecipheriv,
    createHash,
    createHmac,
    randomBytes,
    timingSafeEqual,
} = require('node:crypto');
const { sql } = require('drizzle-orm');
const { RegistrationError } = require('./registration');
const { emitAuditEvent } = require('./observability');

const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;
const TOTP_WINDOW = 1;
const MFA_SECRET_BYTES = 20;
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_BYTES = 10;
const ENCRYPTED_SECRET_BYTES = 32;
const MFA_KEY_ENV = 'PAINTTRACK_MFA_ENCRYPTION_KEY';
const MFA_SESSION_REJECTED = 'MFA_SESSION_REJECTED';

function decodeEncryptionKey(value) {
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) {
        throw new Error(`${MFA_KEY_ENV} must be a 32-byte hexadecimal key`);
    }
    return Buffer.from(value, 'hex');
}

function normalizeTotpCode(value) {
    return typeof value === 'string' && /^\d{6}$/.test(value) ? value : null;
}

function normalizeRecoveryCode(value) {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toUpperCase().replace(/[-\s]/g, '');
    return /^[A-Z2-9]{16}$/.test(normalized) ? normalized : null;
}

function base32Encode(buffer) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0;
    let value = 0;
    let output = '';
    for (const byte of buffer) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            output += alphabet[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
    return output;
}

function base32Decode(value) {
    if (typeof value !== 'string' || !/^[A-Z2-7]+$/i.test(value)) throw new TypeError('无效 MFA 密钥');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0;
    let current = 0;
    const output = [];
    for (const character of value.toUpperCase().replace(/=+$/, '')) {
        const index = alphabet.indexOf(character);
        if (index < 0) throw new TypeError('无效 MFA 密钥');
        current = (current << 5) | index;
        bits += 5;
        if (bits >= 8) {
            output.push((current >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return Buffer.from(output);
}

function hotp(secret, counter) {
    const counterBuffer = Buffer.alloc(8);
    counterBuffer.writeBigUInt64BE(BigInt(counter));
    const digest = createHmac('sha1', secret).update(counterBuffer).digest();
    const offset = digest[digest.length - 1] & 0x0f;
    const binary = ((digest[offset] & 0x7f) << 24)
        | ((digest[offset + 1] & 0xff) << 16)
        | ((digest[offset + 2] & 0xff) << 8)
        | (digest[offset + 3] & 0xff);
    return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

function totpCode(secret, timestamp = Date.now()) {
    if (!Buffer.isBuffer(secret) || secret.length < 16) throw new TypeError('无效 MFA 密钥');
    const counter = Math.floor(timestamp / 1000 / TOTP_PERIOD_SECONDS);
    return hotp(secret, counter);
}

function matchingTotpCounter(secret, code, timestamp = Date.now()) {
    const normalized = normalizeTotpCode(code);
    if (!normalized) return null;
    const counter = Math.floor(timestamp / 1000 / TOTP_PERIOD_SECONDS);
    let matched = null;
    for (let offset = -TOTP_WINDOW; offset <= TOTP_WINDOW; offset += 1) {
        const candidate = counter + offset;
        if (candidate < 0) continue;
        const expected = Buffer.from(hotp(secret, candidate));
        const actual = Buffer.from(normalized);
        if (timingSafeEqual(expected, actual)) matched = candidate;
    }
    return matched;
}

function verifyTotp(secret, code, timestamp = Date.now()) {
    return matchingTotpCounter(secret, code, timestamp) !== null;
}

function encryptSecret(secret, encryptionKey) {
    if (!Buffer.isBuffer(secret) || secret.length < 16) throw new TypeError('无效 MFA 密钥');
    const key = Buffer.isBuffer(encryptionKey) ? encryptionKey : decodeEncryptionKey(encryptionKey);
    if (key.length !== ENCRYPTED_SECRET_BYTES) throw new TypeError('无效 MFA 加密密钥');
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
    return {
        secretCiphertext: ciphertext.toString('base64url'),
        secretNonce: nonce.toString('base64url'),
        secretTag: cipher.getAuthTag().toString('base64url'),
    };
}

function decryptSecret(record, encryptionKey) {
    const key = Buffer.isBuffer(encryptionKey) ? encryptionKey : decodeEncryptionKey(encryptionKey);
    const secretCiphertext = record?.secretCiphertext ?? record?.secret_ciphertext;
    const secretNonce = record?.secretNonce ?? record?.secret_nonce;
    const secretTag = record?.secretTag ?? record?.secret_tag;
    if (key.length !== ENCRYPTED_SECRET_BYTES || typeof secretCiphertext !== 'string'
        || typeof secretNonce !== 'string' || typeof secretTag !== 'string') throw new TypeError('无效 MFA 密文');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(secretNonce, 'base64url'));
    decipher.setAuthTag(Buffer.from(secretTag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(secretCiphertext, 'base64url')), decipher.final()]);
}

function recoveryDigest(code) {
    const normalized = normalizeRecoveryCode(code);
    if (!normalized) throw new TypeError('无效恢复码');
    return createHash('sha256').update(normalized).digest('hex');
}

function generateRecoveryCodes(count = RECOVERY_CODE_COUNT) {
    if (!Number.isInteger(count) || count < 1 || count > 20) throw new RangeError('恢复码数量超出范围');
    return Array.from({ length: count }, () => base32Encode(randomBytes(RECOVERY_CODE_BYTES)).slice(0, 16));
}

function assertAdmin(user) {
    if (!user || user.role !== 'admin') throw new RegistrationError('FORBIDDEN', 403);
}

function createAdminMfaService({ database, encryptionKey = process.env[MFA_KEY_ENV], auditSink = console, clock = () => Date.now() }) {
    if (!database || typeof database.execute !== 'function' || typeof database.transaction !== 'function') throw new TypeError('需要数据库事务接口');
    const key = decodeEncryptionKey(encryptionKey);
    async function rateLimit(bucket) {
        const result = await database.execute(sql`INSERT INTO auth_rate_limits(bucket, window_start, hits)
            VALUES (${bucket}, clock_timestamp(), 1)
            ON CONFLICT (bucket) DO UPDATE SET
                hits = CASE WHEN auth_rate_limits.window_start <= clock_timestamp() - interval '1 minute' THEN 1 ELSE auth_rate_limits.hits + 1 END,
                window_start = CASE WHEN auth_rate_limits.window_start <= clock_timestamp() - interval '1 minute' THEN clock_timestamp() ELSE auth_rate_limits.window_start END
            WHERE auth_rate_limits.window_start <= clock_timestamp() - interval '1 minute' OR auth_rate_limits.hits < 10
            RETURNING hits`);
        if (!result.rows.length) throw new RegistrationError('RATE_LIMITED', 429);
    }
    async function consumeManagementProof(tx, user, code, tokenHash) {
        const factorResult = await tx.execute(sql`SELECT id,secret_ciphertext,secret_nonce,secret_tag,last_totp_counter
            FROM admin_mfa_factors WHERE user_id=${user.id} AND factor_type='totp'
                AND enabled_at IS NOT NULL AND revoked_at IS NULL FOR UPDATE`);
        const factor = factorResult.rows[0];
        if (!factor) throw new RegistrationError('INVALID_MFA_PROOF', 401);

        let accepted = false;
        if (normalizeTotpCode(code)) {
            const counter = matchingTotpCounter(decryptSecret(factor, key), code, clock());
            if (counter !== null && (factor.last_totp_counter === null || counter > Number(factor.last_totp_counter))) {
                const consumed = await tx.execute(sql`UPDATE admin_mfa_factors SET last_totp_counter=${counter}
                    WHERE id=${factor.id} AND (last_totp_counter IS NULL OR last_totp_counter < ${counter}) RETURNING id`);
                accepted = consumed.rows.length > 0;
            }
        } else if (normalizeRecoveryCode(code)) {
            const digest = recoveryDigest(code);
            const consumed = await tx.execute(sql`UPDATE admin_recovery_codes SET consumed_at=clock_timestamp()
                WHERE user_id=${user.id} AND code_digest=${digest} AND consumed_at IS NULL RETURNING id`);
            accepted = consumed.rows.length > 0;
        }
        if (!accepted) throw new RegistrationError('INVALID_MFA_PROOF', 401);

        const session = await tx.execute(sql`UPDATE auth_sessions SET auth_level='mfa', mfa_verified_at=clock_timestamp(), step_up_verified_at=NULL
            WHERE token_hash=${tokenHash} AND user_id=${user.id} AND revoked_at IS NULL AND expires_at>clock_timestamp() RETURNING user_id`);
        if (!session.rows.length) {
            const error = new Error('MFA session rejected');
            error.code = 'MFA_SESSION_REJECTED';
            throw error;
        }
    }
    return {
        async getStatus(user, { requestId } = {}) {
            assertAdmin(user);
            const result = await database.execute(sql`SELECT enabled_at, revoked_at,
                (SELECT COUNT(*)::int FROM admin_recovery_codes WHERE user_id=${user.id} AND consumed_at IS NULL) AS recovery_remaining
                FROM admin_mfa_factors WHERE user_id=${user.id} AND factor_type='totp'
                ORDER BY id DESC LIMIT 1`);
            const row = result.rows[0];
            emitAuditEvent({ action: 'admin.mfa.status_read', actorId: user.id, outcome: 'accepted', requestId }, auditSink);
            return {
                enabled: Boolean(row?.enabled_at) && !row?.revoked_at,
                revoked: Boolean(row?.revoked_at),
                enrollmentPending: Boolean(row && !row.enabled_at && !row.revoked_at),
                recoveryRemaining: Number(row?.recovery_remaining || 0),
            };
        },
        async beginEnrollment(user, { requestId } = {}) {
            assertAdmin(user);
            if (user.authLevel === 'mfa') throw new RegistrationError('MFA_ALREADY_ENABLED', 409);
            const secret = randomBytes(MFA_SECRET_BYTES);
            const encrypted = encryptSecret(secret, key);
            const result = await database.transaction((tx) => tx.execute(sql`INSERT INTO admin_mfa_factors(user_id, factor_type, secret_ciphertext, secret_nonce, secret_tag)
                VALUES (${user.id}, 'totp', ${encrypted.secretCiphertext}, ${encrypted.secretNonce}, ${encrypted.secretTag})
                ON CONFLICT (user_id, factor_type) DO UPDATE SET secret_ciphertext=excluded.secret_ciphertext,
                    secret_nonce=excluded.secret_nonce, secret_tag=excluded.secret_tag, enabled_at=NULL, revoked_at=NULL
                WHERE admin_mfa_factors.enabled_at IS NULL OR admin_mfa_factors.revoked_at IS NOT NULL RETURNING id`));
            if (!result.rows.length) throw new RegistrationError('MFA_ALREADY_ENABLED', 409);
            emitAuditEvent({ action: 'admin.mfa.enrollment_started', actorId: user.id, outcome: 'accepted', requestId }, auditSink);
            return { secret: base32Encode(secret), algorithm: 'SHA1', digits: TOTP_DIGITS, period: TOTP_PERIOD_SECONDS };
        },
        async verifyCode(user, code, { requestId } = {}) {
            assertAdmin(user);
            await rateLimit('mfa-login');
            const result = await database.transaction(async (tx) => {
                const found = await tx.execute(sql`SELECT id,secret_ciphertext,secret_nonce,secret_tag,last_totp_counter FROM admin_mfa_factors
                    WHERE user_id=${user.id} AND factor_type='totp' AND enabled_at IS NOT NULL AND revoked_at IS NULL FOR UPDATE`);
                const record = found.rows[0];
                if (!record) return false;
                const counter = matchingTotpCounter(decryptSecret(record, key), code, clock());
                if (counter === null || (record.last_totp_counter !== null && counter <= Number(record.last_totp_counter))) return false;
                const consumed = await tx.execute(sql`UPDATE admin_mfa_factors SET last_totp_counter=${counter}
                    WHERE id=${record.id} AND (last_totp_counter IS NULL OR last_totp_counter < ${counter}) RETURNING id`);
                return consumed.rows.length > 0;
            });
            if (!result) {
                emitAuditEvent({ action: 'admin.mfa.verification_rejected', actorId: user.id, outcome: 'rejected', requestId }, auditSink);
                throw new RegistrationError('INVALID_MFA_CODE', 401);
            }
            emitAuditEvent({ action: 'admin.mfa.verification_accepted', actorId: user.id, outcome: 'accepted', requestId }, auditSink);
            return { status: 'verified' };
        },
        async verifyTotpAndElevate(user, code, tokenHash, { requestId, stepUp = false } = {}) {
            assertAdmin(user);
            await rateLimit('mfa-login');
            const result = await database.transaction(async (tx) => {
                const found = await tx.execute(sql`SELECT id,secret_ciphertext,secret_nonce,secret_tag,last_totp_counter FROM admin_mfa_factors
                    WHERE user_id=${user.id} AND factor_type='totp' AND enabled_at IS NOT NULL AND revoked_at IS NULL FOR UPDATE`);
                const record = found.rows[0];
                if (!record) return false;
                const counter = matchingTotpCounter(decryptSecret(record, key), code, clock());
                if (counter === null || (record.last_totp_counter !== null && counter <= Number(record.last_totp_counter))) return false;
                const consumed = await tx.execute(sql`UPDATE admin_mfa_factors SET last_totp_counter=${counter}
                    WHERE id=${record.id} AND (last_totp_counter IS NULL OR last_totp_counter < ${counter}) RETURNING id`);
                if (!consumed.rows.length) return false;
                const session = stepUp
                    ? await tx.execute(sql`UPDATE auth_sessions SET step_up_verified_at=clock_timestamp()
                        WHERE token_hash=${tokenHash} AND user_id=${user.id} AND auth_level='mfa' AND revoked_at IS NULL AND expires_at>clock_timestamp() RETURNING user_id`)
                    : await tx.execute(sql`UPDATE auth_sessions SET auth_level='mfa',mfa_verified_at=clock_timestamp(),step_up_verified_at=NULL
                        WHERE token_hash=${tokenHash} AND user_id=${user.id} AND revoked_at IS NULL AND expires_at>clock_timestamp() RETURNING user_id`);
                if (!session.rows.length) {
                    const error = new Error(MFA_SESSION_REJECTED);
                    error.code = MFA_SESSION_REJECTED;
                    throw error;
                }
                return true;
            });
            if (!result) throw new RegistrationError('INVALID_MFA_CODE', 401);
            emitAuditEvent({ action: stepUp ? 'admin.mfa.step_up_verified' : 'admin.mfa.session_elevated', actorId: user.id, outcome: 'accepted', requestId }, auditSink);
            return { status: stepUp ? 'verified' : 'elevated' };
        },
        async verifyStepUpWithRecoveryCode(user, code, tokenHash, { requestId } = {}) {
            assertAdmin(user);
            await rateLimit('mfa-recovery');
            const digest = recoveryDigest(code);
            const result = await database.transaction(async (tx) => {
                const consumed = await tx.execute(sql`UPDATE admin_recovery_codes SET consumed_at=clock_timestamp()
                    WHERE user_id=${user.id} AND code_digest=${digest} AND consumed_at IS NULL RETURNING id`);
                if (!consumed.rows.length) return false;
                const session = await tx.execute(sql`UPDATE auth_sessions SET step_up_verified_at=clock_timestamp()
                    WHERE token_hash=${tokenHash} AND user_id=${user.id} AND auth_level='mfa' AND revoked_at IS NULL AND expires_at>clock_timestamp() RETURNING user_id`);
                if (!session.rows.length) {
                    const error = new Error(MFA_SESSION_REJECTED);
                    error.code = MFA_SESSION_REJECTED;
                    throw error;
                }
                return true;
            });
            if (!result) throw new RegistrationError('INVALID_RECOVERY_CODE', 401);
            emitAuditEvent({ action: 'admin.mfa.step_up_verified', actorId: user.id, outcome: 'accepted', requestId }, auditSink);
            return { status: 'verified' };
        }, 
        async verifyEnrollment(user, code, { requestId } = {}) {
            assertAdmin(user);
            await rateLimit('mfa-login');
            const valid = await database.transaction(async (tx) => {
                const found = await tx.execute(sql`SELECT id,secret_ciphertext,secret_nonce,secret_tag FROM admin_mfa_factors
                    WHERE user_id=${user.id} AND factor_type='totp' AND enabled_at IS NULL AND revoked_at IS NULL FOR UPDATE`);
                const record = found.rows[0];
                if (!record) return false;
                const counter = matchingTotpCounter(decryptSecret(record, key), code, clock());
                if (counter === null) return false;
                const updated = await tx.execute(sql`UPDATE admin_mfa_factors SET enabled_at=clock_timestamp(),last_totp_counter=${counter}
                    WHERE id=${record.id} AND enabled_at IS NULL AND revoked_at IS NULL RETURNING id`);
                return updated.rows.length > 0;
            });
            if (!valid) {
                emitAuditEvent({ action: 'admin.mfa.enrollment_rejected', actorId: user.id, outcome: 'rejected', requestId }, auditSink);
                throw new RegistrationError('INVALID_MFA_CODE', 401);
            }
            emitAuditEvent({ action: 'admin.mfa.enrollment_verified', actorId: user.id, outcome: 'accepted', requestId }, auditSink);
            return { status: 'enabled' };
        },
        async issueRecoveryCodes(user, code, tokenHash, { requestId } = {}) {
            assertAdmin(user);
            await rateLimit('mfa-recovery');
            const codes = generateRecoveryCodes();
            const digests = codes.map((recoveryCode) => recoveryDigest(recoveryCode));
            await database.transaction(async (tx) => {
                await consumeManagementProof(tx, user, code, tokenHash);
                await tx.execute(sql`DELETE FROM admin_recovery_codes WHERE user_id=${user.id}`);
                for (const digest of digests) await tx.execute(sql`INSERT INTO admin_recovery_codes(user_id, code_digest) VALUES (${user.id}, ${digest})`);
            });
            emitAuditEvent({ action: 'admin.mfa.recovery_issued', actorId: user.id, outcome: 'accepted', requestId }, auditSink);
            return { codes };
        },
        async revokeFactor(user, code, tokenHash, { requestId } = {}) {
            assertAdmin(user);
            await rateLimit('mfa-recovery');
            await database.transaction(async (tx) => {
                await consumeManagementProof(tx, user, code, tokenHash);
                const revoked = await tx.execute(sql`UPDATE admin_mfa_factors SET revoked_at=clock_timestamp()
                    WHERE user_id=${user.id} AND factor_type='totp' AND enabled_at IS NOT NULL AND revoked_at IS NULL RETURNING id`);
                if (!revoked.rows.length) throw new RegistrationError('MFA_NOT_ENABLED', 409);
                await tx.execute(sql`DELETE FROM admin_recovery_codes WHERE user_id=${user.id}`);
                await tx.execute(sql`UPDATE auth_sessions SET revoked_at=clock_timestamp()
                    WHERE user_id=${user.id} AND revoked_at IS NULL`);
            });
            emitAuditEvent({ action: 'admin.mfa.factor_revoked', actorId: user.id, outcome: 'accepted', requestId }, auditSink);
            return { status: 'revoked' };
        },
        async consumeRecoveryCode(user, code, { requestId } = {}) {
            assertAdmin(user);
            await rateLimit('mfa-recovery');
            const digest = recoveryDigest(code);
            const result = await database.transaction((tx) => tx.execute(sql`UPDATE admin_recovery_codes SET consumed_at=clock_timestamp()
                WHERE user_id=${user.id} AND code_digest=${digest} AND consumed_at IS NULL RETURNING id`));
            if (!result.rows.length) {
                emitAuditEvent({ action: 'admin.mfa.recovery_rejected', actorId: user.id, outcome: 'rejected', requestId }, auditSink);
                throw new RegistrationError('INVALID_RECOVERY_CODE', 401);
            }
            emitAuditEvent({ action: 'admin.mfa.recovery_consumed', actorId: user.id, outcome: 'accepted', requestId }, auditSink);
            return { status: 'accepted' };
        },
        async consumeRecoveryCodeAndElevate(user, code, tokenHash, { requestId } = {}) {
            assertAdmin(user);
            await rateLimit('mfa-recovery');
            const digest = recoveryDigest(code);
            const result = await database.transaction(async (tx) => {
                const consumed = await tx.execute(sql`UPDATE admin_recovery_codes SET consumed_at=clock_timestamp()
                    WHERE user_id=${user.id} AND code_digest=${digest} AND consumed_at IS NULL RETURNING id`);
                if (!consumed.rows.length) return { rows: [] };
                return tx.execute(sql`UPDATE auth_sessions SET auth_level='mfa', mfa_verified_at=clock_timestamp(), step_up_verified_at=NULL
                    WHERE token_hash=${tokenHash} AND user_id=${user.id} AND revoked_at IS NULL AND expires_at>clock_timestamp()
                    RETURNING user_id`);
            });
            if (!result.rows.length) {
                emitAuditEvent({ action: 'admin.mfa.recovery_rejected', actorId: user.id, outcome: 'rejected', requestId }, auditSink);
                throw new RegistrationError('INVALID_RECOVERY_CODE', 401);
            }
            emitAuditEvent({ action: 'admin.mfa.recovery_consumed', actorId: user.id, outcome: 'accepted', requestId }, auditSink);
            emitAuditEvent({ action: 'admin.mfa.session_elevated', actorId: user.id, outcome: 'accepted', requestId }, auditSink);
            return { status: 'elevated' };
        },
    };
}

module.exports = {
    createAdminMfaService,
    base32Decode,
    base32Encode,
    decryptSecret,
    encryptSecret,
    generateRecoveryCodes,
    normalizeRecoveryCode,
    recoveryDigest,
    totpCode,
    verifyTotp,
    matchingTotpCounter,
    TOTP_PERIOD_SECONDS,
    TOTP_DIGITS,
};
