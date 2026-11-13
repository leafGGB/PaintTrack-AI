'use strict';

/**
 * 资产生命周期：孤儿「未完成归档」对象回收。
 *
 * 与 assetPurge 的区别，以及为什么不能用同一条查询：
 *
 * - `assetPurge` 处理的是**用户已软删除**的行：状态 `deleted`、持有 `storage_key`，
 *   清理的是行上登记的键。
 * - 这里处理的是**归档中途被强杀**留下的行：状态仍是 `pending`/`uploading`，而
 *   `assets_status_storage_consistency_check` 强制这两种状态 `storage_key IS NULL`，
 *   所以行上根本没有键可读。键只能按归档约定推导：`users/<owner_id>/assets/<asset_id>`
 *   （见 lib/server/assetArchive.js）。这不是猜测，是那条写入路径的唯一键格式。
 *
 * 收敛信号用 `abandoned_at`：
 * - 成功删除对象后写 `abandoned_at`，该行从此不再被认领；
 * - 删除失败则不写，只把 `purge_attempts` 与 `last_purge_error` 更新，下一轮继续重试；
 * - 失败到 `maxAttempts` 后不再认领，但仍计入 `exhausted` 让人看见。
 *
 * 为什么不把行标成 `failed`：cleanup 角色**没有** `status` 写权限（这是刻意的最小权限
 * 边界，验收里还有「cleanup 不能改 status」的负例）。把行改成 failed 需要扩大该角色的
 * 权限面，因此这里选择只写 `abandoned_at` 这一列，行的 status 保持原状，语义由该列承担。
 *
 * 已知局限（必须在文档中保留）：schema 里没有上传租约/心跳字段，因此「多久算超时」只能
 * 用 `created_at` 老化判断。当前没有交互式上传通道，`pending` 行全部由归档路径在数秒内
 * 创建并转成 `ready`，所以默认 6 小时的窗口不会误删正在写入的对象。将来若引入真正的
 * 分片/长时上传，必须补租约（heartbeat 或 upload_expires_at），不能只调大这个窗口。
 */

const DEFAULT_ABANDONMENT_MS = 6 * 60 * 60 * 1000;
const MAX_ABANDONMENT_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_BATCH_SIZE = 500;
const MAX_ERROR_FIELD = 120;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 与 assetPurge 保持同一份键族白名单：即使推导出的键被写坏，也只能落在
// 该 owner 自己的 assets/thumbnails 前缀下。
const OWNER_KEY_FAMILIES = Object.freeze(['assets', 'thumbnails']);

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
    // 只取错误码/类型名：本地存储错误常带绝对路径，不能进数据库。
    const raw = (error && (error.code || error.name)) || 'RECLAIM_FAILED';
    const text = String(raw).replace(/[^A-Za-z0-9_.:-]/g, '');
    return `${stage}:${(text || 'RECLAIM_FAILED').slice(0, MAX_ERROR_FIELD)}`;
}

/** 归档路径约定的对象键。owner 与 asset 都必须是 UUID，避免键里出现路径字符。 */
function assetKeyFor(ownerId, assetId) {
    return `users/${String(ownerId).toLowerCase()}/assets/${String(assetId).toLowerCase()}`;
}

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
           FROM assets
          WHERE status IN ('pending', 'uploading') AND abandoned_at IS NULL`,
        [maxAttempts],
    );
    const row = result.rows[0] || { pending: 0, exhausted: 0 };
    return { pending: row.pending, exhausted: row.exhausted };
}

async function reclaimAbandonedAssets({
    pool, objectStore,
    abandonmentMs = DEFAULT_ABANDONMENT_MS,
    batchSize = 50,
    maxAttempts = 5,
    dryRun = false,
    now = () => new Date(),
} = {}) {
    assertPool(pool);
    assertObjectStore(objectStore);
    assertInteger('abandonmentMs', abandonmentMs, { min: 0, max: MAX_ABANDONMENT_MS });
    assertInteger('batchSize', batchSize, { min: 1, max: MAX_BATCH_SIZE });
    assertInteger('maxAttempts', maxAttempts, { min: 1, max: 100 });
    if (typeof dryRun !== 'boolean') throw new TypeError('dryRun must be a boolean');
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    const startedAt = now();
    if (!(startedAt instanceof Date) || Number.isNaN(startedAt.getTime())) {
        throw new TypeError('now must return a valid Date');
    }
    const cutoff = new Date(startedAt.getTime() - abandonmentMs);

    // 只认 pending/uploading，且该行尚未被判定放弃。
    // 排序用 created_at：这是「这一行已经等了多久」的唯一可靠依据。
    const selection = `SELECT id, owner_id, created_at, thumbnail_storage_key
                         FROM assets
                        WHERE status IN ('pending', 'uploading')
                          AND abandoned_at IS NULL
                          AND created_at <= $1::timestamptz
                          AND purge_attempts < $2
                        ORDER BY created_at
                        LIMIT $3`;
    const params = [cutoff.toISOString(), maxAttempts, batchSize];

    let claimed;
    if (dryRun) {
        const result = await pool.query(selection, params);
        claimed = result.rows.map((row) => ({ ...row, purge_attempts: null }));
    } else {
        // 认领即计数，与 assetPurge 一致：进程中途崩溃也不会无限重试同一行。
        // 刻意不改 updated_at —— 那是真实生命周期写入的时间，不该被清理流程伪造成心跳。
        const result = await pool.query(
            `WITH claimed AS (${selection} FOR UPDATE SKIP LOCKED)
             UPDATE assets AS a
                SET purge_attempts = a.purge_attempts + 1
               FROM claimed
              WHERE a.id = claimed.id
             RETURNING a.id, a.owner_id, a.created_at, a.thumbnail_storage_key, a.purge_attempts`,
            params,
        );
        claimed = result.rows;
    }

    const reclaimed = [];
    const failed = [];

    for (const row of claimed) {
        if (!UUID_PATTERN.test(String(row.id)) || !UUID_PATTERN.test(String(row.owner_id))) {
            // 正常不可达；主键与 owner 都是 uuid 类型。防御性跳过而不是中断整批。
            failed.push({ id: String(row.id), code: 'claim:invalid_id' });
            continue;
        }

        const keys = [row.thumbnail_storage_key, assetKeyFor(row.owner_id, row.id)]
            .filter((key) => typeof key === 'string');
        const foreignKey = keys.find((key) => !keyBelongsToOwner(key, row.owner_id));
        if (foreignKey) {
            if (!dryRun) {
                await pool.query(
                    `UPDATE assets SET last_purge_error = $2
                      WHERE id = $1::uuid AND abandoned_at IS NULL`,
                    [row.id, 'orphan-verify:key_owner_mismatch'],
                );
            }
            failed.push({ id: row.id, code: 'orphan-verify:key_owner_mismatch' });
            continue;
        }

        if (dryRun) {
            reclaimed.push({ id: row.id, objects: keys.length, dryRun: true });
            continue;
        }

        let code = null;
        for (const key of keys) {
            try {
                // 对象不存在返回 false，视为幂等成功。
                await objectStore.deleteObject({ key });
            } catch (error) {
                code = failureCode('orphan-delete', error);
                break;
            }
        }

        if (code) {
            await pool.query(
                `UPDATE assets SET last_purge_error = $2
                  WHERE id = $1::uuid AND abandoned_at IS NULL`,
                [row.id, code],
            );
            failed.push({ id: row.id, code });
            continue;
        }

        // 条件里重复声明状态：并发下若该行已被别的进程推进到 ready，
        // 这里的更新命中 0 行，正是期望行为（不覆盖真实状态）。
        await pool.query(
            `UPDATE assets SET abandoned_at = now(), last_purge_error = NULL
              WHERE id = $1::uuid
                AND abandoned_at IS NULL
                AND status IN ('pending', 'uploading')`,
            [row.id],
        );
        reclaimed.push({ id: row.id, objects: keys.length });
    }

    const backlog = await countBacklog(pool, maxAttempts);

    return Object.freeze({
        dryRun,
        abandonmentCutoff: cutoff.toISOString(),
        claimed: claimed.length,
        reclaimed: Object.freeze(reclaimed),
        failed: Object.freeze(failed),
        pending: backlog.pending,
        exhausted: backlog.exhausted,
    });
}

module.exports = {
    DEFAULT_ABANDONMENT_MS,
    MAX_ABANDONMENT_MS,
    MAX_BATCH_SIZE,
    assetKeyFor,
    keyBelongsToOwner,
    reclaimAbandonedAssets,
};
