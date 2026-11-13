const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');

const fixture = path.join(__dirname, 'fixtures/worker-process.cjs');
const entrypoint = path.join(__dirname, '../lib/server/worker/index.js');
const logDirectory = path.join(__dirname, '../.workbuddy');

function store(task = true) {
    // 每次执行独立持久化目录，按任务要求保留测试证据，不做清理。
    const directory = fs.mkdtempSync(path.join(logDirectory, 'worker-process-'));
    const filename = path.join(directory, 'state.json');
    fs.writeFileSync(filename, JSON.stringify({
        task: task ? {
            id: 'task-1', status: 'queued', available_at: Date.now(), attempts: 0,
            max_attempts: 3, lease_token: null, lease_expires_at: null, worker_id: null,
        } : null,
        events: [],
    }));
    return { filename, read: () => JSON.parse(fs.readFileSync(filename, 'utf8')) };
}

function launch(t, state, mode, { cli = false, oldToken } = {}) {
    const child = fork(cli ? entrypoint : fixture, [], {
        execArgv: cli ? ['--require', fixture] : [],
        env: {
            ...process.env,
            // 真实 CLI 入口现在要求显式指定 Provider 模式；未配置时会 fail-closed 拒绝启动。
            // 本用例只验证进程生命周期，因此显式使用只读的 mock 实现。
            ...(cli ? { PAINTTRACK_WORKER_PROVIDER: 'mock', NODE_ENV: 'test',
                PAINTTRACK_WORKER_DATABASE_URL: 'postgres://unused/isolated-file-test' } : {}),
            PAINTTRACK_WORKER_TEST_STORE: state.filename,
            PAINTTRACK_WORKER_TEST_MODE: mode,
            PAINTTRACK_WORKER_TEST_OLD_TOKEN: oldToken || '',
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stdout = '';
    let stderr = '';
    const messages = [];
    const waiters = [];
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('message', (message) => {
        messages.push(message);
        for (const waiter of [...waiters]) {
            if (message.event === waiter.event) waiter.resolve(message);
        }
    });
    const exit = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => {
            for (const waiter of [...waiters]) waiter.reject(new Error(`子进程提前退出 ${code}: ${stderr}`));
            resolve({ code, signal, stdout, stderr });
        });
    });
    // 仅在测试失败时终止本测试创建的子进程，不影响项目其他进程。
    t.after(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
    });
    return {
        child,
        exit,
        wait(event) {
            const existing = messages.find((message) => message.event === event);
            if (existing) return Promise.resolve(existing);
            return new Promise((resolve, reject) => {
                const waiter = {
                    event,
                    resolve(message) { clearTimeout(timer); waiters.splice(waiters.indexOf(waiter), 1); resolve(message); },
                    reject(error) { clearTimeout(timer); waiters.splice(waiters.indexOf(waiter), 1); reject(error); },
                };
                const timer = setTimeout(() => waiter.reject(new Error(`未收到子进程事件 ${event}: ${stderr}`)), 5000);
                waiters.push(waiter);
            });
        },
    };
}

test('real CLI entrypoint exits cleanly when idle using an isolated pool substitute', { timeout: 10000 }, async (t) => {
    const state = store(false);
    const child = launch(t, state, 'idle', { cli: true });
    await child.wait('idle');
    child.child.send('stop');
    const exit = await child.exit;
    assert.equal(exit.code, 0, exit.stderr);
    assert.match(exit.stdout, /"status":"stopped"/);
    assert.ok(state.read().events.some((event) => event.event === 'pool-ended'));
});

test('real Node worker cooperatively cancels and exits without finalizing the task', { timeout: 10000 }, async (t) => {
    const state = store();
    const child = launch(t, state, 'cooperative');
    await child.wait('started');
    child.child.send('stop');
    await child.wait('aborted');
    const exit = await child.exit;
    assert.equal(exit.code, 0, exit.stderr);
    assert.match(exit.stdout, /"status":"stopped"/);
    assert.equal(state.read().task.status, 'running');
    assert.ok(!state.read().events.some((event) => ['completed', 'failed'].includes(event.event)));
    assert.equal(state.read().events.at(-1).event, 'pool-ended');
});

test('non-cooperative Node worker with a live handle is terminated nonzero without success writes', { timeout: 10000 }, async (t) => {
    const state = store();
    const child = launch(t, state, 'uncooperative');
    await child.wait('started');
    child.child.send('stop');
    const exit = await child.exit;
    assert.equal(exit.code, 1, exit.stderr);
    assert.match(exit.stdout, /"status":"cancellation-timeout"/);
    assert.doesNotMatch(exit.stdout, /"status":"stopped"/);
    assert.equal(state.read().task.status, 'running');
    assert.ok(!state.read().events.some((event) => ['completed', 'failed'].includes(event.event)));
});

test('Node worker cannot hang forever while closing a stuck pool', { timeout: 10000 }, async (t) => {
    const state = store(false);
    const child = launch(t, state, 'pool-hang');
    await child.wait('idle');
    child.child.send('stop');
    const exit = await child.exit;
    assert.equal(exit.code, 1, exit.stderr);
    assert.match(exit.stderr, /pool shutdown timed out/);
});

test('Node crash and restart recover an expired lease from a persistent file substitute, not a real database', { timeout: 10000 }, async (t) => {
    const state = store();
    const first = launch(t, state, 'crash');
    const { task: originalTask } = await first.wait('started');
    first.child.send('crash');
    assert.equal((await first.exit).code, 23);
    assert.equal(state.read().task.status, 'running');
    assert.equal(state.read().task.attempts, 1);

    // 等待真实时钟越过持久化租约；不是直接改状态或伪造过期时间。
    const expiresAt = state.read().task.lease_expires_at;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, expiresAt - Date.now() + 30)));
    const second = launch(t, state, 'recover');
    const { task: reclaimedTask } = await second.wait('started');
    assert.notEqual(reclaimedTask.lease_token, originalTask.lease_token);
    assert.equal(reclaimedTask.attempts, 2);
    assert.equal(state.read().task.status, 'running');
    const probe = launch(t, state, 'probe', { oldToken: originalTask.lease_token });
    await probe.wait('fenced');
    const probeExit = await probe.exit;
    assert.equal(probeExit.code, 0, probeExit.stderr);
    assert.equal(state.read().task.status, 'running');
    assert.equal(state.read().task.lease_token, reclaimedTask.lease_token);

    second.child.send('finish');
    const secondExit = await second.exit;
    assert.equal(secondExit.code, 0, secondExit.stderr);
    assert.equal(state.read().task.status, 'succeeded');
    assert.equal(state.read().events.filter((event) => event.event === 'recovered').length, 1);
    assert.equal(state.read().events.filter((event) => event.event === 'completed').length, 1);
});
