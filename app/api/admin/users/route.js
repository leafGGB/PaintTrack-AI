const { createAdminUserListHandler } = require('../../../../lib/server/adminUsersHttp');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = createAdminUserListHandler();
