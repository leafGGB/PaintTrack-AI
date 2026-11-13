import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { allowed } from '../../../lib/server/developmentMailbox.js';
import MailboxClient from './MailboxClient';
export const dynamic = 'force-dynamic';
export default async function MailboxPage() {
    if (!allowed({ headers: await headers() })) notFound();
    return <MailboxClient />;
}
