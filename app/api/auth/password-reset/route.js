import { createPasswordResetHandler } from '../../../../lib/server/passwordResetHttp.js';
import { allowed, enabled, getDevelopmentMailer } from '../../../../lib/server/developmentMailbox.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
    if (enabled() && !allowed(request, true)) {
        return Response.json({ code: 'NOT_FOUND' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    }
    return createPasswordResetHandler('request', { mailer: getDevelopmentMailer() })(request);
}
