'use strict';

const { sql } = require('drizzle-orm');
const { getDatabase } = require('./db');
const { RegistrationError } = require('./registration');

const DAY_US = 86400000000n;
const WINDOW_US = 31n * DAY_US;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INPUT_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const CLOCK_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

function invalidQuery() { throw new RegistrationError('INVALID_ADMIN_ANALYTICS_QUERY', 400); }
function invalidData() { throw new Error('ADMIN_ANALYTICS_DATA_INVALID'); }

function inputTime(value) {
    if (typeof value !== 'string' || !INPUT_TIME.test(value)) invalidQuery();
    const milliseconds = Date.parse(value);
    const canonical = value.includes('.') ? value : value.replace('Z', '.000Z');
    if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== canonical) invalidQuery();
    return { text: canonical, us: BigInt(milliseconds) * 1000n };
}

function parseQuery(params) {
    if (!(params instanceof URLSearchParams)) invalidQuery();
    for (const key of params.keys()) {
        if (!['from', 'to'].includes(key) || params.getAll(key).length !== 1) invalidQuery();
    }
    if (params.has('from') !== params.has('to')) invalidQuery();
    if (!params.has('from')) return null;
    const from = inputTime(params.get('from'));
    const to = inputTime(params.get('to'));
    if (from.us >= to.us || to.us - from.us > WINDOW_US) invalidQuery();
    return { from, to };
}

function clockTime(value) {
    if (typeof value !== 'string' || !CLOCK_TIME.test(value)) invalidData();
    const milliseconds = Date.parse(value);
    if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value.replace(/\d{3}Z$/, 'Z')) invalidData();
    return BigInt(milliseconds) * 1000n + BigInt(value.slice(-4, -1));
}

function isoMicroseconds(us) {
    // PostgreSQL 时钟保留微秒，不让 JS Date 截断默认窗口的右端点。
    const milliseconds = us / 1000n;
    const remainder = us % 1000n;
    if (remainder < 0n) return new Date(Number(milliseconds - 1n)).toISOString().replace('Z', `${String(remainder + 1000n).padStart(3, '0')}Z`);
    return new Date(Number(milliseconds)).toISOString().replace('Z', `${String(remainder).padStart(3, '0')}Z`);
}

async function databaseClock(tx) {
    const result = await tx.execute(sql`SELECT to_char(pg_catalog.clock_timestamp() AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS as_of`);
    return result.rows[0]?.as_of;
}

function rankingQuery(from, to) {
    return sql`WITH task_batch AS (
        SELECT t.owner_id,t.status,t.logical_model_pk,t.route_snapshot->>'logicalModelId' AS model_id,
            CASE
                WHEN t.logical_model_pk IS NULL OR t.route_snapshot IS NULL
                    OR t.route_snapshot_version IS NULL OR t.route_snapshot_hash IS NULL THEN 'missing_route'
                WHEN t.route_snapshot_version <> 1 THEN 'unsupported_version'
                WHEN jsonb_typeof(t.route_snapshot) <> 'object' THEN 'invalid_identity'
                WHEN jsonb_typeof(t.route_snapshot->'snapshotVersion') = 'number'
                    AND t.route_snapshot->>'snapshotVersion' <> '1' THEN 'unsupported_version'
                WHEN jsonb_typeof(t.route_snapshot->'snapshotVersion') = 'number'
                    AND t.route_snapshot->>'snapshotVersion' = '1'
                    AND jsonb_typeof(t.route_snapshot->'logicalModelId') = 'string'
                    AND (t.route_snapshot->>'logicalModelId') ~ '^[a-z0-9][a-z0-9._-]{1,127}$'
                    AND CASE WHEN jsonb_typeof(t.route_snapshot->'logicalModelVersion') = 'number'
                        THEN CASE WHEN (t.route_snapshot->>'logicalModelVersion') ~ '^[1-9][0-9]{0,15}$'
                            THEN (t.route_snapshot->>'logicalModelVersion')::numeric <= 9007199254740991
                            ELSE false END ELSE false END
                    AND jsonb_typeof(t.route_snapshot->'capabilitySnapshot') = 'object'
                    AND t.route_snapshot->'capabilitySnapshot'->>'operation' = t.task_type
                    AND t.route_snapshot->'capabilitySnapshot'->>'mediaType' =
                        CASE t.task_type WHEN 'image.generate' THEN 'image' ELSE 'video' END
                    AND t.route_snapshot_hash ~ '^[0-9a-f]{64}$' THEN NULL
                ELSE 'invalid_identity'
            END AS reason
        FROM generation_tasks t
        WHERE t.task_type IN ('image.generate','video.generate')
            AND t.created_at >= ${from}::timestamptz AND t.created_at < ${to}::timestamptz
    ), model_tasks AS (
        SELECT logical_model_pk,model_id,count(*) AS task_count,
            count(*) FILTER (WHERE status='succeeded') AS succeeded_task_count
        FROM task_batch WHERE reason IS NULL GROUP BY logical_model_pk,model_id
    ), unclassified_tasks AS (
        SELECT reason,count(*) AS task_count,count(*) FILTER (WHERE status='succeeded') AS succeeded_task_count
        FROM task_batch WHERE reason IS NOT NULL GROUP BY reason
    ), user_tasks AS (
        SELECT owner_id AS user_id,count(*) AS task_count,
            count(*) FILTER (WHERE status='succeeded') AS succeeded_task_count
        FROM task_batch GROUP BY owner_id
    ), user_settles AS (
        SELECT e.user_id,sum(e.credit_tenths) AS settled_tenths
        FROM credit_ledger_events e
        JOIN generation_tasks t ON t.id=e.task_id AND t.owner_id=e.user_id
        WHERE e.kind='settle' AND e.created_at >= ${from}::timestamptz AND e.created_at < ${to}::timestamptz
            AND t.task_type IN ('image.generate','video.generate')
        GROUP BY e.user_id
    ), user_usage AS (
        SELECT coalesce(t.user_id,e.user_id) AS user_id,coalesce(t.task_count,0) AS task_count,
            coalesce(t.succeeded_task_count,0) AS succeeded_task_count,coalesce(e.settled_tenths,0) AS settled_tenths
        FROM user_tasks t FULL OUTER JOIN user_settles e ON e.user_id=t.user_id
    ), top_models AS (
        SELECT * FROM model_tasks ORDER BY task_count DESC,logical_model_pk ASC,model_id COLLATE "C" ASC LIMIT 10
    ), top_users AS (
        SELECT * FROM user_usage ORDER BY task_count DESC,user_id ASC LIMIT 10
    )
    SELECT 'model' AS section,m.logical_model_pk::text AS id,m.model_id AS label,
        m.task_count::text,m.succeeded_task_count::text,NULL::text AS settled_tenths,
        NULL::text AS model_count,NULL::text AS user_count
    FROM top_models m
    UNION ALL
    SELECT 'user',a.user_id::text,u.email,a.task_count::text,a.succeeded_task_count::text,a.settled_tenths::text,NULL,NULL
    FROM top_users a LEFT JOIN users u ON u.id=a.user_id
    UNION ALL
    SELECT 'unclassified',reason,NULL,task_count::text,succeeded_task_count::text,NULL,NULL,NULL FROM unclassified_tasks
    UNION ALL
    SELECT 'totals',NULL,NULL,(SELECT count(*)::text FROM task_batch),
        (SELECT count(*) FILTER (WHERE status='succeeded')::text FROM task_batch),
        (SELECT coalesce(sum(settled_tenths),0)::text FROM user_settles),
        (SELECT count(*)::text FROM model_tasks),(SELECT count(*)::text FROM user_usage)`;
}

function integer(value) {
    if (!['string', 'bigint'].includes(typeof value) || !/^(0|[1-9]\d*)$/.test(String(value))) invalidData();
    return BigInt(value).toString();
}

function counts(row) {
    const taskCount = integer(row.task_count);
    const succeededTaskCount = integer(row.succeeded_task_count);
    if (BigInt(succeededTaskCount) > BigInt(taskCount)) invalidData();
    return { taskCount, succeededTaskCount };
}

function projectRows(rows) {
    const models = [];
    const users = [];
    const reasons = Object.fromEntries(['missing_route', 'unsupported_version', 'invalid_identity']
        .map(reason => [reason, { taskCount: '0', succeededTaskCount: '0' }]));
    const seen = new Set();
    let totals;
    for (const row of rows) {
        const key = JSON.stringify([row.section, row.id, row.section === 'model' ? row.label : null]);
        if (seen.has(key)) invalidData();
        seen.add(key);
        const value = counts(row);
        if (row.section === 'model') {
            if (!UUID.test(row.id) || typeof row.label !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,127}$/.test(row.label)) invalidData();
            models.push({ logicalModelPk: row.id, logicalModelId: row.label, ...value });
        } else if (row.section === 'user') {
            if (!UUID.test(row.id) || (row.label !== null && typeof row.label !== 'string')) invalidData();
            users.push({ userId: row.id, email: row.label, profileAvailable: row.label !== null,
                ...value, settledTenths: integer(row.settled_tenths) });
        } else if (row.section === 'unclassified') {
            if (!Object.hasOwn(reasons, row.id)) invalidData();
            reasons[row.id] = value;
        } else if (row.section === 'totals') {
            if (totals) invalidData();
            totals = { ...value, settledTenths: integer(row.settled_tenths),
                modelCount: integer(row.model_count), userCount: integer(row.user_count) };
        } else invalidData();
    }
    if (!totals || models.length > 10 || users.length > 10) invalidData();
    const compareId = (a, b) => a < b ? -1 : a > b ? 1 : 0;
    const compareCount = (a, b) => BigInt(a.taskCount) > BigInt(b.taskCount) ? -1 : BigInt(a.taskCount) < BigInt(b.taskCount) ? 1 : 0;
    models.sort((a, b) => compareCount(a, b) || compareId(a.logicalModelPk, b.logicalModelPk) || compareId(a.logicalModelId, b.logicalModelId));
    users.sort((a, b) => compareCount(a, b) || compareId(a.userId, b.userId));
    const unclassified = Object.values(reasons).reduce((sum, value) => ({
        taskCount: (BigInt(sum.taskCount) + BigInt(value.taskCount)).toString(),
        succeededTaskCount: (BigInt(sum.succeededTaskCount) + BigInt(value.succeededTaskCount)).toString(),
    }), { taskCount: '0', succeededTaskCount: '0' });
    return { models, users, totals, unclassified: { ...unclassified, reasons } };
}

// 仅供未来已通过 admin+MFA 门禁的 GET 宿主调用；这里不解析会话或扩大授权。
function createAdminAnalyticsReadService({ database = getDatabase, clock = databaseClock, environment = process.env } = {}) {
    if (typeof database !== 'function' && typeof database?.transaction !== 'function') throw new TypeError('database 必须支持只读事务');
    if (typeof clock !== 'function') throw new TypeError('clock 必须为函数');
    if (environment.NODE_ENV === 'production' && clock !== databaseClock) throw new TypeError('生产环境不可替换数据库时钟');
    return Object.freeze({
        async read(params = new URLSearchParams()) {
            // 格式拒绝在数据库工厂/事务之前完成；未来结束时间需采样 DB 时钟，但不执行排名 SQL。
            const explicit = parseQuery(params);
            const db = typeof database === 'function' ? database() : database;
            return db.transaction(async tx => {
                await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
                const asOf = await clock(tx);
                const nowUs = clockTime(asOf);
                if (explicit && explicit.to.us > nowUs) invalidQuery();
                const from = explicit ? explicit.from.text : isoMicroseconds(nowUs - WINDOW_US);
                const to = explicit ? explicit.to.text : asOf;
                const result = await tx.execute(rankingQuery(from, to));
                return {
                    ...projectRows(result.rows),
                    window: { from, to, asOf, timeZone: 'UTC', interval: '[from,to)', defaultDays: 31, maxDays: 31 },
                    timeBasis: { taskCount: 'generation_tasks.created_at',
                        succeededTaskCount: 'generation_tasks.created_at; current status=succeeded',
                        settledTenths: 'credit_ledger_events.created_at; kind=settle' },
                    unitVersion: 'credit_tenths_v1', topLimit: 10, orderBy: 'taskCount DESC, identity ASC',
                    capabilities: { attemptsAvailable: false, attemptCount: null, reason: '当前读取边界未开放 Provider attempt' },
                    modelAttribution: 'persisted_identity_structure_only',
                    scope: 'image.generate/video.generate; includes local mock; 模型任务量（非实际上游请求数）',
                };
            }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
        },
    });
}

module.exports = { createAdminAnalyticsReadService };
