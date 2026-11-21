'use strict';

const { TaskApiError } = require('./taskSubmission');
const { toPublicTask } = require('./taskView');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

// 列清单固定：列表与详情共用同一投影，避免两处字段漂移导致 UI 与接口不一致。
const PUBLIC_COLUMNS = `id, task_type, status, created_at, updated_at, completed_at,
                        cancel_requested_at, result, last_error`;

function assertOwnerId(ownerId) {
    if (typeof ownerId !== 'string' || !UUID_PATTERN.test(ownerId)) {
        throw new TypeError('ownerId must be a UUID');
    }
}

function parseLimit(value) {
    if (value === undefined || value === null || value === '') return DEFAULT_LIMIT;
    if (typeof value !== 'string' || !/^[1-9][0-9]{0,2}$/.test(value)) {
        throw new TaskApiError('INVALID_PAGINATION', 400);
    }
    const limit = Number(value);
    if (limit > MAX_LIMIT) throw new TaskApiError('INVALID_PAGINATION', 400);
    return limit;
}

// 游标是不透明字符串，客户端不应解析。使用 (created_at, id) 做 keyset 分页，
// 避免 OFFSET 在并发新增任务时重复或漏掉记录。
function encodeCursor(row, createdAt = new Date(row.created_at).toISOString()) {
    return Buffer.from(JSON.stringify({ createdAt, id: row.id }), 'utf8').toString('base64url');
}

function decodeCursor(value, preservePrecision = false) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || value.length > 512) {
        throw new TaskApiError('INVALID_PAGINATION', 400);
    }
    let parsed;
    try {
        parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    } catch {
        throw new TaskApiError('INVALID_PAGINATION', 400);
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.id !== 'string'
        || !UUID_PATTERN.test(parsed.id) || typeof parsed.createdAt !== 'string') {
        throw new TaskApiError('INVALID_PAGINATION', 400);
    }
    const createdAt = new Date(parsed.createdAt);
    if (Number.isNaN(createdAt.getTime())) throw new TaskApiError('INVALID_PAGINATION', 400);
    const iso = createdAt.toISOString();
    if (preservePrecision) {
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(parsed.createdAt)
            || parsed.createdAt.replace(/\d{3}Z$/, 'Z') !== iso) {
            throw new TaskApiError('INVALID_PAGINATION', 400);
        }
        return { createdAt: parsed.createdAt, id: parsed.id };
    }
    return { createdAt: iso, id: parsed.id };
}

function createTaskQueryService({ pool } = {}) {
    if (!pool || typeof pool.query !== 'function') throw new TypeError('pool is required');

    return Object.freeze({
        async list({ ownerId, limit, cursor } = {}) {
            assertOwnerId(ownerId);
            const pageSize = parseLimit(limit);
            const position = decodeCursor(cursor);
            const result = await pool.query(
                `SELECT ${PUBLIC_COLUMNS}
                 FROM generation_tasks
                 WHERE owner_id = $1::uuid
                   AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
                 ORDER BY created_at DESC, id DESC
                 LIMIT $4`,
                [ownerId, position ? position.createdAt : null, position ? position.id : null, pageSize + 1],
            );
            const rows = result.rows || [];
            const hasMore = rows.length > pageSize;
            const page = hasMore ? rows.slice(0, pageSize) : rows;
            return {
                tasks: page.map(toPublicTask),
                nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
            };
        },

        async listStudioHistory({ ownerId, media, limit, cursor } = {}) {
            assertOwnerId(ownerId);
            if (media !== 'image' && media !== 'video') throw new TaskApiError('INVALID_MEDIA_FILTER', 400);
            const pageSize = parseLimit(limit);
            const position = decodeCursor(cursor, true);
            // 游标保留 PostgreSQL 的微秒精度，避免同一毫秒内的较早记录被跳过。
            // 资产 UUID 转文本进行关联，历史结果里的非 UUID 值只会匹配不到资产。
            const result = await pool.query(
                `SELECT t.id, a.id AS asset_id, t.result->>'resultUrl' AS result_url,
                        COALESCE(t.route_snapshot->>'logicalModelId', t.payload->>'logicalModelId') AS logical_model_id,
                        t.payload->>'prompt' AS prompt, t.created_at,
                        to_char(t.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
                 FROM generation_tasks AS t
                 JOIN assets AS a
                   ON a.id::text = t.result->>'assetId'
                  AND a.owner_id = t.owner_id
                  AND a.status = 'ready'
                  AND a.deleted_at IS NULL
                 WHERE t.owner_id = $1::uuid
                   AND t.status = 'succeeded'
                   AND t.task_type = CASE $2::text WHEN 'image' THEN 'image.generate' ELSE 'video.generate' END
                   AND a.media_type = $2::text
                   AND t.result->>'archive' = 'ready'
                   AND t.result->>'resultUrl' = '/api/assets/' || a.id::text || '/content'
                   AND ($3::timestamptz IS NULL OR (t.created_at, t.id) < ($3::timestamptz, $4::uuid))
                 ORDER BY t.created_at DESC, t.id DESC
                 LIMIT $5`,
                [ownerId, media, position ? position.createdAt : null, position ? position.id : null, pageSize + 1],
            );
            const rows = result.rows || [];
            const hasMore = rows.length > pageSize;
            const page = hasMore ? rows.slice(0, pageSize) : rows;
            return {
                items: page.map((row) => ({
                    id: row.id,
                    assetId: row.asset_id,
                    resultUrl: row.result_url,
                    logicalModelId: row.logical_model_id,
                    prompt: row.prompt,
                    createdAt: row.created_at,
                })),
                nextCursor: hasMore ? encodeCursor(page[page.length - 1], page[page.length - 1].cursor_time) : null,
            };
        },

        async get({ ownerId, taskId } = {}) {
            assertOwnerId(ownerId);
            // 非法 ID 与"不存在"返回同一种结果：不能让调用方通过错误差异枚举他人任务。
            if (typeof taskId !== 'string' || !UUID_PATTERN.test(taskId)) return null;
            const result = await pool.query(
                `SELECT ${PUBLIC_COLUMNS}
                 FROM generation_tasks
                 WHERE id = $1::uuid AND owner_id = $2::uuid`,
                [taskId, ownerId],
            );
            return result.rowCount === 1 ? toPublicTask(result.rows[0]) : null;
        },
    });
}

module.exports = {
    DEFAULT_LIMIT,
    MAX_LIMIT,
    createTaskQueryService,
    decodeCursor,
    encodeCursor,
    parseLimit,
};
