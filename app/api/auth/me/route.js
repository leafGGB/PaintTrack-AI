import { createSessionHandler } from '../../../../lib/server/sessionHttp';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = createSessionHandler('me');
