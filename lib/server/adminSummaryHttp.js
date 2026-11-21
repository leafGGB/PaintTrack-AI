'use strict';

const { getDatabase } = require('./db');
const { createSessionService, sessionCookie } = require('./session');
const { requireAdminMfa } = require('./authorization');
const { authPolicy, checkOrigin } = require('./authPolicy');
const { createErrorResponse, getRequestId, writeLog } = require('./observability');
const { RegistrationError } = require('./registration');

function createAdminSummaryHandler({ database = getDatabase, session = createSessionService, environment = process.env, sink = console } = {}) {
    return async function GET(request) {
        const requestId = getRequestId(request.headers.get('x-request-id'));
        const headers = { 'Cache-Control': 'no-store', Vary: 'Cookie' };
        let actor = null;
        try {
            checkOrigin(request, authPolicy(environment), false);
            const db = typeof database === 'function' ? database() : database;
            const sessionService = typeof session === 'function' ? session({ database: db }) : session;
            const result = await sessionService.me(sessionCookie(request));
            actor = result.user;
            if (!actor) throw new RegistrationError('UNAUTHENTICATED', 401);
            requireAdminMfa(actor);
            const [users, tasks, assets] = await Promise.all([
                db.execute(require('drizzle-orm').sql`SELECT count(*)::int AS count FROM users`),
                db.execute(require('drizzle-orm').sql`SELECT count(*)::int AS count FROM generation_tasks WHERE status IN ('queued','running')`),
                db.execute(require('drizzle-orm').sql`SELECT count(*)::int AS count FROM assets WHERE status <> 'deleted'`),
            ]);
            return Response.json({ data: { actor: { id: actor.id, role: actor.role }, counts: {
                users: users.rows[0]?.count ?? 0,
                activeTasks: tasks.rows[0]?.count ?? 0,
                activeAssets: assets.rows[0]?.count ?? 0,
            } }, requestId }, { status: 200, headers });
        } catch (error) {
            const known = error instanceof RegistrationError;
            const code = known ? error.code : 'ADMIN_SUMMARY_UNAVAILABLE';
            const status = known ? error.status : 503;
            writeLog(status >= 500 ? 'error' : 'warn', { service: 'admin-summary', event: 'request.rejected', errorCode: code, actorId: actor?.id, requestId }, sink);
            const response = createErrorResponse({ code, requestId });
            return Response.json(response.body, { status, headers: { ...headers, ...response.headers } });
        }
    };
}

module.exports = { createAdminSummaryHandler };
