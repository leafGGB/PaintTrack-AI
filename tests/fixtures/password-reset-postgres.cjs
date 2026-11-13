const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { drizzle } = require('drizzle-orm/node-postgres');
const { createPasswordResetService } = require('../../lib/server/passwordReset');
const { createPasswordResetHandler } = require('../../lib/server/passwordResetHttp');
const { createSessionService } = require('../../lib/server/session');
const { hashPassword, verifyPassword } = require('../../lib/server/passwords');
const { tokenDigest } = require('../../lib/server/registration');
const { createTestOutbox } = require('./registration-outbox.cjs');

const environment = { NODE_ENV: 'development', APP_BASE_URL: 'http://localhost', AUTH_ALLOW_LOCAL_HTTP: '1' };
const request = (url, body) => new Request(url, { method: 'POST', headers: {
    'content-type': 'application/json', origin: 'http://localhost',
}, body: JSON.stringify(body) });

async function checkPasswordReset(pool, record) {
    const database = drizzle(pool);
    const outbox = createTestOutbox();
    const logs = [];
    const sink = { info: (value) => logs.push(value), warn: (value) => logs.push(value), error: (value) => logs.push(value) };
    const mailer = { ...outbox, async sendPasswordReset(message) {
        outbox.messages.push({ ...message, type: 'password-reset' });
    } };
    const service = createPasswordResetService({ database, mailer, sink });
    const prefix = randomBytes(8).toString('hex');
    const email = (name) => `${prefix}.${name}@example.test`;
    const makeUser = async (name) => {
        const password = `Old-password-${randomBytes(12).toString('hex')}`;
        const passwordHash = await hashPassword(password);
        const row = (await pool.query(`INSERT INTO users(email,password_hash,email_verified_at)
            VALUES($1,$2,clock_timestamp()) RETURNING id,password_hash`, [email(name), passwordHash])).rows[0];
        return { ...row, password };
    };
    const userRow = async (userId) => (await pool.query('SELECT * FROM users WHERE id=$1', [userId])).rows[0];
    const resetRows = async (userId) => (await pool.query('SELECT * FROM password_reset_tokens WHERE user_id=$1 ORDER BY created_at,id', [userId])).rows;
    const http = (action, db = database, sender = mailer) => createPasswordResetHandler(action, {
        database: db, mailer: sender, sink, environment,
    });
    const requestHandler = http('request');

    assert.equal((await pool.query("SELECT count(*)::int AS count FROM auth_rate_limits WHERE bucket='password-reset'")).rows[0].count, 0);
    const unknownResponse = await requestHandler(request('http://localhost/api/auth/password-reset', { email: email('missing') }));
    const user = await makeUser('primary');
    const knownResponse = await requestHandler(request('http://localhost/api/auth/password-reset', { email: email('primary').toUpperCase() }));
    assert.equal(unknownResponse.status, 202);
    assert.equal(knownResponse.status, 202);
    const unknownBody = await unknownResponse.json();
    const knownBody = await knownResponse.json();
    assert.deepEqual(unknownBody, knownBody);
    assert.deepEqual(knownBody, { status: 'accepted' });
    assert.equal(outbox.messages.length, 1);
    const firstMessage = outbox.messages[0];
    assert.equal(firstMessage.email, email('primary'));
    const firstTokenRow = (await resetRows(user.id))[0];
    assert.equal(firstTokenRow.token_hash, tokenDigest(firstMessage.token));
    assert.notEqual(firstTokenRow.token_hash, firstMessage.token);
    assert.equal(firstTokenRow.token_hash.length, 64);
    assert.ok(firstTokenRow.expires_at - firstTokenRow.created_at >= 1_799_000
        && firstTokenRow.expires_at - firstTokenRow.created_at < 1_801_000);
    assert.equal(firstTokenRow.consumed_at, null);
    record('真实PG邮箱枚举统一202/仅已验证账户写入SHA-256 token hash/30分钟有效期', 'passed');

    const failingMailer = { kind: 'test-memory-outbox', async sendPasswordReset() { throw new Error('合成邮件投递失败'); } };
    await assert.rejects(createPasswordResetService({ database, mailer: failingMailer, sink })
        .request({ email: email('primary') }));
    assert.deepEqual(await resetRows(user.id), [firstTokenRow]);
    assert.equal((await resetRows(user.id))[0].consumed_at, null);
    assert.equal(outbox.messages.length, 1);
    record('邮件替身失败回滚旧token消费和新token写入', 'passed');

    const requestAgain = await requestHandler(request('http://localhost/api/auth/password-reset', { email: email('primary') }));
    assert.equal(requestAgain.status, 202);
    const primaryRows = await resetRows(user.id);
    assert.equal(primaryRows.length, 2);
    assert.ok(primaryRows[0].consumed_at);
    assert.equal(primaryRows[1].token_hash, tokenDigest(outbox.messages[1].token));
    assert.equal(primaryRows[1].consumed_at, null);

    const sessionTokens = [randomBytes(32).toString('base64url'), randomBytes(32).toString('base64url')];
    await Promise.all(sessionTokens.map((sessionToken) => pool.query(`INSERT INTO auth_sessions(user_id,token_hash,expires_at)
        VALUES($1,$2,clock_timestamp()+interval '8 hours')`, [user.id, tokenDigest(sessionToken)])));
    const previouslyRevoked = randomBytes(32).toString('base64url');
    await pool.query(`INSERT INTO auth_sessions(user_id,token_hash,expires_at,revoked_at)
        VALUES($1,$2,clock_timestamp()+interval '8 hours',clock_timestamp())`, [user.id, tokenDigest(previouslyRevoked)]);
    const beforePassword = await userRow(user.id);
    const beforeSessions = await pool.query('SELECT token_hash,revoked_at FROM auth_sessions WHERE user_id=$1 ORDER BY token_hash', [user.id]);
    const rollbackDatabase = {
        execute: (...args) => database.execute(...args),
        transaction: (callback) => database.transaction(async (tx) => {
            const result = await callback(tx);
            throw new Error(`合成提交前失败 ${result?.status || ''}`);
        }),
    };
    const rollbackService = createPasswordResetService({ database: rollbackDatabase, sink });
    const latestToken = outbox.messages[1].token;
    await assert.rejects(rollbackService.consume({ token: latestToken, password: 'New-secure-password-2026' }), /合成提交前失败/);
    assert.deepEqual(await userRow(user.id), beforePassword);
    assert.deepEqual(await pool.query('SELECT token_hash,revoked_at FROM auth_sessions WHERE user_id=$1 ORDER BY token_hash', [user.id]), beforeSessions);
    assert.equal((await resetRows(user.id))[1].consumed_at, null);
    record('真实PG token消费/密码更新/会话撤销在事务提交失败时整体回滚', 'passed');

    const newPassword = 'New-secure-password-2026';
    assert.deepEqual(await service.consume({ token: latestToken, password: newPassword }), { status: 'accepted' });
    const afterPassword = await userRow(user.id);
    assert.notEqual(afterPassword.password_hash, beforePassword.password_hash);
    assert.equal(await verifyPassword(newPassword, afterPassword.password_hash), true);
    assert.equal(await verifyPassword(user.password, afterPassword.password_hash), false);
    const afterSessions = await pool.query('SELECT token_hash,revoked_at FROM auth_sessions WHERE user_id=$1 ORDER BY token_hash', [user.id]);
    for (const session of afterSessions.rows.filter((row) => row.token_hash !== tokenDigest(previouslyRevoked))) assert.ok(session.revoked_at);
    assert.ok(afterSessions.rows.find((row) => row.token_hash === tokenDigest(previouslyRevoked)).revoked_at);
    assert.ok((await resetRows(user.id))[1].consumed_at);
    await assert.rejects(service.consume({ token: latestToken, password: 'Another-secure-password-2026' }),
        (error) => error.code === 'INVALID_RESET_TOKEN');
    const sessionService = createSessionService({ database, sink });
    for (const sessionToken of sessionTokens) assert.deepEqual(await sessionService.me(sessionToken), { user: null });
    record('真实PG密码更新后原密码失效/所有活跃session撤销/token一次性消费及旧Cookie无效', 'passed');

    const raceUser = await makeUser('race');
    const raceResponse = await requestHandler(request('http://localhost/api/auth/password-reset', { email: email('race') }));
    assert.equal(raceResponse.status, 202);
    const raceToken = outbox.messages.at(-1).token;
    const races = await Promise.allSettled(Array.from({ length: 2 }, () => service.consume({
        token: raceToken, password: 'Concurrent-reset-password-2026',
    })));
    assert.equal(races.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(races.filter((result) => result.status === 'rejected' && result.reason.code === 'INVALID_RESET_TOKEN').length, 1);
    assert.equal((await resetRows(raceUser.id))[0].consumed_at !== null, true);
    record('真实PG并发双重消费仅一个成功', 'passed');

    const expiredUser = await makeUser('expired');
    const expiredResponse = await requestHandler(request('http://localhost/api/auth/password-reset', { email: email('expired') }));
    assert.equal(expiredResponse.status, 202);
    const expiredToken = outbox.messages.at(-1).token;
    await pool.query(`UPDATE password_reset_tokens
        SET created_at=clock_timestamp()-interval '31 minutes', expires_at=clock_timestamp()-interval '1 second'
        WHERE user_id=$1`, [expiredUser.id]);
    const expiredHash = (await resetRows(expiredUser.id))[0];
    await assert.rejects(service.consume({ token: expiredToken, password: 'Expired-reset-password-2026' }),
        (error) => error.code === 'INVALID_RESET_TOKEN');
    assert.equal((await userRow(expiredUser.id)).password_hash, expiredUser.password_hash);
    assert.equal((await resetRows(expiredUser.id))[0].consumed_at, null);
    assert.ok(expiredHash.expires_at < new Date());
    record('真实PG过期token拒绝消费且不更新密码', 'passed');

    for (const [query, values] of [
        ['INSERT INTO password_reset_tokens(user_id,token_hash,expires_at) VALUES($1,$2,clock_timestamp()+interval \'1 hour\')', [user.id, 'not-a-hash']],
        ['INSERT INTO password_reset_tokens(user_id,token_hash,expires_at) VALUES($1,$2,clock_timestamp()+interval \'1 hour\')', ['00000000-0000-4000-8000-000000000000', tokenDigest('orphan-reset')]],
    ]) await assert.rejects(pool.query(query, values), (error) => ['23503', '23514'].includes(error.code));
    await assert.rejects(pool.query(`INSERT INTO auth_rate_limits(bucket,window_start,hits)
        VALUES('not-a-bucket',clock_timestamp(),1)`), (error) => error.code === '23514');
    record('真实PG重置token hash格式/外键和共享bucket CHECK负例', 'passed');

    await pool.query("UPDATE auth_rate_limits SET window_start=clock_timestamp()-interval '2 minutes' WHERE bucket='password-reset'");
    const limited = await Promise.all(Array.from({ length: 11 }, (_, index) => http('request')(
        request('http://localhost/api/auth/password-reset', { email: `limit-${index}-${prefix}@example.test` }))));
    assert.equal(limited.filter((response) => response.status === 202).length, 10);
    assert.equal(limited.filter((response) => response.status === 429).length, 1);
    assert.equal(limited.find((response) => response.status === 429).headers.get('retry-after'), '60');
    assert.equal((await pool.query("SELECT hits FROM auth_rate_limits WHERE bucket='password-reset'")).rows[0].hits, 10);
    await pool.query("UPDATE auth_rate_limits SET window_start=clock_timestamp()-interval '2 minutes' WHERE bucket='password-reset'");
    record('真实共享PG password-reset限流并发11次恰好10通过1拒绝且返回Retry-After', 'passed');

    const persisted = JSON.stringify((await pool.query('SELECT row_to_json(t) AS data FROM password_reset_tokens t')).rows)
        + JSON.stringify((await pool.query('SELECT row_to_json(u) AS data FROM users u')).rows)
        + JSON.stringify((await pool.query('SELECT row_to_json(s) AS data FROM auth_sessions s')).rows);
    const secrets = [user.password, newPassword, ...outbox.messages.map((message) => message.token)];
    for (const secret of secrets) assert.ok(!persisted.includes(secret));
    for (const secret of [...secrets, email('primary'), email('race'), email('expired')]) assert.ok(!logs.join('').includes(secret));
    record('真实PG行及审计日志不含明文密码/重置token/邮箱', 'passed');
}

module.exports = { checkPasswordReset };
