import AdminShell from '@/components/AdminShell';

export const metadata = { title: '管理员后台 — PaintTrack' };
export const dynamic = 'force-dynamic';

export default function ZhAdminLayout({ children }) {
  return <AdminShell basePath="/zh/admin">{children}</AdminShell>;
}
