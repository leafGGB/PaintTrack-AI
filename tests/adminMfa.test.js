const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { sql } = require('drizzle-orm');
const {
    createAdminMfaService,
    decryptSecret,
    encryptSecret,
    generateRecoveryCodes,
    recoveryDigest,
    totpCode,
    verifyTotp,
    matchingTotpCounter,
} = require('../lib/server/adminMfa');

const key = randomBytes(32).toString('hex');
const admin = { id: 'admin-1', role: 'admin' };
const quiet = { info() {}, warn() {}, error() {} };
function queryText(query) {
    return query?.queryChunks?.map((chunk) => typeof chunk === 'string' ? chunk : Array.isArray(chunk?.value) ? chunk.value.join('') : '').join('') || '';
}

test('TOTP RFC 6238 基础计算、窗口校验和非法输入拒绝', () => {
    const secret = Buffer.from('12345678901234567890');
    assert.equal(totpCode(secret, 59000), '287082');
    assert.equal(verifyTotp(secret, '287082', 59000), true);
    assert.equal(verifyTotp(secret, '287082', 59000 + 30000), true);
    assert.equal(verifyTotp(secret, '287082', 59000 + 60000), false);
    assert.equal(verifyTotp(secret, '12345', 59000), false);
    assert.equal(matchingTotpCounter(secret, '287082', 59000), 1);
});

test('TOTP counter 原子消费阻止重复使用，step-up 只在因子与会话同时成功时写入', async () => {
    const secret = Buffer.from('12345678901234567890');
    const encrypted = encryptSecret(secret, key);
    let lastCounter = null;
    let stepUpWritten = false;
    const database = {
        async execute(query) {
            const text = query.queryChunks.map((chunk) => typeof chunk === 'string' ? chunk : Array.isArray(chunk?.value) ? chunk.value.join('') : '').join('');
            if (text.includes('auth_rate_limits')) return { rows: [{ hits: 1 }] };
            return { rows: [] };
        },
        async transaction(callback) {
            return callback({
                async execute(query) {
                    const text = query.queryChunks.map((chunk) => typeof chunk === 'string' ? chunk : Array.isArray(chunk?.value) ? chunk.value.join('') : '').join('');
                    if (text.includes('SELECT id,secret_ciphertext')) return { rows: [{ id: 'factor-1', ...encrypted, last_totp_counter: lastCounter }] };
                    if (text.includes('UPDATE admin_mfa_factors SET last_totp_counter')) {
                        const parameters = query.queryChunks.filter((chunk) => typeof chunk !== 'string' && !Array.isArray(chunk?.value));
                        lastCounter = Number(parameters[0]);
                        return { rows: [{ id: 'factor-1' }] };
                    }
                    if (text.includes('UPDATE auth_sessions SET step_up_verified_at')) {
                        stepUpWritten = true;
                        return { rows: [{ user_id: admin.id }] };
                    }
                    return { rows: [] };
                },
            });
        },
    };
    const now = 59000;
    const service = createAdminMfaService({ database, encryptionKey: key, auditSink: quiet, clock: () => now });
    const code = totpCode(secret, now);
    assert.deepEqual(await service.verifyTotpAndElevate(admin, code, 'a'.repeat(64), { stepUp: true }), { status: 'verified' });
    assert.equal(lastCounter, 1);
    await assert.rejects(service.verifyTotpAndElevate(admin, code, 'a'.repeat(64), { stepUp: true }), (error) => error.code === 'INVALID_MFA_CODE');
    assert.equal(stepUpWritten, true);
});

test('TOTP 密钥使用 AES-256-GCM 加密，篡改或错误密钥不能解密', () => {
    const secret = randomBytes(20);
    const encrypted = encryptSecret(secret, key);
    assert.deepEqual(decryptSecret(encrypted, key), secret);
    assert.deepEqual(decryptSecret({
        secret_ciphertext: encrypted.secretCiphertext,
        secret_nonce: encrypted.secretNonce,
        secret_tag: encrypted.secretTag,
    }, key), secret);
    const alteredTag = `${encrypted.secretTag[0] === 'A' ? 'B' : 'A'}${encrypted.secretTag.slice(1)}`;
    assert.throws(() => decryptSecret({ ...encrypted, secretTag: alteredTag }, key));
    assert.throws(() => decryptSecret(encrypted, randomBytes(32).toString('hex')));
});

test('恢复码只使用规范字符、摘要不含明文且每次生成值独立', () => {
    const codes = generateRecoveryCodes();
    assert.equal(codes.length, 10);
    assert.equal(new Set(codes).size, codes.length);
    for (const code of codes) {
        assert.match(code, /^[A-Z2-9]{16}$/);
        assert.equal(recoveryDigest(code).length, 64);
        assert.notEqual(recoveryDigest(code), code);
    }
    assert.notDeepEqual(generateRecoveryCodes(), codes);
});

test('管理员 MFA enrollment、恢复码签发和恢复码并发消费都经过事务', async () => {
    const rows = [];
    const statements = [];
    const proofSecret = Buffer.from('12345678901234567890');
    const proofFactor = { id: 'factor-1', ...encryptSecret(proofSecret, key), last_totp_counter: null };
    let factorEnrolled = false;
    const database = {
        async execute(query) {
            statements.push(queryText(query));
            if (statements.at(-1).includes('SELECT secret_ciphertext')) {
                return rows.length ? { rows: [rows[0]] } : { rows: [] };
            }
            return { rows: [{ hits: 1 }] };
        },
        async transaction(callback) {
            const tx = {
                async execute(query) {
                    statements.push(queryText(query));
                    if (statements.at(-1).includes('INSERT INTO admin_mfa_factors')) {
                        if (factorEnrolled) return { rows: [] };
                        factorEnrolled = true;
                        rows[0] = Object.fromEntries(query.queryChunks.filter((chunk) => typeof chunk !== 'string').map(() => []));
                    }
                    if (statements.at(-1).includes('SELECT id,secret_ciphertext')) return { rows: [proofFactor] };
                    if (statements.at(-1).includes('UPDATE admin_recovery_codes')) return { rows: [{ id: 'code-1' }] };
                    if (statements.at(-1).includes('UPDATE auth_sessions')) return { rows: [{ user_id: admin.id }] };
                    if (statements.at(-1).includes('INSERT INTO admin_mfa_factors')) return { rows: [{ id: 'factor-1' }] };
                    return { rows: [{ hits: 1 }] };
                },
            };
            return callback(tx);
        },
    };
    const service = createAdminMfaService({ database, encryptionKey: key, auditSink: quiet, clock: () => 59000 });
    const enrollment = await service.beginEnrollment(admin);
    assert.match(enrollment.secret, /^[A-Z2-7]+$/);
    await assert.rejects(service.beginEnrollment({ ...admin, authLevel: 'mfa' }), (error) => error.code === 'MFA_ALREADY_ENABLED');
    assert.match(statements.join(' '), /WHERE admin_mfa_factors\.enabled_at IS NULL OR admin_mfa_factors\.revoked_at IS NOT NULL RETURNING id/);
    const proofCode = totpCode(proofSecret, 59000);
    const codes = await service.issueRecoveryCodes(admin, proofCode, 'a'.repeat(64));
    assert.equal(codes.codes.length, 10);
    assert.ok(statements.length >= 3);
    assert.deepEqual(await service.consumeRecoveryCode(admin, codes.codes[0]), { status: 'accepted' });
    const revokeCode = totpCode(proofSecret, 59000 + 30000);
    assert.deepEqual(await service.revokeFactor(admin, revokeCode, 'a'.repeat(64)), { status: 'revoked' });
    const sqlText = statements.join(' ');
    assert.match(sqlText, /DELETE FROM admin_recovery_codes/);
    assert.match(sqlText, /UPDATE auth_sessions SET revoked_at/);
    assert.match(sqlText, /step_up_verified_at=NULL/);
});

test('普通用户不能初始化或消费管理员 MFA', async () => {
    const database = { async execute() { assert.fail('不应访问数据库'); }, async transaction() { assert.fail('不应访问数据库'); } };
    const service = createAdminMfaService({ database, encryptionKey: key, auditSink: quiet });
    await assert.rejects(service.beginEnrollment({ id: 'user-1', role: 'user' }), (error) => error.code === 'FORBIDDEN');
    await assert.rejects(service.consumeRecoveryCode({ id: 'user-1', role: 'user' }, 'A'.repeat(16)), (error) => error.code === 'FORBIDDEN');
});
