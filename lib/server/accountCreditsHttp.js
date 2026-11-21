'use strict';

const { getDatabase } = require('./db');
const { createAccountCreditsService } = require('./accountCredits');
const { createSessionService, sessionCookie } = require('./session');
const { authPolicy, checkOrigin } = require('./authPolicy');
const { createErrorResponse, getRequestId, writeLog } = require('./observability');
const { RegistrationError } = require('./registration');

function createAccountCreditsHandler({ database = getDatabase, session = createSessionService, environment = process.env, sink = console } = {}) {
    return async function handle(request) {
        const requestId = getRequestId(request.headers.get('x-request-id'));
        const headers = { 'Cache-Control': 'no-store', Vary: 'Cookie', 'Referrer-Policy': 'no-referrer', 'x-request-id': requestId };
        let user;
        try {
            const policy = authPolicy(environment);
            checkOrigin(request, policy, false);
            const db = database();
            user = (await session({ database: db }).me(sessionCookie(request))).user;
            if (!user) throw new RegistrationError('UNAUTHENTICATED', 401);
            const params = new URL(request.url).searchParams;
            for (const key of ['limit', 'kind', 'cursor']) {
                if (params.getAll(key).length > 1) throw new RegistrationError('INVALID_CREDIT_QUERY', 400);
            }
            const options = Object.fromEntries(['limit', 'kind', 'cursor'].filter(key => params.has(key)).map(key => [key, params.get(key)]));
            const credits = await createAccountCreditsService({ database: db }).read(user.id, options);
            return Response.json({ credits }, { headers });
        } catch (error) {
            const known = error instanceof RegistrationError;
            const code = known ? error.code : 'CREDIT_UNAVAILABLE';
            const status = known ? error.status : 503;
            writeLog(status >= 500 ? 'error' : 'warn', { service: 'account-credits', event: 'request.rejected', errorCode: code, actorId: user?.id, requestId }, sink);
            const response = createErrorResponse({ code, requestId });
            return Response.json(response.body, { status, headers: { ...headers, ...response.headers } });
        }
    };
}

module.exports = { createAccountCreditsHandler };
