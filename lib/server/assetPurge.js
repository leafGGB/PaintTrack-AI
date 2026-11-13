'use strict';

/**
 * 资产生命周期：物理对象清理。
 *
 * 用户删除资产只是「软删除」——`assets.status` 置为 `deleted`、写入 `deleted_at`，
 * 并**保留** `storage_key`（数据库约束要求 deleted 状态必须持有存储键）。本模块负责
 * 之后真正删除对象存储里的二进制，并把结果写回三列清理状态：
 *
 *   purged_at        清理完成时间；为空表示对象可能仍在
 *   purge_attempts   已认领次数，用于限制重试并让长期失败的记录浮出水面
 *   last_purge_error 最后一次失败的阶段与错误码（只存码，不存消息）
 *
 * 设计取舍：
 * - 认领与标记分开，删除对象在两次数据库写之间、**不持有事务**，避免慢存储拖住行锁。
 * - 删除对象天然幂等（对象已不存在视为成功），因此「先删后标」中断后可直接重试。
 * - 认领事务提交后到删除完成之间没有租约，理论上两个清理进程可能重复删除同一对象；
 *   因为删除幂等、重复代价有界（最多多一次 unlink/DELETE 调用），这里不额外引入租约列。
 * - 错误消息可能是文件系统绝对路径，故只持久化错误码，不持久化 message。
 */

const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_BATCH_SIZE = 500;
const MAX_ERROR_FIELD = 120;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertPool(pool) {
    if (!pool || typeof pool.query !== 'function') throw new TypeError('pool is required');
}

function assertObjectStore(objectStore) {
    if (!objectStore || typeof objectStore.deleteObject !== 'function') {
        throw new TypeError('objectStore with deleteObject is required');
    }
}

function assertInteger(name, value, { min, max }) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new TypeError(`${name} must be an integer between ${min} and ${max}`);
    }
}

function failureCode(stage, error) {
    // 只取错误码/类型名，绝不拼接 message：本地存储错误常带绝对路径。
    const raw = (error && (error.code || error.name)) || 'PURGE_FAILED';
    const text = String(raw).replace(/[^A-Za-z0-9_.:-]/g, '');
    return `${stage}:${(text || 'PURGE_FAILED').slice(0, MAX_ERROR_FIELD)}`;
}

/**
 * 归档键必须落在该资产 owner 自己的前缀下，否则拒绝删除。
 * 这是纵深防御：即使数据库行被写坏，也不能借清理流程删掉别人的对象。
 * 只接受已登记的键族；缩略图必须与主对象同级并列（文件存储里无法把对象嵌在
 * 另一个对象键之下——主对象本身就是一个文件）。
 */
const OWNER_KEY_FAMILIES = Object.freeze(['assets', 'thumbnails']);

function keyBelongsToOwner(key, ownerId) {
    if (typeof key !== 'string') return false;
    const prefix = `users/${String(ownerId).toLowerCase()}/`;
    const normalized = key.toLowerCase();
    if (!normalized.startsWith(prefix)) return false;
    const family = normalized.slice(prefix.length).split('/')[0];
    return OWNER_KEY_FAMILIES.includes(family);
}

async function countBacklog(pool, maxAttempts) {
    const result = await pool.query(
        `SELECT count(*)::int AS pending,
                count(*) FILTER (WHERE purge_attempts >= $1)::int AS exhausted
           FROM assets WHERE status = 'deleted' AND purged_at IS NULL`,
        [maxAttempts],
    );
    const row = result.rows[0] || { pending: 0, exhausted: 0 };
    return { pending: row.pending, exhausted: row.exhausted };
}

async function purgeDeletedAssets({
    pool, objectStore,
    retentionMs = DEFAULT_RETENTION_MS,
    batchSize = 50,
    maxAttempts = 5,
    dryRun = false,
    now = () => new Date(),
} = {}) {
    assertPool(pool);
    assertObjectStore(objectStore);
    assertInteger('retentionMs', retentionMs, { min: 0, max: MAX_RETENTION_MS });
    assertInteger('batchSize', batchSize, { min: 1, max: MAX_BATCH_SIZE });
    assertInteger('maxAttempts', maxAttempts, { min: 1, max: 100 });
    if (typeof dryRun !== 'boolean') throw new TypeError('dryRun must be a boolean');
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    const startedAt = now();
    if (!(startedAt instanceof Date) || Number.isNaN(startedAt.getTime())) {
        throw new TypeError('now must return a valid Date');
    }
    const cutoff = new Date(startedAt.getTime() - retentionMs);

    const selection = `SELECT id, owner_id, storage_key, thumbnail_storage_key
                         FROM assets
                        WHERE status = 'deleted'
                          AND purged_at IS NULL
                          AND deleted_at <= $1::timestamptz
                          AND purge_attempts < $2
                        ORDER BY deleted_at
                        LIMIT $3`;
    const params = [cutoff.toISOString(), maxAttempts, batchSize];

    let claimed;
    if (dryRun) {
        const result = await pool.query(selection, params);
        claimed = result.rows.map((row) => ({ ...row, purge_attempts: null }));
    } else {
        // 认领即计数：purge_attempts 在删除开始前自增，进程中途崩溃也不会无限重试。
        // FOR UPDATE SKIP LOCKED 让并发清理进程跳过彼此正在处理的行。
        const result = await pool.query(
            `WITH claimed AS (${selection} FOR UPDATE SKIP LOCKED)
             UPDATE assets AS a
                SET purge_attempts = a.purge_attempts + 1,
                    updated_at = now()
               FROM claimed
              WHERE a.id = claimed.id
             RETURNING a.id, a.owner_id, a.storage_key, a.thumbnail_storage_key, a.purge_attempts`,
            params,
        );
        claimed = result.rows;
    }

    const purged = [];
    const failed = [];

    for (const row of claimed) {
        if (!UUID_PATTERN.test(row.id)) {
            // 正常不可达；主键是 uuid 类型。防御性跳过而不是抛错中断整批。
            failed.push({ id: String(row.id), code: 'claim:invalid_id' });
            continue;
        }
        const keys = [row.thumbnail_storage_key, row.storage_key].filter((key) => typeof key === 'string');
        const foreignKey = keys.find((key) => !keyBelongsToOwner(key, row.owner_id));
        if (foreignKey) {
            if (!dryRun) {
                await pool.query(
                    `UPDATE assets SET last_purge_error = $2, updated_at = now()
                      WHERE id = $1::uuid AND purged_at IS NULL`,
                    [row.id, 'verify:key_owner_mismatch'],
                );
            }
            failed.push({ id: row.id, code: 'verify:key_owner_mismatch' });
            continue;
        }
        if (dryRun) {
            purged.push({ id: row.id, objects: keys.length, dryRun: true });
            continue;
        }

        let code = null;
        for (const key of keys) {
            try {
                // deleteObject 对不存在的对象返回 false，视为幂等成功。
                await objectStore.deleteObject({ key });
            } catch (error) {
                code = failureCode('delete', error);
                break;
            }
        }

        if (code) {
            await pool.query(
                `UPDATE assets SET last_purge_error = $2, updated_at = now()
                  WHERE id = $1::uuid AND purged_at IS NULL`,
                [row.id, code],
            );
            failed.push({ id: row.id, code });
            continue;
        }

        // 已被并发进程标记完成时 rowCount 为 0，同样算作成功。
        await pool.query(
            `UPDATE assets SET purged_at = now(), last_purge_error = NULL, updated_at = now()
              WHERE id = $1::uuid AND purged_at IS NULL`,
            [row.id],
        );
        purged.push({ id: row.id, objects: keys.length });
    }

    const backlog = await countBacklog(pool, maxAttempts);

    return Object.freeze({
        dryRun,
        retentionCutoff: cutoff.toISOString(),
        claimed: claimed.length,
        purged: Object.freeze(purged),
        failed: Object.freeze(failed),
        pending: backlog.pending,
        exhausted: backlog.exhausted,
    });
}

module.exports = {
    DEFAULT_RETENTION_MS,
    MAX_BATCH_SIZE,
    MAX_RETENTION_MS,
    purgeDeletedAssets,
};
