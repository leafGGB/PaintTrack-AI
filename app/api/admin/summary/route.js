const { createAdminSummaryHandler } = require('../../../../lib/server/adminSummaryHttp');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = createAdminSummaryHandler();
