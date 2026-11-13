import { createCatalogHandler } from '../../../../lib/server/catalogHttp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = createCatalogHandler();
