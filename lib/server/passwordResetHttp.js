const { getDatabase } = require('./db');
const { createPasswordResetService } = require('./passwordReset');
const { RegistrationError } = require('./registration');
const { KdfBusyError } = require('./passwords');
const { readInput } = require('./registrationHttp');
const { authPolicy, checkOrigin } = require('./authPolicy');
const { createErrorResponse, getRequestId, writeLog } = require('./observability');

function createPasswordResetHandler(action, { database = getDatabase, mailer, sink = console, environment = process.env } = {}) {
    if (!['request', 'consume'].includes(action)) throw new TypeError('无效密码重置操作');
    return async (request) => {
        const requestId = getRequestId(request.headers.get('x-request-id'));
        const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'x-request-id': requestId };
        try {
            checkOrigin(request, authPolicy(environment));
            if (request.method !== 'POST') throw new RegistrationError('METHOD_NOT_ALLOWED', 405);
            const input = await readInput(request);
            const service = createPasswordResetService({ database: typeof database === 'function' ? database() : database, mailer, sink });
            await service[action](input, { requestId });
            return Response.json({ status: 'accepted' }, { status: 202, headers });
        } catch (error) {
            const known = error instanceof RegistrationError || error instanceof KdfBusyError;
            const code = known ? error.code : 'PASSWORD_RESET_UNAVAILABLE';
            const status = known ? error.status : 503;
            writeLog(status >= 500 ? 'error' : 'warn', { service: 'password-reset', event: 'request.rejected', errorCode: code, requestId }, sink);
            const response = createErrorResponse({ code, requestId });
            return Response.json(response.body, { status, headers: { ...headers, ...(status === 429 || code === 'KDF_BUSY' ? { 'Retry-After': '60' } : {}) } });
        }
    };
}
module.exports = { createPasswordResetHandler };
