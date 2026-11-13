const { getDatabase } = require('./db');
const { createAdminMfaService, normalizeRecoveryCode } = require('./adminMfa');
const { requireUser } = require('./authorization');
const { RegistrationError } = require('./registration');
const { authPolicy, checkOrigin } = require('./authPolicy');
const { sessionCookie, createSessionService } = require('./session');
const { createErrorResponse, getRequestId, writeLog } = require('./observability');
const { readInput } = require('./registrationHttp');

const ACTIONS = new Set(['status', 'enrollment.begin', 'enrollment.verify', 'recovery.issue', 'factor.revoke', 'recovery.consume', 'session.elevate', 'step-up.verify']);

async function readCodeInput(request, { allowRecovery = false } = {}) {
    const input = await readInput(request);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'code')) {
        throw new RegistrationError('INVALID_INPUT', 400);
    }
    if (typeof input.code !== 'string' || (!/^\d{6}$/.test(input.code) && !(allowRecovery && normalizeRecoveryCode(input.code)))) {
        throw new RegistrationError('INVALID_INPUT', 400);
    }
    return input.code;
}

function createAdminMfaHandler(action, { database = getDatabase, sink = console, environment = process.env, encryptionKey = environment.PAINTTRACK_MFA_ENCRYPTION_KEY, clock = () => Date.now() } = {}) {
    if (!ACTIONS.has(action)) throw new TypeError('无效 MFA 操作');
    return async (request) => {
        const requestId = getRequestId(request.headers.get('x-request-id'));
        const headers = { 'Cache-Control': 'no-store', Vary: 'Cookie', 'Referrer-Policy': 'no-referrer', 'x-request-id': requestId };
        let user;
        try {
            const policy = authPolicy(environment);
            checkOrigin(request, policy, true);
            if (request.method !== 'POST') throw new RegistrationError('METHOD_NOT_ALLOWED', 405);
            const db = typeof database === 'function' ? database() : database;
            user = await requireUser(request, db);
            const service = createAdminMfaService({ database: db, encryptionKey, auditSink: sink, clock });
            const token = sessionCookie(request);
            if (action === 'status') return Response.json(await service.getStatus(user, { requestId }), { headers });
            if (action === 'enrollment.begin') return Response.json(await service.beginEnrollment(user, { requestId }), { headers });
            if (action === 'enrollment.verify') return Response.json(await service.verifyEnrollment(user, await readCodeInput(request), { requestId }), { headers });
            if (action === 'recovery.issue') {
                const code = await readCodeInput(request, { allowRecovery: true });
                const tokenHash = require('node:crypto').createHash('sha256').update(token).digest('hex');
                return Response.json(await service.issueRecoveryCodes(user, code, tokenHash, { requestId }), { headers });
            }
            if (action === 'factor.revoke') {
                const code = await readCodeInput(request, { allowRecovery: true });
                const tokenHash = require('node:crypto').createHash('sha256').update(token).digest('hex');
                return Response.json(await service.revokeFactor(user, code, tokenHash, { requestId }), { headers });
            }
            if (action === 'recovery.consume') {
                const code = await readCodeInput(request, { allowRecovery: true });
                return Response.json(await service.consumeRecoveryCodeAndElevate(user, code, require('node:crypto').createHash('sha256').update(token).digest('hex'), { requestId }), { headers });
            }
            if (action === 'session.elevate') {
                const code = await readCodeInput(request);
                return Response.json(await service.verifyTotpAndElevate(user, code, require('node:crypto').createHash('sha256').update(token).digest('hex'), { requestId }), { headers });
            }
            if (action === 'step-up.verify') {
                const code = await readCodeInput(request, { allowRecovery: true });
                const tokenHash = require('node:crypto').createHash('sha256').update(token).digest('hex');
                try {
                    return Response.json(await service.verifyTotpAndElevate(user, code, tokenHash, { requestId, stepUp: true }), { headers });
                } catch (error) {
                    if (!(error instanceof RegistrationError) || error.code !== 'INVALID_MFA_CODE' || !normalizeRecoveryCode(code)) throw error;
                    return Response.json(await service.verifyStepUpWithRecoveryCode(user, code, tokenHash, { requestId }), { headers });
                }
            }
            throw new RegistrationError('INVALID_INPUT', 400);
        } catch (error) {
            const known = error instanceof RegistrationError;
            const code = known ? error.code : 'MFA_UNAVAILABLE';
            const status = known ? error.status : 503;
            writeLog(status >= 500 ? 'error' : 'warn', { service: 'auth-mfa', event: 'request.rejected', errorCode: code, requestId }, sink);
            const response = createErrorResponse({ code, requestId });
            return Response.json(response.body, { status, headers: { ...headers, ...(status === 429 ? { 'Retry-After': '60' } : {}) } });
        }
    };
}

module.exports = { createAdminMfaHandler, ACTIONS };
