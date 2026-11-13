'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { MemoryObjectStore } = require('../lib/server/storage/memoryObjectStore');
const { DEFAULT_RETENTION_MS, purgeDeletedAssets } = require('../lib/server/assetPurge');

const HOUR = 3600000;
const NOW = new Date('2026-11-13T12:00:00.000Z');

/**
 * 只实现 assetPurge 用到的那几条语句的状态化替身。
 * 目的不是模拟 Postgres，而是钉死「认领条件、计数时机、成功/失败标记」这几条语义。
 */
function fakeDatabase(seed = []) {
    const rows = seed.map((row) => ({
        status: 'deleted', purged_at: null, purge_attempts: 0, thumbnail_storage_key: null, ...row,
    }));
    const calls = [];
    return {
        rows,
        calls,
        async query(text, values = []) {
            calls.push({ text, values });
            if (text.startsWith('WITH claimed AS')) {
                const [cutoff, maxAttempts, limit] = values;
                const claimed = rows
                    .filter((row) => row.status === 'deleted' && row.purged_at === null
                        && new Date(row.deleted_at) <= new Date(cutoff) && row.purge_attempts < maxAttempts)
                    .sort((a, b) => new Date(a.deleted_at) - new Date(b.deleted_at))
                    .slice(0, limit);
                for (const row of claimed) row.purge_attempts += 1;
                return { rowCount: claimed.length, rows: claimed.map((row) => ({ ...row })) };
            }
            if (text.startsWith('SELECT id, owner_id')) {
                const [cutoff, maxAttempts, limit] = values;
                const selected = rows
                    .filter((row) => row.status === 'deleted' && row.purged_at === null
                        && new Date(row.deleted_at) <= new Date(cutoff) && row.purge_attempts < maxAttempts)
                    .sort((a, b) => new Date(a.deleted_at) - new Date(b.deleted_at))
                    .slice(0, limit);
                return { rowCount: selected.length, rows: selected.map((row) => ({ ...row })) };
            }
            if (text.startsWith('SELECT count(*)::int AS pending')) {
                const [maxAttempts] = values;
                const live = rows.filter((row) => row.status === 'deleted' && row.purged_at === null);
                return {
                    rowCount: 1,
                    rows: [{
                        pending: live.length,
                        exhausted: live.filter((row) => row.purge_attempts >= maxAttempts).length,
                    }],
                };
            }
            if (/SET purged_at = now\(\)/.test(text)) {
                const row = rows.find((item) => item.id === values[0]);
                if (!row || row.purged_at !== null) return { rowCount: 0, rows: [] };
                row.purged_at = new Date();
                row.last_purge_error = null;
                return { rowCount: 1, rows: [{ id: row.id }] };
            }
            if (/SET last_purge_error = \$2/.test(text)) {
                const row = rows.find((item) => item.id === values[0]);
                if (!row || row.purged_at !== null) return { rowCount: 0, rows: [] };
                row.last_purge_error = values[1];
                return { rowCount: 1, rows: [{ id: row.id }] };
            }
            throw new Error(`unexpected query: ${text.slice(0, 60)}`);
        },
    };
}

function deletedAsset(ownerId, { hoursAgo = 48, ...rest } = {}) {
    const id = rest.id || randomUUID();
    return {
        id,
        owner_id: ownerId,
        storage_key: `users/${ownerId}/assets/${id}`,
        deleted_at: new Date(NOW.getTime() - hoursAgo * HOUR),
        ...rest,
    };
}

test('清理已删除资产：删除主对象与缩略图、标记 purged_at、计数一次', async () => {
    const ownerId = randomUUID();
    const withThumb = deletedAsset(ownerId);
    const plain = deletedAsset(ownerId);
    withThumb.thumbnail_storage_key = `users/${ownerId}/thumbnails/${withThumb.id}`;
    const database = fakeDatabase([withThumb, plain]);
    const store = new MemoryObjectStore();
    await store.putObject({ key: withThumb.storage_key, body: Buffer.from('main'), acl: 'private' });
    await store.putObject({ key: withThumb.thumbnail_storage_key, body: Buffer.from('thumb'), acl: 'private' });
    await store.putObject({ key: plain.storage_key, body: Buffer.from('main'), acl: 'private' });

    const summary = await purgeDeletedAssets({ pool: database, objectStore: store, now: () => NOW });

    assert.equal(summary.dryRun, false);
    assert.equal(summary.claimed, 2);
    assert.equal(summary.purged.length, 2);
    assert.equal(summary.failed.length, 0);
    assert.equal(summary.pending, 0);
    assert.equal(await store.hasObject({ key: withThumb.storage_key }), false);
    assert.equal(await store.hasObject({ key: withThumb.thumbnail_storage_key }), false);
    assert.equal(await store.hasObject({ key: plain.storage_key }), false);
    for (const row of database.rows) {
        assert.ok(row.purged_at instanceof Date);
        assert.equal(row.purge_attempts, 1);
        assert.equal(row.last_purge_error, null);
    }
    // 认领必须带行锁跳过，避免并发清理进程互相等待。
    assert.match(database.calls[0].text, /FOR UPDATE SKIP LOCKED/);
    // 认领与删除之间不开事务：标记语句是独立调用，不在同一个 BEGIN 里。
    assert.equal(database.calls.some((call) => /BEGIN|COMMIT/.test(call.text)), false);
    // 保留键记在数据库里，但对象已经不存在——这正是 purged_at 与 storage_key 并存的原因。
    assert.match(withThumb.storage_key, new RegExp(`^users/${ownerId}/assets/`));
});

test('保留期未到不清理，超过保留期才认领', async () => {
    const ownerId = randomUUID();
    const fresh = deletedAsset(ownerId, { hoursAgo: 1 });
    const old = deletedAsset(ownerId, { hoursAgo: 30 });
    const database = fakeDatabase([fresh, old]);
    const store = new MemoryObjectStore();
    await store.putObject({ key: fresh.storage_key, body: Buffer.from('a'), acl: 'private' });
    await store.putObject({ key: old.storage_key, body: Buffer.from('b'), acl: 'private' });

    const summary = await purgeDeletedAssets({ pool: database, objectStore: store, retentionMs: 24 * HOUR, now: () => NOW });

    assert.equal(summary.claimed, 1);
    assert.equal(summary.retentionCutoff, new Date(NOW.getTime() - 24 * HOUR).toISOString());
    assert.equal(await store.hasObject({ key: fresh.storage_key }), true);
    assert.equal(await store.hasObject({ key: old.storage_key }), false);
    assert.equal(summary.pending, 1);
});

test('存储删除失败：记录错误码、保留 purged_at，下一次重试可成功', async () => {
    const ownerId = randomUUID();
    const asset = deletedAsset(ownerId);
    const database = fakeDatabase([asset]);
    const failing = {
        async deleteObject() {
            const error = new Error('EACCES: permission denied, unlink /srv/private/users/x');
            error.code = 'EACCES';
            throw error;
        },
    };

    const first = await purgeDeletedAssets({ pool: database, objectStore: failing, now: () => NOW });
    assert.equal(first.purged.length, 0);
    assert.deepEqual(first.failed, [{ id: asset.id, code: 'delete:EACCES' }]);
    assert.equal(database.rows[0].purged_at, null);
    assert.equal(database.rows[0].purge_attempts, 1);
    // 只持久化错误码：本地存储的错误消息带绝对路径，不能进数据库。
    assert.equal(database.rows[0].last_purge_error, 'delete:EACCES');
    assert.equal(JSON.stringify(first).includes('/srv/private'), false);

    const store = new MemoryObjectStore();
    await store.putObject({ key: asset.storage_key, body: Buffer.from('x'), acl: 'private' });
    const second = await purgeDeletedAssets({ pool: database, objectStore: store, now: () => NOW });
    assert.equal(second.purged.length, 1);
    assert.equal(database.rows[0].purge_attempts, 2);
    assert.equal(database.rows[0].last_purge_error, null);
    assert.ok(database.rows[0].purged_at instanceof Date);
});

test('对象已不存在视为幂等成功，不因 ENOENT 反复重试', async () => {
    const ownerId = randomUUID();
    const asset = deletedAsset(ownerId);
    const database = fakeDatabase([asset]);
    const store = new MemoryObjectStore();

    const summary = await purgeDeletedAssets({ pool: database, objectStore: store, now: () => NOW });
    assert.equal(summary.purged.length, 1);
    assert.ok(database.rows[0].purged_at instanceof Date);
});

test('尝试次数用尽后不再认领，并作为 exhausted 暴露给运维', async () => {
    const ownerId = randomUUID();
    const asset = deletedAsset(ownerId, { purge_attempts: 5, last_purge_error: 'delete:EACCES' });
    const database = fakeDatabase([asset]);
    const store = new MemoryObjectStore();
    await store.putObject({ key: asset.storage_key, body: Buffer.from('x'), acl: 'private' });

    const summary = await purgeDeletedAssets({ pool: database, objectStore: store, maxAttempts: 5, now: () => NOW });

    assert.equal(summary.claimed, 0);
    assert.equal(summary.exhausted, 1);
    assert.equal(await store.hasObject({ key: asset.storage_key }), true);
    assert.equal(database.rows[0].purge_attempts, 5);
});

test('存储键不属于该资产 owner 时拒绝删除对象（纵深防御）', async () => {
    const ownerId = randomUUID();
    const otherOwner = randomUUID();
    const asset = deletedAsset(ownerId, { storage_key: `users/${otherOwner}/assets/${randomUUID()}` });
    const database = fakeDatabase([asset]);
    const deleted = [];
    const store = {
        async deleteObject({ key }) { deleted.push(key); return true; },
    };

    const summary = await purgeDeletedAssets({ pool: database, objectStore: store, now: () => NOW });

    assert.equal(deleted.length, 0);
    assert.deepEqual(summary.failed, [{ id: asset.id, code: 'verify:key_owner_mismatch' }]);
    assert.equal(database.rows[0].purged_at, null);
    assert.equal(database.rows[0].last_purge_error, 'verify:key_owner_mismatch');
});

test('同一 owner 但不在已登记键族下的对象也拒绝删除', async () => {
    const ownerId = randomUUID();
    const asset = deletedAsset(ownerId, { storage_key: `users/${ownerId}/avatar/me` });
    const database = fakeDatabase([asset]);
    const deleted = [];
    const store = { async deleteObject({ key }) { deleted.push(key); return true; } };

    const summary = await purgeDeletedAssets({ pool: database, objectStore: store, now: () => NOW });

    assert.equal(deleted.length, 0);
    assert.deepEqual(summary.failed, [{ id: asset.id, code: 'verify:key_owner_mismatch' }]);
});

test('dry-run 只报告候选，不删对象也不写库', async () => {
    const ownerId = randomUUID();
    const asset = deletedAsset(ownerId);
    const database = fakeDatabase([asset]);
    const store = new MemoryObjectStore();
    await store.putObject({ key: asset.storage_key, body: Buffer.from('x'), acl: 'private' });

    const summary = await purgeDeletedAssets({ pool: database, objectStore: store, dryRun: true, now: () => NOW });

    assert.equal(summary.dryRun, true);
    assert.equal(summary.claimed, 1);
    assert.equal(summary.purged[0].id, asset.id);
    assert.equal(await store.hasObject({ key: asset.storage_key }), true);
    assert.equal(database.rows[0].purge_attempts, 0);
    assert.equal(database.calls.some((call) => /UPDATE assets SET/.test(call.text)), false);
});

test('单批上限生效，剩余留在下一轮', async () => {
    const ownerId = randomUUID();
    const assets = Array.from({ length: 3 }, (_, index) => deletedAsset(ownerId, { hoursAgo: 48 + index }));
    const database = fakeDatabase(assets);
    const store = new MemoryObjectStore();
    for (const asset of assets) await store.putObject({ key: asset.storage_key, body: Buffer.from('x'), acl: 'private' });

    const summary = await purgeDeletedAssets({ pool: database, objectStore: store, batchSize: 2, now: () => NOW });

    assert.equal(summary.claimed, 2);
    assert.equal(summary.pending, 1);
    // 先清最早的：hoursAgo 越大越旧。
    assert.equal(summary.purged[0].id, assets[2].id);
});

test('非法参数一律拒绝，不做部分执行', async () => {
    const database = fakeDatabase([]);
    const store = new MemoryObjectStore();
    const base = { pool: database, objectStore: store };
    await assert.rejects(purgeDeletedAssets({ objectStore: store }), { message: 'pool is required' });
    await assert.rejects(purgeDeletedAssets({ pool: database }), TypeError);
    await assert.rejects(purgeDeletedAssets({ ...base, objectStore: {} }), TypeError);
    await assert.rejects(purgeDeletedAssets({ ...base, retentionMs: -1 }), TypeError);
    await assert.rejects(purgeDeletedAssets({ ...base, batchSize: 0 }), TypeError);
    await assert.rejects(purgeDeletedAssets({ ...base, batchSize: 501 }), TypeError);
    await assert.rejects(purgeDeletedAssets({ ...base, maxAttempts: 0 }), TypeError);
    await assert.rejects(purgeDeletedAssets({ ...base, dryRun: 'yes' }), TypeError);
    await assert.rejects(purgeDeletedAssets({ ...base, now: () => new Date('invalid') }), TypeError);
    assert.equal(database.calls.length, 0);
});

test('默认保留期为 24 小时', () => {
    assert.equal(DEFAULT_RETENTION_MS, 24 * HOUR);
});
