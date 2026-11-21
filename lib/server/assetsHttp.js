'use strict';

const { getDatabase } = require('./db');
const { authPolicy, checkOrigin } = require('./authPolicy');
const { requireUser, requireAdminMfa } = require('./authorization');
const { RegistrationError } = require('./registration');
const { createErrorResponse, getRequestId, writeLog } = require('./observability');
const { createAssetsQueryService, parseAssetsQuery } = require('./assetsQuery');

function createAssetsHandler({ database = getDatabase, environment = process.env, sink = console, queryFactory = createAssetsQueryService } = {}) {
    return async (request) => {
        const requestId = getRequestId(request.headers.get('x-request-id'));
        const headers = { 'Cache-Control': 'no-store', Vary: 'Cookie', 'Referrer-Policy': 'no-referrer', 'x-request-id': requestId };
        try {
            checkOrigin(request, authPolicy(environment), false);
            if (request.method !== 'GET') throw new RegistrationError('METHOD_NOT_ALLOWED', 405);
            const db = typeof database === 'function' ? database() : database;
            const user = await requireUser(request, db);
            if (user.role === 'admin') requireAdminMfa(user);
            const input = parseAssetsQuery(new URL(request.url).searchParams);
            const page = await queryFactory({ pool: db.$client }).list({ ...input, ownerId: user.id });
            return Response.json({ accountId: user.id, items: page.items, nextCursor: page.nextCursor }, { headers });
        } catch (error) {
            const known = error instanceof RegistrationError;
            const code = known ? error.code : 'ASSETS_QUERY_UNAVAILABLE';
            const status = known ? error.status : 503;
            writeLog(status >= 500 ? 'error' : 'warn', { service: 'assets', event: 'list.rejected', errorCode: code, requestId }, sink);
            const response = createErrorResponse({ code, requestId });
            return Response.json(response.body, { status, headers: { ...response.headers, ...headers } });
        }
    };
}

module.exports = { createAssetsHandler };
