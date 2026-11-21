const { createAccountCreditsHandler } = require('../../../../lib/server/accountCreditsHttp');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = createAccountCreditsHandler();
