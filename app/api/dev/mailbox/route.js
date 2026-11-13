import { mailboxResponse, clearMailbox } from '../../../../lib/server/developmentMailbox.js';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = mailboxResponse;
export const DELETE = clearMailbox;
