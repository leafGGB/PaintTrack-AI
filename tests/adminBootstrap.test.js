const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createAdminBootstrapService, AdminBootstrapError, BOOTSTRAP_LOCK_ID } = require('../lib/server/adminBootstrap');
const { assertBootstrapEnvironment, readSecret, safeFailure } = require('../scripts/bootstrap-admin');

const runtime = 'postgres://runtime:secret@127.0.0.1:5433/painttrack_dev';
const migration = 'postgres://migrator:secret@127.0.0.1:5433/painttrack_dev';
const bootstrap = 'postgres://bootstrap:secret@127.0.0.1:5433/painttrack_dev';
const auditSink = () => {
    const lines = [];
    return { lines, info(value) { lines.push(value); }, warn(value) { lines.push(value); }, error(value) { lines.push(value); } };
};
const validInput = (email = 'Admin@Example.test') => ({ email, password: 'correct-horse-battery' });

function mockDatabase({ adminCount = 0, emailExists = false, failTransaction = false } = {}) {
    const events = [];
    return {
        events,
        async transaction(callback) {
            events.push('begin');
            let queryCount = 0;
            const tx = { async execute() {
                queryCount++;
                if (queryCount === 1) {
                    events.push('query:lock');
                    return { rows: [] };
                }
                if (queryCount === 2) {
                    events.push('query:admins');
                    return { rows: [{ count: adminCount }] };
                }
                events.push('query:insert');
                return { rows: emailExists ? [] : [{ id: '00000000-0000-4000-8000-000000000001' }] };
            } };
            const result = await callback(tx);
            if (failTransaction) throw new Error('synthetic commit failure');
            events.push('commit');
            return result;
        },
    };
}

test('初始化服务校验注册邮箱/密码，并在一次事务中先锁定、再检查和插入', async () => {
    const database = mockDatabase();
    const sink = auditSink();
    const seen = [];
    const service = createAdminBootstrapService({ database, auditSink: sink,
        hashPasswordImpl: async (password) => { seen.push(password); return `scrypt:32768:8:3:${'a'.repeat(32)}:${'b'.repeat(128)}`; } });
    assert.deepEqual(await service.initialize(validInput()), { userId: '00000000-0000-4000-8000-000000000001' });
    assert.deepEqual(database.events, ['begin', 'query:lock', 'query:admins', 'query:insert', 'commit']);
    assert.deepEqual(seen, ['correct-horse-battery']);
    assert.equal(BOOTSTRAP_LOCK_ID, 724196232);
    assert.match(sink.lines.join(''), /admin\.bootstrap/);
    assert.match(sink.lines.join(''), /accepted/);
    assert.doesNotMatch(sink.lines.join(''), /Admin@Example|correct-horse|scrypt:/);
});

test('存在管理员、邮箱已占用或事务失败时拒绝且不产生成功审计', async () => {
    for (const [options, code] of [
        [{ adminCount: 1 }, 'ADMIN_ALREADY_INITIALIZED'],
        [{ emailExists: true }, 'ADMIN_EMAIL_EXISTS'],
        [{ failTransaction: true }, undefined],
    ]) {
        const database = mockDatabase(options);
        const sink = auditSink();
        const service = createAdminBootstrapService({ database, auditSink: sink,
            hashPasswordImpl: async () => `scrypt:32768:8:3:${'a'.repeat(32)}:${'b'.repeat(128)}` });
        await assert.rejects(service.initialize(validInput()), (error) => code ? error.code === code : error.message === 'synthetic commit failure');
        assert.ok(!database.events.includes('commit'));
        assert.match(sink.lines.join(''), /rejected/);
        assert.doesNotMatch(sink.lines.join(''), /Admin@Example|correct-horse|scrypt:/);
    }
});

test('初始化服务拒绝非法邮箱、短密码和额外客户端字段，且不连接数据库', async () => {
    let transactions = 0;
    const service = createAdminBootstrapService({ database: { async transaction() { transactions++; } }, hashPasswordImpl: async () => 'unused' });
    for (const input of [
        { email: 'bad@localhost', password: 'correct-horse-battery' },
        { email: 'user@example.test', password: 'short' },
        { ...validInput(), role: 'admin' },
    ]) await assert.rejects(service.initialize(input), (error) => error.code === 'INVALID_INPUT');
    assert.equal(transactions, 0);
});

test('bootstrap URL 必须显式指定、与运行/迁移目标一致且使用独立身份', () => {
    assert.throws(() => assertBootstrapEnvironment({ DATABASE_URL: runtime, MIGRATION_DATABASE_URL: migration }), /BOOTSTRAP_DATABASE_URL_REQUIRED/);
    assert.throws(() => assertBootstrapEnvironment({ BOOTSTRAP_DATABASE_URL: runtime, DATABASE_URL: runtime, MIGRATION_DATABASE_URL: migration }), /IDENTITY_MUST_DIFFER/);
    assert.throws(() => assertBootstrapEnvironment({ BOOTSTRAP_DATABASE_URL: bootstrap, DATABASE_URL: runtime.replace('painttrack_dev', 'other'), MIGRATION_DATABASE_URL: migration }), /TARGET_MUST_MATCH/);
    assert.deepEqual(assertBootstrapEnvironment({ BOOTSTRAP_DATABASE_URL: bootstrap, DATABASE_URL: runtime, MIGRATION_DATABASE_URL: migration }), {
        host: '127.0.0.1', port: 5433, database: 'painttrack_dev', username: 'bootstrap', loopback: true,
        runtimeRole: 'runtime', migrationRole: 'migrator',
    });
});

test('隐藏输入只输出提示、不回显密文，并支持退格与取消', async () => {
    class Input extends EventEmitter {
        isTTY = true;
        setRawMode(value) { this.raw = value; }
        setEncoding() {}
        resume() {}
        pause() {}
    }
    const input = new Input();
    const output = { isTTY: true, value: '', write(value) { this.value += value; } };
    const pending = readSecret('密码: ', input, output);
    input.emit('data', 'secretX\u007f\n');
    assert.equal(await pending, 'secret');
    assert.match(output.value, /密码/);
    assert.doesNotMatch(output.value, /secret/);
    assert.equal(input.raw, false);
    const noTty = new Input();
    noTty.isTTY = false;
    assert.throws(() => readSecret('密码: ', noTty, output), /BOOTSTRAP_TTY_REQUIRED/);
});

test('CLI 安全错误文案不包含连接凭据或数据库异常原文', () => {
    assert.match(safeFailure(new Error('postgres://user:secret@db/private')).message, /检查受控数据库身份/);
    assert.doesNotMatch(safeFailure(new Error('postgres://user:secret@db/private')).message, /secret|postgres/);
    assert.equal(safeFailure(new AdminBootstrapError('ADMIN_ALREADY_INITIALIZED')).code, 'ADMIN_ALREADY_INITIALIZED');
});
