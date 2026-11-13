const { timingSafeEqual } = require('node:crypto');

const KEY = Symbol.for('painttrack.developmentMailbox.v1');
const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
function enabled() {
    return process.env.NODE_ENV === 'development' && process.env.PAINTTRACK_LOCAL_MAILBOX === '1'
        && /^[a-f0-9]{64}$/.test(process.env.PAINTTRACK_LOCAL_MAILBOX_SECRET || '')
        && /^http:\/\/127\.0\.0\.1:[0-9]{2,5}$/.test(process.env.PAINTTRACK_LOCAL_MAILBOX_ORIGIN || '');
}
function allowed(request, mutation = false) {
    if (!enabled()) return false;
    const expected = process.env.PAINTTRACK_LOCAL_MAILBOX_SECRET;
    const supplied = request.headers.get('x-painttrack-local-capability') || '';
    if (!/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return false;
    const origin = process.env.PAINTTRACK_LOCAL_MAILBOX_ORIGIN;
    if (request.headers.get('host') !== new URL(origin).host) return false;
    if (request.headers.get('origin') && request.headers.get('origin') !== origin) return false;
    if (mutation && request.headers.get('origin') !== origin) return false;
    const site = request.headers.get('sec-fetch-site');
    return !site || site === 'same-origin' || site === 'none';
}
function state() {
    if (!globalThis[KEY]) globalThis[KEY] = [];
    const messages = globalThis[KEY];
    const now = Date.now();
    while (messages.length && messages[0].expiresAt <= now) messages.shift();
    return messages;
}
function getDevelopmentMailer() {
    if (!enabled()) return undefined;
    return {
        kind: 'test-memory-outbox',
        async sendVerification({ email, token }) {
            const messages = state();
            if (messages.length >= 100) throw new Error('Development mailbox capacity reached');
            messages.push({ type: 'verification', email, token, expiresAt: Date.now() + 15 * 60 * 1000 });
        },
        async sendPasswordReset({ email, token }) {
            const messages = state();
            if (messages.length >= 100) throw new Error('Development mailbox capacity reached');
            messages.push({ type: 'password-reset', email, token, expiresAt: Date.now() + 30 * 60 * 1000 });
        },

    };
}
function mailboxResponse(request) {
    if (!allowed(request)) return Response.json({ code: 'NOT_FOUND' }, { status: 404, headers });
    return Response.json({ messages: state().map(({ type = 'verification', email, token, expiresAt }) => ({
        type, email, expiresAt,
        path: type === 'password-reset' ? `/reset-password#${token}` : `/verify-email#${token}`,
        ...(type === 'verification' ? { verificationPath: `/verify-email#${token}` } : {}),
    })) }, { headers });
}
function clearMailbox(request) {
    if (!allowed(request, true)) return Response.json({ code: 'NOT_FOUND' }, { status: 404, headers });
    state().length = 0;
    return new Response(null, { status: 204, headers });
}
module.exports = { enabled, allowed, getDevelopmentMailer, mailboxResponse, clearMailbox };
