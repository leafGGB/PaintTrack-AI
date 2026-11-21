'use client';

import { useEffect, useState } from 'react';
import { createAdminModelsGateway } from '@/lib/adminModelsData';

const gatewayDefault = createAdminModelsGateway();
const card = 'rounded-2xl border border-slate-200 bg-white p-6';
const button = 'rounded-lg border border-slate-300 px-3 py-2 text-sm text-violet-700 hover:bg-violet-50 disabled:opacity-50';
const input = 'mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm';
const labels = { 'image.generate': '文生图', 'image.edit': '图像编辑', 'video.generate': '文生视频', 'video.generate_from_image': '图生视频', 'video.edit': '视频编辑' };

export default function AdminModels({ gateway = gatewayDefault } = {}) {
  const [state, setState] = useState({ status: 'loading', filters: { search: '', type: 'all', enabled: 'all' }, query: { q: '', type: 'all', enabled: 'all', limit: 20 }, cursors: [null], page: 0, selectedId: null, retry: 0 });
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setState(current => ({ ...current, status: 'loading', data: null, selectedId: null }));
    Promise.resolve().then(() => active ? gateway.read({ ...state.query, cursor: state.cursors[state.page] }, { signal: controller.signal }) : null).then(data => {
      if (active) setState(current => ({ ...current, status: 'ready', data }));
    }).catch(error => {
      if (active) setState(current => ({ ...current, status: 'error', data: null, authError: [401, 403].includes(error?.status) }));
    });
    return () => { active = false; controller.abort(); };
  }, [gateway, state.query, state.page, state.cursors, state.retry]);
  return <AdminModelsView state={state} setState={setState} />;
}

export function AdminModelsView({ state, setState }) {
  const patch = changes => setState(current => ({ ...current, ...changes }));
  if (state.status === 'loading') return <section role="status" className={card}>正在加载真实模型目录……</section>;
  if (state.status === 'error') return <section role="alert" className={card}><p>{state.authError ? '请重新完成管理员登录与 MFA 后重试。' : '真实模型目录暂时不可用，请重试；未回退到 Mock。'}</p><button className={`${button} mt-4`} onClick={() => setState(current => ({ ...current, status: 'loading', data: null, retry: current.retry + 1 }))}>重试</button></section>;
  const { data, filters } = state;
  // 防止注入旧 Mock DTO 后错误标记为真实来源。
  if (data?.source !== 'api' || data.mock !== false || data.writesAvailable !== false) return <section role="alert" className={card}>模型数据来源无效，未展示目录。</section>;
  const selected = data.models.find(row => row.id === state.selectedId);
  const filter = (key, value) => patch({ filters: { ...filters, [key]: value } });
  const capabilities = row => row.capabilities.map(value => labels[value] || value).join('、') || '不支持的能力声明';
  const template = row => row.capabilityTemplate ? `${row.capabilityTemplate.key} · v${row.capabilityTemplate.version}` : '未声明';
  function apply(event) {
    event.preventDefault();
    patch({ query: { q: filters.search.trim(), type: filters.type, enabled: filters.enabled, limit: 20 }, cursors: [null], page: 0, status: 'loading', data: null, selectedId: null });
  }
  function next() {
    if (!data.nextCursor) return;
    patch({ cursors: [...state.cursors.slice(0, state.page + 1), data.nextCursor], page: state.page + 1, status: 'loading', data: null, selectedId: null });
  }
  return <div className="space-y-6">
    <section className="rounded-2xl border-2 border-sky-300 bg-sky-50 p-6">
      <p className="font-semibold text-sky-900">真实只读数据 / API</p><h2 className="mt-3 text-2xl font-semibold">模型目录 · 只读</h2>
      <p className="mt-3 text-sm leading-7 text-slate-700">读取当前模型目录与绑定摘要，不提供新增、启用、禁用或其他写操作。目录启用与绑定状态不代表上游实时可用。</p>
      <p className="mt-2 text-sm text-slate-600">价格未授权读取，不等于未配置或免费；当前目录不用于改写历史快照。</p>
      <p className="mt-2 break-all text-xs text-slate-500">快照时间（UTC）：{data.meta?.asOf} · 请求标识：{data.meta?.requestId}</p>
    </section>
    <section className={card} aria-label="模型目录筛选"><form onSubmit={apply}>
      <div className="grid gap-4 md:grid-cols-3">
        <label className="text-sm">搜索名称 / 稳定 ID<input className={input} maxLength={128} value={filters.search} onChange={event => filter('search', event.target.value)} placeholder="输入模型名称或 ID" /></label>
        <label className="text-sm">类型<select className={input} value={filters.type} onChange={event => filter('type', event.target.value)}><option value="all">全部类型</option><option value="image">image · 图像</option><option value="video">video · 视频</option></select></label>
        <label className="text-sm">启用状态<select className={input} value={filters.enabled} onChange={event => filter('enabled', event.target.value)}><option value="all">全部状态</option><option value="true">启用</option><option value="false">禁用</option></select></label>
      </div><button type="submit" className={`${button} mt-4`}>应用筛选</button><p className="mt-3 text-xs text-slate-500">筛选提交到服务器；每页最多 20 项，不代表目录总数。分页读取为独立快照。</p>
    </form></section>
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
      <section className={`${card} min-w-0`} aria-label="模型列表">
        <h3 className="font-semibold">模型列表 · API 只读</h3>
        {!data.models.length ? <p role="status" className="mt-5 text-sm text-slate-500">没有匹配的模型，请调整筛选条件。</p> : <div className="mt-5 overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-xs text-slate-500"><tr>{['名称 / 稳定 ID', '类型 / 能力', '状态 / 目录版本', '能力模板', 'Provider 绑定', '价格', '详情'].map(title => <th key={title} scope="col" className="whitespace-nowrap px-3 py-3">{title}</th>)}</tr></thead><tbody>{data.models.map(row => <tr key={row.id} className="border-t border-slate-100 align-top">
          <td className="px-3 py-4"><p className="font-medium">{row.name}</p><p className="mt-1 break-all text-xs text-slate-500">{row.id}</p></td>
          <td className="px-3 py-4">{row.type}<p className="mt-1 text-xs text-slate-500">{capabilities(row)}</p></td>
          <td className="whitespace-nowrap px-3 py-4">{row.enabled ? '启用' : '禁用'}<p className="mt-1 text-xs text-slate-500">v{row.catalogVersion}</p></td>
          <td className="px-3 py-4">{template(row)}</td><td className="px-3 py-4">{row.bindings.length ? `${row.bindings.length} 条绑定摘要` : '无绑定'}</td><td className="px-3 py-4">未授权读取</td>
          <td className="px-3 py-4"><button className={button} aria-pressed={selected?.id === row.id} onClick={() => patch({ selectedId: row.id })}>查看详情</button></td>
        </tr>)}</tbody></table></div>}
        <div className="mt-5 flex flex-wrap items-center gap-3"><button className={button} disabled={state.page === 0} onClick={() => patch({ page: state.page - 1, status: 'loading', data: null, selectedId: null })}>上一页</button><span className="text-sm text-slate-500">第 {state.page + 1} 页 · 本页 {data.models.length} 项</span><button className={button} disabled={!data.nextCursor} onClick={next}>下一页</button></div>
      </section>
      <aside className={card} aria-label="模型详情"><h3 className="font-semibold">模型详情 · API 只读</h3>
        {!selected ? <p className="mt-4 text-sm text-slate-500">选择一个模型查看详情。</p> : <><dl className="mt-4 space-y-4 break-words text-sm">{[
          ['名称', selected.name], ['稳定 ID', selected.id], ['模型 UUID', selected.logicalModelPk], ['类型', selected.type], ['启用状态', selected.enabled ? '启用' : '禁用'],
          ['目录版本', selected.catalogVersion], ['能力', capabilities(selected)], ['能力模板', template(selected)], ['参数版本', selected.parameterSchemaVersion ?? '未声明'], ['价格', '未授权读取'],
        ].map(([label, value]) => <div key={label}><dt className="text-slate-500">{label}</dt><dd className="mt-1 font-medium">{value}</dd></div>)}</dl>
          <h4 className="mt-5 text-sm font-semibold">Provider 绑定摘要</h4>{!selected.bindings.length ? <p className="mt-2 text-sm">无绑定</p> : <ul className="mt-3 space-y-3">{selected.bindings.map((binding, index) => <li key={index} className="break-all rounded-lg border border-slate-200 p-3 text-xs leading-6">实例：{binding.providerInstanceId}<br />模型：{binding.providerModelId}<br />{binding.routeRole === 'primary' ? '主路由' : '备用路由'} · 顺序 {binding.routeOrder} · 绑定 v{binding.bindingVersion} · {binding.active ? '绑定启用' : '绑定禁用'}</li>)}</ul>}
          <button className={`${button} mt-5`} onClick={() => patch({ selectedId: null })}>关闭详情</button></>}
        <p className="mt-5 text-xs leading-6 text-slate-500">仅展示白名单标识、主备角色、顺序和版本；不读取 Provider 秘密、地址或实时健康状态。</p>
      </aside>
    </div>
  </div>;
}
