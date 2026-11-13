const { Client } = require('pg');
const { runWorkerProcess } = require('../../lib/server/worker');

// 仅由本地隔离验收入口启动；使用真实 pg，凭据只从隔离的子进程环境读取。
const mode = process.env.PAINTTRACK_POSTGRES_WORKER_MODE;
const send = (message) => { if (process.connected) process.send(message); };
let started = false;
let finishTask;

process.on('message', (message) => {
    if (message === 'stop') process.emit('SIGTERM');
    if (message === 'finish') finishTask?.();
    if (message !== 'start' || started) return;
    started = true;
    (async () => {
        const verification = new Client({ connectionString: process.env.PAINTTRACK_WORKER_DATABASE_URL });
        try {
            await verification.connect();
            const identity = await verification.query('SELECT current_user AS username');
            send({ event: 'identity', username: identity.rows[0].username });
        } finally {
            await verification.end();
        }
        await runWorkerProcess({
            databaseUrl: process.env.PAINTTRACK_WORKER_DATABASE_URL,
            workerId: `postgres-child-${process.pid}`,
            leaseSeconds: ['crash', 'cooperative', 'uncooperative'].includes(mode) ? 2 : 10,
            heartbeatIntervalMs: 200,
            pollIntervalMs: 50,
            shutdownGraceMs: 50,
            cancellationTimeoutMs: 1000,
            processTask: async (task, { signal }) => {
                send({ event: 'started', taskId: task.id, token: task.lease_token, attempts: task.attempts });
                if (mode === 'cooperative') {
                    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
                    send({ event: 'aborted' });
                    return;
                }
                if (mode === 'uncooperative' || mode === 'crash') {
                    // 保留真实句柄，确保强制终止和取消超时不是未决 Promise 自然退出。
                    setInterval(() => {}, 1000);
                    await new Promise(() => {});
                }
                await new Promise((resolve) => { finishTask = resolve; });
                finishTask = undefined;
            },
        });
        if (process.connected) process.disconnect();
    })().catch(() => {
        // 不输出 pg 错误、连接字符串或子进程环境。
        process.stderr.write('PostgreSQL Worker 验收子进程失败\n');
        process.exit(1);
    });
});
send({ event: 'ready' });
