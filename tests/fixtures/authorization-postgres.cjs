const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { drizzle } = require('drizzle-orm/node-postgres');
const { hashPassword, tokenDigest } = require('../../lib/server/registration');
const { createSessionService } = require('../../lib/server/session');
const { createAuthorizationHandler } = require('../../lib/server/authorizationHttp');
async function checkAuthorization(pool, owner, record) {
    const database = drizzle(pool);
    const environment = { NODE_ENV: 'production', APP_BASE_URL: 'https://authorization.test' };
    const lines = [];
    const sink = { info: (v) => lines.push(v), warn: (v) => lines.push(v), error: (v) => lines.push(v) };
    const password = `Synthetic-${randomBytes(12).toString('hex')}`;
    const hash = await hashPassword(password);
    const users = [];
    for (let i = 0; i < 3; i++) {
        const email = `authorization-${randomBytes(6).toString('hex')}@example.test`;
        users.push((await pool.query('INSERT INTO users(email,password_hash,email_verified_at) VALUES($1,$2,clock_timestamp()) RETURNING id,email,role', [email, hash])).rows[0]);
    }
    assert.ok(users.every((u) => u.role === 'user'));
    await owner.query("UPDATE users SET role='admin' WHERE id=$1", [users[2].id]);
    await assert.rejects(owner.query("UPDATE users SET role='invalid' WHERE id=$1", [users[0].id]), (e) => e.code === '23514');
    await assert.rejects(owner.query('UPDATE users SET role=NULL WHERE id=$1', [users[0].id]), (e) => e.code === '23502');
    const service = createSessionService({ database, sink });
    await pool.query("UPDATE auth_rate_limits SET window_start=clock_timestamp()-interval '2 minutes' WHERE bucket='login'");
    const sessions = [];
    for (const user of users) sessions.push(await service.login({ email: user.email, password }));
    await pool.query("UPDATE auth_sessions SET auth_level='mfa', mfa_verified_at=clock_timestamp() WHERE token_hash=$1", [tokenDigest(sessions[2].token)]);
    const req = (token, headers = {}) => new Request(`${environment.APP_BASE_URL}/api/admin/summary`, { headers: {
        ...(token ? { cookie: `painttrack_session=${token}` } : {}), ...headers,
    } });
    const admin = createAuthorizationHandler('admin.summary', { database, environment, sink });
    const asset = createAuthorizationHandler('asset.read', { database, environment, sink });
    assert.equal((await admin(req(null, { 'x-role': 'admin' }))).status, 401);
    assert.equal((await admin(req(sessions[0].token, { 'x-role': 'admin', 'x-user-role': 'admin' }))).status, 403);
    const allowed = await admin(req(sessions[2].token));
    assert.equal(allowed.status, 200);
    assert.deepEqual(Object.keys(await allowed.json()), ['summary']);
    record('真实PG默认user/role约束/匿名401/伪造role无效/普通403/admin200', 'passed');
    const id = (await owner.query("INSERT INTO assets(owner_id,media_type,metadata) VALUES($1,'image',$2) RETURNING id", [users[0].id, { private: 'never-return' }])).rows[0].id;
    const read = (session, target = id) => asset(req(session?.token), { params: Promise.resolve({ id: target }) });
    assert.equal((await read(null)).status, 401);
    const own = await read(sessions[0]);
    assert.equal(own.status, 200);
    assert.deepEqual(Object.keys((await own.json()).asset), ['id', 'media_type', 'mime_type', 'size_bytes', 'status', 'created_at']);
    assert.equal((await read(sessions[1])).status, 404);
    assert.equal((await read(sessions[2])).status, 404);
    assert.equal((await read(sessions[0], randomUUID())).status, 404);
    record('真实assets本人200/第二用户404/admin跨用户404/不存在404/响应无存储键metadata', 'passed');
    // 软删除：Web 运行角色只被授予 status/updated_at/deleted_at 的列级 UPDATE，
    // 这一段同时证明"权限刚好够完成删除"和"权限不足以篡改对象元数据"。
    const storageKey = `users/${users[0].id}/assets/probe`;
    const deletable = (await owner.query(
        "INSERT INTO assets(owner_id,media_type,storage_key,status,size_bytes) VALUES($1,'image',$2,'ready',16) RETURNING id",
        [users[0].id, storageKey],
    )).rows[0].id;
    const remove = createAuthorizationHandler('asset.delete', { database, environment, sink });
    const del = (session, target = deletable, origin = environment.APP_BASE_URL) => remove(
        new Request(`${environment.APP_BASE_URL}/api/assets/${target}`, {
            method: 'DELETE',
            headers: {
                ...(session ? { cookie: `painttrack_session=${session.token}` } : {}),
                ...(origin ? { origin } : {}),
            },
        }),
        { params: Promise.resolve({ id: target }) },
    );
    assert.equal((await del(sessions[0], deletable, null)).status, 403);
    assert.equal((await del(sessions[0], deletable, 'http://evil.test')).status, 403);
    assert.equal((await del(sessions[1])).status, 404);
    assert.equal((await del(sessions[2])).status, 404);
    assert.equal((await del(sessions[0], randomUUID())).status, 404);
    assert.equal((await del(sessions[0], id)).status, 409);
    assert.equal((await owner.query("SELECT status FROM assets WHERE id=$1", [deletable])).rows[0].status, 'ready');
    record('真实PG删除拒绝缺失/跨站Origin、他人资产、admin跨用户、不存在UUID与pending状态', 'passed');

    const removed = await del(sessions[0]);
    assert.equal(removed.status, 200);
    const removedBody = await removed.json();
    assert.deepEqual(Object.keys(removedBody.asset), ['id', 'status', 'deletedAt', 'alreadyDeleted']);
    assert.equal(removedBody.asset.status, 'deleted');
    assert.equal(removedBody.asset.alreadyDeleted, false);
    assert.equal((await read(sessions[0], deletable)).status, 404);
    const stored = await owner.query('SELECT status,deleted_at,storage_key,size_bytes FROM assets WHERE id=$1', [deletable]);
    assert.equal(stored.rows[0].status, 'deleted');
    assert.ok(stored.rows[0].deleted_at instanceof Date);
    assert.equal(stored.rows[0].storage_key, storageKey);
    assert.equal(Number(stored.rows[0].size_bytes), 16);
    const repeated = await del(sessions[0]);
    assert.equal(repeated.status, 200);
    assert.equal((await repeated.json()).asset.alreadyDeleted, true);
    record('真实PG软删除保留storage_key与元数据、读取立即404、重复删除幂等200', 'passed');

    // 列级授权必须刚好够用：可写删除三列，不可写对象元数据与存储定位。
    // 注意 status 本身是允许列，因此不能用"改 status"来代表越权，必须换成未授权列。
    assert.equal((await read(sessions[0], id)).status, 200);
    for (const text of [
        "UPDATE assets SET mime_type='image/jpeg' WHERE id=$1",
        "UPDATE assets SET storage_key='users/other' WHERE id=$1",
        'UPDATE assets SET size_bytes=32 WHERE id=$1',
        "UPDATE assets SET checksum_sha256=repeat('a',64) WHERE id=$1",
        `UPDATE assets SET owner_id='${randomUUID()}' WHERE id=$1`,
    ]) {
        await assert.rejects(pool.query(text, [id]), (error) => error.code === '42501');
    }
    record('真实PG Web角色仅删除三列可写，对象元数据与存储键写入返回42501', 'passed');
    await owner.query("UPDATE users SET role='admin' WHERE id=$1", [users[0].id]);
    assert.equal((await admin(req(sessions[0].token))).status, 403);
    await pool.query("UPDATE auth_sessions SET auth_level='mfa', mfa_verified_at=clock_timestamp() WHERE token_hash=$1", [tokenDigest(sessions[0].token)]);
    assert.equal((await admin(req(sessions[0].token))).status, 200);
    assert.equal((await service.me(sessions[0].token)).user.role, 'admin');
    await owner.query("UPDATE users SET role='user' WHERE id=$1", [users[0].id]);
    assert.equal((await admin(req(sessions[0].token))).status, 403);
    record('同一session提权及降权提交后下一请求即时生效', 'passed');
    await pool.query('UPDATE users SET email_verified_at=NULL WHERE id=$1', [users[1].id]);
    assert.equal((await read(sessions[1])).status, 401);
    await service.logout(sessions[2].token);
    assert.equal((await admin(req(sessions[2].token))).status, 401);
    await pool.query("UPDATE auth_sessions SET created_at=clock_timestamp()-interval '10 hours',expires_at=clock_timestamp()-interval '1 minute' WHERE token_hash=$1", [tokenDigest(sessions[0].token)]);
    assert.equal((await read(sessions[0])).status, 401);
    record('已有session的未验证/撤销/过期身份不能使用受保护端点', 'passed');
    for (const secret of [password, hash, ...users.map((u) => u.email), ...sessions.map((s) => s.token)]) assert.ok(!lines.join('').includes(secret));
    record('实际授权日志及审计无密码邮箱hash或session明文', 'passed');
}
module.exports = { checkAuthorization };
