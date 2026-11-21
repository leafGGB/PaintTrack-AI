import AdminShell from '@/components/AdminShell';

export const metadata = { title: '管理员后台 — PaintTrack' };
export const dynamic = 'force-dynamic';

export default function AdminLayout({ children }) {
  return <AdminShell basePath="/admin">{children}</AdminShell>;
}
