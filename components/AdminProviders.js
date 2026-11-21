'use client';

import { useEffect, useState } from 'react';
import { healthLabels, verificationLabels, loadAdminProviders, getProviderRoutes, filterAdminProviders, validateProviderPriority, setMockProviderEnabled, setMockProviderPriority, swapMockProviderRoute } from '@/lib/adminProvidersData';

const card = 'rounded-2xl border border-slate-200 bg-white p-6';
const button = 'rounded-lg border border-slate-300 px-3 py-2 text-sm text-violet-700 hover:bg-violet-50 disabled:opacity-50';
const input = 'mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm';
const checkedAt = value => value ? `${value.replace('T', ' ').replace('Z', '')} UTC（固定演示）` : '未检查（固定演示）';

export default function AdminProviders() {
  const [state, setState] = useState({ status: 'loading' });
  useEffect(() => {
    let active = true;
    loadAdminProviders().then(data => {
      if (active) setState({ status: 'ready', data, filters: { search: '', enabled: 'all', modelId: 'all' }, selectedId: null, priority: '', error: '', pending: null, notice: '' });
    }).catch(() => { if (active) setState({ status: 'error' }); });
    return () => { active = false; };
  }, []);
  return <AdminProvidersView state={state} setState={setState} />;
}

export function AdminProvidersView({ state, setState }) {
  if (state.status === 'loading') return <section role="status" className={card}>正在加载 Mock 演示 Provider 与路由……</section>;
  if (state.status === 'error') return <section role="alert" className={card}>演示 Provider 目录暂时不可用，请刷新页面；未回退到其他数据源。</section>;
  const { data, filters, pending } = state;
  const rows = filterAdminProviders(data, filters);
  const selected = data.providers.find(row => row.id === state.selectedId);
  const routes = selected ? getProviderRoutes(data, selected.id) : [];
  const locked = !!pending || data.source !== 'mock';
  const patch = changes => setState(current => ({ ...current, ...changes }));
  const filter = (key, value) => patch({ filters: { ...filters, [key]: value } });

  function preparePriority(event) {
    event.preventDefault();
    const checked = validateProviderPriority(state.priority);
    patch({ error: checked.error || '', pending: checked.error ? null : { action: 'priority', id: selected.id, value: checked.value, description: `${selected.name} / ${selected.id}：优先级 ${selected.priority} → ${checked.value}` }, notice: '' });
  }
  function confirmDemo() {
    setState(current => {
      const action = current.pending;
      if (!action) return current;
      const next = action.action === 'toggle' ? setMockProviderEnabled(current.data, action.id, action.enabled)
        : action.action === 'priority' ? setMockProviderPriority(current.data, action.id, action.value)
          : swapMockProviderRoute(current.data, action.id);
      return { ...current, data: next, pending: null, error: '', notice: '仅演示：本页内存已更新，未保存到服务器；刷新恢复，真实 Provider、路由与任务均未改变。' };
    });
  }

  return <div className="space-y-6">
    <section className="rounded-2xl border-2 border-amber-300 bg-amber-50 p-6">
      <p className="font-semibold text-amber-900">演示数据 / Mock，非真实Provider状态</p>
      <h2 className="mt-3 text-2xl font-semibold">Provider 与路由 · 隔离演示</h2>
      <p className="mt-3 text-sm leading-7 text-slate-700">启停、优先级与主/备用切换仅改变当前页面内存，刷新恢复。不调用真实 API、不做真实 Provider 调用或网络健康检查、不持久化。</p>
      <p className="mt-2 text-sm leading-7 text-slate-600">健康、验证状态和最近检查均为固定演示，不是实时健康，也不证明可调用。禁用不会自动切换路由；优先级不改变主备角色。</p>
      <p className="mt-2 text-sm text-slate-600">不读取或展示 Secret、API key、连接信息；不修改模型目录、任务、账务或价格，不提供定价功能。</p>
    </section>
    {state.notice && <p role="status" className="rounded-xl border border-violet-200 bg-white p-4 text-sm text-violet-800">{state.notice}</p>}
    <section className={card} aria-label="演示 Provider 筛选">
      <div className="grid gap-4 md:grid-cols-3">
        <label className="text-sm">搜索名称 / 稳定 ID<input className={input} value={filters.search} onChange={event => filter('search', event.target.value)} placeholder="输入演示 Provider 名称或 ID" /></label>
        <label className="text-sm">启停状态<select className={input} value={filters.enabled} onChange={event => filter('enabled', event.target.value)}><option value="all">全部状态</option><option value="true">启用（演示）</option><option value="false">禁用（演示）</option></select></label>
        <label className="text-sm">关联模型<select className={input} value={filters.modelId} onChange={event => filter('modelId', event.target.value)}><option value="all">全部模型</option>{data.models.map(model => <option key={model.id} value={model.id}>{model.name} / {model.id}</option>)}</select></label>
      </div>
      <p className="mt-5 text-sm text-slate-500">Mock · 筛选结果 {rows.length} / {data.providers.length} 项；优先级 1–100，数值越小越优先（仅演示，不参与真实调度）。</p>
    </section>
    {pending && <section role="alertdialog" aria-modal="false" aria-labelledby="provider-demo-confirm" aria-describedby="provider-demo-impact" className="rounded-2xl border-2 border-violet-300 bg-white p-6">
      <h3 id="provider-demo-confirm" className="font-semibold">确认{pending.action === 'swap' ? '主/备用互换' : pending.action === 'priority' ? '调整优先级' : pending.enabled ? '启用 Provider' : '禁用 Provider'}（仅演示）</h3>
      <p className="mt-3 break-words text-sm">{pending.description}</p>
      <p id="provider-demo-impact" className="mt-3 text-sm leading-7 text-slate-600">仅修改本页内存，不向服务器写入；刷新恢复。不影响真实 Provider、模型目录、任务、账务或价格。主备互换允许包含禁用演示实例，不代表可用性判断或自动故障转移。</p>
      <div className="mt-4 flex gap-3"><button className={button} onClick={confirmDemo}>确认演示（不保存）</button><button className={button} onClick={() => patch({ pending: null, notice: '已取消本次演示，Provider 与路由未改变。' })}>取消演示（不修改）</button></div>
    </section>}
    <section className={`${card} min-w-0`} aria-label="Mock Provider 列表">
      <h3 className="font-semibold">Provider 实例 · Mock</h3>
      {!rows.length ? <p role="status" className="mt-5 text-sm text-slate-500">没有匹配的演示 Provider，请调整筛选条件。</p> : <div className="mt-5 overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-xs text-slate-500"><tr>{['名称 / 稳定 ID', '启停状态', '关联模型 / 主备用路由', '优先级（演示）', '健康 / 验证（固定演示）', '最近检查（非实时）', '演示操作'].map(title => <th key={title} scope="col" className="whitespace-nowrap px-3 py-3">{title}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.id} className="border-t border-slate-100 align-top">
        <td className="px-3 py-4"><p className="font-medium">{row.name}</p><p className="mt-1 break-all text-xs text-slate-500">{row.id}</p></td>
        <td className="whitespace-nowrap px-3 py-4"><span className={row.enabled ? 'text-emerald-700' : 'text-slate-500'}>{row.enabled ? '启用' : '禁用'}（演示）</span></td>
        <td className="px-3 py-4">{getProviderRoutes(data, row.id).map(route => <p key={route.id} className="mb-2">{route.model.name} / {route.modelId}<span className="block text-xs text-violet-700">{route.role} · {route.id}（演示）</span></p>)}{!getProviderRoutes(data, row.id).length && '未关联（演示）'}</td>
        <td className="px-3 py-4">{row.priority}</td>
        <td className="px-3 py-4">{healthLabels[row.health]}<p className="mt-1 text-xs text-slate-500">{verificationLabels[row.verification]}</p></td>
        <td className="px-3 py-4 text-xs">{checkedAt(row.lastCheckedAt)}</td>
        <td className="space-y-2 px-3 py-4"><button className={button} disabled={!!pending} aria-pressed={selected?.id === row.id} onClick={() => patch({ selectedId: row.id, priority: String(row.priority), error: '' })}>查看路由详情（演示）</button><button className={button} disabled={locked} onClick={() => patch({ pending: { action: 'toggle', id: row.id, enabled: !row.enabled, description: `${row.name} / ${row.id}：${row.enabled ? '启用 → 禁用' : '禁用 → 启用'}（演示）` }, notice: '' })}>{row.enabled ? '禁用 Provider' : '启用 Provider'}（仅演示）</button></td>
      </tr>)}</tbody></table></div>}
    </section>
    <section className={card} aria-label="Mock Provider 路由详情">
      <h3 className="font-semibold">Provider 与路由详情 · Mock</h3>
      {!selected ? <p className="mt-4 text-sm text-slate-500">选择一个演示 Provider 查看路由详情。</p> : <>
        <dl className="mt-4 grid gap-4 break-words text-sm md:grid-cols-3">{[
          ['名称 / 稳定 ID', `${selected.name} / ${selected.id}`], ['启停状态', selected.enabled ? '启用（演示）' : '禁用（演示）'], ['优先级（演示）', selected.priority],
          ['固定演示健康', healthLabels[selected.health]], ['固定演示验证', verificationLabels[selected.verification]], ['最近检查（非实时）', checkedAt(selected.lastCheckedAt)],
        ].map(([label, value]) => <div key={label}><dt className="text-slate-500">{label}</dt><dd className="mt-1 font-medium">{value}</dd></div>)}</dl>
        <form onSubmit={preparePriority} noValidate className="mt-6 max-w-lg space-y-3">
          <label className="block text-sm">演示优先级（1–100 整数）<input type="number" min={1} max={100} step={1} className={input} value={state.priority} disabled={locked} aria-invalid={!!state.error} aria-describedby={state.error ? 'provider-priority-error' : undefined} onChange={event => patch({ priority: event.target.value, error: '' })} /></label>
          {state.error && <p id="provider-priority-error" role="alert" className="text-sm text-rose-700">{state.error}</p>}
          <button type="submit" className={button} disabled={locked}>预览优先级（仅演示）</button>
        </form>
        <div className="mt-6 space-y-4">{!routes.length ? <p className="text-sm text-slate-500">未关联演示路由。</p> : routes.map(route => <article key={route.id} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
          <h4 className="break-words font-medium">{route.model.name} / {route.modelId}</h4>
          <p className="mt-2 text-xs text-slate-500">路由 ID：{route.id} · 本实例为{route.role}（演示）</p>
          <p className="mt-3 break-words text-sm">主路由：{route.primary.name} / {route.primary.id} · {route.primary.enabled ? '启用' : '禁用'}（演示）</p>
          <p className="mt-2 break-words text-sm">备用路由：{route.backup.name} / {route.backup.id} · {route.backup.enabled ? '启用' : '禁用'}（演示）</p>
          <button className={`${button} mt-4`} disabled={locked} onClick={() => patch({ pending: { action: 'swap', id: route.id, description: `${route.model.name} / ${route.modelId}（${route.id}）：主路由 ${route.primary.name} / ${route.primary.id} → ${route.backup.name} / ${route.backup.id}；备用路由反向互换。` }, notice: '' })}>互换主/备用（仅演示）</button>
        </article>)}</div>
        <button className={`${button} mt-5`} disabled={!!pending} onClick={() => patch({ selectedId: null, priority: '', error: '' })}>关闭详情（演示）</button>
      </>}
      <p className="mt-5 text-xs leading-6 text-slate-500">全部为独立 Mock。筛选不清除已选详情；健康与验证不会随演示操作变化，不进行实时探测。</p>
    </section>
  </div>;
}
