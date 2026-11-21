'use client';

import { useEffect, useState } from 'react';
import { loadAdminAnalytics } from '@/lib/adminAnalyticsData';

const card = 'rounded-2xl border border-slate-200 bg-white p-6';
const reasons = { missing_route: '缺少历史路由', unsupported_version: '不支持的快照版本', invalid_identity: '身份结构无效' };

function MockBadge({ source }) {
  return <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-900">{source === 'mock' ? 'Mock · 演示数据' : '真实 API 数据'}</span>;
}

export function AdminAnalyticsView({ data }) {
  const mock = data.source === 'mock';
  return <div className="space-y-6">
    <section role="note" className="rounded-2xl border-2 border-amber-300 bg-amber-50 p-6 text-amber-950">
      <h2 className="text-xl font-semibold">{mock ? '演示数据 / Mock，非真实运营结果' : '使用分析 · 真实 API 数据'}</h2>
      <p className="mt-3 text-sm leading-6">{mock ? '仅用于界面开发，全部数字与身份均为固定虚构示例；未连接真实分析 API，不代表 PostgreSQL 或生产验收。' : '数据来自独立分析读取入口。'}</p>
    </section>
    <section className={card}>
      <h2 className="font-semibold">{mock ? '演示窗口' : '统计窗口'} · {data.window.timeZone} · {data.window.interval}</h2>
      <p className="mt-3 break-all text-sm text-slate-600">{data.window.from} → {data.window.to}</p>
      <p className="mt-2 break-all text-xs text-slate-500">{mock ? '固定演示快照' : '读取快照'} asOf：{data.window.asOf}；默认连续 {data.window.defaultDays} 天，最大 {data.window.maxDays} 天。日期筛选尚未开放，无实时刷新。</p>
    </section>
    <section aria-label="窗口全量汇总" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
      {[
        ['新建任务', data.totals.taskCount], ['本批次当前成功任务', data.totals.succeededTaskCount],
        ['实际结算积分', `${data.totals.settledCredits} credit`], ['已归类模型', data.totals.modelCount], ['用户维度', data.totals.userCount],
      ].map(([label, value]) => <div key={label} className={card}><p className="text-xs text-amber-800">{mock ? 'Mock · 全量' : '全量'}</p><p className="mt-2 text-sm text-slate-500">{label}</p><p className="mt-4 break-all text-2xl font-semibold tabular-nums">{value}</p></div>)}
    </section>
    <div className="grid gap-6 xl:grid-cols-2">
      <section aria-labelledby="model-ranking-title" className={card}>
        <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="model-ranking-title" className="font-semibold">模型任务数排名</h2><MockBadge source={data.source} /></div>
        <p className="mt-3 text-xs leading-6 text-slate-500">Top {data.topLimit} · 按 taskCount 降序，历史模型身份升序；非实际上游请求数。未归类不进入本榜。</p>
        <ol className="mt-5 space-y-5">{data.models.map((row, index) => <li key={`${row.logicalModelPk}:${row.logicalModelId}`}>
          <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm"><span className="break-all font-medium">{index + 1}. {row.logicalModelId}</span><span className="tabular-nums">{row.taskCount} 任务 · 当前成功 {row.succeededTaskCount}</span></div>
          <div aria-hidden="true" className="mt-2 h-3 overflow-hidden rounded-full bg-violet-50"><div className="h-full rounded-full bg-violet-500" style={{ width: row.barWidth }} /></div>
          <p className="mt-1 break-all text-xs text-slate-400">历史模型 PK：{row.logicalModelPk}</p>
        </li>)}</ol>
        {data.models.length === 0 && <p className="mt-5 text-sm text-slate-500">窗口内无已归类模型任务。</p>}
      </section>
      <section aria-labelledby="user-ranking-title" className={card}>
        <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="user-ranking-title" className="font-semibold">用户使用量排名</h2><MockBadge source={data.source} /></div>
        <p className="mt-3 text-xs leading-6 text-slate-500">Top {data.topLimit} · 按 taskCount 降序、userId 升序，不按结算积分排序。</p>
        <div className="mt-4 overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">用户任务量与实际结算积分，按 taskCount 排序</caption><thead className="border-b border-slate-200 text-xs text-slate-500"><tr><th className="py-3 pr-4">用户</th><th className="px-2">任务数</th><th className="px-2">当前成功</th><th className="pl-2">实际结算积分（credit）</th></tr></thead><tbody>{data.users.map((row, index) => <tr key={row.userId} className="border-b border-slate-100 align-top"><td className="py-4 pr-4"><p className="font-medium">{mock ? `演示用户 ${index + 1}` : row.email || '用户资料不可用'}</p><p className="mt-1 break-all text-xs text-slate-400">{row.userId}</p>{!row.profileAvailable && <p className="mt-1 text-xs text-slate-500">用户资料不可用{mock ? ' · 未提供真实资料' : ''}</p>}</td><td className="px-2 py-4 tabular-nums">{row.taskCount}</td><td className="px-2 py-4 tabular-nums">{row.succeededTaskCount}</td><td className="py-4 pl-2 tabular-nums">{row.settledCredits}</td></tr>)}</tbody></table></div>
        {data.users.length === 0 && <p className="mt-5 text-sm text-slate-500">窗口内无任务或结算用户。</p>}
      </section>
    </div>
    <section className={card}>
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold">未归类汇总</h2><MockBadge source={data.source} /></div>
      <p className="mt-3 text-sm text-slate-600">{data.unclassified.taskCount} 任务 · 本批次当前成功 {data.unclassified.succeededTaskCount}；已计入窗口全量与用户用量，不计入正常模型榜。</p>
      <ul className="mt-4 grid gap-3 text-sm sm:grid-cols-3">{Object.entries(data.unclassified.reasons).map(([reason, value]) => <li key={reason} className="rounded-xl bg-slate-50 p-4"><p className="text-slate-500">{reasons[reason]}</p><p className="mt-2">{value.taskCount} 任务 / 当前成功 {value.succeededTaskCount}</p></li>)}</ul>
    </section>
    <section className={card}>
      <h2 className="font-semibold">统计口径与能力边界</h2>
      <ul className="mt-3 list-inside list-disc space-y-2 text-sm leading-7 text-slate-600">
        <li>任务数按创建时间；当前成功仅同一创建批次在快照时 status=succeeded，不是窗口内完成数，也不计算成功率。</li>
        <li>实际结算积分仅统计窗口内 settle 事件，可包含更早创建的任务；不计 reserve/grant，不减 release。零消耗不代表免费或已经结清。</li>
        <li>Provider attempt 不可用：{data.capabilities.reason}；attemptCount 为 null，不以 0、任务领取数或实际 Provider 调用数代替。</li>
        <li>范围：{data.scope}。模型仅按持久化历史身份结构归类，不验证完整 hash、不证明实际调用目标。</li>
        <li>榜单最多 Top {data.topLimit}，窗口全量不是榜单简单相加；积分以整数十分之一单位精确格式化，不是收入、成本或利润。</li>
      </ul>
    </section>
  </div>;
}

export default function AdminAnalytics() {
  const [state, setState] = useState({ status: 'loading', data: null });
  useEffect(() => {
    let active = true;
    loadAdminAnalytics().then(data => {
      if (active) setState({ status: 'ready', data });
    }).catch(() => {
      if (active) setState({ status: 'error', data: null });
    });
    return () => { active = false; };
  }, []);
  if (state.status === 'loading') return <section role="status" className={card}>正在加载演示分析数据……</section>;
  if (state.status === 'error') return <section role="alert" className={card}>分析数据暂时不可用，不回退或生成替代数据。</section>;
  return <AdminAnalyticsView data={state.data} />;
}
