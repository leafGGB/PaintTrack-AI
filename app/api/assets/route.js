import { createAssetsHandler } from '../../../lib/server/assetsHttp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = createAssetsHandler();
