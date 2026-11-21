'use strict';

const { RegistrationError } = require('./registration');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

function parseLimit(value) {
    if (value === undefined) return DEFAULT_LIMIT;
    if (typeof value !== 'string' || !/^[1-9][0-9]?$/.test(value) || Number(value) > MAX_LIMIT) {
        throw new RegistrationError('INVALID_PAGINATION', 400);
    }
    return Number(value);
}

function decodeCursor(value) {
    if (value === undefined) return null;
    const invalid = () => new RegistrationError('INVALID_PAGINATION', 400);
    if (typeof value !== 'string' || value.length === 0 || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) {
        throw invalid();
    }
    let parsed;
    try {
        const bytes = Buffer.from(value, 'base64url');
        if (bytes.toString('base64url') !== value) throw invalid();
        parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
        throw invalid();
    }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object'
        || Object.keys(parsed).length !== 2
        || typeof parsed.id !== 'string' || !UUID_PATTERN.test(parsed.id)
        || typeof parsed.createdAt !== 'string'
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(parsed.createdAt)
        || parsed.createdAt.startsWith('0000-')) throw invalid();
    const date = new Date(parsed.createdAt);
    if (Number.isNaN(date.getTime()) || parsed.createdAt.replace(/\d{3}Z$/, 'Z') !== date.toISOString()) {
        throw invalid();
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
}

function validateList({ media, limit, cursor }) {
    if (media !== 'all' && media !== 'image' && media !== 'video') throw new RegistrationError('INVALID_MEDIA_FILTER', 400);
    return { pageSize: parseLimit(limit), position: decodeCursor(cursor) };
}

function parseAssetsQuery(searchParams) {
    for (const key of searchParams.keys()) {
        if (!['media', 'limit', 'cursor'].includes(key) || searchParams.getAll(key).length !== 1) {
            throw new RegistrationError('INVALID_ASSET_FILTER', 400);
        }
    }
    const input = {
        media: searchParams.get('media') ?? undefined,
        limit: searchParams.get('limit') ?? undefined,
        cursor: searchParams.get('cursor') ?? undefined,
    };
    validateList(input);
    return input;
}

function normalizeSize(value) {
    if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) throw new Error('INVALID_ASSET_SIZE');
    const size = Number(value);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('INVALID_ASSET_SIZE');
    return size;
}

function createAssetsQueryService({ pool } = {}) {
    if (!pool || typeof pool.query !== 'function') throw new TypeError('pool is required');
    return Object.freeze({
        async list({ ownerId, media, limit, cursor } = {}) {
            if (typeof ownerId !== 'string' || !UUID_PATTERN.test(ownerId)) throw new TypeError('ownerId must be a UUID');
            const { pageSize, position } = validateList({ media, limit, cursor });
            // 时间由 PostgreSQL 格式化，游标绝不经过会截断微秒的 JS Date。
            const result = await pool.query(
                `SELECT id, media_type, mime_type, size_bytes,
                        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
                 FROM assets
                 WHERE owner_id = $1::uuid
                   AND media_type IN ('image', 'video')
                   AND ($2::text = 'all' OR media_type = $2::text)
                   AND status = 'ready'
                   AND deleted_at IS NULL
                   AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
                 ORDER BY created_at DESC, id DESC
                 LIMIT $5`,
                [ownerId, media, position ? position.createdAt : null, position ? position.id : null, pageSize + 1],
            );
            const rows = result.rows || [];
            const hasMore = rows.length > pageSize;
            const page = hasMore ? rows.slice(0, pageSize) : rows;
            const last = page[page.length - 1];
            return {
                items: page.map((row) => ({
                    id: row.id,
                    mediaType: row.media_type,
                    mimeType: row.mime_type,
                    sizeBytes: normalizeSize(row.size_bytes),
                    createdAt: row.cursor_time,
                    resultUrl: `/api/assets/${row.id}/content`,
                })),
                nextCursor: hasMore ? Buffer.from(JSON.stringify({ createdAt: last.cursor_time, id: last.id }), 'utf8').toString('base64url') : null,
            };
        },
    });
}

module.exports = { DEFAULT_LIMIT, MAX_LIMIT, createAssetsQueryService, decodeCursor, parseAssetsQuery, parseLimit };
