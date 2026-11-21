'use client';

import { useEffect, useRef, useState } from 'react';

function formatDate(value, locale) {
  if (!value) return locale === 'zh' ? '暂无数据' : 'Not available';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return locale === 'zh' ? '暂无数据' : 'Not available';
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function formatCredits(tenths) {
  const value = BigInt(String(tenths || '0'));
  const whole = value / 10n;
  const fraction = value % 10n;
  return `${whole}.${fraction}`;
}

const eventTone = {
  reserve: 'text-amber-100',
  settle: 'text-rose-100',
  release: 'text-emerald-100',
  grant: 'text-cyan-100',
};

async function mfaRequest(path, body) {
  const response = await fetch(`/api/auth/mfa/${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result?.error?.code || 'MFA_UNAVAILABLE');
  return result;
}

export default function AccountCenter({ locale = 'en' }) {
  const isZh = locale === 'zh';
  const [status, setStatus] = useState('loading');
  const [user, setUser] = useState(null);
  const [message, setMessage] = useState('');
  const [copied, setCopied] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [mfaStatus, setMfaStatus] = useState(null);
  const [creditsStatus, setCreditsStatus] = useState('loading');
  const [credits, setCredits] = useState(null);
  const [creditKind, setCreditKind] = useState('');
  const [creditsLoadingMore, setCreditsLoadingMore] = useState(false);
  const [creditsMoreError, setCreditsMoreError] = useState(false);
  const creditsRequestRef = useRef({ sequence: 0, controller: null });
  const [mfaLoading, setMfaLoading] = useState(false);
  const [enrollment, setEnrollment] = useState(null);
  const [verificationCode, setVerificationCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState(null);
  const [managementCode, setManagementCode] = useState('');
  const [elevationCode, setElevationCode] = useState('');
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  const text = isZh ? {
    eyebrow: '账户 / 概览', title: '账户中心', subtitle: '查看当前登录身份与账户功能状态。',
    identity: '账户身份', email: '邮箱地址', id: '用户 ID', role: '账户角色', verified: '邮箱验证',
    verifiedYes: '已验证', created: '账户创建时间', copy: '复制 ID', copied: '已复制',
    quota: '额度与账单', available: '可用额度', reserved: '冻结额度', total: '总额度', unit: 'credit', loadingCredits: '正在读取真实额度…', creditsError: '额度与账单暂时无法读取，请稍后重试。', retryCredits: '重新读取', emptyLedger: '暂无账单流水', more: '加载更多', loadingMore: '正在加载…', moreError: '加载更多失败，列表未改变，请重试。', refresh: '刷新账单', filter: '账单类型', all: '全部', freezeHint: '冻结表示额度占用，结算才会实际扣除；释放不是新增赠送。', task: '任务', event: { reserve: '冻结', settle: '结算扣除', release: '释放冻结', grant: '额度发放' },
    usage: '使用记录', usageHint: '任务用量与用户扣点记录会显示在上方账单流水中。',
    security: '管理员安全', mfaTitle: '多因素认证（MFA）', mfaEnabled: '已启用', mfaDisabled: '未启用', mfaPending: '等待验证', mfaRevoked: '已撤销',
    mfaDescription: '使用身份验证器保护管理员操作。密钥和恢复码只在对应流程中显示。', begin: '开始设置 MFA', beginAgain: '重新设置', verify: '验证并启用', verifying: '正在验证…', secret: '手动录入密钥', algorithm: '算法', period: '周期',
    recovery: '恢复码', issueRecovery: '签发新的恢复码', issuing: '正在签发…', recoveryHint: '恢复码只显示这一次。请复制并保存在安全位置；签发新一组会使旧恢复码失效。', copyRecovery: '复制恢复码', copiedRecovery: '已复制恢复码',
    managementProof: '输入当前 6 位验证码或一个未使用的恢复码', elevationTitle: '验证管理员身份', elevationDescription: '输入身份验证器中的 6 位验证码，或使用一个未使用的恢复码完成本次登录的 MFA 验证。', elevationCode: '验证码或恢复码', elevate: '验证并继续', elevating: '正在验证…', elevationRequired: '管理员操作前需要完成 MFA 验证。', elevationFailed: '验证失败。请检查验证码或恢复码后重试。', elevationUnavailable: 'MFA 验证暂时不可用，请稍后重试。', revokeFactor: '撤销 MFA 并退出所有会话', revokeConfirm: '再次点击确认撤销', revoked: 'MFA 已撤销，正在退出登录。',
    statusError: 'MFA 状态暂时无法读取。', invalidCode: '验证码无效或已使用，请检查身份验证器后重试。', genericMfaError: 'MFA 操作未完成，请稍后重试。',
    loading: '正在验证账户身份…', error: '暂时无法读取账户信息，请刷新页面重试。', retry: '重新加载', backToStudio: '返回工作室', signOut: '安全登出', signingOut: '正在登出…',
    roleUser: '用户', roleAdmin: '管理员',
  } : {
    eyebrow: 'ACCOUNT / OVERVIEW', title: 'Account center', subtitle: 'Review the signed-in identity and account feature status.',
    identity: 'Account identity', email: 'Email address', id: 'User ID', role: 'Account role', verified: 'Email verification',
    verifiedYes: 'Verified', created: 'Account created', copy: 'Copy ID', copied: 'Copied',
    quota: 'Credits & billing', available: 'Available', reserved: 'Reserved', total: 'Total', unit: 'credit', loadingCredits: 'Loading live credit data…', creditsError: 'Credit and billing data is temporarily unavailable.', retryCredits: 'Reload credits', emptyLedger: 'No ledger entries yet', more: 'Load more', loadingMore: 'Loading…', moreError: 'Loading more failed; the list is unchanged. Try again.', refresh: 'Refresh ledger', filter: 'Ledger type', all: 'All', freezeHint: 'Reserved means credits are occupied; settlement is the actual deduction. Release is not a new grant.', task: 'Task', event: { reserve: 'Reserved', settle: 'Settled', release: 'Released', grant: 'Granted' },
    usage: 'Usage history', usageHint: 'Task usage and credit events appear in the ledger above.',
    security: 'ADMIN SECURITY', mfaTitle: 'Multi-factor authentication', mfaEnabled: 'Enabled', mfaDisabled: 'Not enabled', mfaPending: 'Verification pending', mfaRevoked: 'Revoked',
    mfaDescription: 'Protect administrator actions with an authenticator app. Secrets and recovery codes are shown only during their respective flows.', begin: 'Set up MFA', beginAgain: 'Set up again', verify: 'Verify and enable', verifying: 'Verifying…', secret: 'Manual setup key', algorithm: 'Algorithm', period: 'Period',
    recovery: 'Recovery codes', issueRecovery: 'Issue new recovery codes', issuing: 'Issuing…', recoveryHint: 'Recovery codes are shown once. Store them securely; issuing a new set invalidates the previous set.', copyRecovery: 'Copy recovery codes', copiedRecovery: 'Recovery codes copied',
    managementProof: 'Enter a current 6-digit code or one unused recovery code', elevationTitle: 'Verify administrator identity', elevationDescription: 'Enter a current 6-digit authenticator code or one unused recovery code to complete MFA verification for this sign-in.', elevationCode: 'Authenticator or recovery code', elevate: 'Verify and continue', elevating: 'Verifying…', elevationRequired: 'Administrator actions require MFA verification.', elevationFailed: 'Verification failed. Check the code and try again.', elevationUnavailable: 'MFA verification is temporarily unavailable. Try again later.', revokeFactor: 'Revoke MFA and sign out all sessions', revokeConfirm: 'Click again to confirm revocation', revoked: 'MFA was revoked. Signing out.',
    statusError: 'MFA status is temporarily unavailable.', invalidCode: 'The code is invalid or already used. Check your authenticator and try again.', genericMfaError: 'The MFA operation could not be completed. Try again later.',
    loading: 'Verifying account identity…', error: 'Account information is temporarily unavailable. Refresh and try again.', retry: 'Reload', backToStudio: 'Back to studio', signOut: 'Sign out securely', signingOut: 'Signing out…',
    roleUser: 'User', roleAdmin: 'Administrator',
  };

  async function loadCredits({ append = false, cursor = null, kind = creditKind } = {}) {
    const request = creditsRequestRef.current;
    if (!append) {
      request.sequence += 1;
      request.controller?.abort();
      request.controller = new AbortController();
      setCreditsStatus('loading');
      setCreditsLoadingMore(false);
      setCreditsMoreError(false);
    } else {
      setCreditsLoadingMore(true);
      setCreditsMoreError(false);
    }
    const sequence = request.sequence;
    const query = new URLSearchParams({ limit: '20' });
    if (kind) query.set('kind', kind);
    if (cursor) query.set('cursor', cursor);
    try {
      const response = await fetch(`/api/account/credits?${query}`, { cache: 'no-store', credentials: 'same-origin', signal: request.controller?.signal });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.credits) throw new Error('CREDIT_UNAVAILABLE');
      if (sequence !== request.sequence) return;
      setCredits((current) => {
        if (!append || !current) return result.credits;
        const ids = new Set((current.events || []).map((event) => event.id));
        return { ...result.credits, events: [...(current.events || []), ...(result.credits.events || []).filter((event) => !ids.has(event.id))] };
      });
      setCreditsStatus('ready');
    } catch (error) {
      if (error.name === 'AbortError' || sequence !== request.sequence) return;
      if (append) setCreditsMoreError(true);
      else setCreditsStatus('error');
    } finally {
      if (sequence === request.sequence) setCreditsLoadingMore(false);
    }
  }

  async function loadMfaStatus() {
    try {
      const result = await mfaRequest('status');
      setMfaStatus(result);
    } catch {
      setMfaStatus({ error: true });
    }
  }

  useEffect(() => {
    let active = true;
    fetch('/api/auth/me', { cache: 'no-store', credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) throw new Error('AUTH_UNAVAILABLE');
        const result = await response.json();
        if (!active) return;
        if (!result.user) {
          const nextPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
          window.location.replace(`/login?next=${encodeURIComponent(nextPath)}`);
          return;
        }
        setUser(result.user);
        setStatus('ready');
        loadCredits();
        if (result.user.role === 'admin') loadMfaStatus();
      })
      .catch(() => { if (active) setStatus('error'); });
    return () => {
      active = false;
      creditsRequestRef.current.controller?.abort();
    };
  }, []);

  async function copyUserId() {
    try {
      await navigator.clipboard.writeText(user.id);
      setCopied(true);
      setMessage(isZh ? '用户 ID 已复制。' : 'User ID copied.');
    } catch {
      setCopied(false);
      setMessage(isZh ? '复制失败，请手动选择用户 ID。' : 'Copy failed. Select the user ID manually.');
    }
  }

  async function copyRecoveryCodes() {
    try {
      await navigator.clipboard.writeText(recoveryCodes.join('\n'));
      setMessage(text.copiedRecovery);
    } catch {
      setMessage(isZh ? '复制失败，请手动选择恢复码。' : 'Copy failed. Select the recovery codes manually.');
    }
  }

  async function startEnrollment() {
    setMfaLoading(true);
    setMessage('');
    setRecoveryCodes(null);
    try {
      setEnrollment(await mfaRequest('enrollment/begin'));
      setMfaStatus((current) => ({ ...(current || {}), enabled: false, enrollmentPending: true, revoked: false }));
    } catch { setMessage(text.genericMfaError); }
    finally { setMfaLoading(false); }
  }

  async function verifyEnrollment(event) {
    event.preventDefault();
    if (!/^\d{6}$/.test(verificationCode)) {
      setMessage(text.invalidCode);
      return;
    }
    setMfaLoading(true);
    setMessage('');
    try {
      await mfaRequest('enrollment/verify', { code: verificationCode });
      setEnrollment(null);
      setVerificationCode('');
      await loadMfaStatus();
      setMessage(isZh ? 'MFA 已启用。' : 'MFA is enabled.');
    } catch (error) {
      setMessage(error.message === 'INVALID_MFA_CODE' ? text.invalidCode : text.genericMfaError);
    } finally { setMfaLoading(false); }
  }

  async function refreshUser() {
    const response = await fetch('/api/auth/me', { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) throw new Error('AUTH_UNAVAILABLE');
    const result = await response.json();
    if (!result.user) throw new Error('AUTH_REQUIRED');
    setUser(result.user);
    return result.user;
  }

  async function elevateSession(event) {
    event.preventDefault();
    const code = elevationCode.trim();
    if (!code) {
      setMessage(text.elevationFailed);
      return;
    }
    setMfaLoading(true);
    setMessage('');
    try {
      const action = /^\d{6}$/.test(code) ? 'session/elevate' : 'recovery/consume';
      await mfaRequest(action, { code });
      const refreshedUser = await refreshUser();
      setElevationCode('');
      if (refreshedUser.role !== 'admin' || refreshedUser.authLevel !== 'mfa') {
        throw new Error('MFA_ELEVATION_NOT_CONFIRMED');
      }
      const requested = new URLSearchParams(window.location.search).get('next');
      if (requested && requested.startsWith('/') && !requested.startsWith('//') && !requested.includes('\\\\')) {
        try {
          const target = new URL(requested, window.location.origin);
          if (target.origin === window.location.origin && !['/login', '/register', '/reset-password', '/account', '/zh/account'].includes(target.pathname)) {
            window.location.replace(`${target.pathname}${target.search}${target.hash}`);
            return;
          }
        } catch {}
      }
      setMessage(isZh ? '管理员 MFA 验证已完成。' : 'Administrator MFA verification is complete.');
    } catch (error) {
      setMessage(error.message === 'INVALID_MFA_PROOF' || error.message === 'INVALID_MFA_CODE'
        ? text.elevationFailed : text.elevationUnavailable);
    } finally { setMfaLoading(false); }
  }

  async function issueRecoveryCodes() {
    if (!managementCode) {
      setMessage(text.invalidCode);
      return;
    }
    setMfaLoading(true);
    setMessage('');
    try {
      const result = await mfaRequest('recovery/issue', { code: managementCode });
      setManagementCode('');
      setRecoveryCodes(Array.isArray(result.codes) ? result.codes : []);
      await loadMfaStatus();
    } catch (error) { setMessage(error.message === 'INVALID_MFA_PROOF' ? text.invalidCode : text.genericMfaError); }
    finally { setMfaLoading(false); }
  }

  async function revokeMfa() {
    if (!confirmRevoke) {
      setConfirmRevoke(true);
      return;
    }
    if (!managementCode) {
      setMessage(text.invalidCode);
      return;
    }
    setMfaLoading(true);
    setMessage('');
    try {
      await mfaRequest('factor/revoke', { code: managementCode });
      setManagementCode('');
      setRecoveryCodes(null);
      setMessage(text.revoked);
      window.setTimeout(() => window.location.replace('/login'), 700);
    } catch (error) {
      setConfirmRevoke(false);
      setMessage(error.message === 'INVALID_MFA_PROOF' ? text.invalidCode : text.genericMfaError);
    } finally { setMfaLoading(false); }
  }

  async function logout() {
    setLoggingOut(true);
    setMessage('');
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
      if (response.status !== 204) throw new Error('LOGOUT_UNAVAILABLE');
      window.location.replace('/login');
    } catch {
      setMessage(isZh ? '登出未完成，请重试。' : 'Sign out failed. Please try again.');
      setLoggingOut(false);
    }
  }

  if (status === 'loading') return <main className="min-h-screen bg-[#030303] px-5 py-16 text-white"><p role="status" className="mx-auto max-w-4xl text-sm text-white/55">{text.loading}</p></main>;
  if (status === 'error') return <main className="min-h-screen bg-[#030303] px-5 py-16 text-white"><section className="mx-auto max-w-4xl rounded-xl border border-rose-300/15 bg-[#0a0a0b] p-6" role="alert"><h1 className="text-lg font-semibold">{text.error}</h1><button type="button" onClick={() => window.location.reload()} className="mt-4 rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80 hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300">{text.retry}</button></section></main>;

  const mfaLabel = mfaStatus?.error ? text.statusError : mfaStatus?.enabled ? text.mfaEnabled : mfaStatus?.revoked ? text.mfaRevoked : mfaStatus?.enrollmentPending ? text.mfaPending : text.mfaDisabled;

  return (
    <main className="min-h-screen bg-[#030303] px-4 py-8 text-white sm:px-8 sm:py-12">
      <div className="mx-auto max-w-5xl">
        <header className="mb-8 flex flex-wrap items-end justify-between gap-4 border-b border-white/[0.07] pb-6">
          <div><p className="text-[10px] font-semibold tracking-[0.22em] text-[#22d3ee]/75">{text.eyebrow}</p><h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">{text.title}</h1><p className="mt-2 text-sm text-white/45">{text.subtitle}</p></div>
          <div className="flex flex-wrap items-center gap-3"><a href={isZh ? '/zh/studio' : '/studio'} className="rounded-md border border-white/10 px-3.5 py-2 text-sm font-medium text-white/65 transition hover:bg-white/[0.06] hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300">{text.backToStudio}</a><button type="button" onClick={logout} disabled={loggingOut} className="rounded-md border border-white/10 bg-white/[0.04] px-3.5 py-2 text-sm font-medium text-white/75 transition hover:bg-white/[0.08] hover:text-white disabled:cursor-wait disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300">{loggingOut ? text.signingOut : text.signOut}</button></div>
        </header>

        {message && <p role="status" className="mb-5 rounded-lg border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-white/70">{message}</p>}

        <section aria-labelledby="account-identity-title" className="rounded-xl border border-white/[0.08] bg-[#0a0a0b] p-5 sm:p-7">
          <div className="mb-6 flex items-center gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-lg border border-cyan-300/20 bg-cyan-300/[0.08] text-sm font-semibold text-cyan-100" aria-hidden="true">{user.email?.[0]?.toUpperCase() || 'U'}</span><div><h2 id="account-identity-title" className="text-base font-semibold">{text.identity}</h2><p className="mt-0.5 text-xs text-white/40">{user.email}</p></div></div>
          <dl className="grid gap-4 sm:grid-cols-2"><div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-4"><dt className="text-xs text-white/40">{text.email}</dt><dd className="mt-2 break-all text-sm text-white/85">{user.email}</dd></div><div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-4"><dt className="text-xs text-white/40">{text.id}</dt><dd className="mt-2 flex flex-wrap items-center gap-2"><code className="break-all text-xs text-white/70">{user.id}</code><button type="button" onClick={copyUserId} className="shrink-0 rounded border border-white/10 px-2 py-1 text-[11px] text-white/60 hover:bg-white/[0.06] focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300">{copied ? text.copied : text.copy}</button></dd></div><div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-4"><dt className="text-xs text-white/40">{text.role}</dt><dd className="mt-2 text-sm text-white/85">{user.role === 'admin' ? text.roleAdmin : text.roleUser}</dd></div><div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-4"><dt className="text-xs text-white/40">{text.verified}</dt><dd className="mt-2 inline-flex items-center gap-2 text-sm text-emerald-200"><span className="h-1.5 w-1.5 rounded-full bg-emerald-300" />{user.emailVerified ? text.verifiedYes : '—'}</dd></div>{user.createdAt && <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-4 sm:col-span-2"><dt className="text-xs text-white/40">{text.created}</dt><dd className="mt-2 text-sm text-white/75">{formatDate(user.createdAt, locale)}</dd></div>}</dl>
        </section>

        {user.role === 'admin' && <section aria-labelledby="mfa-title" className="mt-5 rounded-xl border border-cyan-300/15 bg-[#0a0a0b] p-5 sm:p-7"><div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-[10px] font-semibold tracking-[0.18em] text-cyan-200/60">{text.security}</p><h2 id="mfa-title" className="mt-2 text-base font-semibold">{text.mfaTitle}</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-white/45">{text.mfaDescription}</p></div><span className={`rounded-full border px-3 py-1.5 text-xs ${mfaStatus?.enabled ? 'border-emerald-200/20 bg-emerald-200/[0.06] text-emerald-100' : 'border-amber-200/15 bg-amber-200/[0.06] text-amber-100/80'}`}>{mfaLabel}</span></div>
          {!mfaStatus?.enabled && <div className="mt-6"><button type="button" onClick={startEnrollment} disabled={mfaLoading} className="rounded-md border border-cyan-200/20 bg-cyan-200/[0.08] px-3.5 py-2 text-sm font-medium text-cyan-100 hover:bg-cyan-200/[0.14] disabled:cursor-wait disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300">{mfaStatus?.enrollmentPending ? text.beginAgain : text.begin}</button>{enrollment && <div className="mt-4 rounded-lg border border-white/[0.08] bg-white/[0.025] p-4"><p className="text-xs text-white/50">{text.secret}</p><code className="mt-2 block break-all rounded bg-black/30 p-3 text-sm tracking-[0.16em] text-cyan-100">{enrollment.secret}</code><dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-xs text-white/45"><div><dt className="inline">{text.algorithm}: </dt><dd className="inline text-white/75">{enrollment.algorithm}</dd></div><div><dt className="inline">{text.period}: </dt><dd className="inline text-white/75">{enrollment.period}s</dd></div></dl><form onSubmit={verifyEnrollment} className="mt-4 flex flex-wrap items-end gap-3"><label className="block"><span className="mb-1.5 block text-xs text-white/50">{text.verify}</span><input value={verificationCode} onChange={(event) => setVerificationCode(event.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]{6}" className="w-36 rounded-md border border-white/10 bg-black/30 px-3 py-2 text-center text-lg tracking-[0.35em] text-white outline-none focus:border-cyan-300/60" aria-label={text.verify} /></label><button type="submit" disabled={mfaLoading || verificationCode.length !== 6} className="rounded-md border border-white/10 bg-white/[0.06] px-3.5 py-2 text-sm text-white/80 hover:bg-white/[0.1] disabled:cursor-wait disabled:opacity-50">{mfaLoading ? text.verifying : text.verify}</button></form></div>}</div>}
          {mfaStatus?.enabled && user.authLevel !== 'mfa' && <div className="mt-6 rounded-lg border border-amber-200/15 bg-amber-200/[0.04] p-4"><h3 className="text-sm font-semibold text-amber-100">{text.elevationTitle}</h3><p className="mt-2 max-w-2xl text-sm leading-6 text-white/50">{text.elevationDescription}</p><form onSubmit={elevateSession} className="mt-4 flex flex-wrap items-end gap-3"><label className="block w-full max-w-sm"><span className="mb-1.5 block text-xs text-white/55">{text.elevationCode}</span><input value={elevationCode} onChange={(event) => setElevationCode(event.target.value.toUpperCase().replace(/[^A-Z0-9 -]/g, '').slice(0, 32))} autoComplete="one-time-code" className="w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 font-mono text-sm text-white outline-none focus:border-cyan-300/60" /></label><button type="submit" disabled={mfaLoading || !elevationCode.trim()} className="rounded-md border border-cyan-200/20 bg-cyan-200/[0.08] px-3.5 py-2 text-sm text-cyan-100 hover:bg-cyan-200/[0.14] disabled:cursor-wait disabled:opacity-50">{mfaLoading ? text.elevating : text.elevate}</button></form></div>}
          {mfaStatus?.enabled && user.authLevel === 'mfa' && <div className="mt-6 rounded-lg border border-white/[0.08] bg-white/[0.025] p-4"><label className="block max-w-xl"><span className="mb-1.5 block text-xs text-white/55">{text.managementProof}</span><input value={managementCode} onChange={(event) => setManagementCode(event.target.value.toUpperCase().replace(/[^A-Z0-9 -]/g, '').slice(0, 32))} autoComplete="one-time-code" className="w-full rounded-md border border-white/10 bg-black/30 px-3 py-2 font-mono text-sm text-white outline-none focus:border-cyan-300/60" /></label><div className="mt-4 flex flex-wrap gap-2"><button type="button" onClick={issueRecoveryCodes} disabled={mfaLoading || !managementCode} className="rounded-md border border-white/10 px-3 py-2 text-xs text-white/75 hover:bg-white/[0.06] disabled:cursor-wait disabled:opacity-50">{mfaLoading ? text.issuing : text.issueRecovery}</button><button type="button" onClick={revokeMfa} disabled={mfaLoading || !managementCode} className="rounded-md border border-rose-300/20 px-3 py-2 text-xs text-rose-100/80 hover:bg-rose-300/[0.08] disabled:cursor-wait disabled:opacity-50">{confirmRevoke ? text.revokeConfirm : text.revokeFactor}</button></div>{recoveryCodes && <div className="mt-4"><pre className="grid gap-1 rounded-md bg-black/35 p-4 font-mono text-sm tracking-[0.12em] text-amber-100">{recoveryCodes.join('\n')}</pre><button type="button" onClick={copyRecoveryCodes} className="mt-3 rounded border border-white/10 px-3 py-2 text-xs text-white/70 hover:bg-white/[0.06]">{text.copyRecovery}</button></div>}</div>}
        </section>}

        <div className="mt-5 grid gap-5 md:grid-cols-2"><section aria-labelledby="account-quota-title" className="rounded-xl border border-white/[0.08] bg-[#0a0a0b] p-5 sm:p-6 md:col-span-2"><p className="text-[10px] font-semibold tracking-[0.18em] text-white/35">01 / ACCOUNT</p><h2 id="account-quota-title" className="mt-3 text-base font-semibold">{text.quota}</h2>{creditsStatus === 'loading' && <p role="status" className="mt-4 text-sm text-white/45">{text.loadingCredits}</p>}{creditsStatus === 'error' && <div className="mt-4 flex flex-wrap items-center gap-3"><p role="alert" className="text-sm text-amber-100/80">{text.creditsError}</p><button type="button" onClick={loadCredits} className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-white/70 hover:bg-white/[0.06] focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300">{text.retryCredits}</button></div>}{creditsStatus === 'ready' && credits && <><dl className="mt-5 grid gap-3 sm:grid-cols-3"><div className="rounded-lg border border-cyan-200/15 bg-cyan-200/[0.05] p-4"><dt className="text-xs text-white/45">{text.available}</dt><dd className="mt-2 text-2xl font-semibold text-cyan-100">{formatCredits(credits.availableTenths)} <span className="text-xs font-normal text-white/45">{text.unit}</span></dd></div><div className="rounded-lg border border-amber-200/15 bg-amber-200/[0.05] p-4"><dt className="text-xs text-white/45">{text.reserved}</dt><dd className="mt-2 text-2xl font-semibold text-amber-100">{formatCredits(credits.reservedTenths)} <span className="text-xs font-normal text-white/45">{text.unit}</span></dd></div><div className="rounded-lg border border-white/[0.08] bg-white/[0.025] p-4"><dt className="text-xs text-white/45">{text.total}</dt><dd className="mt-2 text-2xl font-semibold text-white/90">{formatCredits(credits.totalTenths)} <span className="text-xs font-normal text-white/45">{text.unit}</span></dd></div></dl><div className="mt-6 border-t border-white/[0.07] pt-5"><div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-sm font-semibold">{text.usage}</h3><div className="flex items-center gap-2"><label htmlFor="credit-kind" className="text-xs text-white/45">{text.filter}</label><select id="credit-kind" value={creditKind} onChange={(event) => { const kind = event.target.value; setCreditKind(kind); loadCredits({ kind }); }} className="rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-white/75"><option value="">{text.all}</option><option value="grant">{text.event.grant}</option><option value="reserve">{text.event.reserve}</option><option value="settle">{text.event.settle}</option><option value="release">{text.event.release}</option></select><button type="button" onClick={() => loadCredits()} disabled={creditsLoadingMore} className="rounded-md border border-white/10 px-2 py-1.5 text-xs text-white/65 hover:bg-white/[0.06] disabled:opacity-50">{text.refresh}</button></div></div><p className="mt-2 text-xs leading-5 text-white/40">{text.freezeHint}</p>{credits.events.length === 0 ? <p className="mt-3 text-sm text-white/40">{text.emptyLedger}</p> : <ul className="mt-3 divide-y divide-white/[0.06]">{credits.events.map((event) => <li key={event.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0"><div><p className={`text-sm ${eventTone[event.kind] || 'text-white/80'}`}>{text.event[event.kind] || event.kind}</p><p className="mt-1 text-xs text-white/35">{formatDate(event.createdAt, locale)}{event.taskId ? ` · ${event.taskId}` : ''}{event.task ? ` · ${text.task}: ${event.task.taskType} (${event.task.status})` : ''}</p></div><span className="font-mono text-sm text-white/80">{event.kind === 'grant' ? '+' : event.kind === 'settle' ? '-' : ''}{formatCredits(event.amountTenths)} {text.unit}</span></li>)}</ul>}{creditsMoreError && <div className="mt-3 flex flex-wrap items-center gap-3"><p role="alert" className="text-xs text-amber-100/80">{text.moreError}</p><button type="button" onClick={() => loadCredits({ append: true, cursor: credits.nextCursor })} disabled={creditsLoadingMore} className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-white/70 hover:bg-white/[0.06] disabled:opacity-50">{text.more}</button></div>}{credits.nextCursor && !creditsMoreError && <button type="button" onClick={() => loadCredits({ append: true, cursor: credits.nextCursor })} disabled={creditsLoadingMore} className="mt-4 w-full rounded-md border border-white/10 px-3 py-2 text-xs text-white/70 hover:bg-white/[0.06] disabled:opacity-50">{creditsLoadingMore ? text.loadingMore : text.more}</button>}</div></>}</section><section aria-labelledby="account-usage-title" className="rounded-xl border border-white/[0.08] bg-[#0a0a0b] p-5 sm:p-6 md:col-span-2"><p className="text-[10px] font-semibold tracking-[0.18em] text-white/35">02 / ACTIVITY</p><h2 id="account-usage-title" className="mt-3 text-base font-semibold">{text.usage}</h2><p className="mt-4 text-sm leading-6 text-white/45">{text.usageHint}</p></section></div>
      </div>
    </main>
  );
}
