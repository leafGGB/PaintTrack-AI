import { NextResponse } from 'next/server';
import { checkDatabaseHealth } from '../../../../lib/server/db/index.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
    const result = await checkDatabaseHealth();
    const healthy = result.status === 'ok';

    return NextResponse.json(
        { database: result.status },
        { status: healthy ? 200 : 503, headers: { 'Cache-Control': 'no-store' } }
    );
}
