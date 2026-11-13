import AccountCenter from '@/components/AccountCenter';

export const metadata = { title: '账户中心 — PaintTrack' };
export const dynamic = 'force-dynamic';

export default function ZhAccountPage() {
  return <AccountCenter locale="zh" />;
}
