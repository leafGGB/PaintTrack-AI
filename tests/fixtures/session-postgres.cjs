const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { drizzle } = require('drizzle-orm/node-postgres');
const { hashPassword, tokenDigest } = require('../../lib/server/registration');
const { createSessionService, loginRateLimit, COOKIE_NAME } = require('../../lib/server/session');
const { createSessionHandler } = require('../../lib/server/sessionHttp');
async function checkSessions(pool, record) {
    const database = drizzle(pool);
    const logs = [];
    const sink = { info: (v) => logs.push(v), warn: (v) => logs.push(v), error: (v) => logs.push(v) };
    const service = createSessionService({ database, sink });
    const password = `Synthetic-${randomBytes(12).toString('hex')}`;
    const email = `session-${randomBytes(6).toString('hex')}@example.test`;
    const hash = await hashPassword(password);
    const user = (await pool.query('INSERT INTO users(email,password_hash,email_verified_at) VALUES($1,$2,clock_timestamp()) RETURNING id,email,role,created_at,email_verified_at', [email, hash])).rows[0];
    const sessionUser = { id: user.id, email: user.email, role: user.role, authLevel: 'password', mfaVerifiedAt: null, stepUpVerifiedAt: null, emailVerified: true, createdAt: user.created_at };
    // 经过 HTTP JSON 边界后 Date 必然序列化为 ISO 字符串，因此这里单独准备 JSON 形态的期望值；
    // 服务层直调仍按 Date 比较，两条路径各自断言自己真实的契约。
    const sessionBody = { user: { ...sessionUser, createdAt: new Date(sessionUser.createdAt).toISOString() } };
    const loginUser = { id: user.id, role: user.role };
    const unverified = `unverified-${randomBytes(6).toString('hex')}@example.test`;
    await pool.query('INSERT INTO users(email,password_hash) VALUES($1,$2)', [unverified, hash]);
    const sessionRow = async (token) => (await pool.query('SELECT * FROM auth_sessions WHERE token_hash=$1', [tokenDigest(token)])).rows[0];
    const login = (oldToken) => service.login({ email, password }, { oldToken });
    await pool.query("UPDATE auth_rate_limits SET window_start=clock_timestamp()-interval '2 minutes' WHERE bucket='login'");
    const first = await login();
    assert.equal(user.role, 'user');
    assert.deepEqual(first.user, loginUser);
    assert.deepEqual(await service.me(first.token), { user: sessionUser });
    const stored = await sessionRow(first.token);
    assert.equal(stored.token_hash, tokenDigest(first.token));
    assert.equal(stored.expires_at - stored.created_at >= 28800000, true);
    assert.ok(stored.expires_at - stored.created_at < 28801000);
    assert.equal(stored.revoked_at, null);
    await service.me(first.token);
    assert.deepEqual(await sessionRow(first.token), stored);
    record('真实PG登录/me仅user.id及role/默认user/256位token仅hash/固定8小时且GET不续期', 'passed');
    const second = await login(first.token);
    assert.notEqual(first.token, second.token);
    assert.ok((await sessionRow(first.token)).revoked_at);
    assert.deepEqual(await service.me(first.token), { user: null });
    assert.deepEqual(await service.me(second.token), { user: sessionUser });
    record('成功重新登录生成新token并事务撤销原session，旧Cookie重放无效', 'passed');

    const wrapped = { execute: (...args) => database.execute(...args), transaction: (callback) => database.transaction(async (tx) => {
        const result = await callback(tx);
        throw new Error(`合成提交前失败 ${result.token || ''} ${email} ${password}`);
    }) };
    const before = await sessionRow(second.token);
    const count = (await pool.query('SELECT count(*)::int n FROM auth_sessions')).rows[0].n;
    await assert.rejects(createSessionService({ database: wrapped, sink }).login({ email, password }, { oldToken: second.token }));
    assert.deepEqual(await sessionRow(second.token), before);
    assert.equal((await pool.query('SELECT count(*)::int n FROM auth_sessions')).rows[0].n, count);
    assert.deepEqual(await service.me(second.token), { user: sessionUser });
    await assert.rejects(createSessionService({ database: wrapped, sink }).logout(second.token));
    assert.deepEqual(await sessionRow(second.token), before);
    record('真实事务在新session插入/旧session撤销后异常整体回滚，登出失败回滚', 'passed');

    await Promise.all(Array.from({ length: 6 }, () => service.logout(second.token)));
    const revoked = await sessionRow(second.token);
    assert.ok(revoked.revoked_at);
    await service.logout(second.token);
    assert.deepEqual(await sessionRow(second.token), revoked);
    assert.deepEqual(await service.me(second.token), { user: null });
    const third = await login();
    await pool.query("UPDATE auth_sessions SET created_at=clock_timestamp()-interval '10 hours',expires_at=clock_timestamp()-interval '1 minute' WHERE token_hash=$1", [tokenDigest(third.token)]);
    assert.deepEqual(await service.me(third.token), { user: null });
    assert.deepEqual(await service.me(randomBytes(32).toString('base64url')), { user: null });
    assert.deepEqual(await service.me('invalid'), { user: null });
    record('6并发撤销幂等/重放无效/过期伪造session拒绝', 'passed');

    const raceBase = await login();
    const [racingFirst, racingSecond] = await Promise.all([login(raceBase.token), login(raceBase.token), service.logout(raceBase.token)]);
    assert.notEqual(racingFirst.token, racingSecond.token);
    assert.deepEqual(await service.me(raceBase.token), { user: null });
    assert.deepEqual(await service.me(racingFirst.token), { user: sessionUser });
    assert.deepEqual(await service.me(racingSecond.token), { user: sessionUser });
    await service.logout(racingFirst.token);
    assert.deepEqual(await service.me(racingFirst.token), { user: null });
    assert.deepEqual(await service.me(racingSecond.token), { user: sessionUser });
    record('并发两次登录与旧token登出均提交，新token独立且登出仅撤销所带会话', 'passed');

    const environment = { NODE_ENV: 'production', APP_BASE_URL: 'https://session.test' };
    const handler = createSessionHandler('login', { database, sink, environment });
    const meHandler = createSessionHandler('me', { database, sink, environment });
    const req = (input) => new Request('https://session.test/api/auth/login', { method: 'POST',
        headers: { origin: 'https://session.test', 'content-type': 'application/json' }, body: JSON.stringify(input) });
    for (const input of [{ email, password: `${password}-wrong` }, { email: unverified, password }, { email: `unknown-${email}`, password }]) {
        const response = await handler(req(input));
        assert.equal(response.status, 401);
        const body = await response.json();
        assert.equal(body.error.code, 'INVALID_CREDENTIALS');
        assert.equal(body.error.message, 'Request failed');
        assert.equal(response.headers.get('set-cookie'), null);
    }
    const secure = await handler(req({ email, password }));
    assert.equal(secure.status, 200);
    assert.match(secure.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Secure; Max-Age=28800/);
    assert.deepEqual(await secure.json(), { user: loginUser });
    const secureToken = secure.headers.get('set-cookie').split(';')[0].slice(`${COOKIE_NAME}=`.length);
    const meResponse = await meHandler(new Request('https://session.test/api/auth/me', { headers: { cookie: `${COOKIE_NAME}=${secureToken}` } }));
    const meBody = await meResponse.json();
    assert.deepEqual(meBody, sessionBody);
    assert.match(meBody.user.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(meResponse.headers.get('cache-control'), 'no-store');
    record('真实PG未验证/错密码/未知邮箱稳定401、最小登录身份与me账户身份字段及生产HTTPS Cookie Secure', 'passed');

    await pool.query("UPDATE auth_rate_limits SET window_start=clock_timestamp()-interval '2 minutes' WHERE bucket='login'");
    const peers = Array.from({ length: 3 }, () => drizzle(pool));
    const rates = await Promise.allSettled(Array.from({ length: 35 }, (_, i) => loginRateLimit(peers[i % peers.length])));
    assert.equal(rates.filter((v) => v.status === 'fulfilled').length, 30);
    assert.equal(rates.filter((v) => v.status === 'rejected' && v.reason.code === 'RATE_LIMITED').length, 5);
    const limited = await handler(req({ email, password }));
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '60');
    assert.equal((await pool.query("SELECT hits FROM auth_rate_limits WHERE bucket='login'")).rows[0].hits, 30);
    await pool.query("UPDATE auth_rate_limits SET window_start=clock_timestamp()-interval '2 minutes' WHERE bucket='login'");
    record('3服务实例共享PG限流35并发恰好30通过5拒绝，HTTP429且窗口恢复', 'passed');

    for (const [text, values, code] of [
        ['INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,clock_timestamp()+interval \'1 hour\')', [user.id, 'not-a-hash'], '23514'],
        ['INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,clock_timestamp()+interval \'1 hour\')', [user.id, stored.token_hash], '23505'],
        ['INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,clock_timestamp()-interval \'1 hour\')', [user.id, tokenDigest('expired')], '23514'],
        ['INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES($1,$2,clock_timestamp()+interval \'1 hour\')', ['00000000-0000-4000-8000-000000000000', tokenDigest('orphan')], '23503'],
    ]) await assert.rejects(pool.query(text, values), (error) => error.code === code);
    record('session数据库hash格式/唯一/到期/CASCADE外键约束负例', 'passed');
    const persisted = JSON.stringify((await pool.query('SELECT row_to_json(s) FROM auth_sessions s')).rows);
    for (const secret of [first.token, second.token, third.token, password]) assert.ok(!persisted.includes(secret));
    for (const secret of [first.token, second.token, third.token, password, email, unverified, hash]) assert.ok(!logs.join('').includes(secret));
    record('真实PG session行无token明文，错误和审计序列化日志无凭据邮箱hash或SQL', 'passed');
}
module.exports = { checkSessions };
