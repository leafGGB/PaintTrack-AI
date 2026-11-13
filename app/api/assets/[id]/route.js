import { createAuthorizationHandler } from '../../../../lib/server/authorizationHttp';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = createAuthorizationHandler('asset.read');
export const DELETE = createAuthorizationHandler('asset.delete');
