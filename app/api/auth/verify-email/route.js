import { createRegistrationHandler } from '../../../../lib/server/registrationHttp.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = createRegistrationHandler('verify-email');
