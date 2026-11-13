const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { drizzle } = require('drizzle-orm/node-postgres');
const { sql } = require('drizzle-orm');
const { createAdminMfaService, base32Decode, encryptSecret, generateRecoveryCodes, recoveryDigest, totpCode } = require('../../lib/server/adminMfa');
const { createAdminMfaHandler } = require('../../lib/server/adminMfaHttp');
const { tokenDigest, hashPassword } = require('../../lib/server/registration');

async function checkAdminMfa(runtimePool, owner, record) {
    const userId = crypto.randomUUID();
    const email = `admin-mfa-${crypto.randomBytes(8).toString('hex')}@example.test`;
    const passwordHash = await hashPassword(`Synthetic-${crypto.randomBytes(16).toString('hex')}`);
    const tokens = Array.from({ length: 7 }, () => crypto.randomBytes(32).toString('base64url'));
    const baseTime = Math.floor(Date.now() / 30000) * 30000;
    const secret = crypto.randomBytes(20);
    const encryptionKey = crypto.randomBytes(32).toString('hex');
    const encrypted = encryptSecret(secret, encryptionKey);
    const database = drizzle(runtimePool);
    const auditSink = { info() {}, warn() {}, error() {} };
    const tokenHashes = tokens.map(tokenDigest);
    const counter = Math.floor(baseTime / 1000 / 30);

    try {
        await owner.query('INSERT INTO users(id,email,password_hash,email_verified_at,role) VALUES($1,$2,$3,clock_timestamp(),\'admin\')', [userId, email, passwordHash]);
        await owner.query(`INSERT INTO admin_mfa_factors(user_id,factor_type,secret_ciphertext,secret_nonce,secret_tag,enabled_at,last_totp_counter)
            VALUES($1,'totp',$2,$3,$4,clock_timestamp(),NULL)`, [userId, encrypted.secretCiphertext, encrypted.secretNonce, encrypted.secretTag]);
        for (const tokenHash of tokenHashes) {
            await owner.query(`INSERT INTO auth_sessions(user_id,token_hash,expires_at,auth_level,mfa_verified_at)
                VALUES($1,$2,clock_timestamp()+interval '8 hours','mfa',clock_timestamp())`, [userId, tokenHash]);
        }

        const admin = { id: userId, role: 'admin', authLevel: 'mfa' };
        const service = createAdminMfaService({ database, encryptionKey, auditSink, clock: () => baseTime });
        const proofCode = totpCode(secret, baseTime);
        const concurrentTotp = await Promise.allSettled([
            service.verifyTotpAndElevate(admin, proofCode, tokenHashes[0]),
            service.verifyTotpAndElevate(admin, proofCode, tokenHashes[1]),
        ]);
        assert.deepEqual(concurrentTotp.filter((item) => item.status === 'fulfilled').length, 1, concurrentTotp.map((item) => item.status === 'rejected' ? `rejected:${item.reason.code || item.reason.name || 'ERROR'}` : 'fulfilled'));
        assert.equal(concurrentTotp.filter((item) => item.status === 'rejected' && item.reason.code === 'INVALID_MFA_CODE').length, 1);
        let factor = (await owner.query('SELECT last_totp_counter FROM admin_mfa_factors WHERE user_id=$1', [userId])).rows[0];
        assert.equal(Number(factor.last_totp_counter), counter);
        record('真实PG同一TOTP并发消费恰有一个成功', 'passed');

        const recoveryCode = generateRecoveryCodes(1)[0];
        await owner.query('INSERT INTO admin_recovery_codes(user_id,code_digest) VALUES($1,$2)', [userId, recoveryDigest(recoveryCode)]);
        const concurrentRecovery = await Promise.allSettled([
            service.consumeRecoveryCodeAndElevate(admin, recoveryCode, tokenHashes[2]),
            service.consumeRecoveryCodeAndElevate(admin, recoveryCode, tokenHashes[3]),
        ]);
        assert.equal(concurrentRecovery.filter((item) => item.status === 'fulfilled').length, 1);
        assert.equal(concurrentRecovery.filter((item) => item.status === 'rejected' && item.reason.code === 'INVALID_RECOVERY_CODE').length, 1);
        const consumedRecovery = await owner.query('SELECT consumed_at FROM admin_recovery_codes WHERE user_id=$1 AND code_digest=$2', [userId, recoveryDigest(recoveryCode)]);
        assert.ok(consumedRecovery.rows[0].consumed_at);
        record('真实PG同一恢复码并发消费恰有一个成功', 'passed');

        const queryText = (query) => query?.queryChunks?.map((chunk) => typeof chunk === 'string' ? chunk : Array.isArray(chunk?.value) ? chunk.value.join('') : '').join('') || '';
        const failingSessionDatabase = {
            execute: (...args) => database.execute(...args),
            transaction: (callback) => database.transaction((tx) => callback({
                execute(query) {
                    if (queryText(query).includes('UPDATE auth_sessions')) return tx.execute(sql`SELECT 1/0`);
                    return tx.execute(query);
                },
            })),
        };
        const failingSessionService = createAdminMfaService({ database: failingSessionDatabase, encryptionKey, auditSink, clock: () => baseTime + 30000 });
        const recoveryForRollback = generateRecoveryCodes(1)[0];
        await owner.query('INSERT INTO admin_recovery_codes(user_id,code_digest) VALUES($1,$2)', [userId, recoveryDigest(recoveryForRollback)]);
        const beforeRollback = (await owner.query('SELECT last_totp_counter FROM admin_mfa_factors WHERE user_id=$1', [userId])).rows[0].last_totp_counter;
        await assert.rejects(failingSessionService.verifyStepUpWithRecoveryCode(admin, recoveryForRollback, tokenHashes[4]));
        await assert.rejects(failingSessionService.verifyTotpAndElevate(admin, totpCode(secret, baseTime + 30000), tokenHashes[4]));
        const afterFailedStepUp = await owner.query(`SELECT f.last_totp_counter, r.consumed_at, s.auth_level, s.step_up_verified_at
            FROM admin_mfa_factors f JOIN admin_recovery_codes r ON r.user_id=f.user_id
            JOIN auth_sessions s ON s.user_id=f.user_id WHERE f.user_id=$1 AND r.code_digest=$2 AND s.token_hash=$3`,
        [userId, recoveryDigest(recoveryForRollback), tokenHashes[4]]);
        assert.equal(afterFailedStepUp.rows[0].consumed_at, null);
        assert.equal(afterFailedStepUp.rows[0].auth_level, 'mfa');
        assert.equal(afterFailedStepUp.rows[0].step_up_verified_at, null);
        assert.equal(Number(afterFailedStepUp.rows[0].last_totp_counter), Number(beforeRollback));
        record('真实PGsession更新SQL失败回滚恢复码消费、TOTP计数和会话写入', 'passed');

        const failingInsertDatabase = {
            execute: (...args) => database.execute(...args),
            transaction: (callback) => database.transaction((tx) => callback({
                execute(query) {
                    if (queryText(query).includes('INSERT INTO admin_recovery_codes')) return tx.execute(sql`SELECT 1/0`);
                    return tx.execute(query);
                },
            })),
        };
        const failingInsertService = createAdminMfaService({ database: failingInsertDatabase, encryptionKey, auditSink, clock: () => baseTime + 30000 });
        const oldRecoveryCode = generateRecoveryCodes(1)[0];
        await owner.query('INSERT INTO admin_recovery_codes(user_id,code_digest) VALUES($1,$2)', [userId, recoveryDigest(oldRecoveryCode)]);
        const rollbackIssueProof = totpCode(secret, baseTime + 30000);
        await assert.rejects(failingInsertService.issueRecoveryCodes(admin, rollbackIssueProof, tokenHashes[4]));
        const oldCodeAfterRollback = await owner.query('SELECT consumed_at FROM admin_recovery_codes WHERE user_id=$1 AND code_digest=$2', [userId, recoveryDigest(oldRecoveryCode)]);
        factor = (await owner.query('SELECT last_totp_counter FROM admin_mfa_factors WHERE user_id=$1', [userId])).rows[0];
        assert.equal(oldCodeAfterRollback.rows[0].consumed_at, null);
        assert.equal(Number(factor.last_totp_counter), Number(beforeRollback));
        const issued = await service.issueRecoveryCodes(admin, rollbackIssueProof, tokenHashes[4]);
        assert.equal(issued.codes.length, 10);
        assert.equal((await owner.query('SELECT count(*)::int AS count FROM admin_recovery_codes WHERE user_id=$1 AND consumed_at IS NULL', [userId])).rows[0].count, 10);
        record('真实PG恢复码插入SQL失败回滚旧码与TOTP消费，重试后恰有10个新码', 'passed');

        const revokeProof = totpCode(secret, baseTime + 60000);
        const revokeService = createAdminMfaService({ database, encryptionKey, auditSink, clock: () => baseTime + 60000 });
        await revokeService.revokeFactor(admin, revokeProof, tokenHashes[5]);
        const revoked = await owner.query(`SELECT f.revoked_at,
            (SELECT count(*)::int FROM admin_recovery_codes WHERE user_id=$1) AS recovery_count,
            (SELECT count(*)::int FROM auth_sessions WHERE user_id=$1 AND revoked_at IS NULL) AS active_sessions
            FROM admin_mfa_factors f WHERE f.user_id=$1`, [userId]);
        assert.ok(revoked.rows[0].revoked_at);
        assert.equal(revoked.rows[0].recovery_count, 0);
        assert.equal(revoked.rows[0].active_sessions, 0);
        const revokedFactorService = createAdminMfaService({ database, encryptionKey, auditSink, clock: () => baseTime + 90000 });
        await assert.rejects(revokedFactorService.verifyTotpAndElevate(admin, totpCode(secret, baseTime + 90000), tokenHashes[6]));
        record('真实PG撤销因子清除恢复码并撤销管理员全部会话，旧因子不能再提升会话', 'passed');

        await owner.query("DELETE FROM auth_rate_limits WHERE bucket IN ('mfa-login','mfa-recovery')");
        const flowAdminId = crypto.randomUUID();
        const flowUserId = crypto.randomUUID();
        const flowEmail = `admin-mfa-flow-${crypto.randomBytes(8).toString('hex')}@example.test`;
        const ordinaryEmail = `mfa-ordinary-${crypto.randomBytes(8).toString('hex')}@example.test`;
        const flowToken = crypto.randomBytes(32).toString('base64url');
        const flowPeerToken = crypto.randomBytes(32).toString('base64url');
        const ordinaryToken = crypto.randomBytes(32).toString('base64url');
        const flowPasswordHash = await hashPassword(`Synthetic-${crypto.randomBytes(16).toString('hex')}`);
        const ordinaryPasswordHash = await hashPassword(`Synthetic-${crypto.randomBytes(16).toString('hex')}`);
        const flowEncryptionKey = crypto.randomBytes(32).toString('hex');
        const environment = { NODE_ENV: 'development', APP_BASE_URL: 'http://127.0.0.1:3213', AUTH_ALLOW_LOCAL_HTTP: '1', PAINTTRACK_MFA_ENCRYPTION_KEY: flowEncryptionKey };
        const postMfa = async (action, sessionToken, body, requestOrigin = environment.APP_BASE_URL, now = baseTime) => {
            const response = await createAdminMfaHandler(action, { database, encryptionKey: flowEncryptionKey, auditSink, environment, clock: () => now }) (
                new Request(`${environment.APP_BASE_URL}/api/auth/mfa/${action.replaceAll('.', '/')}`, {
                    method: 'POST',
                    headers: {
                        origin: requestOrigin,
                        cookie: `painttrack_session=${sessionToken}`,
                        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
                    },
                    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                })
            );
            return { response, body: await response.json() };
        };
        try {
            await owner.query('INSERT INTO users(id,email,password_hash,email_verified_at,role) VALUES($1,$2,$3,clock_timestamp(),\'admin\')', [flowAdminId, flowEmail, flowPasswordHash]);
            await owner.query('INSERT INTO users(id,email,password_hash,email_verified_at,role) VALUES($1,$2,$3,clock_timestamp(),\'user\')', [flowUserId, ordinaryEmail, ordinaryPasswordHash]);
            for (const session of [
                { userId: flowAdminId, token: flowToken },
                { userId: flowAdminId, token: flowPeerToken },
                { userId: flowUserId, token: ordinaryToken },
            ]) {
                await owner.query('INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,clock_timestamp()+interval \'8 hours\')', [session.userId, tokenDigest(session.token)]);
            }

            const initialStatus = await postMfa('status', flowToken);
            assert.equal(initialStatus.response.status, 200);
            assert.match(initialStatus.response.headers.get('cache-control'), /no-store/);
            assert.match(initialStatus.response.headers.get('vary'), /cookie/i);
            assert.equal(initialStatus.body.enabled, false);
            const crossOrigin = await postMfa('enrollment.begin', flowToken, undefined, 'http://evil.example');
            assert.equal(crossOrigin.response.status, 403);
            const ordinaryStatus = await postMfa('status', ordinaryToken);
            assert.equal(ordinaryStatus.response.status, 403);
            record('真实PG MFA HTTP 状态读取仅管理员可用，敏感响应 no-store/Vary Cookie，跨源请求拒绝', 'passed');

            const enrollment = await postMfa('enrollment.begin', flowToken);
            assert.equal(enrollment.response.status, 200);
            assert.equal(typeof enrollment.body.secret, 'string');
            assert.equal(enrollment.body.algorithm, 'SHA1');
            assert.equal(enrollment.body.digits, 6);
            assert.equal(enrollment.body.period, 30);
            const flowSecret = base32Decode(enrollment.body.secret);
            const enrollmentVerify = await postMfa('enrollment.verify', flowToken, { code: totpCode(flowSecret, baseTime) });
            assert.equal(enrollmentVerify.response.status, 200);
            assert.equal(enrollmentVerify.body.status, 'enabled');
            const enabledStatus = await postMfa('status', flowToken);
            assert.equal(enabledStatus.body.enabled, true);
            const replacement = await postMfa('enrollment.begin', flowToken);
            assert.equal(replacement.response.status, 409);
            assert.equal(replacement.body.error.code, 'MFA_ALREADY_ENABLED');
            record('真实PG MFA HTTP enrollment 密钥返回后以 TOTP 启用，已启用因子不能重新 enrollment 覆盖', 'passed');

            const firstIssue = await postMfa('recovery.issue', flowToken, { code: totpCode(flowSecret, baseTime + 30000) }, environment.APP_BASE_URL, baseTime + 30000);
            assert.equal(firstIssue.response.status, 200);
            assert.equal(firstIssue.body.codes.length, 10);
            assert.ok(firstIssue.body.codes.every((code) => /^[A-Z2-9]{16}$/.test(code)));
            let persistedCodes = await owner.query('SELECT code_digest FROM admin_recovery_codes WHERE user_id=$1 AND consumed_at IS NULL', [flowAdminId]);
            assert.equal(persistedCodes.rowCount, 10);
            assert.ok(firstIssue.body.codes.every((code) => persistedCodes.rows.some((row) => row.code_digest === recoveryDigest(code))));
            const firstCodes = firstIssue.body.codes;

            await owner.query('UPDATE auth_sessions SET auth_level=\'password\',mfa_verified_at=NULL,step_up_verified_at=NULL WHERE token_hash=$1', [tokenDigest(flowToken)]);
            const elevated = await postMfa('session.elevate', flowToken, { code: totpCode(flowSecret, baseTime + 60000) }, environment.APP_BASE_URL, baseTime + 60000);
            assert.equal(elevated.response.status, 200);
            assert.equal(elevated.body.status, 'elevated');

            await owner.query('UPDATE auth_sessions SET auth_level=\'password\',mfa_verified_at=NULL,step_up_verified_at=NULL WHERE token_hash=$1', [tokenDigest(flowToken)]);
            const recoveryElevated = await postMfa('recovery.consume', flowToken, { code: firstCodes[0] });
            assert.equal(recoveryElevated.response.status, 200);
            assert.equal(recoveryElevated.body.status, 'elevated');
            const recoveryReplay = await postMfa('recovery.consume', flowToken, { code: firstCodes[0] });
            assert.equal(recoveryReplay.response.status, 401);
            assert.equal(recoveryReplay.body.error.code, 'INVALID_RECOVERY_CODE');

            const steppedUp = await postMfa('step-up.verify', flowToken, { code: totpCode(flowSecret, baseTime + 90000) }, environment.APP_BASE_URL, baseTime + 90000);
            assert.equal(steppedUp.response.status, 200);
            const { requireAdminStepUp } = require('../../lib/server/authorization');
            const elevatedUser = (await require('../../lib/server/session').createSessionService({ database }).me(flowToken)).user;
            assert.equal(elevatedUser.authLevel, 'mfa');
            assert.doesNotThrow(() => requireAdminStepUp(elevatedUser));

            const secondIssue = await postMfa('recovery.issue', flowToken, { code: totpCode(flowSecret, baseTime + 120000) }, environment.APP_BASE_URL, baseTime + 120000);
            assert.equal(secondIssue.response.status, 200);
            assert.equal(secondIssue.body.codes.length, 10);
            const oldCodeAfterResign = await postMfa('recovery.consume', flowPeerToken, { code: firstCodes[1] });
            assert.equal(oldCodeAfterResign.response.status, 401);
            assert.equal(oldCodeAfterResign.body.error.code, 'INVALID_RECOVERY_CODE');
            persistedCodes = await owner.query('SELECT code_digest FROM admin_recovery_codes WHERE user_id=$1 AND consumed_at IS NULL', [flowAdminId]);
            assert.equal(persistedCodes.rowCount, 10);
            assert.ok(secondIssue.body.codes.every((code) => persistedCodes.rows.some((row) => row.code_digest === recoveryDigest(code))));
            assert.ok(firstCodes.every((code) => !persistedCodes.rows.some((row) => row.code_digest === recoveryDigest(code))));
            record('真实PG MFA HTTP 恢复码仅由签发响应返回且数据库仅存摘要；消费一次性、step-up 门禁与重签作废旧码通过', 'passed');

            const revokedHttp = await postMfa('factor.revoke', flowToken, { code: totpCode(flowSecret, baseTime + 150000) }, environment.APP_BASE_URL, baseTime + 150000);
            assert.equal(revokedHttp.response.status, 200);
            assert.equal(revokedHttp.body.status, 'revoked');
            const revokeState = await owner.query(`SELECT f.revoked_at,
                (SELECT count(*)::int FROM admin_recovery_codes WHERE user_id=$1) AS recovery_count,
                (SELECT count(*)::int FROM auth_sessions WHERE user_id=$1 AND revoked_at IS NULL) AS active_sessions
                FROM admin_mfa_factors f WHERE f.user_id=$1`, [flowAdminId]);
            assert.ok(revokeState.rows[0].revoked_at);
            assert.equal(revokeState.rows[0].recovery_count, 0);
            assert.equal(revokeState.rows[0].active_sessions, 0);
            const afterRevocation = await postMfa('status', flowToken);
            assert.equal(afterRevocation.response.status, 401);
            record('真实PG MFA HTTP 因子撤销清空恢复码并撤销管理员全部会话，撤销后原 Cookie 立即失效', 'passed');
        } finally {
            await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[flowAdminId, flowUserId]]);
        }
    } finally {
        await owner.query('DELETE FROM users WHERE id=$1', [userId]);
    }
}

module.exports = { checkAdminMfa };
