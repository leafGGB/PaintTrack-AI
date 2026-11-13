const fs = require('node:fs');
const { Pool } = require('pg');
const queue = require('../../lib/server/worker/taskQueue');

// 仅用于串行子进程测试的文件持久化 SQL 替身，不模拟 PostgreSQL 锁、事务或崩溃恢复。
const storePath = process.env.PAINTTRACK_WORKER_TEST_STORE;
const mode = process.env.PAINTTRACK_WORKER_TEST_MODE;
const read = () => JSON.parse(fs.readFileSync(storePath, 'utf8'));
const write = (state) => {
    const temporaryPath = `${storePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(state));
    fs.renameSync(temporaryPath, storePath);
};
const send = (message) => { if (process.connected) process.send(message); };
const result = (row) => ({ rowCount: row ? 1 : 0, rows: row ? [{ ...row }] : [] });
let announcedIdle = false;

Pool.prototype.query = async function query(text, values = []) {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(text)) return result(null);
    const state = read();
    const row = state.task;
    const now = Date.now();
    if (/FOR UPDATE SKIP LOCKED/.test(text)) {
        const selected = row?.status === 'queued' && row.available_at <= now ? row : null;
        if (!selected && !announcedIdle) {
            announcedIdle = true;
            send({ event: 'idle' });
        }
        return result(selected);
    }
    // 0015 起恢复语句把 cancelled 也纳入分支，状态参数位置后移到 $4。
    if (/WHERE status = \$4 AND lease_expires_at <= now\(\)/.test(text)) {
        if (row?.status !== 'running' || row.lease_expires_at > now) return result(null);
        row.status = row.cancel_requested_at ? 'cancelled'
            : (row.attempts < row.max_attempts ? 'queued' : 'failed');
        row.available_at = now;
        row.lease_token = row.lease_expires_at = row.worker_id = null;
        state.events.push({ event: 'recovered', status: row.status });
    } else if (/attempts = attempts \+ 1/.test(text)) {
        if (!row || row.id !== values[4] || row.status !== values[5]) return result(null);
        Object.assign(row, {
            status: values[0], lease_token: values[1], lease_expires_at: now + values[2] * 1000,
            worker_id: values[3], attempts: row.attempts + 1,
        });
        state.events.push({ event: 'claimed', token: row.lease_token, workerId: row.worker_id });
    } else {
        const failure = /last_error = \$4/.test(text);
        const heartbeat = /SET lease_expires_at =/.test(text);
        const [id, status, token] = failure ? [values[4], values[5], values[6]] : [values[1], values[2], values[3]];
        if (!row || row.id !== id || row.status !== status || row.lease_token !== token || row.lease_expires_at <= now) {
            return result(null);
        }
        if (heartbeat) {
            row.lease_expires_at = now + values[0] * 1000;
            state.events.push({ event: 'heartbeat' });
        } else {
            row.status = failure ? (row.attempts < row.max_attempts ? 'queued' : 'failed') : 'succeeded';
            row.lease_token = row.lease_expires_at = row.worker_id = null;
            state.events.push({ event: failure ? 'failed' : 'completed' });
        }
    }
    write(state);
    return result(row);
};
Pool.prototype.connect = async function connect() {
    return { query: this.query.bind(this), release() {} };
};
Pool.prototype.end = async function end() {
    if (mode === 'pool-hang') return new Promise(() => {});
    const state = read();
    state.events.push({ event: 'pool-ended' });
    write(state);
    if (require.main !== module && process.connected) process.disconnect();
};

if (require.main === module) {
    if (mode === 'probe') {
        (async () => {
            const pool = new Pool();
            for (const operation of [queue.heartbeatTask, queue.completeTask, queue.failTask]) {
                try {
                    await operation(pool, {
                        taskId: 'task-1', leaseToken: process.env.PAINTTRACK_WORKER_TEST_OLD_TOKEN,
                        errorMessage: 'stale failure', result: { kind: 'probe' },
                    });
                    throw new Error(`${operation.name} accepted a stale lease`);
                } catch (error) {
                    if (!(error instanceof queue.TaskQueueError) || error.code !== 'LEASE_LOST') throw error;
                }
            }
            send({ event: 'fenced' });
            process.disconnect();
        })().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exit(1); });
    } else {
        const { runWorkerProcess } = require('../../lib/server/worker');
        process.on('message', (message) => {
            if (message === 'stop') process.emit('SIGTERM');
            if (message === 'crash') process.exit(23);
        });
        runWorkerProcess({
            databaseUrl: 'postgres://unused/isolated-file-test', workerId: `child-${process.pid}`,
            leaseSeconds: 1, heartbeatIntervalMs: 100, pollIntervalMs: 10000,
            shutdownGraceMs: 20, cancellationTimeoutMs: 40,
            processTask: async (task, { signal }) => {
                send({ event: 'started', task });
                if (mode === 'recover') {
                    await new Promise((resolve) => {
                        const onMessage = (message) => {
                            if (message === 'finish') {
                                process.removeListener('message', onMessage);
                                resolve();
                            }
                        };
                        process.on('message', onMessage);
                    });
                    setImmediate(() => process.emit('SIGTERM'));
                    return;
                }
                if (mode === 'cooperative') {
                    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
                    send({ event: 'aborted' });
                    return;
                }
                // 故意保留事件循环句柄，确保非零退出不是未决 Promise 自然退出的假象。
                setInterval(() => {}, 1000);
                await new Promise(() => {});
            },
        }).then(() => {
            if (process.connected) process.disconnect();
        }).catch((error) => { process.stderr.write(`${error.stack}\n`); process.exit(1); });
    }
} else {
    // 通过 --require 运行真实 CLI 入口；隔离连接池及配置读取，不访问环境文件或数据库。
    require('../../lib/server/env').getEnvironment = () => ({ databaseUrl: 'postgres://unused/isolated-file-test' });
    process.on('message', (message) => {
        if (message === 'stop') process.emit('SIGTERM');
    });
    process.once('beforeExit', () => { if (process.connected) process.disconnect(); });
}
