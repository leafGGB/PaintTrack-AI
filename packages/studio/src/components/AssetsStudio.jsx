"use client";

import { useEffect, useRef, useState } from 'react';
import useAssets from '../useAssets.js';
import { deleteAsset } from '../taskClient.js';
import { invalidateAssets } from '../assetInvalidations.js';
import ConfirmDialog from './ui/ConfirmDialog.jsx';

export default function AssetsStudio({ accountId, active = true, locale = 'en' }) {
  const zh = locale === 'zh';
  const [media, setMedia] = useState('all');
  const filters = zh ? { all: '全部资产', image: '图片', video: '视频' } : { all: 'All assets', image: 'Images', video: 'Videos' };
  const assets = useAssets(accountId, media, active);
  const [preview, setPreview] = useState(null);
  const [target, setTarget] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const scope = useRef(null);
  const identity = `${accountId || ''}:${media}:${active}`;
  scope.current = identity;
  const currentPreview = preview?.scope === identity && assets.items.some((item) => item.id === preview.item.id) ? preview.item : null;
  const currentTarget = target?.scope === identity ? target.item : null;
  const deleting = useRef(false);
  useEffect(() => {
    if (!currentPreview) return;
    const close = (event) => { if (event.key === 'Escape') setPreview(null); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [currentPreview]);
  async function remove() {
    if (!currentTarget || deleting.current) return;
    const captured = identity;
    deleting.current = true;
    setBusy(true); setError(null);
    try {
      await deleteAsset(currentTarget.id);
      invalidateAssets(accountId, { type: 'deleted', assetId: currentTarget.id });
      if (scope.current !== captured) return;
      setTarget(null); setPreview(null);
    } catch {
      if (scope.current === captured) setError(zh ? '删除失败，请重试。' : 'Deletion failed. Please retry.');
    } finally {
      deleting.current = false;
      if (scope.current === captured) setBusy(false);
    }
  }
  return (
    <section className="h-full overflow-y-auto p-4 sm:p-8 text-white" aria-label={zh ? '我的资产' : 'My assets'}>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <h1 className="text-xl font-semibold">{zh ? '我的资产' : 'My assets'}</h1>
        <div className="flex flex-wrap gap-2">
          <div role="group" aria-label={zh ? '资产分组' : 'Asset type'} className="flex flex-wrap gap-2">
            {Object.entries(filters).map(([value, label]) => <button key={value} type="button" aria-pressed={media === value} className={`rounded-lg border px-4 py-2 text-sm ${media === value ? 'border-cyan-400 text-cyan-300' : 'border-white/15 text-white/60'}`} onClick={() => { if (value !== media) { setMedia(value); setTarget(null); setPreview(null); setBusy(false); setError(null); } }}>{label}</button>)}
          </div>
          <button type="button" className="px-3 text-sm" disabled={assets.loading} onClick={() => void assets.refresh()}>{zh ? '刷新' : 'Refresh'}</button>
        </div>
      </div>
      <p className="text-xs text-white/50 mb-4">{zh ? '仅展示当前账号已归档的资产。删除后将同步从生成历史中移除。' : 'Only archived assets belonging to this account. Deletion also removes them from generation history.'}</p>
      {assets.error && <div role="alert" className="mb-4 text-amber-200">{zh ? '资产加载失败。' : 'Assets could not be loaded.'}<button type="button" className="ml-3 underline" onClick={() => void assets.retry()}>{zh ? '重试' : 'Retry'}</button></div>}
      {!assets.loading && !assets.error && assets.items.length === 0 && <p className="py-16 text-center text-white/50">{zh ? '暂无资产' : 'No assets yet'}</p>}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4">
        {assets.items.map((item) => <article key={item.id} className="rounded-xl border border-white/10 bg-white/[0.03] overflow-hidden">
          <button type="button" aria-label={zh ? '预览资产' : 'Preview asset'} className="block w-full aspect-video bg-black/30" onClick={() => setPreview({ scope: identity, item })}>
            {item.mediaType === 'image' ? <img src={item.resultUrl} alt={zh ? '生成图片' : 'Generated image'} loading="lazy" className="w-full h-full object-contain" /> : <video src={item.resultUrl} preload="metadata" muted className="w-full h-full object-contain" />}
          </button>
          <div className="p-3 flex items-center justify-between gap-2 text-xs text-white/60"><span>{new Date(item.createdAt).toLocaleDateString()} · {(item.sizeBytes / 1024).toFixed(1)} KB</span><button type="button" className="text-red-300" onClick={() => { setTarget({ scope: identity, item }); setError(null); }}>{zh ? '删除' : 'Delete'}</button></div>
        </article>)}
      </div>
      {assets.loading && <p role="status" className="py-6 text-center text-white/60">{zh ? '加载中…' : 'Loading…'}</p>}
      {assets.nextCursor && !assets.error && <button type="button" disabled={assets.loading} className="block mx-auto my-6 px-5 py-2 rounded-lg border border-white/15" onClick={() => void assets.loadMore()}>{zh ? '加载更多' : 'Load more'}</button>}
      {currentPreview && <div role="dialog" aria-modal="true" aria-label={zh ? '资产预览' : 'Asset preview'} className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-6" onClick={() => setPreview(null)}><button type="button" className="absolute right-6 top-6" onClick={() => setPreview(null)}>{zh ? '关闭' : 'Close'}</button>{currentPreview.mediaType === 'image' ? <img src={currentPreview.resultUrl} alt="" className="max-w-full max-h-[85vh] object-contain" onClick={(event) => event.stopPropagation()} /> : <video src={currentPreview.resultUrl} controls autoPlay className="max-w-full max-h-[85vh]" onClick={(event) => event.stopPropagation()} />}</div>}
      <ConfirmDialog open={Boolean(currentTarget)} title={zh ? '删除资产？' : 'Delete asset?'} description={zh ? '删除后将无法在资产列表与生成历史中访问。' : 'This asset will no longer be available in assets or generation history.'} confirmLabel={zh ? '删除' : 'Delete'} cancelLabel={zh ? '取消' : 'Cancel'} busyLabel={zh ? '删除中…' : 'Deleting…'} busy={busy} error={error} onConfirm={remove} onCancel={() => { if (!busy) setTarget(null); }} />
    </section>
  );
}
