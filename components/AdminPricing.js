'use client';

import { useEffect, useRef, useState } from 'react';
import { createAdminPricingGateway, formatPricingTenths, preparePricingDraft, versionStatus, selectPricingHead } from '@/lib/adminPricingData';

const card = 'rounded-2xl border border-slate-200 bg-white p-6';
const button = 'rounded-lg border border-slate-300 px-3 py-2 text-sm text-violet-700 hover:bg-violet-50 disabled:opacity-50';
const input = 'mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm';
const labels = { draft: '草稿', scheduled: '未生效', effective: '已生效', cancelled: '已取消', revoked: '已撤销' };
const actions = { createDraft: '新增草稿', publish: '发布版本', cancel: '取消未生效版本', revoke: '撤销已生效版本' };
const initialForm = { modelId: '', pricingVersion: '', amount: '', effectiveFrom: '' };

export default function AdminPricing({ gateway: injectedGateway }) {
  const [defaultGateway] = useState(() => injectedGateway || createAdminPricingGateway());
  const gateway = injectedGateway || defaultGateway;
  const [state, setState] = useState({ status: 'loading', modelId: 'all', selected: '', form: initialForm, pending: null, busy: false, error: '', notice: '' });
  const request = useRef({ controller: null, sequence: 0, busy: false });
  useEffect(() => {
    const current = request.current;
    const sequence = ++current.sequence;
    current.controller?.abort();
    current.controller = new AbortController();
    current.busy = false;
    const signal = current.controller.signal;
    setState({ status: 'loading', modelId: 'all', selected: '', form: initialForm, pending: null, busy: false, error: '', notice: '' });
    gateway.read({}, { signal }).then(result => {
      if (signal.aborted || sequence !== current.sequence) return;
      setState(previous => ({ ...previous, status: result.ok ? 'ready' : 'error', data: result.data, meta: result.meta, error: result.error?.message || '' }));
    });
    return () => { ++current.sequence; current.controller.abort(); current.busy = false; };
  }, [gateway]);

  async function confirmPricingPreview() {
    const current = request.current;
    if (!state.pending || current.busy || current.completed === state.pending || !current.controller || current.controller.signal.aborted) return;
    current.completed = state.pending;
    current.busy = true;
    const sequence = ++current.sequence;
    const signal = current.controller.signal;
    setState(previous => ({ ...previous, busy: true, error: '' }));
    const result = await gateway.command(state.pending, { signal });
    if (signal.aborted || sequence !== current.sequence) return;
    current.busy = false;
    setState(previous => ({ ...previous, busy: false, pending: null,
      ...(result.ok ? { data: result.data, meta: result.meta, notice: result.meta.mock ? '仅演示：本页内存已更新，刷新恢复；未保存服务器，不改历史报价、不收费。' : '命令已返回，请核对最新快照。' }
        : { error: `${result.error.code}：${result.error.message}`, notice: '' }) }));
  }
  return <AdminPricingView state={state} setState={setState} onConfirm={confirmPricingPreview} />;
}

export function AdminPricingView({ state, setState, onConfirm }) {
  if (state.status === 'loading') return <section role="status" className={card}>正在加载定价版本……</section>;
  if (state.status === 'error') return <section role="alert" className={card}>定价接口暂时不可用，请刷新页面；未回退到 Mock。</section>;
  const { data, meta, pending } = state;
  const patch = changes => setState(current => ({ ...current, ...changes }));
  const locked = !!pending || state.busy || !meta.writesAvailable;
  const rows = data.versions.filter(row => state.modelId === 'all' || row.config.modelId === state.modelId)
    .slice().sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  const selected = data.versions.find(row => `${row.config.modelId}:${row.config.pricingVersion}` === state.selected);
  const scope = meta.mock ? 'Mock' : 'API';
  function preview(event) {
    event.preventDefault();
    try { patch({ pending: preparePricingDraft(data, state.form), error: '', notice: '' }); }
    catch (error) { patch({ error: error.message, pending: null }); }
  }
  function prepare(action, row) {
    patch({ pending: { action, modelId: row.config.modelId, pricingVersion: row.config.pricingVersion }, error: '', notice: '' });
  }
  const target = pending && data.versions.find(row => row.config.modelId === pending.modelId && row.config.pricingVersion === pending.pricingVersion);
  return <div className="space-y-6">
    <section className="rounded-2xl border-2 border-amber-300 bg-amber-50 p-6">
      <p className="font-semibold text-amber-900">{meta.mock ? '演示数据 / Mock，非真实定价' : 'API 数据源 · 请核对服务端能力'}</p>
      <h2 className="mt-3 text-2xl font-semibold">定价版本 · {scope}</h2>
      <p className="mt-3 text-sm leading-7">{meta.mock ? '全部价格为虚构测试值，不是商业默认价。不接真实 API，仅页面内存，刷新恢复；不改历史报价、不收费、不影响模型、Provider、任务与账务。' : '当前页面只支持受限 v1 定价投影。'}</p>
      <p className="mt-3 font-semibold text-amber-900">{data.clock.fixed ? '固定演示时钟（永不推进，非实时）' : '服务端采样时钟'}：{data.clock.asOf} · UTC</p>
      <p className="mt-2 text-sm leading-7 text-slate-600">生效与未来时间校验均以此时钟为准。改价必须追加版本；取消未生效版本、撤销已生效版本。撤销最新头不自动回退旧版，必须另发新版本；旧报价保持不变。</p>
      <p className="mt-2 text-xs leading-6 text-slate-600">最小投影：图片 per_unit / 单张、视频 per_second；可读分辨率与时长档位、帧率有理系数。新增仅复用固定演示档位并统一单价，不支持全部模板编辑。真实接入仍需服务端鉴权、step-up、幂等、事务及持久审计；本页未实现这些安全门禁。</p>
    </section>
    {state.notice && <p role="status" className={card}>{state.notice}</p>}
    {state.error && <p role="alert" className="rounded-xl border border-rose-200 bg-white p-4 text-sm text-rose-700">{state.error}</p>}
    <section className={card} aria-label="定价模型筛选">
      <label className="text-sm">模型筛选<select className={input} value={state.modelId} onChange={event => patch({ modelId: event.target.value })}><option value="all">全部模型</option>{data.models.map(model => <option key={model.id} value={model.id}>{model.name} / {model.id}</option>)}</select></label>
      <div className="mt-4 grid gap-4 md:grid-cols-2">{data.models.filter(model => state.modelId === 'all' || model.id === state.modelId).map(model => {
        const head = selectPricingHead(data, model.id);
        return <p key={model.id} className="rounded-xl bg-slate-50 p-4 text-sm">{model.name} / {model.id}<span className="mt-2 block text-violet-700">当前头：{head.head?.config.pricingVersion || '无'} · {head.available ? '可用' : '无可用版本（不回退旧版）'} · {scope}</span></p>;
      })}</div>
    </section>
    <section className={card} aria-label="新增定价草稿">
      <h3 className="font-semibold">追加版本 / 新增草稿 · {scope}</h3>
      <form onSubmit={preview} noValidate className="mt-4 grid gap-4 md:grid-cols-2">
        <label className="text-sm">草稿模型<select className={input} disabled={locked} value={state.form.modelId} onChange={event => patch({ form: { ...state.form, modelId: event.target.value } })}><option value="">请选择模型</option>{data.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label>
        <label className="text-sm">新版本名<input className={input} disabled={locked} value={state.form.pricingVersion} onChange={event => patch({ form: { ...state.form, pricingVersion: event.target.value } })} /></label>
        <label className="text-sm">统一档位单价（credit，最多1位小数；图片每张 / 视频每秒）<input className={input} inputMode="decimal" disabled={locked} value={state.form.amount} onChange={event => patch({ form: { ...state.form, amount: event.target.value } })} /></label>
        <label className="text-sm">未来 UTC 整秒生效点（YYYY-MM-DDTHH:mm:ssZ）<input className={input} disabled={locked} value={state.form.effectiveFrom} onChange={event => patch({ form: { ...state.form, effectiveFrom: event.target.value } })} /></label>
        <p className="text-xs leading-6 text-slate-500">金额无预填值。图片固定 1024x1024 / 1536x864、maxOutputCount=1；视频固定 [1,3000) / [3000,6001) ms，24fps×1/1、30fps×3/2。草稿不参与选价；另行确认发布后才进入时间轴。</p>
        <button type="submit" className={button} disabled={locked}>预览新增草稿</button>
      </form>
      {!meta.writesAvailable && <p className="mt-3 text-sm">此数据源未开放命令，仅可读取。</p>}
    </section>
    {pending && <section role="alertdialog" aria-modal="false" aria-labelledby="pricing-confirm" className="rounded-2xl border-2 border-violet-300 bg-white p-6">
      <h3 id="pricing-confirm" className="font-semibold">预览：{actions[pending.action]} · {scope}</h3>
      <p className="mt-3 break-words text-sm">模型 {pending.modelId} / 版本 {pending.pricingVersion}；生效点 {pending.effectiveFrom || target?.effectiveFrom} UTC</p>
      {pending.unitPriceTenths !== undefined && <p className="mt-3 text-sm">统一档位单价：{formatPricingTenths(pending.unitPriceTenths)} credit（{pending.unitPriceTenths} tenths）；图片每张 / 视频每秒，帧率系数不变。</p>}
      <p className="mt-3 text-sm leading-7">影响范围：仅此模型的新报价选择；草稿无选价影响，发布仅未来生效，取消阻止预约生效，撤销阻止该版本后续选用。撤销最新头不自动回退旧版，不改变任何历史报价。{meta.mock && '本次仅演示，不写服务器、不收费，刷新恢复。'}</p>
      <div className="mt-4 flex gap-3"><button className={button} disabled={state.busy} onClick={onConfirm}>{state.busy ? '正在执行…' : '确认操作'}</button><button className={button} disabled={state.busy} onClick={() => patch({ pending: null, notice: '已取消预览，数据未改变。' })}>取消预览</button></div>
    </section>}
    <section className={card} aria-label="定价版本时间轴">
      <h3 className="font-semibold">版本列表 / 时间轴 · {scope}</h3>
      <p className="mt-2 text-xs text-slate-500">按生效点倒序；已生效不一定是当前头。取消、撤销记录保留。</p>
      {!rows.length ? <p role="status" className="mt-4">没有匹配的定价版本。</p> : <ol className="mt-5 space-y-4">{rows.map(row => {
        const status = versionStatus(row, data.clock.asOf);
        return <li key={`${row.config.modelId}:${row.config.pricingVersion}`} className="rounded-xl border border-slate-200 p-4">
          <p className="break-words font-medium">{row.config.modelId} / {row.config.pricingVersion} · {labels[status]} · {scope}</p>
          <p className="mt-2 text-sm">生效点：{row.effectiveFrom} UTC</p>
          <p className="mt-2 text-xs text-slate-500">发布：{row.publishedAt || '未发布'}；取消：{row.cancelledAt || '无'}；撤销：{row.revokedAt || '无'}</p>
          <p className="mt-2 text-xs text-slate-500">影响范围：仅 {row.config.modelId} 新报价；历史报价不变。</p>
          <div className="mt-3 flex flex-wrap gap-3"><button className={button} disabled={!!pending || state.busy} onClick={() => patch({ selected: `${row.config.modelId}:${row.config.pricingVersion}` })}>查看价格与单位</button>
            {['draft', 'scheduled', 'effective'].includes(status) && <button className={button} disabled={locked} onClick={() => prepare({ draft: 'publish', scheduled: 'cancel', effective: 'revoke' }[status], row)}>{actions[{ draft: 'publish', scheduled: 'cancel', effective: 'revoke' }[status]]}</button>}</div>
        </li>;
      })}</ol>}
    </section>
    <section className={card} aria-label="定价单位详情">
      <h3 className="font-semibold">图片 / 视频价格档位与单位详情 · {scope}</h3>
      {!selected ? <p className="mt-4 text-sm text-slate-500">选择一个版本查看详情。</p> : <>
        <p className="mt-4 break-words text-sm">{selected.config.modelId} / {selected.config.pricingVersion} · {selected.config.templateType} · {labels[versionStatus(selected, data.clock.asOf)]}</p>
        <ul className="mt-4 space-y-2 text-sm">{selected.config.resolutions?.map(band => <li key={band.resolutionKey}>{band.resolutionKey}：{formatPricingTenths(band.unitPriceTenths)} credit / 张 · {band.unitPriceTenths} tenths · {band.enabled ? '启用' : '禁用'}</li>)}
          {selected.config.durationBands?.map(band => <li key={band.start}>[{band.start}, {band.end}) ms：{formatPricingTenths(band.unitPriceTenths)} credit / 秒 · {band.unitPriceTenths} tenths · {band.enabled ? '启用' : '禁用'}</li>)}
          {selected.config.fpsRates?.map(rate => <li key={rate.fps}>{rate.fps} fps：系数 {rate.numerator}/{rate.denominator} · {rate.enabled ? '启用' : '禁用'}</li>)}</ul>
        <p className="mt-4 text-sm">{selected.config.quantityMode ? '图片：per_unit，输出上限1张。' : `视频：per_second，有效时长 ${selected.config.minDurationMs}–${selected.config.maxDurationMs} ms；金额×durationMs/1000×帧率系数。`}</p>
        <p className="mt-3 text-xs leading-6 text-slate-500">currencyUnit={selected.config.currencyUnit}；最小单位0.1 credit；{selected.config.precisionVersion}；{selected.config.roundingModeVersion}。整数字符串 tenths / BigInt，最终向上取整；本页不生成真实报价。</p>
        <button className={`${button} mt-4`} disabled={!!pending || state.busy} onClick={() => patch({ selected: '' })}>关闭详情</button>
      </>}
    </section>
  </div>;
}
