'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { MemoryObjectStore } = require('../lib/server/storage/memoryObjectStore');
const {
    DEFAULT_ABANDONMENT_MS,
    MAX_ABANDONMENT_MS,
    assetKeyFor,
    reclaimAbandonedAssets,
} = require('../lib/server/orphanReclaim');

const HOUR = 3600000;
const NOW = new Date('2026-11-13T12:00:00.000Z');

/**
 * 只实现 orphanReclaim 用到的那几条语句的状态化替身。
 * 目的不是模拟 Postgres，而是钉死「老化窗口、认领计数、成功/失败标记」这几条语义，
 * 以及最要紧的一条：选择语句**绝不读 storage_key**（pending 行按约束必然为 NULL）。
 */
function fakeDatabase(seed = []) {
    const rows = seed.map((row) => ({
        status: 'pending', purge_attempts: 0, thumbnail_storage_key: null,
        abandoned_at: null, last_purge_error: null, ...row,
    }));
    const calls = [];
    const eligible = (row, cutoff, maxAttempts) => ['pending', 'uploading'].includes(row.status)
        && row.abandoned_at === null
        && new Date(row.created_at) <= new Date(cutoff)
        && row.purge_attempts < maxAttempts;
    return {
        rows,
        calls,
        async query(text, values = []) {
            calls.push({ text, values });
            if (text.startsWith('WITH claimed AS')) {
                const [cutoff, maxAttempts, limit] = values;
                const claimed = rows
                    .filter((row) => eligible(row, cutoff, maxAttempts))
                    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
                    .slice(0, limit);
                for (const row of claimed) row.purge_attempts += 1;
                return { rowCount: claimed.length, rows: claimed.map((row) => ({ ...row })) };
            }
            if (text.startsWith('SELECT id, owner_id')) {
                const [cutoff, maxAttempts, limit] = values;
                const selected = rows
                    .filter((row) => eligible(row, cutoff, maxAttempts))
                    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
                    .slice(0, limit);
                return { rowCount: selected.length, rows: selected.map((row) => ({ ...row })) };
            }
            if (text.startsWith('SELECT count(*)::int AS pending')) {
                const [maxAttempts] = values;
                const live = rows.filter((row) => ['pending', 'uploading'].includes(row.status)
                    && row.abandoned_at === null);
                return {
                    rowCount: 1,
                    rows: [{
                        pending: live.length,
                        exhausted: live.filter((row) => row.purge_attempts >= maxAttempts).length,
                    }],
                };
            }
            if (/SET abandoned_at = now\(\)/.test(text)) {
                const row = rows.find((item) => item.id === values[0]);
                if (!row || row.abandoned_at !== null) return { rowCount: 0, rows: [] };
                row.abandoned_at = new Date();
                row.last_purge_error = null;
                return { rowCount: 1, rows: [{ id: row.id }] };
            }
            if (/SET last_purge_error = \$2/.test(text)) {
                const row = rows.find((item) => item.id === values[0]);
                if (!row || row.abandoned_at !== null) return { rowCount: 0, rows: [] };
                row.last_purge_error = values[1];
                return { rowCount: 1, rows: [{ id: row.id }] };
            }
            throw new Error(`unexpected query: ${text.slice(0, 60)}`);
        },
    };
}

function orphanAsset(ownerId, { hoursAgo = 7, status = 'pending', ...rest } = {}) {
    const id = rest.id || randomUUID();
    return {
        id,
        owner_id: ownerId,
        status,
        created_at: new Date(NOW.getTime() - hoursAgo * HOUR),
        ...rest,
    };
}

// fakeDatabase 会复制 seed 行（否则真实现里数据库才是唯一副本就会误导断言），
// 因此断言必须打在 database.rows 上，而不是调用方手里的 seed 对象。
function rowOf(database, id) {
    const row = database.rows.find((item) => item.id === id);
    assert.ok(row, `row ${id} not found in fake database`);
    return row;
}

test('回收超时未完成的行：按 (owner,id) 推导键删对象、写 abandoned_at、只计一次尝试', async () => {
    const ownerId = randomUUID();
    const stale = orphanAsset(ownerId);
    const uploading = orphanAsset(ownerId, { status: 'uploading' });
    const database = fakeDatabase([stale, uploading]);
    const store = new MemoryObjectStore();
    // 归档路径写的就是这个键——行上没有 storage_key 可用。
    await store.putObject({ key: assetKeyFor(ownerId, stale.id), body: Buffer.from('orphan'), acl: 'private' });
    await store.putObject({ key: assetKeyFor(ownerId, uploading.id), body: Buffer.from('orphan'), acl: 'private' });

    const summary = await reclaimAbandonedAssets({ pool: database, objectStore: store, now: () => NOW });

    assert.equal(summary.dryRun, false);
    assert.equal(summary.claimed, 2);
    assert.equal(summary.reclaimed.length, 2);
    assert.equal(summary.failed.length, 0);
    assert.equal(summary.pending, 0);
    assert.equal(await store.hasObject({ key: assetKeyFor(ownerId, stale.id) }), false);
    assert.equal(await store.hasObject({ key: assetKeyFor(ownerId, uploading.id) }), false);
    for (const row of database.rows) {
        assert.ok(row.abandoned_at instanceof Date);
        assert.equal(row.purge_attempts, 1);
        assert.equal(row.last_purge_error, null);
        // 状态不由清理流程改写：cleanup 角色没有 status 写权限。
        assert.ok(['pending', 'uploading'].includes(row.status));
    }
    assert.match(database.calls[0].text, /FOR UPDATE SKIP LOCKED/);
    assert.equal(database.calls.some((call) => /BEGIN|COMMIT/.test(call.text)), false);
});

test('选择与认领语句不读 storage_key：pending/uploading 行的该列按约束必为 NULL', async () => {
    const ownerId = randomUUID();
    const database = fakeDatabase([orphanAsset(ownerId)]);
    const store = new MemoryObjectStore();
    await reclaimAbandonedAssets({ pool: database, objectStore: store, now: () => NOW });
    for (const call of database.calls) {
        assert.equal(/storage_key/.test(call.text.replace(/thumbnail_storage_key/g, '')), false, call.text.slice(0, 80));
    }
});

test('未超时、ready、deleted、已放弃的行都不认领', async () => {
    const ownerId = randomUUID();
    const fresh = orphanAsset(ownerId, { hoursAgo: 1 });
    const ready = orphanAsset(ownerId, { status: 'ready', storage_key: `users/${ownerId}/assets/x` });
    const deleted = orphanAsset(ownerId, { status: 'deleted', deleted_at: new Date(NOW.getTime() - 2 * HOUR) });
    const alreadyReclaimed = orphanAsset(ownerId, { abandoned_at: new Date(NOW.getTime() - HOUR) });
    const database = fakeDatabase([fresh, ready, deleted, alreadyReclaimed]);
    const store = new MemoryObjectStore();

    const summary = await reclaimAbandonedAssets({ pool: database, objectStore: store, now: () => NOW });

    assert.equal(summary.claimed, 0);
    assert.equal(summary.reclaimed.length, 0);
    assert.equal(rowOf(database, fresh.id).abandoned_at, null);
    assert.equal(rowOf(database, ready.id).abandoned_at, null);
    assert.equal(rowOf(database, deleted.id).abandoned_at, null);
    // 已放弃的行不重复计数，也不会被再次“回收”。
    assert.equal(rowOf(database, alreadyReclaimed.id).purge_attempts, 0);
    // 只剩 fresh 计入 pending（ready/deleted/已放弃都不属于本流程）。
    assert.equal(summary.pending, 1);
});

test('对象删除失败：不写 abandoned_at、记错误码、下一轮仍可重试', async () => {
    const ownerId = randomUUID();
    const row = orphanAsset(ownerId);
    const database = fakeDatabase([row]);
    const store = {
        async deleteObject({ key }) {
            throw Object.assign(new Error(`EACCES ${key}`), { code: 'EACCES' });
        },
    };

    const first = await reclaimAbandonedAssets({ pool: database, objectStore: store, now: () => NOW });
    assert.equal(first.reclaimed.length, 0);
    assert.equal(first.failed.length, 1);
    assert.equal(first.failed[0].code, 'orphan-delete:EACCES');
    assert.equal(rowOf(database, row.id).abandoned_at, null);
    assert.equal(rowOf(database, row.id).purge_attempts, 1);
    assert.equal(rowOf(database, row.id).last_purge_error, 'orphan-delete:EACCES');

    // 第二轮仍会认领它——失败必须可重试，否则对象永远留在存储里。
    const second = await reclaimAbandonedAssets({ pool: database, objectStore: store, now: () => NOW });
    assert.equal(second.claimed, 1);
    assert.equal(rowOf(database, row.id).purge_attempts, 2);
});

test('尝试次数用尽后不再认领，并计入 exhausted', async () => {
    const ownerId = randomUUID();
    const row = orphanAsset(ownerId, { purge_attempts: 5, last_purge_error: 'orphan-delete:EACCES' });
    const database = fakeDatabase([row]);
    const store = new MemoryObjectStore();

    const summary = await reclaimAbandonedAssets({ pool: database, objectStore: store, maxAttempts: 5, now: () => NOW });

    assert.equal(summary.claimed, 0);
    assert.equal(summary.pending, 1);
    assert.equal(summary.exhausted, 1);
    assert.equal(rowOf(database, row.id).abandoned_at, null);
    assert.equal(rowOf(database, row.id).purge_attempts, 5);
});

test('dry-run 只报告候选：不删对象、不写库、不计数', async () => {
    const ownerId = randomUUID();
    const row = orphanAsset(ownerId);
    const database = fakeDatabase([row]);
    const store = new MemoryObjectStore();
    await store.putObject({ key: assetKeyFor(ownerId, row.id), body: Buffer.from('orphan'), acl: 'private' });

    const summary = await reclaimAbandonedAssets({ pool: database, objectStore: store, dryRun: true, now: () => NOW });

    assert.equal(summary.dryRun, true);
    assert.equal(summary.claimed, 1);
    assert.equal(summary.reclaimed[0].objects, 1);
    assert.equal(summary.reclaimed[0].dryRun, true);
    assert.equal(await store.hasObject({ key: assetKeyFor(ownerId, row.id) }), true);
    assert.equal(rowOf(database, row.id).abandoned_at, null);
    assert.equal(rowOf(database, row.id).purge_attempts, 0);
    assert.equal(database.calls.some((call) => /SET abandoned_at/.test(call.text)), false);
});

test('同 owner 的缩略图一并删除；跨 owner 的键一律拒绝并记录校验失败', async () => {
    const ownerId = randomUUID();
    const withThumb = orphanAsset(ownerId);
    withThumb.thumbnail_storage_key = `users/${ownerId}/thumbnails/${withThumb.id}`;
    const foreignThumb = orphanAsset(ownerId, { thumbnail_storage_key: `users/${randomUUID()}/thumbnails/x` });
    const database = fakeDatabase([withThumb, foreignThumb]);
    const store = new MemoryObjectStore();
    await store.putObject({ key: withThumb.thumbnail_storage_key, body: Buffer.from('thumb'), acl: 'private' });
    await store.putObject({ key: assetKeyFor(ownerId, withThumb.id), body: Buffer.from('main'), acl: 'private' });
    await store.putObject({ key: assetKeyFor(ownerId, foreignThumb.id), body: Buffer.from('main'), acl: 'private' });

    const summary = await reclaimAbandonedAssets({ pool: database, objectStore: store, now: () => NOW });

    assert.equal(summary.reclaimed.length, 1);
    assert.equal(summary.reclaimed[0].objects, 2);
    assert.equal(await store.hasObject({ key: withThumb.thumbnail_storage_key }), false);
    assert.equal(await store.hasObject({ key: assetKeyFor(ownerId, withThumb.id) }), false);

    assert.equal(summary.failed.length, 1);
    assert.equal(summary.failed[0].code, 'orphan-verify:key_owner_mismatch');
    // 跨 owner 的键被拒后，本行的主对象也不能顺手删掉——校验失败即整行跳过。
    assert.equal(await store.hasObject({ key: assetKeyFor(ownerId, foreignThumb.id) }), true);
    assert.equal(rowOf(database, foreignThumb.id).abandoned_at, null);
});

test('行内 owner/id 不是 UUID 时跳过该行而不是中断整批', async () => {
    const ownerId = randomUUID();
    const broken = orphanAsset(ownerId, { id: '../../etc/passwd' });
    const healthy = orphanAsset(ownerId);
    const database = fakeDatabase([broken, healthy]);
    const store = new MemoryObjectStore();
    await store.putObject({ key: assetKeyFor(ownerId, healthy.id), body: Buffer.from('main'), acl: 'private' });

    const summary = await reclaimAbandonedAssets({ pool: database, objectStore: store, now: () => NOW });

    assert.equal(summary.failed.length, 1);
    assert.equal(summary.failed[0].code, 'claim:invalid_id');
    assert.equal(summary.reclaimed.length, 1);
    assert.ok(rowOf(database, healthy.id).abandoned_at instanceof Date);
    assert.equal(rowOf(database, broken.id).abandoned_at, null);
});

test('参数校验：pool、objectStore、时间窗口、批次与次数上限', async () => {
    const store = new MemoryObjectStore();
    const database = fakeDatabase();
    await assert.rejects(() => reclaimAbandonedAssets({}), /pool is required/);
    await assert.rejects(() => reclaimAbandonedAssets({ pool: database }), /objectStore with deleteObject is required/);
    await assert.rejects(
        () => reclaimAbandonedAssets({ pool: database, objectStore: store, abandonmentMs: MAX_ABANDONMENT_MS + 1 }),
        /abandonmentMs/,
    );
    await assert.rejects(
        () => reclaimAbandonedAssets({ pool: database, objectStore: store, batchSize: 0 }),
        /batchSize/,
    );
    await assert.rejects(
        () => reclaimAbandonedAssets({ pool: database, objectStore: store, maxAttempts: 0 }),
        /maxAttempts/,
    );
    await assert.rejects(
        () => reclaimAbandonedAssets({ pool: database, objectStore: store, now: () => new Date('nope') }),
        /valid Date/,
    );
    assert.equal(DEFAULT_ABANDONMENT_MS, 6 * HOUR);
});

test('键由 owner 与 assetId 推导，形如 users/<owner>/assets/<id> 且全小写', () => {
    const ownerId = randomUUID().toUpperCase();
    const assetId = randomUUID().toUpperCase();
    assert.equal(assetKeyFor(ownerId, assetId), `users/${ownerId.toLowerCase()}/assets/${assetId.toLowerCase()}`);
});
