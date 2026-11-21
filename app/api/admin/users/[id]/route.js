const { createAdminUserDetailHandler } = require('../../../../../lib/server/adminUsersHttp');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const handler = createAdminUserDetailHandler();

export async function GET(request, { params }) {
    const { id } = await params;
    return handler(request, id);
}
