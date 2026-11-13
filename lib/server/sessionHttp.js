const { getDatabase } = require('./db');
const { RegistrationError, validateInput } = require('./registration');
const { KdfBusyError } = require('./passwords');
const { readInput } = require('./registrationHttp');
const { authPolicy, checkOrigin } = require('./authPolicy');
const { createSessionService, sessionCookie, cookieValue } = require('./session');
const { createErrorResponse, getRequestId, writeLog } = require('./observability');
function createSessionHandler(action, { database = getDatabase, sink = console, environment = process.env } = {}) {
    if (!['login', 'logout', 'me'].includes(action)) throw new TypeError('无效会话操作');
    return async (request) => {
        const requestId = getRequestId(request.headers.get('x-request-id'));
        const headers = { 'Cache-Control': 'no-store', 'Vary': 'Cookie', 'Referrer-Policy': 'no-referrer', 'x-request-id': requestId };
        try {
            const policy = authPolicy(environment);
            checkOrigin(request, policy, action !== 'me');
            if (request.method !== (action === 'me' ? 'GET' : 'POST')) throw new RegistrationError('METHOD_NOT_ALLOWED', 405);
            const input = action === 'login' ? await readInput(request) : null;
            if (action === 'login') validateInput('register', input);
            const service = createSessionService({ database: typeof database === 'function' ? database() : database, sink });
            const token = sessionCookie(request);
            if (action === 'login') {
                const result = await service.login(input, { oldToken: token, requestId });
                headers['Set-Cookie'] = cookieValue(result.token, policy.secure, result.expiresAt);
                return Response.json({ user: result.user }, { headers });
            }
            if (action === 'logout') {
                await service.logout(token, { requestId });
                headers['Set-Cookie'] = cookieValue(null, policy.secure);
                return new Response(null, { status: 204, headers });
            }
            return Response.json(await service.me(token), { headers });
        } catch (error) {
            const known = error instanceof RegistrationError || error instanceof KdfBusyError;
            const code = known ? error.code : 'AUTH_UNAVAILABLE';
            const status = known ? error.status : 503;
            writeLog(status >= 500 ? 'error' : 'warn', { service: 'auth', event: 'request.rejected', errorCode: code, requestId }, sink);
            const response = createErrorResponse({ code, requestId });
            return Response.json(response.body, { status, headers: { ...headers, ...(status === 429 || code === 'KDF_BUSY' ? { 'Retry-After': '60' } : {}) } });
        }
    };
}
module.exports = { createSessionHandler };
