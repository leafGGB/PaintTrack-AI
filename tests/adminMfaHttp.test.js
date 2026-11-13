const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { createAdminMfaHandler } = require('../lib/server/adminMfaHttp');

const environment = { NODE_ENV: 'development', APP_BASE_URL: 'http://localhost:3212', AUTH_ALLOW_LOCAL_HTTP: '1' };
const origin = environment.APP_BASE_URL;
const token = randomBytes(32).toString('base64url');
const quiet = { info() {}, warn() {}, error() {} };
const encryptionKey = randomBytes(32).toString('hex');
const request = (body, headers = {}, method = 'POST', action = 'session/elevate') => new Request(`${origin}/api/auth/mfa/${action}`, {
    method,
    headers: { origin, cookie: `painttrack_session=${token}`, 'content-type': 'application/json', ...headers },
    ...(method !== 'GET' ? { body: JSON.stringify(body) } : {}),
});

function dbFor(user) {
    return {
        async execute(query) {
            const text = query.queryChunks.map((chunk) => typeof chunk === 'string' ? chunk : '').join('');
            if (text.includes('auth_rate_limits')) return { rows: [{ hits: 1 }] };
            return { rows: [{ id: user?.id || 'user-1', email: 'admin@example.test', role: user?.role || 'admin', auth_level: 'password', email_verified_at: new Date(), created_at: new Date() }] };
        },
        async transaction(callback) { return callback({ async execute() { return { rows: [] }; } }); },
    };
}

test('MFA HTTP 先校验 Origin、方法和登录状态，不读取非法请求数据库', async () => {
    let calls = 0;
    const handler = createAdminMfaHandler('session.elevate', { environment: { ...environment, PAINTTRACK_MFA_ENCRYPTION_KEY: encryptionKey }, sink: quiet, database: () => { calls += 1; return dbFor({ role: 'admin' }); } });
    assert.equal((await handler(request({ code: '123456' }, { origin: 'http://evil.test' }))).status, 403);
    assert.equal((await handler(request({ code: '123456' }, {}, 'GET'))).status, 405);
    assert.equal(calls, 0);
});

test('普通用户不能调用管理员 MFA，错误输入固定返回且不回显异常', async () => {
    const handler = createAdminMfaHandler('session.elevate', { environment: { ...environment, PAINTTRACK_MFA_ENCRYPTION_KEY: encryptionKey }, sink: quiet, database: () => dbFor({ id: 'user-1', role: 'user' }) });
    const forbidden = await handler(request({ code: '123456' }));
    assert.equal(forbidden.status, 403);
    assert.equal((await forbidden.json()).error.code, 'FORBIDDEN');
    const invalid = await handler(request({ code: 'x'.repeat(5000) }));
    assert.ok([400, 413].includes(invalid.status));
});

test('step-up 缺少因子时拒绝，不调用 MFA 状态提升', async () => {
    const database = dbFor({ role: 'admin' });
    const handler = createAdminMfaHandler('step-up.verify', { environment: { ...environment, PAINTTRACK_MFA_ENCRYPTION_KEY: encryptionKey }, sink: quiet, database });
    const response = await handler(request({}, {}, 'POST', 'step-up/verify'));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'INVALID_INPUT');
});

test('step-up 仅在有效 TOTP 提交后更新会话状态', async () => {
    let elevated = false;
    const database = {
        async execute(query) {
            const text = query.queryChunks.map((chunk) => typeof chunk === 'string' ? chunk : Array.isArray(chunk?.value) ? chunk.value.join('') : '').join('');
            if (text.includes('auth_rate_limits')) return { rows: [{ hits: 1 }] };
            return { rows: [{ id: 'admin-1', email: 'admin@example.test', role: 'admin', auth_level: 'mfa', email_verified_at: new Date(), created_at: new Date(), mfa_verified_at: new Date() }] };
        },
        async transaction(callback) {
            return callback({ async execute(query) {
                const text = query.queryChunks.map((chunk) => typeof chunk === 'string' ? chunk : Array.isArray(chunk?.value) ? chunk.value.join('') : '').join('');
                if (text.includes('SELECT id,secret_ciphertext')) return { rows: [] };
                if (text.includes('UPDATE admin_recovery_codes')) return { rows: [] };
                elevated = true;
                return { rows: [{ user_id: 'admin-1' }] };
            } });
        },
    };
    const handler = createAdminMfaHandler('step-up.verify', { environment: { ...environment, PAINTTRACK_MFA_ENCRYPTION_KEY: encryptionKey }, sink: quiet, database });
    const response = await handler(request({ code: '123456' }, {}, 'POST', 'step-up/verify'));
    assert.equal(response.status, 401);
    assert.equal(elevated, false);
});

test('MFA 管理请求拒绝缺失、非法和多余字段的证明输入', async () => {
    const handler = createAdminMfaHandler('factor.revoke', { environment: { ...environment, PAINTTRACK_MFA_ENCRYPTION_KEY: encryptionKey }, sink: quiet, database: dbFor({ role: 'admin' }) });
    for (const body of [{}, { code: '123456', extra: true }, { code: '12345' }, { code: '!!!' }]) {
        const response = await handler(request(body, {}, 'POST', 'factor/revoke'));
        assert.equal(response.status, 400);
        assert.equal((await response.json()).error.code, 'INVALID_INPUT');
    }
    const unusedRecoveryShape = await handler(request({ code: 'A'.repeat(16) }, {}, 'POST', 'factor/revoke'));
    assert.equal(unusedRecoveryShape.status, 401);
    assert.equal((await unusedRecoveryShape.json()).error.code, 'INVALID_MFA_PROOF');
});

test('内部异常不回显密钥、SQL 或错误正文', async () => {
    const secret = 'ciphertext secret SELECT password_hash';
    const lines = [];
    const sink = { info: (v) => lines.push(v), warn: (v) => lines.push(v), error: (v) => lines.push(v) };
    const handler = createAdminMfaHandler('session.elevate', { environment: { ...environment, PAINTTRACK_MFA_ENCRYPTION_KEY: encryptionKey }, sink, database: () => ({
        async execute() { throw new Error(secret); },
        async transaction() { throw new Error(secret); },
    }) });
    const response = await handler(request({ code: '123456' }));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'MFA_UNAVAILABLE');
    assert.ok(!lines.join('').includes(secret));
});
