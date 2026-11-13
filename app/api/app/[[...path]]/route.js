import { createAuthorizationHandler } from '../../../../lib/server/authorizationHttp';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const blocked = createAuthorizationHandler('cloud.blocked');
export { blocked as GET, blocked as HEAD, blocked as POST, blocked as PUT, blocked as PATCH, blocked as DELETE, blocked as OPTIONS };
