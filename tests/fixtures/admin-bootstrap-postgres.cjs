const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { drizzle } = require('drizzle-orm/node-postgres');
const { createAdminBootstrapService } = require('../../lib/server/adminBootstrap');
const { verifyPassword } = require('../../lib/server/passwords');
const { main: runBootstrapCli } = require('../../scripts/bootstrap-admin');

class TtyInput extends EventEmitter {
    constructor(values) {
        super();
        this.isTTY = true;
        this.values = [...values];
    }
    setRawMode(value) { this.raw = value; }
    setEncoding() {}
    resume() {
        const value = this.values.shift();
        if (value !== undefined) queueMicrotask(() => this.emit('data', `${value}\n`));
    }
    pause() {}
}

function testOutput() {
    return { isTTY: true, value: '', write(value) { this.value += value; } };
}

async function checkAdminBootstrap(pool, runtimePool, owner, bootstrapUrl, runtimeUrl, migrationUrl, record) {
    const database = drizzle(pool);
    const sinkLines = [];
    const sink = { info: (value) => sinkLines.push(value), warn: (value) => sinkLines.push(value), error: (value) => sinkLines.push(value) };
    const prefix = randomBytes(8).toString('hex');
    const password = `Bootstrap-${randomBytes(12).toString('hex')}`;
    const email = `admin-${prefix}@example.test`;
    const service = createAdminBootstrapService({ database, auditSink: sink });

    const rollbackEmail = `rollback-${prefix}@example.test`;
    const rollbackDatabase = {
        transaction(callback) {
            return database.transaction(async (tx) => {
                await callback(tx);
                throw new Error('synthetic bootstrap commit failure');
            });
        },
    };
    const rollbackService = createAdminBootstrapService({ database: rollbackDatabase, auditSink: sink });
    await assert.rejects(rollbackService.initialize({ email: rollbackEmail, password }), /synthetic bootstrap commit failure/);
    assert.equal((await owner.query('SELECT count(*)::int AS count FROM users WHERE email=$1', [rollbackEmail])).rows[0].count, 0);
    record('管理员插入提交前失败真实回滚且无半成品用户', 'passed');

    const occupiedEmail = `occupied-${prefix}@example.test`;
    const baselineHash = (await require('../../lib/server/passwords').hashPassword(password));
    const occupied = (await owner.query('INSERT INTO users(email,password_hash,email_verified_at) VALUES($1,$2,clock_timestamp()) RETURNING id,password_hash,role', [occupiedEmail, baselineHash])).rows[0];
    await assert.rejects(service.initialize({ email: occupiedEmail, password }), (error) => error.code === 'ADMIN_EMAIL_EXISTS');
    assert.deepEqual((await owner.query('SELECT id,password_hash,role FROM users WHERE id=$1', [occupied.id])).rows[0], occupied);
    record('仅有普通用户且目标邮箱冲突时拒绝升权且不修改现有用户', 'passed');

    const raceResults = await Promise.allSettled(Array.from({ length: 8 }, (_, index) =>
        service.initialize({ email: `race-${prefix}-${index}@example.test`, password })));
    assert.equal(raceResults.filter((entry) => entry.status === 'fulfilled').length, 1);
    assert.ok(raceResults.filter((entry) => entry.status === 'rejected').every((entry) => entry.reason.code === 'ADMIN_ALREADY_INITIALIZED'));
    const raceAdminId = raceResults.find((entry) => entry.status === 'fulfilled').value.userId;
    assert.equal((await owner.query("SELECT count(*)::int AS count FROM users WHERE role='admin'")).rows[0].count, 1);
    await owner.query("UPDATE users SET role='user' WHERE id=$1 AND role='admin'", [raceAdminId]);
    assert.equal((await owner.query("SELECT count(*)::int AS count FROM users WHERE role='admin'")).rows[0].count, 0);
    record('8路并发首次初始化恰有一个成功；测试身份随后由迁移连接恢复为user', 'passed');

    const cliInput = new TtyInput([email, password, password]);
    const cliOutput = testOutput();
    await runBootstrapCli({
        env: { BOOTSTRAP_DATABASE_URL: bootstrapUrl, DATABASE_URL: runtimeUrl, MIGRATION_DATABASE_URL: migrationUrl },
        input: cliInput,
        output: cliOutput,
    });
    assert.match(cliOutput.value, /管理员初始化完成/);
    assert.doesNotMatch(cliOutput.value, /admin-[0-9a-f]+@example|Bootstrap-|postgresql:/);
    const admin = (await owner.query('SELECT id,email,password_hash,email_verified_at,role FROM users WHERE email=$1', [email])).rows[0];
    assert.equal(admin.email, email);
    assert.equal(admin.role, 'admin');
    assert.ok(admin.email_verified_at);
    assert.notEqual(admin.password_hash, password);
    assert.match(admin.password_hash, /^scrypt:32768:8:3:/);
    assert.equal(await verifyPassword(password, admin.password_hash), true);
    assert.match(sinkLines.join(''), /admin\.bootstrap/);
    for (const secret of [email, password, admin.password_hash]) assert.doesNotMatch(sinkLines.join(''), new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    record('CLI首次创建已验证admin、scrypt哈希及脱敏输出', 'passed');

    await assert.rejects(service.initialize({ email: `second-${prefix}@example.test`, password }), (error) => error.code === 'ADMIN_ALREADY_INITIALIZED');
    await assert.rejects(service.initialize({ email, password: `Other-${randomBytes(12).toString('hex')}` }), (error) => error.code === 'ADMIN_ALREADY_INITIALIZED');
    assert.equal((await owner.query("SELECT count(*)::int AS count FROM users WHERE role='admin'")).rows[0].count, 1);
    record('已有admin时重复初始化和新邮箱升权均安全拒绝', 'passed');

    await assert.rejects(service.initialize({ email: `second-${prefix}@example.test`, password }), (error) => error.code === 'ADMIN_ALREADY_INITIALIZED');
    assert.equal((await owner.query("SELECT count(*)::int AS count FROM users WHERE role='admin'")).rows[0].count, 1);
    record('已有admin时重复初始化和新邮箱升权均安全拒绝', 'passed');

    const runtimeUser = `runtime-negative-${prefix}@example.test`;
    const runtimeHash = admin.password_hash;
    await assert.rejects(runtimePool.query("INSERT INTO users(email,password_hash,role) VALUES($1,$2,'admin')", [runtimeUser, runtimeHash]), (error) => error.code === '42501');
    await assert.rejects(runtimePool.query("INSERT INTO users(email,password_hash,role) VALUES($1,$2,'user')", [runtimeUser, runtimeHash]), (error) => error.code === '42501');
    await assert.rejects(runtimePool.query("UPDATE users SET role='admin' WHERE id=$1", [admin.id]), (error) => error.code === '42501');
    assert.equal((await owner.query('SELECT role FROM users WHERE id=$1', [admin.id])).rows[0].role, 'admin');
    record('runtime身份不能INSERT/UPDATE users.role，bootstrap结果不受影响', 'passed');

}

module.exports = { checkAdminBootstrap };
