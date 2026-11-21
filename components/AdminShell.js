'use client';

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';

const AdminContext = createContext(null);
const modules = [
  ['', '总览', '当前平台快照'], ['users', '用户', '精确邮箱搜索与用户只读详情'],
  ['models', '模型目录', '仅提供隔离 Mock 目录与内存添加、启停演示，真实模型管理尚未开放。'],
  ['providers', 'Provider 与路由', '仅提供独立 Mock 实例与主备路由内存演示，非真实健康或配置；真实 Provider 管理尚未开放。'],
  ['pricing', '定价', '仅提供独立 Mock 定价版本与内存生命周期演示，非真实定价；真实发布 API 尚未开放。'],
  ['analytics', '使用分析', '仅提供明确标识的 Mock 演示排名，真实分析 API 尚未接入。'],
  ['tasks', '任务运营', '任务、调用与 unknown 证据查询尚未开放；人工裁决未启用。'],
  ['billing', '额度与账务', '独立账务查询尚未开放；用户详情仅含余额与最近账单摘要，不支持额度调整。'],
  ['audit', '风险与审计', '风险事件与持久审计查询尚未开放，不展示虚构活动记录。'],
  ['settings', '系统设置', '运营策略配置尚未开放；这里不是环境变量或凭据编辑器。'],
];

export default function AdminShell({ basePath = '/admin', children }) {
  const pathname = usePathname();
  const active = modules.find(([slug]) => pathname === `${basePath}${slug ? `/${slug}` : ''}`) || modules[0];
  const [state, setState] = useState({ status: 'loading', data: null });
  const summaryRequest = useRef({ sequence: 0, controller: null });
  const accountPath = basePath.startsWith('/zh/') ? '/zh/account' : '/account';

  async function loadSummary() {
    const request = summaryRequest.current;
    const sequence = ++request.sequence;
    request.controller?.abort();
    const controller = new AbortController();
    request.controller = controller;
    setState({ status: 'loading', data: null });
    try {
      const response = await fetch('/api/admin/summary', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      const body = await response.json();
      if (sequence !== request.sequence || controller.signal.aborted) return;
      if (!response.ok) {
        setState({ status: [401, 403].includes(response.status) ? 'denied' : 'error', data: null });
        return;
      }
      setState({ status: 'ready', data: body.data });
    } catch {
      if (sequence !== request.sequence || controller.signal.aborted) return;
      setState({ status: 'error', data: null });
    }
  }

  useEffect(() => {
    const request = summaryRequest.current;
    loadSummary();
    return () => { ++request.sequence; request.controller?.abort(); };
  }, []);

  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
    window.location.assign(accountPath);
  }

  return <div className="min-h-screen bg-slate-50 text-slate-900">
    <div className="mx-auto min-h-screen max-w-[1600px] lg:grid lg:grid-cols-[240px_minmax(0,1fr)]">
      <aside className="border-b border-slate-200 bg-white p-5 lg:border-b-0 lg:border-r">
        <a href={basePath} className="text-lg font-semibold text-violet-700">PaintTrack 管理控制台</a>
        <nav aria-label="后台导航" className="mt-6 grid grid-cols-2 gap-1 lg:grid-cols-1">
          {modules.map(([slug, label]) => {
            const href = `${basePath}${slug ? `/${slug}` : ''}`;
            const isActive = active[0] === slug;
            return <a key={slug} href={href} aria-current={isActive ? 'page' : undefined} className={`rounded-xl px-3 py-3 text-sm ${isActive ? 'bg-violet-50 font-semibold text-violet-700' : 'text-slate-600 hover:bg-slate-50'}`}>{label}</a>;
          })}
        </nav>
        <p className="mt-6 text-xs leading-6 text-slate-500">只读模式 · 管理接口逐请求校验管理员身份与 MFA。管理写操作尚未开放。</p>
        <a href={accountPath} className="mt-4 inline-block text-sm text-violet-700">返回账户中心</a>
      </aside>
      <div className="min-w-0">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 bg-white px-6 py-5">
          <div><p className="text-xs text-slate-500">工作空间 / 管理控制台</p><h1 className="mt-2 text-xl font-semibold">{active[1]}</h1></div>
          <div className="flex items-center gap-4"><span className="text-xs text-slate-500">管理员身份与 MFA 保护</span><button onClick={signOut} className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600">安全退出</button></div>
        </header>
        <main className="p-6 lg:p-8">
          {state.status === 'loading' && <section role="status" className="rounded-2xl border border-slate-200 bg-white p-8 text-slate-600">正在检查管理员会话……</section>}
          {state.status === 'denied' && <section role="alert" className="rounded-2xl border border-amber-200 bg-white p-8"><h2 className="font-semibold text-amber-800">进入后台前必须登录管理员账户并完成 MFA 验证。</h2><a href={accountPath} className="mt-4 inline-block text-sm text-violet-700">返回账户中心</a></section>}
          {state.status === 'error' && <section role="alert" className="rounded-2xl border border-rose-200 bg-white p-8"><h2 className="font-semibold text-rose-700">管理员后台暂时不可用。</h2><button onClick={loadSummary} className="mt-4 rounded-lg border border-slate-200 px-4 py-2 text-sm">重试</button></section>}
          {state.status === 'ready' && <AdminContext.Provider value={{ data: state.data, basePath }}>{children}</AdminContext.Provider>}
        </main>
      </div>
    </div>
  </div>;
}

export function AdminOverview() {
  const { data, basePath } = useContext(AdminContext);
  return <div className="space-y-6">
    <section className="rounded-2xl border border-slate-200 bg-white p-6"><p className="text-xs font-semibold text-violet-700">当前快照 · 真实数据</p><h2 className="mt-3 text-2xl font-semibold">运营概览</h2><p className="mt-3 text-sm leading-6 text-slate-500">计数来自现有汇总 API，不包含增长率、收入或历史趋势；日期筛选尚未开放，当前为全量快照。</p></section>
    <section aria-label="平台指标" className="grid gap-4 sm:grid-cols-3">{[['注册用户', data.counts.users], ['活跃任务', data.counts.activeTasks], ['有效资产', data.counts.activeAssets]].map(([label, value]) => <div key={label} className="rounded-2xl border border-slate-200 bg-white p-6"><p className="text-sm text-slate-500">{label}</p><p className="mt-4 text-3xl font-semibold">{value}</p></div>)}</section>
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]"><section className="rounded-2xl border border-slate-200 bg-white p-6"><h2 className="font-semibold">用户目录</h2><p className="mt-3 text-sm text-slate-500">精确邮箱搜索，查看身份、有效会话数与额度摘要。</p><a href={`${basePath}/users`} className="mt-5 inline-block text-sm font-medium text-violet-700">查看用户 →</a></section><aside className="rounded-2xl border border-slate-200 bg-white p-6"><h2 className="font-semibold">运营提醒</h2><p className="mt-3 text-sm leading-7 text-slate-500">当前仅总览和用户只读已接入。模型、路由、定价、账务调整与审计操作尚未开放。</p></aside></div>
  </div>;
}

export function AdminPendingPage({ module }) {
  const entry = modules.find(([slug]) => slug === module);
  return <section className="rounded-2xl border border-slate-200 bg-white p-8"><span className="rounded-full bg-violet-50 px-3 py-1 text-xs text-violet-700">尚未开放</span><h2 className="mt-5 text-xl font-semibold">{entry[1]}</h2><p className="mt-4 max-w-2xl text-sm leading-7 text-slate-500">{entry[2]}</p><p className="mt-4 text-xs text-slate-500">当前仅完成独立页面骨架，不提供模拟数据、管理写操作或未接入功能。</p></section>;
}
