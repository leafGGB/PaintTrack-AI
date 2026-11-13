const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { purgeDeletedAssets } = require('../../lib/server/assetPurge');
const { reclaimAbandonedAssets } = require('../../lib/server/orphanReclaim');
const { createFileObjectStore } = require('../../lib/server/storage/fileObjectStore');

async function exists(target) {
    try { await fs.access(target); return true; } catch { return false; }
}

/**
 * 在真实隔离 PostgreSQL 上验证清理链路：
 * 清理角色权限刚好够用 → 软删除行被认领 → 对象真的从磁盘消失 → 重跑幂等。
 * 这条用例的价值在权限：单测用的是替身数据库，证明不了「cleanup 角色读不到用户/任务表」。
 */
async function checkAssetPurge(cleanupPool, record, { owner } = {}) {
    assert.ok(owner && typeof owner.query === 'function', 'owner client is required');
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'painttrack-purge-'));
    try {
        const ownerId = randomUUID();
        const assetId = randomUUID();
        const storageKey = `users/${ownerId}/assets/${assetId}`;
        // 缩略图与主对象同级：文件存储无法把对象嵌在另一个对象键之下（主对象是文件）。
        const thumbnailKey = `users/${ownerId}/thumbnails/${assetId}`;
        const store = createFileObjectStore({ rootDirectory: root });
        await store.putObject({ key: storageKey, body: Buffer.from('main-bytes'), acl: 'private' });
        await store.putObject({ key: thumbnailKey, body: Buffer.from('thumb-bytes'), acl: 'private' });

        await owner.query(
            `INSERT INTO assets(id,owner_id,media_type,mime_type,size_bytes,storage_key,thumbnail_storage_key,status)
             VALUES($1::uuid,$2::uuid,'image','image/png',10,$3,$4,'ready')`,
            [assetId, ownerId, storageKey, thumbnailKey],
        );
        // 用数据库时钟写 1 小时前的删除时间，避免宿主与容器时钟偏差影响保留期判断。
        await owner.query("UPDATE assets SET status='deleted',deleted_at=clock_timestamp()-interval '1 hour' WHERE id=$1::uuid", [assetId]);

        // 1) 表级权限必须全无：cleanup 只靠列级授权工作。
        const tablePrivileges = await cleanupPool.query(`SELECT has_table_privilege(current_user,'public.assets','SELECT') AS sel,
            has_table_privilege(current_user,'public.assets','UPDATE') AS upd,
            has_table_privilege(current_user,'public.assets','INSERT') AS ins,
            has_table_privilege(current_user,'public.assets','DELETE') AS del`);
        assert.deepEqual(tablePrivileges.rows[0], { sel: false, upd: false, ins: false, del: false });

        // 2) 越权语句一律 42501：读不到用户/任务，也读不到资产元数据。
        for (const sql of [
            'SELECT email FROM users LIMIT 1',
            'SELECT count(*) FROM generation_tasks',
            'SELECT mime_type FROM assets',
            'SELECT metadata FROM assets',
            "UPDATE assets SET status='ready'",
            "UPDATE assets SET storage_key='users/x/assets/y'",
            "INSERT INTO assets(owner_id,media_type,status) VALUES(gen_random_uuid(),'image','pending')",
            'DELETE FROM assets',
        ]) {
            await assert.rejects(cleanupPool.query(sql), (error) => error.code === '42501', `应拒绝：${sql}`);
        }
        record('真实PG cleanup角色无表级权限，越权读写返回42501', 'passed');

        // 3) 正常清理：对象从磁盘消失，行被标记完成。
        // 保留期取 30 分钟：本行是 1 小时前删除的，而其它 fixture 刚删除的资产不在窗口内，
        // 这样断言的是「本行被清理」，而不是依赖整库只有一条候选。
        assert.equal(await exists(path.join(root, storageKey)), true);
        const first = await purgeDeletedAssets({ pool: cleanupPool, objectStore: store, retentionMs: 30 * 60 * 1000 });
        assert.equal(first.claimed, 1);
        assert.deepEqual(first.purged.map((item) => item.id), [assetId]);
        assert.equal(first.failed.length, 0);
        assert.equal(await exists(path.join(root, storageKey)), false);
        assert.equal(await exists(path.join(root, thumbnailKey)), false);
        const purgedRow = (await owner.query('SELECT status,purged_at,purge_attempts,last_purge_error FROM assets WHERE id=$1::uuid', [assetId])).rows[0];
        assert.equal(purgedRow.status, 'deleted');
        assert.ok(purgedRow.purged_at instanceof Date);
        assert.equal(purgedRow.purge_attempts, 1);
        assert.equal(purgedRow.last_purge_error, null);

        // 4) 重跑幂等：本行不再被认领，也不会把失败计数继续累加。
        const second = await purgeDeletedAssets({ pool: cleanupPool, objectStore: store, retentionMs: 30 * 60 * 1000 });
        assert.equal(second.claimed, 0);
        assert.equal(second.purged.length, 0);
        assert.equal((await owner.query('SELECT purge_attempts FROM assets WHERE id=$1::uuid', [assetId])).rows[0].purge_attempts, 1);

        // 5) 约束兜底：已清理的资产不能被改回 ready，尝试次数不能为负。
        await assert.rejects(
            owner.query("UPDATE assets SET status='ready' WHERE id=$1::uuid", [assetId]),
            (error) => error.code === '23514',
        );
        await assert.rejects(
            owner.query('UPDATE assets SET purge_attempts=-1 WHERE id=$1::uuid', [assetId]),
            (error) => error.code === '23514',
        );
        record('真实PG清理：对象被删除/标记完成/重跑幂等/已清理不可复活', 'passed');

        // 6) 孤儿回收：归档中途被强杀会留下「对象已写入、行仍是 pending」的组合，
        //    此时行上没有 storage_key（CHECK 强制为 NULL），键只能按 (owner,id) 推导。
        const orphanOwnerId = randomUUID();
        const orphanId = randomUUID();
        const orphanKey = `users/${orphanOwnerId}/assets/${orphanId}`;
        await owner.query(
            `INSERT INTO assets(id,owner_id,media_type,mime_type,size_bytes,status)
             VALUES($1::uuid,$2::uuid,'image','image/png',9,'pending')`,
            [orphanId, orphanOwnerId],
        );
        // 用数据库时钟做旧，避免宿主与容器时钟偏差影响老化窗口判断。
        await owner.query("UPDATE assets SET created_at=clock_timestamp()-interval '7 hours' WHERE id=$1::uuid", [orphanId]);
        await store.putObject({ key: orphanKey, body: Buffer.from('orphan-bytes'), acl: 'private' });
        assert.equal(await exists(path.join(root, orphanKey)), true);

        const reclaimWindow = 6 * 60 * 60 * 1000;
        const reclaim = await reclaimAbandonedAssets({ pool: cleanupPool, objectStore: store, abandonmentMs: reclaimWindow });
        assert.ok(reclaim.reclaimed.some((item) => item.id === orphanId), '本行应被认定为孤儿并回收');
        assert.equal(await exists(path.join(root, orphanKey)), false);
        const orphanRow = (await owner.query(
            'SELECT status,abandoned_at,purge_attempts,last_purge_error FROM assets WHERE id=$1::uuid',
            [orphanId],
        )).rows[0];
        // 清理流程不写 status：cleanup 角色没有该列的写权限。
        assert.equal(orphanRow.status, 'pending');
        assert.ok(orphanRow.abandoned_at instanceof Date);
        assert.equal(orphanRow.purge_attempts, 1);
        assert.equal(orphanRow.last_purge_error, null);

        // 7) 重跑不再认领已放弃的行（收敛而不是每轮重复删同一个键）。
        const secondReclaim = await reclaimAbandonedAssets({ pool: cleanupPool, objectStore: store, abandonmentMs: reclaimWindow });
        assert.equal(secondReclaim.reclaimed.some((item) => item.id === orphanId), false);

        // 8) 安全边界：窗口内刚创建的 pending 行绝不能被回收，否则会删掉正在写入的对象。
        const freshId = randomUUID();
        const freshKey = `users/${orphanOwnerId}/assets/${freshId}`;
        await owner.query(
            `INSERT INTO assets(id,owner_id,media_type,mime_type,size_bytes,status)
             VALUES($1::uuid,$2::uuid,'image','image/png',9,'pending')`,
            [freshId, orphanOwnerId],
        );
        await store.putObject({ key: freshKey, body: Buffer.from('in-flight'), acl: 'private' });
        const freshReclaim = await reclaimAbandonedAssets({ pool: cleanupPool, objectStore: store, abandonmentMs: reclaimWindow });
        assert.equal(freshReclaim.reclaimed.some((item) => item.id === freshId), false);
        assert.equal(await exists(path.join(root, freshKey)), true);
        const freshRow = (await owner.query('SELECT abandoned_at FROM assets WHERE id=$1::uuid', [freshId])).rows[0];
        assert.equal(freshRow.abandoned_at, null);
        record('真实PG孤儿回收：pending行按推导键删对象、写abandoned_at、重跑收敛、窗口内不误删', 'passed');
    } finally {
        await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
}

module.exports = { checkAssetPurge };
