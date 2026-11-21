'use strict';

const { getDatabase } = require('./db');
const { createSessionService, sessionCookie } = require('./session');
const { requireAdminMfa } = require('./authorization');
const { authPolicy, checkOrigin } = require('./authPolicy');
const { createErrorResponse, getRequestId, writeLog } = require('./observability');
const { RegistrationError } = require('./registration');
const { createAdminModelsProjectionRead, parseQuery } = require('./adminModelsProjectionRead');

function createAdminModelsHandler({ database = getDatabase, session = createSessionService, projection = createAdminModelsProjectionRead, environment = process.env, sink = console } = {}) {
    return async function GET(request) {
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
            const params = new URL(request.url).searchParams;
            parseQuery(params);
            const service = typeof projection === 'function' ? projection({ database: db }) : projection;
            const result = await service.read(params);
            return Response.json({ ...result, meta: { ...result.meta, requestId }, requestId }, { status: 200, headers });
        } catch (error) {
            const known = error instanceof RegistrationError;
            const code = known ? error.code : error?.code === 'INVALID_ADMIN_MODEL_QUERY' ? error.code : 'ADMIN_MODELS_UNAVAILABLE';
            const status = known ? error.status : code === 'INVALID_ADMIN_MODEL_QUERY' ? 400 : 503;
            writeLog(status >= 500 ? 'error' : 'warn', { service: 'admin-models', event: 'request.rejected', errorCode: code, actorId: actor?.id, requestId }, sink);
            const response = createErrorResponse({ code, requestId });
            return Response.json(response.body, { status, headers: { ...headers, ...response.headers, ...(status === 405 ? { Allow: 'GET' } : {}) } });
        }
    };
}

module.exports = { createAdminModelsHandler };
