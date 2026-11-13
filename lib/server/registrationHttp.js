const { getDatabase } = require('./db');
const { createRegistrationService, RegistrationError, validateInput } = require('./registration');
const { createErrorResponse, getRequestId, writeLog } = require('./observability');
const { authPolicy, checkOrigin } = require('./authPolicy');
const { KdfBusyError } = require('./passwords');

async function readInput(request) {
    if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
        throw new RegistrationError('INVALID_INPUT', 400);
    }
    if (Number(request.headers.get('content-length')) > 2048) throw new RegistrationError('BODY_TOO_LARGE', 413);
    const reader = request.body?.getReader();
    if (!reader) throw new RegistrationError('INVALID_INPUT', 400);
    let size = 0;
    const chunks = [];
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 2048) {
                await reader.cancel();
                throw new RegistrationError('BODY_TOO_LARGE', 413);
            }
            chunks.push(Buffer.from(value));
        }
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    } catch (error) {
        if (error instanceof RegistrationError) throw error;
        throw new RegistrationError('INVALID_INPUT', 400);
    } finally {
        reader.releaseLock();
    }
}
function createRegistrationHandler(action, { database = getDatabase, mailer, sink = console, environment = process.env } = {}) {
    if (!['register', 'verify-email'].includes(action)) throw new TypeError('无效注册操作');
    return async (request) => {
        const requestId = getRequestId(request.headers.get('x-request-id'));
        try {
            checkOrigin(request, authPolicy(environment));
            const input = await readInput(request);
            validateInput(action, input);
            if (action === 'register' && !mailer) throw new RegistrationError('MAIL_UNAVAILABLE', 503);
            const service = createRegistrationService({ database: typeof database === 'function' ? database() : database,
                mailer, auditSink: sink });
            const result = await service[action === 'register' ? 'register' : 'verifyEmail'](input, { requestId });
            return Response.json(result, { status: 202, headers: { 'Cache-Control': 'no-store', 'x-request-id': requestId } });
        } catch (error) {
            const known = error instanceof RegistrationError || error instanceof KdfBusyError;
            const code = known ? error.code : 'REGISTRATION_UNAVAILABLE';
            const status = known ? error.status : 503;
            writeLog(status >= 500 ? 'error' : 'warn', { service: 'registration', event: 'request.rejected', errorCode: code, requestId }, sink);
            const response = createErrorResponse({ code, requestId });
            return Response.json(response.body, { status, headers: { ...response.headers,
                ...(status === 429 ? { 'Retry-After': '60' } : {}) } });
        }
    };
}
module.exports = { createRegistrationHandler, readInput };
