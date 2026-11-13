const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { drizzle } = require('drizzle-orm/node-postgres');
const { createRegistrationService, tokenDigest } = require('../../lib/server/registration');
const { createRegistrationHandler: handler } = require('../../lib/server/registrationHttp');
const createRegistrationHandler = (action, options) => handler(action, { ...options,
    environment: { NODE_ENV: 'development', APP_BASE_URL: 'http://localhost', AUTH_ALLOW_LOCAL_HTTP: '1' } });
const { createTestOutbox } = require('./registration-outbox.cjs');

async function checkRegistration(pool, record) {
    const database = drizzle(pool);
    const outbox = createTestOutbox();
    const logs = [];
    const sink = { info: (v) => logs.push(v), warn: (v) => logs.push(v), error: (v) => logs.push(v) };
    const service = createRegistrationService({ database, mailer: outbox, auditSink: sink });
    const prefix = randomBytes(8).toString('hex');
    const password = `Synthetic-only-${randomBytes(12).toString('hex')}`;
    const email = (name) => `${prefix}.${name}@example.test`;
    const register = (name) => service.register({ email: email(name), password });
    const row = async (name) => (await pool.query('SELECT * FROM users WHERE email=$1', [email(name)])).rows[0];
    const verification = async (id) => (await pool.query('SELECT * FROM email_verification_tokens WHERE user_id=$1', [id])).rows[0];
    const message = (name) => outbox.messages.find((entry) => entry.email === email(name));
    const freshWindow = async (bucket) => pool.query("UPDATE auth_rate_limits SET window_start=clock_timestamp()-interval '2 minutes' WHERE bucket=$1", [bucket]);
    const req = (input) => new Request('http://localhost/api/auth', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost' }, body: JSON.stringify(input) });
    const http = (action, db = database, mailer = outbox) => createRegistrationHandler(action, { database: db, mailer, sink });
    let response = await http('register')(req({ email: `  ${email('success').toUpperCase()}  `, password }));
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { status: 'accepted' });
    assert.equal(response.headers.get('set-cookie'), null);
    const user = await row('success');
    assert.equal(user.role, 'user');
    assert.equal(user.email_verified_at, null);
    assert.notEqual(user.password_hash, password);
    assert.match(user.password_hash, /^scrypt:32768:8:3:/);
    const tokenRow = await verification(user.id);
    assert.equal(tokenRow.token_hash, tokenDigest(message('success').token));
    assert.equal(tokenRow.token_hash.length, 64);
    assert.ok(tokenRow.expires_at - tokenRow.created_at >= 899000 && tokenRow.expires_at - tokenRow.created_at < 901000);
    assert.equal(tokenRow.consumed_at, null);
    record('注册HTTP 202/规范邮箱/密码哈希/仅令牌hash/15分钟有效期/无Cookie', 'passed');

    const duplicate = await service.register({ email: email('success').toUpperCase(), password });
    assert.deepEqual(duplicate, { status: 'accepted' });
    assert.equal(outbox.messages.length, 1);
    const duplicateHttp = await http('register')(req({ email: email('success').toUpperCase(), password }));
    assert.equal(duplicateHttp.status, 202);
    assert.deepEqual(await duplicateHttp.json(), { status: 'accepted' });
    assert.deepEqual(await row('success'), user);
    const concurrent = await Promise.all(Array.from({ length: 4 }, (_, i) => service.register({ email: i % 2 ? email('race').toUpperCase() : email('race'), password })));
    assert.ok(concurrent.every((entry) => entry.status === 'accepted'));
    assert.equal(outbox.messages.filter((entry) => entry.email === email('race')).length, 1);
    assert.equal((await pool.query('SELECT count(*)::int n FROM users WHERE email=$1', [email('race')])).rows[0].n, 1);
    const direct = await Promise.allSettled(Array.from({ length: 2 }, () => pool.query('INSERT INTO users(email,password_hash) VALUES($1,$2)', [email('direct-race'), user.password_hash])));
    assert.equal(direct.filter((entry) => entry.status === 'fulfilled').length, 1);
    assert.equal(direct.filter((entry) => entry.status === 'rejected' && entry.reason.code === '23505').length, 1);
    await assert.rejects(pool.query('INSERT INTO users(email,password_hash) VALUES($1,$2)', [email('upper').toUpperCase(), user.password_hash]), (e) => e.code === '23514');
    record('重复/大小写/4并发注册稳定响应及直接数据库23505唯一冲突', 'passed');

    for (const extra of [{ role: 'admin' }, { verified: true }, { emailVerifiedAt: new Date().toISOString() }]) {
        const denied = await http('register')(req({ email: email('injected'), password, ...extra }));
        assert.equal(denied.status, 400);
    }
    assert.equal(await row('injected'), undefined);
    record('客户端role/verified等注入拒绝且不落库', 'passed');

    const missingMailer = await createRegistrationHandler('register', { database, sink })(req({ email: email('no-mail'), password }));
    assert.equal(missingMailer.status, 503);
    assert.equal(await row('no-mail'), undefined);
    const token = message('success').token;
    const unknown = randomBytes(32).toString('base64url');
    const wrong = await http('verify-email')(req({ token: unknown }));
    assert.equal(wrong.status, 202);
    assert.equal((await row('success')).email_verified_at, null);
    response = await http('verify-email')(req({ token }));
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), await wrong.json());
    const verified = await row('success');
    const consumed = await verification(user.id);
    assert.ok(verified.email_verified_at && consumed.consumed_at);
    await service.verifyEmail({ token });
    assert.deepEqual(await row('success'), verified);
    assert.deepEqual(await verification(user.id), consumed);
    record('验证成功/错token稳定响应/一次性重复消费不改变状态', 'passed');

    const raceUser = await row('race');
    const raceToken = message('race').token;
    await Promise.all(Array.from({ length: 4 }, () => service.verifyEmail({ token: raceToken })));
    const raceConsumed = await verification(raceUser.id);
    assert.ok(raceConsumed.consumed_at);
    const beforeReplay = await row('race');
    await service.verifyEmail({ token: raceToken });
    assert.deepEqual(await verification(raceUser.id), raceConsumed);
    assert.deepEqual(await row('race'), beforeReplay);
    record('4并发验证原子消费且后续重放不改时间戳', 'passed');

    await register('expired');
    const expiredUser = await row('expired');
    await pool.query("UPDATE email_verification_tokens SET created_at=clock_timestamp()-interval '20 minutes', expires_at=clock_timestamp()-interval '1 minute' WHERE user_id=$1", [expiredUser.id]);
    assert.deepEqual(await service.verifyEmail({ token: message('expired').token }), { status: 'accepted' });
    assert.equal((await row('expired')).email_verified_at, null);
    assert.equal((await verification(expiredUser.id)).consumed_at, null);
    record('PostgreSQL过期token不可消费且不验证用户', 'passed');

    const failing = createRegistrationService({ database, auditSink: sink, mailer: {
        kind: 'test-memory-outbox', async sendVerification() { throw new Error('合成投递失败'); },
    } });
    await assert.rejects(failing.register({ email: email('mail-fail'), password }));
    assert.equal(await row('mail-fail'), undefined);
    assert.equal((await pool.query('SELECT count(*)::int n FROM email_verification_tokens t LEFT JOIN users u ON u.id=t.user_id WHERE u.id IS NULL')).rows[0].n, 0);
    record('邮件替身故障导致用户/令牌事务整体回滚', 'passed');

    await register('rollback');
    const rollbackUser = await row('rollback');
    const rollbackToken = message('rollback').token;
    const before = await verification(rollbackUser.id);
    const failAfterConsume = {
        execute: (...args) => database.execute(...args),
        transaction: (callback) => database.transaction((tx) => {
            let statements = 0;
            return callback({ execute: async (...args) => {
                if (++statements === 2) throw new Error('合成更新失败');
                return tx.execute(...args);
            } });
        }),
    };
    const failure = await http('verify-email', failAfterConsume)(req({ token: rollbackToken }));
    assert.equal(failure.status, 503);
    assert.deepEqual(await verification(rollbackUser.id), before);
    assert.equal((await row('rollback')).email_verified_at, null);
    await service.verifyEmail({ token: rollbackToken });
    assert.ok((await row('rollback')).email_verified_at);
    record('真实事务在token已UPDATE后注入故障回滚，原token仍可验证', 'passed');

    await freshWindow('verify-email');
    const rateResults = await Promise.all(Array.from({ length: 65 }, () => http('verify-email')(req({ token: unknown }))));
    assert.equal(rateResults.filter((entry) => entry.status === 202).length, 60);
    assert.equal(rateResults.filter((entry) => entry.status === 429).length, 5);
    assert.equal(rateResults.find((entry) => entry.status === 429).headers.get('retry-after'), '60');
    assert.equal((await pool.query("SELECT hits FROM auth_rate_limits WHERE bucket='verify-email'")).rows[0].hits, 60);
    await freshWindow('verify-email');
    assert.deepEqual(await service.verifyEmail({ token: unknown }), { status: 'accepted' });
    await pool.query("UPDATE auth_rate_limits SET hits=60 WHERE bucket='register'");
    const throttled = await http('register')(req({ email: email('throttled'), password }));
    assert.equal(throttled.status, 429);
    assert.equal(await row('throttled'), undefined);
    await freshWindow('register');
    record('数据库共享原子限流65并发恰好60通过/5拒绝及窗口恢复/注册超限不落库', 'passed');

    const persisted = JSON.stringify((await pool.query('SELECT row_to_json(u) AS data FROM users u')).rows)
        + JSON.stringify((await pool.query('SELECT row_to_json(t) AS data FROM email_verification_tokens t')).rows);
    assert.ok(!persisted.includes(password));
    for (const entry of outbox.messages) assert.ok(!persisted.includes(entry.token));
    const output = logs.join('') + await failure.text() + await throttled.text();
    for (const value of [password, ...outbox.messages.flatMap((entry) => [entry.email, entry.token])]) assert.ok(!output.includes(value));
    const audits = logs.map((line) => JSON.parse(line)).filter((entry) => entry.event === 'audit');
    assert.ok(audits.length > 0 && audits.every((entry) => entry.action && entry.outcome === 'accepted' && entry.requestId));
    record('真实数据库无明文密码/token，HTTP及实际序列化日志无秘密，审计字段完整', 'passed');
}
module.exports = { checkRegistration };
