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
function encodeCursor(row) {
    return Buffer.from(JSON.stringify({
        createdAt: new Date(row.created_at).toISOString(),
        id: row.id,
    }), 'utf8').toString('base64url');
}

function decodeCursor(value) {
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
    return { createdAt: createdAt.toISOString(), id: parsed.id };
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
