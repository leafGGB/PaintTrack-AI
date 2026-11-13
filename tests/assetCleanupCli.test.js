'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { describeTarget, main, parseArguments, readConfiguration, summarize, summarizeReclaim } = require('../scripts/asset-cleanup');


function captureSink() {
    const lines = [];
    return {
        lines,
        log: (line) => lines.push(String(line)),
        error: (line) => lines.push(String(line)),
    };
}

// 一轮会跑两段清理，两段都发 `WITH claimed AS` / `SELECT count(*)` 开头的 SQL，
// 因此按「是否提到 abandoned_at」区分身份，避免两个测试替身互相吃掉对方的查询。
function fakeClient({ rows = [], onClaim, orphanRows = [], onOrphanClaim } = {}) {
    const calls = [];
    const state = { rows, orphans: orphanRows, ended: false };
    const isOrphan = (text) => /abandoned_at/.test(text);
    return {
        state,
        calls,
        on() { return this; },
        async connect() { return this; },
        async end() { state.ended = true; },
        async query(text, values = []) {
            calls.push({ text, values });
            if (text.startsWith('WITH claimed AS')) {
                const claimed = isOrphan(text)
                    ? (onOrphanClaim ? onOrphanClaim(state, values) : [])
                    : (onClaim ? onClaim(state, values) : []);
                return { rowCount: claimed.length, rows: claimed };
            }
            if (text.startsWith('SELECT count(*)::int AS pending')) {
                if (isOrphan(text)) {
                    const live = state.orphans.filter((row) => row.abandoned_at === null
                        && ['pending', 'uploading'].includes(row.status));
                    return {
                        rowCount: 1,
                        rows: [{
                            pending: live.length,
                            exhausted: live.filter((row) => row.purge_attempts >= values[0]).length,
                        }],
                    };
                }
                const live = state.rows.filter((row) => row.purged_at === null);
                return { rowCount: 1, rows: [{ pending: live.length, exhausted: 0 }] };
            }
            if (/SET abandoned_at = now\(\)/.test(text)) {
                const row = state.orphans.find((item) => item.id === values[0]);
                if (!row) return { rowCount: 0, rows: [] };
                row.abandoned_at = new Date();
                row.last_purge_error = null;
                return { rowCount: 1, rows: [{ id: row.id }] };
            }
            if (/SET purged_at = now\(\)/.test(text)) {
                const row = state.rows.find((item) => item.id === values[0]);
                if (!row) return { rowCount: 0, rows: [] };
                row.purged_at = new Date();
                return { rowCount: 1, rows: [{ id: row.id }] };
            }
            if (/SET last_purge_error = \$2/.test(text)) {
                const bucket = isOrphan(text) ? state.orphans : state.rows;
                const row = bucket.find((item) => item.id === values[0]);
                if (!row) return { rowCount: 0, rows: [] };
                row.last_purge_error = values[1];
                return { rowCount: 1, rows: [{ id: row.id }] };
            }
            throw new Error(`unexpected query: ${text.slice(0, 50)}`);
        },
    };
}

test('参数解析：默认值、等号与空格两种写法、非法输入', () => {
    assert.deepEqual(parseArguments([]), {
        dryRun: false,
        retentionHours: 24,
        orphanHours: 6,
        orphans: true,
        batchSize: 50,
        maxAttempts: 5,
        intervalSeconds: 0,
        help: false,
    });
    assert.equal(parseArguments(['--retention-hours', '0']).retentionHours, 0);
    assert.equal(parseArguments(['--retention-hours=6']).retentionHours, 6);
    assert.equal(parseArguments(['--orphan-hours=12']).orphanHours, 12);
    assert.equal(parseArguments(['--orphan-hours', '0']).orphanHours, 0);
    assert.equal(parseArguments(['--no-orphans']).orphans, false);
    assert.equal(parseArguments(['--batch-size', '500']).batchSize, 500);
    assert.equal(parseArguments(['--dry-run', '--interval=30']).intervalSeconds, 30);
    assert.equal(parseArguments(['--help']).help, true);
    assert.throws(() => parseArguments(['--unknown']), /unknown option/);
    assert.throws(() => parseArguments(['--batch-size']), /requires a value/);
    assert.throws(() => parseArguments(['--batch-size', '501']), /between 1 and 500/);
    assert.throws(() => parseArguments(['--max-attempts', '0']), /between 1 and 100/);
    assert.throws(() => parseArguments(['--retention-hours', '-1']), /non-negative integer/);
    assert.throws(() => parseArguments(['--retention-hours', '1.5']), /non-negative integer/);
    assert.throws(() => parseArguments(['--orphan-hours', '-1']), /non-negative integer/);
    // 超过一年（8760h）没有意义：要么是配置错误，要么该用租约而不是老化窗口。
    assert.throws(() => parseArguments(['--orphan-hours', '8761']), /between 0 and 8760/);
});

test('配置校验：缺失、非 postgres 协议、相对路径与文件系统根都被拒绝', () => {
    const root = path.join(os.tmpdir(), 'painttrack-cleanup-root');
    assert.equal(readConfiguration({
        PAINTTRACK_CLEANUP_DATABASE_URL: 'postgres://cleanup:pw@127.0.0.1:5433/db',
        PAINTTRACK_ASSET_STORAGE_ROOT: root,
    }).storageRoot, path.resolve(root));
    assert.throws(() => readConfiguration({ PAINTTRACK_ASSET_STORAGE_ROOT: root }), /PAINTTRACK_CLEANUP_DATABASE_URL_REQUIRED/);
    assert.throws(() => readConfiguration({ PAINTTRACK_CLEANUP_DATABASE_URL: 'mysql://x', PAINTTRACK_ASSET_STORAGE_ROOT: root }), /URL_INVALID/);
    assert.throws(() => readConfiguration({ PAINTTRACK_CLEANUP_DATABASE_URL: 'not a url', PAINTTRACK_ASSET_STORAGE_ROOT: root }), /URL_INVALID/);
    assert.throws(() => readConfiguration({ PAINTTRACK_CLEANUP_DATABASE_URL: 'postgres://x' }), /STORAGE_ROOT_REQUIRED/);
    assert.throws(() => readConfiguration({ PAINTTRACK_CLEANUP_DATABASE_URL: 'postgres://x', PAINTTRACK_ASSET_STORAGE_ROOT: 'relative/dir' }), /STORAGE_ROOT_INVALID/);
    assert.throws(() => readConfiguration({ PAINTTRACK_CLEANUP_DATABASE_URL: 'postgres://x', PAINTTRACK_ASSET_STORAGE_ROOT: path.parse(process.cwd()).root }), /STORAGE_ROOT_INVALID/);
});

test('目标描述只显示主机与库名，不回显口令', () => {
    const described = describeTarget('postgres://cleanup:super-secret@127.0.0.1:5433/painttrack');
    assert.equal(described, '127.0.0.1:5433/painttrack');
    assert.equal(described.includes('super-secret'), false);
    assert.equal(describeTarget('::bad::'), 'unparseable');
});

test('汇总输出不含存储键与连接串', () => {
    const text = JSON.stringify(summarize({
        dryRun: false,
        retentionCutoff: new Date(0).toISOString(),
        claimed: 2,
        purged: [{ id: 'a', objects: 2 }],
        failed: [{ id: 'b', code: 'delete:EACCES' }],
        pending: 3,
        exhausted: 1,
    }));
    assert.equal(text.includes('storage_key'), false);
    assert.equal(text.includes('users/'), false);
    assert.match(text, /"failedCodes":\["delete:EACCES"\]/);
});

test('孤儿回收的汇总不含存储键与推导键前缀', () => {
    const text = JSON.stringify(summarizeReclaim({
        dryRun: false,
        abandonmentCutoff: new Date(0).toISOString(),
        claimed: 1,
        reclaimed: [{ id: 'a', objects: 1 }],
        failed: [{ id: 'b', code: 'orphan-delete:EACCES' }],
        pending: 2,
        exhausted: 1,
    }));
    assert.equal(text.includes('users/'), false);
    assert.match(text, /"event":"asset_orphan_reclaim"/);
    assert.match(text, /"failedCodes":\["orphan-delete:EACCES"\]/);
});

test('配置错误返回 2，且不打印连接串', async () => {
    const sink = captureSink();
    const code = await main({ argv: [], environment: { PAINTTRACK_CLEANUP_DATABASE_URL: 'postgres://u:p@127.0.0.1/db' }, sink });
    assert.equal(code, 2);
    assert.match(sink.lines.join('\n'), /PAINTTRACK_ASSET_STORAGE_ROOT_REQUIRED/);
    assert.equal(sink.lines.join('\n').includes('127.0.0.1'), false);
});

test('--help 返回 0 并输出用法', async () => {
    const sink = captureSink();
    assert.equal(await main({ argv: ['--help'], environment: {}, sink }), 0);
    assert.match(sink.lines.join('\n'), /asset-cleanup/);
});

test('一次执行：无候选返回 0 并关闭连接', async () => {
    const sink = captureSink();
    const client = fakeClient({ rows: [] });
    const code = await main({
        argv: [],
        environment: {
            PAINTTRACK_CLEANUP_DATABASE_URL: 'postgres://cleanup:pw@127.0.0.1:5433/db',
            PAINTTRACK_ASSET_STORAGE_ROOT: path.join(os.tmpdir(), 'painttrack-cleanup-missing'),
        },
        sink,
        clientFactory: () => client,
    });
    assert.equal(code, 0);
    assert.match(sink.lines.join('\n'), /"claimed":0/);
    assert.equal(client.state.ended, true);
});

test('数据库级失败返回 1，只报错误码不报连接串', async () => {
    const sink = captureSink();
    const client = fakeClient({
        onClaim: () => { throw Object.assign(new Error('password authentication failed for user "cleanup"'), { code: '28P01' }); },
    });
    const code = await main({
        argv: [],
        environment: {
            PAINTTRACK_CLEANUP_DATABASE_URL: 'postgres://cleanup:super-secret@127.0.0.1:5433/db',
            PAINTTRACK_ASSET_STORAGE_ROOT: path.join(os.tmpdir(), 'painttrack-cleanup-missing'),
        },
        sink,
        clientFactory: () => client,
    });
    assert.equal(code, 1);
    const output = sink.lines.join('\n');
    assert.match(output, /asset_cleanup_failed/);
    assert.match(output, /28P01/);
    assert.equal(output.includes('super-secret'), false);
    assert.equal(output.includes('password authentication failed'), false);
});

test('对象已不存在时清理仍成功（幂等），并把 purged_at 写回', async () => {
    const ownerId = randomUUID();
    const id = randomUUID();
    const client = fakeClient({
        onClaim: (state) => {
            const row = {
                id,
                owner_id: ownerId,
                storage_key: `users/${ownerId}/assets/${id}`,
                thumbnail_storage_key: null,
                purge_attempts: 1,
                purged_at: null,
            };
            state.rows.push(row);
            return [{ ...row }];
        },
    });
    const sink = captureSink();
    const code = await main({
        argv: ['--retention-hours', '0'],
        environment: {
            PAINTTRACK_CLEANUP_DATABASE_URL: 'postgres://cleanup:pw@127.0.0.1:5433/db',
            PAINTTRACK_ASSET_STORAGE_ROOT: path.join(os.tmpdir(), 'painttrack-cleanup-missing'),
        },
        sink,
        clientFactory: () => client,
    });
    assert.equal(code, 0);
    assert.match(sink.lines.join('\n'), /"purgedCount":1/);
    assert.ok(client.state.rows[0].purged_at instanceof Date);
    // 保留期 0 小时的截止时间应当就是「现在」，不是 24 小时前。
    const cutoff = new Date(client.calls[0].values[0]);
    assert.ok(Math.abs(Date.now() - cutoff.getTime()) < 60000, `cutoff=${cutoff.toISOString()}`);
    assert.equal(client.calls[0].values[1], 5);
});

test('--no-orphans 只跑软删除清理，不产生孤儿回收事件', async () => {
    const sink = captureSink();
    const client = fakeClient({ rows: [] });
    const code = await main({
        argv: ['--no-orphans'],
        environment: {
            PAINTTRACK_CLEANUP_DATABASE_URL: 'postgres://cleanup:pw@127.0.0.1:5433/db',
            PAINTTRACK_ASSET_STORAGE_ROOT: path.join(os.tmpdir(), 'painttrack-cleanup-missing'),
        },
        sink,
        clientFactory: () => client,
    });
    assert.equal(code, 0);
    const output = sink.lines.join('\n');
    assert.match(output, /"event":"asset_cleanup"/);
    assert.equal(output.includes('asset_orphan_reclaim'), false);
    assert.equal(client.calls.some((call) => /abandoned_at/.test(call.text)), false);
});

test('孤儿回收：默认一轮同时清理软删除与超时未完成的行', async () => {
    const ownerId = randomUUID();
    const deletedId = randomUUID();
    const orphanId = randomUUID();
    const client = fakeClient({
        onClaim: (state) => {
            const row = {
                id: deletedId,
                owner_id: ownerId,
                storage_key: `users/${ownerId}/assets/${deletedId}`,
                thumbnail_storage_key: null,
                purge_attempts: 1,
                purged_at: null,
            };
            state.rows.push(row);
            return [{ ...row }];
        },
        onOrphanClaim: (state) => {
            const row = {
                id: orphanId,
                owner_id: ownerId,
                created_at: new Date(Date.now() - 7 * 3600000),
                thumbnail_storage_key: null,
                purge_attempts: 1,
                status: 'pending',
                abandoned_at: null,
                last_purge_error: null,
            };
            state.orphans.push(row);
            return [{ ...row }];
        },
    });
    const sink = captureSink();
    const code = await main({
        argv: ['--retention-hours', '0', '--orphan-hours', '6'],
        environment: {
            PAINTTRACK_CLEANUP_DATABASE_URL: 'postgres://cleanup:pw@127.0.0.1:5433/db',
            PAINTTRACK_ASSET_STORAGE_ROOT: path.join(os.tmpdir(), 'painttrack-cleanup-missing'),
        },
        sink,
        clientFactory: () => client,
    });
    assert.equal(code, 0);
    const output = sink.lines.join('\n');
    assert.match(output, /"purgedCount":1/);
    assert.match(output, /"reclaimedCount":1/);
    assert.ok(client.state.orphans[0].abandoned_at instanceof Date);
    assert.equal(client.state.orphans[0].last_purge_error, null);

    // 两段的截止时间各自独立：孤儿用 --orphan-hours，软删除用 --retention-hours。
    const orphanClaim = client.calls.find((call) => call.text.startsWith('WITH claimed AS') && /abandoned_at/.test(call.text));
    const orphanCutoff = new Date(orphanClaim.values[0]);
    const expected = Date.now() - 6 * 3600000;
    assert.ok(Math.abs(orphanCutoff.getTime() - expected) < 60000, `cutoff=${orphanCutoff.toISOString()}`);
});

test('孤儿对象删除失败返回 1，保留未放弃状态以便下一轮重试', async () => {
    const ownerId = randomUUID();
    const orphanId = randomUUID();
    const client = fakeClient({
        onOrphanClaim: (state) => {
            const row = {
                id: orphanId,
                owner_id: ownerId,
                created_at: new Date(Date.now() - 7 * 3600000),
                // 指向别的 owner：触发键归属校验失败，且不触碰对象存储。
                thumbnail_storage_key: `users/${randomUUID()}/thumbnails/${orphanId}`,
                purge_attempts: 1,
                status: 'pending',
                abandoned_at: null,
                last_purge_error: null,
            };
            state.orphans.push(row);
            return [{ ...row }];
        },
    });
    const sink = captureSink();
    const code = await main({
        argv: ['--orphan-hours', '6'],
        environment: {
            PAINTTRACK_CLEANUP_DATABASE_URL: 'postgres://cleanup:pw@127.0.0.1:5433/db',
            PAINTTRACK_ASSET_STORAGE_ROOT: path.join(os.tmpdir(), 'painttrack-cleanup-missing'),
        },
        sink,
        clientFactory: () => client,
    });
    assert.equal(code, 1);
    assert.match(sink.lines.join('\n'), /orphan-verify:key_owner_mismatch/);
    assert.equal(client.state.orphans[0].abandoned_at, null);
    assert.equal(client.state.orphans[0].last_purge_error, 'orphan-verify:key_owner_mismatch');
});
