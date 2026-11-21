'use strict';

const { sql } = require('drizzle-orm');
const { RegistrationError } = require('./registration');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_EVENTS = 50;
const DEFAULT_LIMIT = 20;
const EVENT_KINDS = new Set(['reserve', 'settle', 'release', 'grant']);
const TASK_STATUSES = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled']);

function normalizeTenths(value) {
    const text = String(value ?? '0');
    if (!/^\d+$/.test(text)) throw new Error('CREDIT_DATA_INVALID');
    return text;
}

function addTenths(left, right) {
    return (BigInt(normalizeTenths(left)) + BigInt(normalizeTenths(right))).toString();
}

function normalizeDate(value) {
    if (value === null || value === undefined) return null;
    let text = String(value).trim().replace(' ', 'T');
    if (/([+-]\d{2})$/.test(text)) text = text.replace(/([+-]\d{2})$/, '$1:00');
    const date = value instanceof Date ? value : new Date(text);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function invalidQuery() { throw new RegistrationError('INVALID_CREDIT_QUERY', 400); }

// Hex is an opaque transport, not an authorization token. Every query still binds the session owner.
function parseCreditQuery(options = {}, userId) {
    const { limit = DEFAULT_LIMIT, kind = null, cursor = null } = options;
    if (!/^[1-9]\d?$/.test(String(limit)) || Number(limit) > MAX_EVENTS) invalidQuery();
    if (kind !== null && !EVENT_KINDS.has(kind)) invalidQuery();
    let after = null;
    if (cursor !== null) {
        if (typeof cursor !== 'string' || cursor.length > 1024 || !/^(?:[0-9a-f]{2})+$/.test(cursor)) invalidQuery();
        try {
            after = JSON.parse(Buffer.from(cursor, 'hex').toString('utf8'));
            if (!after || Array.isArray(after) || Object.keys(after).sort().join(',') !== 'id,kind,time,userId,v'
                || after.v !== 1 || after.userId !== userId || after.kind !== kind || !UUID_PATTERN.test(after.id)
                || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(after.time)
                || Number.isNaN(new Date(after.time).getTime())) invalidQuery();
        } catch { invalidQuery(); }
    }
    return { limit: Number(limit), kind, after };
}

function normalizeEvent(row, userId) {
    if (!EVENT_KINDS.has(row.kind) || !UUID_PATTERN.test(row.id) || row.user_id !== userId
        || !/^\d+$/.test(String(row.credit_tenths)) || (row.task_id && !UUID_PATTERN.test(row.task_id))) throw new Error('CREDIT_DATA_INVALID');
    const createdAt = normalizeDate(row.created_at);
    if (!createdAt) throw new Error('CREDIT_DATA_INVALID');
    let task = null;
    if (row.task_id) {
        if (row.linked_task_id !== row.task_id || !TASK_STATUSES.has(row.task_status) || typeof row.task_type !== 'string') throw new Error('CREDIT_DATA_INVALID');
        task = Object.freeze({ id: row.linked_task_id, taskType: row.task_type, status: row.task_status });
    }
    return Object.freeze({ id: row.id, kind: row.kind, amountTenths: String(row.credit_tenths),
        taskId: row.task_id || null, task, sourceType: row.source_type, createdAt });
}

function createAccountCreditsService({ database } = {}) {
    if (!database || typeof database.execute !== 'function') throw new TypeError('database is required');
    return Object.freeze({
        async read(userId, options = {}) {
            if (typeof userId !== 'string' || !UUID_PATTERN.test(userId)) throw new RegistrationError('UNAUTHENTICATED', 401);
            const { limit, kind, after } = parseCreditQuery(options, userId);
            const kindClause = kind === null ? sql`` : sql`AND e.kind=${kind}`;
            const cursorClause = after === null ? sql`` : sql`AND (e.created_at,e.id) < (${after.time}::timestamptz,${after.id}::uuid)`;
            const [accountResult, eventsResult] = await Promise.all([
                database.execute(sql`SELECT user_id, available_tenths::text, reserved_tenths::text, unit_version
                    FROM credit_accounts WHERE user_id=${userId}`),
                database.execute(sql`SELECT e.id,e.user_id,e.task_id,e.kind,e.credit_tenths::text,e.source_type,e.created_at,
                    to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time,
                    t.id AS linked_task_id,t.task_type,t.status AS task_status
                    FROM credit_ledger_events e LEFT JOIN generation_tasks t ON t.id=e.task_id AND t.owner_id=${userId}
                    WHERE e.user_id=${userId} ${kindClause} ${cursorClause}
                    ORDER BY e.created_at DESC,e.id DESC LIMIT ${limit + 1}`),
            ]);
            const account = accountResult.rows[0];
            if (account && (account.user_id !== userId || account.unit_version !== 'credit_tenths_v1')) throw new Error('CREDIT_DATA_INVALID');
            const availableTenths = normalizeTenths(account?.available_tenths);
            const reservedTenths = normalizeTenths(account?.reserved_tenths);
            const rows = eventsResult.rows.slice(0, limit);
            const events = Object.freeze(rows.map(row => normalizeEvent(row, userId)));
            let nextCursor = null;
            if (eventsResult.rows.length > limit) {
                const last = rows[rows.length - 1];
                // Keep PostgreSQL's full microsecond precision; JS Date would truncate the page boundary.
                if (!last.cursor_time || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(last.cursor_time)) throw new Error('CREDIT_DATA_INVALID');
                nextCursor = Buffer.from(JSON.stringify({ v: 1, userId, kind, time: last.cursor_time, id: last.id })).toString('hex');
            }
            return Object.freeze({ availableTenths, reservedTenths, totalTenths: addTenths(availableTenths, reservedTenths),
                unitVersion: 'credit_tenths_v1', events, nextCursor });
        },
    });
}

module.exports = { MAX_EVENTS, DEFAULT_LIMIT, addTenths, createAccountCreditsService, normalizeDate, normalizeTenths, parseCreditQuery };
