import { notFound } from 'next/navigation';
import { AdminPendingPage } from '@/components/AdminShell';
import AdminAnalytics from '@/components/AdminAnalytics';
import AdminModels from '@/components/AdminModels';
import AdminProviders from '@/components/AdminProviders';
import AdminPricing from '@/components/AdminPricing';

const modules = ['models', 'providers', 'pricing', 'analytics', 'tasks', 'billing', 'audit', 'settings'];

export default async function AdminModulePage({ params }) {
  const { module } = await params;
  if (!modules.includes(module)) notFound();
  if (module === 'analytics') return <AdminAnalytics />;
  if (module === 'models') return <AdminModels />;
  if (module === 'providers') return <AdminProviders />;
  if (module === 'pricing') return <AdminPricing />;
  return <AdminPendingPage module={module} />;
}
