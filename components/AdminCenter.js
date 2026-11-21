'use client';

import { useEffect, useRef, useState } from 'react';

function formatDate(value, locale) {
  if (!value) return locale === 'zh' ? '暂无数据' : 'Not available';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return locale === 'zh' ? '暂无数据' : 'Not available';
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function formatCredits(tenths) {
  const value = BigInt(String(tenths || '0'));
  return `${value / 10n}.${value % 10n}`;
}

const copy = {
  en: {
    loading: 'Loading…', retry: 'Retry', scope: 'Current scope', scopeText: 'Read-only identity, active sessions, credit balances and recent ledger summary. Bans, session revocation and credit changes are not enabled.', directory: 'User directory', search: 'Exact email', searchPlaceholder: 'person@example.com', find: 'Search', clear: 'Clear', empty: 'No users found.', listError: 'The user list is temporarily unavailable.', details: 'User details', select: 'Select a user to inspect read-only details.', id: 'ID', role: 'Role', verified: 'Email verified', yes: 'Verified', no: 'Not verified', created: 'Created', sessions: 'Active sessions', credits: 'Credits', available: 'Available', frozen: 'Frozen', ledger: 'Recent ledger', noLedger: 'No recent ledger entries.', loadMore: 'Load more', loadingMore: 'Loading…', detailError: 'User details are temporarily unavailable.', ledgerKind: { reserve: 'Reserved', settle: 'Settled', release: 'Released', grant: 'Granted' }, roleUser: 'User', roleAdmin: 'Administrator',
  },
  zh: {
    loading: '正在加载……', retry: '重试', scope: '当前范围', scopeText: '仅限读取用户身份、有效会话数、额度余额和最近账单摘要。封禁、解封、会话撤销和额度调整均未启用。', directory: '用户列表', search: '精确邮箱', searchPlaceholder: 'person@example.com', find: '搜索', clear: '清除', empty: '没有找到用户。', listError: '用户列表暂时无法读取。', details: '用户详情', select: '选择用户查看只读详情。', id: '用户 ID', role: '角色', verified: '邮箱验证', yes: '已验证', no: '未验证', created: '创建时间', sessions: '有效会话', credits: '额度', available: '可用', frozen: '冻结', ledger: '最近账单', noLedger: '暂无最近账单流水。', loadMore: '加载更多', loadingMore: '正在加载……', detailError: '用户详情暂时无法读取。', ledgerKind: { reserve: '冻结', settle: '结算', release: '释放', grant: '发放' }, roleUser: '用户', roleAdmin: '管理员',
  },
};

function roleLabel(role, text) { return role === 'admin' ? text.roleAdmin : text.roleUser; }

export default function AdminCenter({ locale = 'zh' }) {
  const text = copy[locale === 'zh' ? 'zh' : 'en'];
  const [users, setUsers] = useState({ status: 'loading', items: [], nextCursor: null });
  const [email, setEmail] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState({ status: 'idle', data: null });
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const usersRequest = useRef({ sequence: 0, controller: null, query: '', loadingMore: false });
  const detailRequest = useRef({ sequence: 0, controller: null });

  async function loadUsers({ append = false, cursor = null, query = usersRequest.current.query } = {}) {
    const request = usersRequest.current;
    if (append && (request.loadingMore || request.controller)) return;
    const sequence = ++request.sequence;
    request.controller?.abort();
    const controller = new AbortController();
    request.controller = controller;
    if (!append) request.query = query.trim();
    request.loadingMore = append;
    setLoadingMore(append);
    setMoreError(false);
    setUsers((current) => ({ ...current, status: append ? current.status : 'loading' }));
    try {
      const params = new URLSearchParams({ limit: '20' });
      if (request.query) params.set('email', request.query);
      if (cursor) params.set('cursor', cursor);
      const response = await fetch(`/api/admin/users?${params}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      const body = await response.json();
      if (sequence !== request.sequence || controller.signal.aborted) return;
      if (!response.ok) throw new Error('ADMIN_USERS_UNAVAILABLE');
      setUsers((current) => ({ status: 'ready', items: append ? [...current.items, ...body.data.users] : body.data.users, nextCursor: body.data.nextCursor }));
    } catch {
      if (sequence !== request.sequence || controller.signal.aborted) return;
      if (append) setMoreError(true);
      else setUsers((current) => ({ ...current, status: 'error' }));
    } finally {
      if (sequence === request.sequence && !controller.signal.aborted) {
        request.controller = null;
        request.loadingMore = false;
        setLoadingMore(false);
      }
    }
  }

  function resetDetail() {
    const request = detailRequest.current;
    ++request.sequence;
    request.controller?.abort();
    request.controller = null;
    setSelectedId(null);
    setDetail({ status: 'idle', data: null });
  }

  async function loadDetail(id) {
    const request = detailRequest.current;
    const sequence = ++request.sequence;
    request.controller?.abort();
    const controller = new AbortController();
    request.controller = controller;
    setSelectedId(id);
    setDetail({ status: 'loading', data: null });
    try {
      const response = await fetch(`/api/admin/users/${encodeURIComponent(id)}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      const body = await response.json();
      if (sequence !== request.sequence || controller.signal.aborted) return;
      if (!response.ok) throw new Error('ADMIN_USER_DETAIL_UNAVAILABLE');
      setDetail({ status: 'ready', data: body.data });
    } catch {
      if (sequence !== request.sequence || controller.signal.aborted) return;
      setDetail({ status: 'error', data: null });
    }
  }

  useEffect(() => {
    const requests = [usersRequest.current, detailRequest.current];
    loadUsers({ query: '' });
    return () => {
      for (const request of requests) {
        ++request.sequence;
        request.controller?.abort();
      }
    };
  }, []);

  function search(event) {
    event.preventDefault();
    resetDetail();
    loadUsers({ query: email });
  }

  function clearSearch() {
    setEmail('');
    resetDetail();
    loadUsers({ query: '' });
  }

  const selected = detail.data?.user;
  return <div className="space-y-6">
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(300px,0.8fr)]">
      <section className="min-w-0 rounded-2xl border border-slate-200 bg-white p-6">
        <h2 className="text-lg font-semibold">{text.directory}</h2>
        <form className="mt-5 flex flex-wrap gap-2" onSubmit={search}>
          <input aria-label={text.search} value={email} onChange={(event) => setEmail(event.target.value)} placeholder={text.searchPlaceholder} className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-violet-400" type="email" />
          <button className="rounded-lg bg-violet-600 px-3 py-2 text-sm text-white" type="submit">{text.find}</button>
          <button className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600" type="button" onClick={clearSearch}>{text.clear}</button>
        </form>
        {users.status === 'loading' && <p role="status" className="mt-6 text-sm text-slate-500">{text.loading}</p>}
        {users.status === 'error' && <div role="alert" className="mt-6"><p className="text-sm text-rose-700">{text.listError}</p><button className="mt-3 rounded-lg border border-slate-200 px-3 py-2 text-sm" onClick={() => loadUsers()}>{text.retry}</button></div>}
        {users.status === 'ready' && users.items.length === 0 && <p className="mt-6 text-sm text-slate-500">{text.empty}</p>}
        {users.status === 'ready' && users.items.length > 0 && <div className="mt-5 divide-y divide-slate-100">{users.items.map((user) => <button key={user.id} aria-pressed={selectedId === user.id} className={`flex w-full flex-wrap items-center justify-between gap-3 rounded-lg px-2 py-4 text-left hover:bg-slate-50 ${selectedId === user.id ? 'bg-violet-50' : ''}`} onClick={() => loadDetail(user.id)}><span className="min-w-0"><span className="block break-all text-sm font-medium">{user.email}</span><span className="mt-1 block text-xs text-slate-500">{roleLabel(user.role, text)} · {user.emailVerified ? text.yes : text.no}</span></span><span className="text-xs text-slate-500">{formatDate(user.createdAt, locale)}</span></button>)}</div>}
        {moreError && <p role="alert" className="mt-5 text-sm text-rose-700">{text.listError}</p>}
        {users.status === 'ready' && users.nextCursor && <button className="mt-5 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 disabled:opacity-50" disabled={loadingMore} onClick={() => loadUsers({ append: true, cursor: users.nextCursor })}>{loadingMore ? text.loadingMore : moreError ? text.retry : text.loadMore}</button>}
      </section>
      <section className="min-w-0 rounded-2xl border border-slate-200 bg-white p-6">
        <h2 className="text-lg font-semibold">{text.details}</h2>
        {detail.status === 'idle' && <p className="mt-6 text-sm text-slate-500">{text.select}</p>}
        {detail.status === 'loading' && <p role="status" className="mt-6 text-sm text-slate-500">{text.loading}</p>}
        {detail.status === 'error' && <div role="alert" className="mt-6"><p className="text-sm text-rose-700">{text.detailError}</p><button className="mt-3 rounded-lg border border-slate-200 px-3 py-2 text-sm" onClick={() => loadDetail(selectedId)}>{text.retry}</button></div>}
        {detail.status === 'ready' && selected && <div className="mt-5 space-y-6">
          <div><h3 className="break-all text-lg font-semibold">{selected.email}</h3><dl className="mt-4 grid gap-3 text-sm">{[[text.id, selected.id], [text.role, roleLabel(selected.role, text)], [text.verified, selected.emailVerified ? text.yes : text.no], [text.created, formatDate(selected.createdAt, locale)]].map(([label, value]) => <div key={label}><dt className="text-slate-500">{label}</dt><dd className="mt-1 break-all text-slate-700">{value}</dd></div>)}</dl></div>
          <div><p className="text-sm text-slate-500">{text.sessions}</p><p className="mt-1 text-2xl font-semibold">{detail.data.activeSessionCount}</p></div>
          <div><p className="text-sm text-slate-500">{text.credits}</p><div className="mt-3 grid grid-cols-2 gap-3"><div className="border-l border-violet-300 pl-3"><p className="text-xs text-slate-500">{text.available}</p><p className="mt-1 text-lg">{formatCredits(detail.data.credits.availableTenths)}</p></div><div className="border-l border-amber-300 pl-3"><p className="text-xs text-slate-500">{text.frozen}</p><p className="mt-1 text-lg">{formatCredits(detail.data.credits.frozenTenths)}</p></div></div></div>
          <div><h3 className="text-sm text-slate-500">{text.ledger}</h3>{detail.data.recentLedger.length === 0 ? <p className="mt-3 text-sm text-slate-500">{text.noLedger}</p> : <ul className="mt-3 divide-y divide-slate-100">{detail.data.recentLedger.map((entry) => <li key={entry.id} className="flex justify-between gap-3 py-3 text-sm"><div><p>{text.ledgerKind[entry.kind] || entry.kind}</p><p className="mt-1 text-xs text-slate-500">{formatDate(entry.createdAt, locale)}</p></div><span className="text-slate-700">{formatCredits(entry.amountTenths)}</span></li>)}</ul>}</div>
        </div>}
      </section>
    </div>
    <section className="rounded-2xl border border-slate-200 bg-white p-6"><h2 className="text-sm font-semibold">{text.scope}</h2><p className="mt-3 text-sm leading-7 text-slate-500">{text.scopeText}</p></section>
  </div>;
}
