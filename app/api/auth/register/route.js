import { createRegistrationHandler } from '../../../../lib/server/registrationHttp.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { allowed, enabled, getDevelopmentMailer } from '../../../../lib/server/developmentMailbox.js';

export async function POST(request) {
    if (enabled() && !allowed(request, true)) {
        return Response.json({ code: 'NOT_FOUND' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    }
    return createRegistrationHandler('register', { mailer: getDevelopmentMailer() })(request);
}
