'use strict';

const { sql } = require('drizzle-orm');
const { getDatabase } = require('./db');
const { createAccountCreditsService, normalizeDate } = require('./accountCredits');
const { createSessionService, sessionCookie } = require('./session');
const { requireAdminMfa } = require('./authorization');
const { authPolicy, checkOrigin } = require('./authPolicy');
const { createErrorResponse, getRequestId, writeLog } = require('./observability');
const { RegistrationError } = require('./registration');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const RECENT_EVENTS = 5;

function invalidQuery() { throw new RegistrationError('INVALID_ADMIN_USER_QUERY', 400); }

function validCursorTime(value) {
    return typeof value === 'string' && CURSOR_TIME.test(value)
        && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value.replace(/\d{3}Z$/, 'Z');
}

function parseCursor(cursor, email = null) {
    if (cursor === null) return null;
    if (typeof cursor !== 'string' || cursor.length > 1200 || !/^(?:[0-9a-f]{2})+$/.test(cursor)) invalidQuery();
    try {
        const value = JSON.parse(Buffer.from(cursor, 'hex').toString('utf8'));
        if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'createdAt,email,id,v'
            || value.v !== 1 || typeof value.id !== 'string' || !UUID_PATTERN.test(value.id)
            || value.email !== email || !validCursorTime(value.createdAt)) invalidQuery();
        return value;
    } catch { invalidQuery(); }
}

function parseListQuery(url) {
    const params = url.searchParams;
    for (const key of params.keys()) {
        if (!['email', 'limit', 'cursor'].includes(key) || params.getAll(key).length !== 1) invalidQuery();
    }
    const email = params.has('email') ? params.get('email').trim().toLowerCase() : null;
    const rawLimit = params.get('limit') ?? String(DEFAULT_LIMIT);
    if (email !== null && (email.length < 3 || Buffer.byteLength(email) > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) invalidQuery();
    if (!/^[1-9]\d?$/.test(rawLimit) || Number(rawLimit) > MAX_LIMIT) invalidQuery();
    return { email, limit: Number(rawLimit), after: parseCursor(params.get('cursor'), email) };
}

function projectUser(row) {
    const createdAt = normalizeDate(row.created_at);
    if (!UUID_PATTERN.test(row.id) || typeof row.email !== 'string' || !['user', 'admin'].includes(row.role) || !createdAt) {
        throw new Error('ADMIN_USER_DATA_INVALID');
    }
    return { id: row.id, email: row.email, role: row.role, emailVerified: Boolean(row.email_verified_at), createdAt };
}

function createAdminUsersHandlers({ database = getDatabase, session = createSessionService, environment = process.env, sink = console } = {}) {
    function handle(action) {
        return async function GET(request, id) {
            const requestId = getRequestId(request.headers.get('x-request-id'));
            const headers = { 'Cache-Control': 'no-store', Vary: 'Cookie', 'Referrer-Policy': 'no-referrer', 'x-request-id': requestId };
            let actor = null;
            try {
                if (request.method !== 'GET') throw new RegistrationError('METHOD_NOT_ALLOWED', 405);
                checkOrigin(request, authPolicy(environment), false);
                const db = typeof database === 'function' ? database() : database;
                const sessionService = typeof session === 'function' ? session({ database: db }) : session;
                actor = (await sessionService.me(sessionCookie(request))).user;
                if (!actor) throw new RegistrationError('UNAUTHENTICATED', 401);
                requireAdminMfa(actor);
                let data;
                if (action === 'list') {
                    const { email, limit, after } = parseListQuery(new URL(request.url));
                    const emailClause = email === null ? sql`` : sql`AND email=${email}`;
                    const cursorClause = after === null ? sql`` : sql`AND (created_at,id) < (${after.createdAt}::timestamptz,${after.id}::uuid)`;
                    const result = await db.execute(sql`SELECT id,email,role,email_verified_at,created_at,
                        to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time
                        FROM users WHERE true ${emailClause} ${cursorClause}
                        ORDER BY created_at DESC,id DESC LIMIT ${limit + 1}`);
                    const rows = result.rows.slice(0, limit);
                    let nextCursor = null;
                    if (result.rows.length > limit) {
                        const last = rows[rows.length - 1];
                        if (!validCursorTime(last.cursor_time)) throw new Error('ADMIN_USER_DATA_INVALID');
                        nextCursor = Buffer.from(JSON.stringify({ v: 1, email, createdAt: last.cursor_time, id: last.id })).toString('hex');
                    }
                    data = { users: rows.map(projectUser), nextCursor };
                } else {
                    if (typeof id !== 'string' || !UUID_PATTERN.test(id)) throw new RegistrationError('NOT_FOUND', 404);
                    const result = await db.execute(sql`SELECT id,email,role,email_verified_at,created_at FROM users WHERE id=${id}::uuid`);
                    const row = result.rows[0];
                    if (!row) throw new RegistrationError('NOT_FOUND', 404);
                    const user = projectUser(row);
                    const [sessions, credits] = await Promise.all([
                        db.execute(sql`SELECT count(*)::int AS count FROM auth_sessions
                            WHERE user_id=${user.id} AND revoked_at IS NULL AND expires_at>clock_timestamp()`),
                        createAccountCreditsService({ database: db }).read(user.id, { limit: RECENT_EVENTS }),
                    ]);
                    data = { user, activeSessionCount: sessions.rows[0].count,
                        credits: { availableTenths: credits.availableTenths, frozenTenths: credits.reservedTenths, unitVersion: credits.unitVersion },
                        recentLedger: credits.events };
                }
                return Response.json({ data, requestId }, { headers });
            } catch (error) {
                const known = error instanceof RegistrationError;
                const code = known ? error.code : action === 'list' ? 'ADMIN_USERS_UNAVAILABLE' : 'ADMIN_USER_DETAIL_UNAVAILABLE';
                const status = known ? error.status : 503;
                writeLog(status >= 500 ? 'error' : 'warn', { service: 'admin-users', event: 'request.rejected', errorCode: code, actorId: actor?.id, requestId }, sink);
                const response = createErrorResponse({ code, requestId });
                return Response.json(response.body, { status, headers: { ...headers, ...response.headers, ...(status === 405 ? { Allow: 'GET' } : {}) } });
            }
        };
    }
    return { list: handle('list'), detail: handle('detail') };
}

function createAdminUserListHandler(options) { return createAdminUsersHandlers(options).list; }
function createAdminUserDetailHandler(options) { return createAdminUsersHandlers(options).detail; }

module.exports = { DEFAULT_LIMIT, MAX_LIMIT, RECENT_EVENTS, createAdminUserDetailHandler, createAdminUserListHandler, createAdminUsersHandlers, parseCursor, parseListQuery };
