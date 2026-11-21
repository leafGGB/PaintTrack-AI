const { createAdminModelsHandler } = require('../../../../lib/server/adminModelsHttp');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = createAdminModelsHandler();
