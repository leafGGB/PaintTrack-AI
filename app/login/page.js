'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import styles from '../register/auth.module.css';

function getSafeNextPath() {
    const requested = new URLSearchParams(window.location.search).get('next');
    if (!requested || !requested.startsWith('/') || requested.startsWith('//') || requested.includes('\\')) return '/studio';
    try {
        const target = new URL(requested, window.location.origin);
        if (target.origin !== window.location.origin || ['/login', '/register', '/reset-password', '/account', '/zh/account'].includes(target.pathname)) return '/studio';
        return `${target.pathname}${target.search}${target.hash}`;
    } catch {
        return '/studio';
    }
}

function getPostLoginPath(user) {
    const nextPath = getSafeNextPath();
    if (user?.role !== 'admin' || user.authLevel === 'mfa') return nextPath;
    const accountPath = window.location.pathname.startsWith('/zh/') ? '/zh/account' : '/account';
    return `${accountPath}?next=${encodeURIComponent(nextPath)}`;
}

export default function LoginPage() {
    const [user, setUser] = useState(null);
    const [busy, setBusy] = useState(true);
    const [message, setMessage] = useState('');
    const [legacyLocal, setLegacyLocal] = useState(false);
    useEffect(() => {
        let active = true;
        setLegacyLocal(window.location.hostname === '127.0.0.1' && window.location.port === '3211');
        const nextPath = getSafeNextPath();
        fetch('/api/auth/me', { cache: 'no-store', credentials: 'same-origin' }).then(async (response) => {
            if (!response.ok) throw new Error();
            const result = await response.json();
            if (!active) return;
            setUser(result.user);
            if (result.user) window.location.replace(getPostLoginPath(result.user));
        }).catch(() => { if (active) setMessage('暂时无法读取登录状态，请刷新重试。'); })
            .finally(() => { if (active) setBusy(false); });
        return () => { active = false; };
    }, []);
    async function submit(event) {
        event.preventDefault();
        const form = event.currentTarget;
        const data = new FormData(form);
        setBusy(true); setMessage('');
        try {
            const response = await fetch('/api/auth/login', { method: 'POST', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: data.get('email'), password: data.get('password') }) });
            if (response.ok) {
                const authenticatedUser = (await response.json()).user;
                setUser(authenticatedUser);
                window.location.replace(getPostLoginPath(authenticatedUser));
                return;
            } else {
                const error = await response.json().catch(() => null);
                const code = error?.error?.code || error?.code;
                setMessage(response.status === 401 ? '邮箱或密码不正确，或邮箱尚未完成验证。请确认账户是在当前端口注册并验证的。'
                    : response.status === 429 ? '尝试过于频繁，请一分钟后重试。'
                        : response.status === 400 ? '请检查邮箱和密码格式。'
                            : response.status === 403 ? '当前访问来源与服务配置不一致，请从正确的本机地址打开。'
                                : code === 'KDF_BUSY' ? '密码校验繁忙，请稍后重试。'
                                    : legacyLocal ? '当前为旧版开发服务，请打开 http://127.0.0.1:3212/login，并在新入口注册验证账户。' : '登录服务暂时不可用，请稍后重试。');
            }
        } catch { setMessage('连接失败，请稍后重试。'); }
        finally { form.elements.password.value = ''; setBusy(false); }
    }
    async function logout() {
        setBusy(true); setMessage('');
        try {
            const response = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
            if (response.status === 204) { setUser(null); setMessage('已安全登出。'); }
            else setMessage('登出未完成，请重试。');
        } catch { setMessage('连接失败，登出未完成，请重试。'); }
        finally { setBusy(false); }
    }
    return <main className={styles.shell}><section className={styles.card} aria-labelledby="login-title">
        <div className={styles.brand}>PAINTTRACK / ACCOUNT</div><h1 id="login-title">登录 PaintTrack</h1>
        <p className={styles.muted}>使用已验证的邮箱登录。到期后需要重新登录。</p>
        {legacyLocal && <p className={styles.notice} role="alert">这是阶段 3.1 的旧开发服务，不能用于本轮登录验收。请打开 <a href="http://127.0.0.1:3212/login">3212 登录入口</a>，并在该入口重新注册和验证测试账户。</p>}
        {user ? <div><p role="status">当前已登录</p><p>账户 ID：{user.id}</p><p>角色：{user.role}</p>
            <button className={styles.button} disabled={busy} onClick={logout}>{busy ? '正在处理…' : '安全登出'}</button></div>
            : <form className={styles.form} onSubmit={submit}>
                <label htmlFor="email">邮箱地址</label><input className={styles.input} id="email" name="email" type="email" autoComplete="username" required maxLength={254} />
                <label htmlFor="password">密码</label><input className={styles.input} id="password" name="password" type="password" autoComplete="current-password" required minLength={12} maxLength={128} />
                <button className={styles.button} disabled={busy}>{busy ? '正在处理…' : '登录'}</button>
            </form>}
        {message && <p className={styles.notice} role="status">{message}</p>}
        <p className={styles.links}><Link href="/register">创建账户</Link> · <Link href="/reset-password">忘记密码？</Link> · <Link href="/dev/mailbox">本机测试收件器</Link></p>
    </section></main>;
}
