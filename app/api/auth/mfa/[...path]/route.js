import { createAdminMfaHandler } from '../../../../../lib/server/adminMfaHttp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const handlers = {
    status: createAdminMfaHandler('status'),
    'enrollment/begin': createAdminMfaHandler('enrollment.begin'),
    'enrollment/verify': createAdminMfaHandler('enrollment.verify'),
    'recovery/issue': createAdminMfaHandler('recovery.issue'),
    'factor/revoke': createAdminMfaHandler('factor.revoke'),
    'recovery/consume': createAdminMfaHandler('recovery.consume'),
    'session/elevate': createAdminMfaHandler('session.elevate'),
    'step-up/verify': createAdminMfaHandler('step-up.verify'),
};

async function dispatch(request, context) {
    const params = await context.params;
    const key = Array.isArray(params?.path) ? params.path.join('/') : '';
    const handler = handlers[key];
    if (!handler) return Response.json({ error: { code: 'NOT_FOUND', message: 'Request failed' } }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    return handler(request);
}

export const POST = dispatch;
