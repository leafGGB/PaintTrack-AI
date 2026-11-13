'use client';

import { useCallback, useEffect, useState } from 'react';
// Subpath import on purpose: the `studio` barrel re-exports all 15 studios, so
// `from 'studio'` would drag reactflow / react-markdown / syntax-highlighter
// into the task panel's module graph just to confirm a cancellation.
import ConfirmDialog from 'studio/ConfirmDialog';

const ACTIVE_STATUSES = new Set(['queued', 'running']);
const STATUS_STYLES = {
  queued: 'border-white/10 bg-white/[0.04] text-white/65',
  running: 'border-cyan-400/25 bg-cyan-400/10 text-cyan-200',
  succeeded: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-200',
  failed: 'border-rose-400/20 bg-rose-400/10 text-rose-200',
  cancelled: 'border-white/10 bg-white/[0.04] text-white/45',
};

export default function TaskCenter({ locale = 'en', triggerClassName = '' }) {
  const isZh = locale === 'zh';
  const [open, setOpen] = useState(false);
  const [tasks, setTasks] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [hasLoadedMore, setHasLoadedMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [selectedTask, setSelectedTask] = useState(null);
  const [busyTaskId, setBusyTaskId] = useState(null);
  // The task awaiting confirmation. `null` keeps the dialog closed; the object
  // itself is the snapshot the user clicked on.
  const [pendingCancel, setPendingCancel] = useState(null);
  const [cancelError, setCancelError] = useState('');

  const loadTasks = useCallback(async ({ cursor, append = false, quiet = false } = {}) => {
    if (quiet) {
      try {
        const response = await fetch('/api/tasks?limit=20', { cache: 'no-store', credentials: 'same-origin' });
        if (!response.ok) throw new Error('TASK_QUERY_UNAVAILABLE');
        const data = await response.json();
        const latest = data.tasks || [];
        setTasks((current) => {
          const latestIds = new Set(latest.map((task) => task.id));
          const older = current.filter((task) => !latestIds.has(task.id));
          return [...latest, ...(hasLoadedMore ? older : [])].slice(0, 50);
        });
        if (!hasLoadedMore) setNextCursor(data.nextCursor || null);
        setError('');
      } catch {
        setError(isZh ? '任务状态暂时无法更新。' : 'Task status could not be refreshed.');
      }
      return;
    }

    append ? setLoadingMore(true) : setLoading(true);
    setError('');
    try {
      const query = new URLSearchParams({ limit: '20' });
      if (cursor) query.set('cursor', cursor);
      const response = await fetch(`/api/tasks?${query}`, { cache: 'no-store', credentials: 'same-origin' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error?.code || 'TASK_QUERY_UNAVAILABLE');
      const incoming = data.tasks || [];
      setTasks((current) => {
        if (!append) return incoming;
        const ids = new Set(current.map((task) => task.id));
        return [...current, ...incoming.filter((task) => !ids.has(task.id))];
      });
      if (append) setHasLoadedMore(true);
      else setHasLoadedMore(false);
      setNextCursor(data.nextCursor || null);
    } catch (cause) {
      setError(cause.message === 'UNAUTHENTICATED'
        ? (isZh ? '请先登录后查看任务。' : 'Sign in to view your tasks.')
        : (isZh ? '暂时无法加载任务，请稍后重试。' : 'Tasks are unavailable. Please try again.'));
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [hasLoadedMore, isZh]);

  useEffect(() => {
    if (!open) return undefined;
    loadTasks();
    const timer = window.setInterval(() => loadTasks({ quiet: true }), 5000);
    return () => window.clearInterval(timer);
  }, [open, loadTasks]);

  const openTask = async (task) => {
    setSelectedTask(task);
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, { cache: 'no-store', credentials: 'same-origin' });
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.task) setSelectedTask(data.task);
    } catch {
      // Keep the list projection visible if details cannot be fetched.
    }
  };

  // Returns true when the backend accepted the cancellation, so the caller can
  // decide whether to dismiss the dialog. A failure is surfaced twice on
  // purpose: `cancelError` renders inside the dialog (which covers the panel,
  // so the panel's own alert is not visible at that moment), and `error` stays
  // for after the dialog closes. That keeps the retry context the native
  // `window.confirm()` used to throw away.
  const cancelTask = async (task) => {
    setBusyTaskId(task.id);
    setError('');
    setCancelError('');
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}/cancel`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok && response.status !== 202) throw new Error(data?.error?.code || 'TASK_CANCELLATION_UNAVAILABLE');
      if (data.task) {
        setTasks((current) => current.map((item) => item.id === task.id ? data.task : item));
        setSelectedTask(data.task);
      }
      loadTasks({ quiet: true });
      return true;
    } catch (cause) {
      const message = cause.message === 'TASK_NOT_CANCELLABLE'
        ? (isZh ? '任务已结束，无法取消。' : 'This task has already finished.')
        : (isZh ? '取消请求未能完成，请重试。' : 'Cancellation failed. Please try again.');
      setError(message);
      setCancelError(message);
      return false;
    } finally {
      setBusyTaskId(null);
    }
  };

  const closeCancelDialog = useCallback(() => {
    setCancelError('');
    setPendingCancel(null);
  }, []);

  const text = {
    title: isZh ? '任务' : 'Tasks',
    close: isZh ? '关闭任务面板' : 'Close task panel',
    refresh: isZh ? '刷新任务' : 'Refresh tasks',
    loading: isZh ? '正在加载任务…' : 'Loading tasks…',
    empty: isZh ? '暂无任务' : 'No tasks yet',
    emptyHint: isZh ? '提交的生成任务会显示在这里。' : 'Submitted generation tasks will appear here.',
    more: isZh ? '加载更多' : 'Load more',
    details: isZh ? '任务详情' : 'Task details',
    cancel: isZh ? '取消任务' : 'Cancel task',
    cancelling: isZh ? '正在取消…' : 'Cancelling…',
    cancelPending: isZh ? '已提交取消请求' : 'Cancellation requested',
    created: isZh ? '创建时间' : 'Created',
    updated: isZh ? '更新时间' : 'Updated',
    result: isZh ? '结果描述' : 'Result descriptor',
    errorCode: isZh ? '错误代码' : 'Error code',
    status: isZh ? '状态' : 'Status',
    taskType: isZh ? '类型' : 'Type',
    closeDetails: isZh ? '关闭详情' : 'Close details',
    statuses: isZh
      ? { queued: '排队中', running: '运行中', succeeded: '已完成', failed: '失败', cancelled: '已取消' }
      : { queued: 'Queued', running: 'Running', succeeded: 'Completed', failed: 'Failed', cancelled: 'Cancelled' },
    cancelConfirm: isZh ? '取消这个任务？' : 'Cancel this task?',
    keepTask: isZh ? '保留任务' : 'Keep task',
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={triggerClassName || 'relative flex h-9 items-center gap-2 rounded-md border border-white/10 bg-white/5 px-3 text-[13px] font-semibold text-white/75 transition-colors hover:border-cyan-300/30 hover:bg-white/10 hover:text-white'}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M8 6h13M8 12h13M8 18h13" /><path d="M3 6h.01M3 12h.01M3 18h.01" />
        </svg>
        <span>{text.title}</span>
        {tasks.some((task) => ACTIVE_STATUSES.has(task.status)) && (
          <span className="h-1.5 w-1.5 rounded-full bg-[#22d3ee]" aria-label={isZh ? '有进行中的任务' : 'Active tasks'} />
        )}
      </button>

      {open && (
        <div className="fixed inset-0 z-[300] flex justify-end bg-black/60 backdrop-blur-[2px]" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
          <section role="dialog" aria-modal="true" aria-labelledby="task-center-title" className="flex h-full w-full max-w-[460px] flex-col border-l border-white/10 bg-[#09090b] text-white shadow-2xl">
            <header className="flex h-14 shrink-0 items-center justify-between border-b border-white/[0.07] px-5">
              <div className="flex items-center gap-2.5">
                <span className="h-1.5 w-1.5 rounded-full bg-[#22d3ee]" />
                <h2 id="task-center-title" className="text-sm font-semibold">{text.title}</h2>
                <span className="text-xs text-white/35">{tasks.length}</span>
              </div>
              <div className="flex items-center gap-1">
                <button type="button" onClick={() => loadTasks()} className="flex h-8 w-8 items-center justify-center rounded-md text-white/45 transition-colors hover:bg-white/[0.06] hover:text-white" aria-label={text.refresh} title={text.refresh}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.6 9A7 7 0 0 1 18 6l2 6M4 12l2 6a7 7 0 0 0 12.4-3"/></svg>
                </button>
                <button type="button" onClick={() => { setOpen(false); setSelectedTask(null); }} className="flex h-8 w-8 items-center justify-center rounded-md text-white/45 transition-colors hover:bg-white/[0.06] hover:text-white" aria-label={text.close}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="m18 6-12 12M6 6l12 12"/></svg>
                </button>
              </div>
            </header>

            {error && <div role="alert" className="mx-4 mt-3 border border-rose-400/20 bg-rose-400/[0.07] px-3 py-2 text-xs leading-5 text-rose-200">{error}</div>}

            {selectedTask && (
              <div className="border-b border-white/[0.07] bg-white/[0.02] px-5 py-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h3 className="text-xs font-semibold text-white/85">{text.details}</h3>
                  <button type="button" onClick={() => setSelectedTask(null)} className="text-[11px] text-white/40 hover:text-white/80">{text.closeDetails}</button>
                </div>
                <dl className="grid grid-cols-[90px_1fr] gap-x-3 gap-y-2 text-[11px] leading-4">
                  <dt className="text-white/35">{text.status}</dt><dd><StatusPill status={selectedTask.status} labels={text.statuses} /></dd>
                  <dt className="text-white/35">{text.taskType}</dt><dd className="break-all text-white/70">{selectedTask.taskType}</dd>
                  <dt className="text-white/35">ID</dt><dd className="break-all font-mono text-white/45">{selectedTask.id}</dd>
                  <dt className="text-white/35">{text.created}</dt><dd className="text-white/60">{formatDate(selectedTask.createdAt, locale)}</dd>
                  {selectedTask.errorCode && <><dt className="text-white/35">{text.errorCode}</dt><dd className="font-mono text-rose-200">{selectedTask.errorCode}</dd></>}
                  {selectedTask.result && <><dt className="text-white/35">{text.result}</dt><dd className="break-all font-mono text-white/60">{JSON.stringify(selectedTask.result)}</dd></>}
                </dl>
              </div>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto">
              {loading && tasks.length === 0 ? (
                <div className="px-5 py-10 text-center text-xs text-white/40">{text.loading}</div>
              ) : tasks.length === 0 ? (
                <div className="mx-5 mt-8 border border-white/[0.07] bg-white/[0.02] px-5 py-8 text-center">
                  <div className="mx-auto mb-3 flex h-9 w-9 items-center justify-center border border-white/10 bg-white/[0.03] text-cyan-200/80">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/></svg>
                  </div>
                  <p className="text-sm font-medium text-white/75">{text.empty}</p>
                  <p className="mt-1 text-xs text-white/35">{text.emptyHint}</p>
                </div>
              ) : (
                <ul className="divide-y divide-white/[0.06]">
                  {tasks.map((task) => (
                    <li key={task.id} className="px-5 py-3.5 transition-colors hover:bg-white/[0.02]">
                      <div className="flex items-start justify-between gap-3">
                        <button type="button" onClick={() => openTask(task)} className="min-w-0 flex-1 text-left">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-[13px] font-medium text-white/85">{task.taskType}</span>
                            <StatusPill status={task.status} labels={text.statuses} />
                          </span>
                          <span className="mt-1.5 block text-[11px] text-white/35">{formatDate(task.updatedAt, locale)}</span>
                          {task.cancelRequestedAt && ACTIVE_STATUSES.has(task.status) && <span className="mt-1 block text-[11px] text-amber-200/75">{text.cancelPending}</span>}
                        </button>
                        {ACTIVE_STATUSES.has(task.status) && !task.cancelRequestedAt && (
                          <button type="button" disabled={busyTaskId === task.id} onClick={() => setPendingCancel(task)} className="shrink-0 border border-white/10 px-2.5 py-1.5 text-[11px] font-medium text-white/55 transition-colors hover:border-rose-300/25 hover:bg-rose-300/[0.06] hover:text-rose-100 disabled:opacity-40">
                            {busyTaskId === task.id ? text.cancelling : text.cancel}
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {nextCursor && <div className="px-5 py-4"><button type="button" disabled={loadingMore} onClick={() => loadTasks({ cursor: nextCursor, append: true })} className="w-full border border-white/10 py-2 text-xs font-medium text-white/55 transition-colors hover:border-cyan-300/25 hover:text-white disabled:opacity-40">{loadingMore ? text.loading : text.more}</button></div>}
            </div>
            <footer className="shrink-0 border-t border-white/[0.07] px-5 py-2.5 text-[10px] text-white/30">{isZh ? '状态每 5 秒自动更新' : 'Status refreshes every 5 seconds'}</footer>
          </section>
        </div>
      )}

      {/* Portalled to document.body at z-[1000], i.e. above this panel's
          z-[300]; Esc/backdrop are handled inside the dialog. */}
      <ConfirmDialog
        open={Boolean(pendingCancel)}
        title={text.cancelConfirm}
        description={pendingCancel ? `${text.taskType}${isZh ? '：' : ': '}${pendingCancel.taskType}` : undefined}
        confirmLabel={text.cancel}
        cancelLabel={text.keepTask}
        busyLabel={text.cancelling}
        busy={Boolean(pendingCancel) && busyTaskId === pendingCancel.id}
        error={cancelError || null}
        onConfirm={async () => {
          if (!pendingCancel || busyTaskId) return;
          const accepted = await cancelTask(pendingCancel);
          if (accepted) closeCancelDialog();
        }}
        onCancel={closeCancelDialog}
      />
    </>
  );
}

function StatusPill({ status, labels }) {
  return <span className={`inline-flex shrink-0 items-center border px-1.5 py-0.5 text-[10px] leading-3 ${STATUS_STYLES[status] || STATUS_STYLES.queued}`}>{labels[status] || status}</span>;
}

function formatDate(value, locale) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
