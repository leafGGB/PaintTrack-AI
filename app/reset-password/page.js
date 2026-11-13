'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import styles from '../register/auth.module.css';

export default function ResetPasswordPage() {
    const [token, setToken] = useState('');
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    useEffect(() => {
        const value = window.location.hash.slice(1);
        window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
        setToken(value);
    }, []);
    async function requestReset(event) {
        event.preventDefault();
        const form = event.currentTarget;
        const email = new FormData(form).get('email');
        setBusy(true); setMessage('');
        try {
            const response = await fetch('/api/auth/password-reset', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email }) });
            setMessage(response.status === 202 ? '如果该邮箱对应已验证账户，请查看本机测试收件器中的重置链接。' : response.status === 429 ? '请求过于频繁，请一分钟后再试。' : '暂时无法处理请求，请稍后重试。');
        } catch { setMessage('连接失败，请稍后重试。'); }
        finally { form.elements.email.value = ''; setBusy(false); }
    }
    async function consumeReset(event) {
        event.preventDefault();
        const form = event.currentTarget;
        const data = new FormData(form);
        const password = data.get('password');
        if (password !== data.get('confirm')) { setMessage('两次输入的密码不一致。'); return; }
        setBusy(true); setMessage('');
        try {
            const response = await fetch('/api/auth/password-reset/consume', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token, password }) });
            setMessage(response.status === 202 ? '密码已更新，所有现有会话已撤销。请使用新密码重新登录。' : response.status === 429 ? '请求过于频繁，请一分钟后再试。' : '重置链接无效或已过期，请重新申请。');
            if (response.status === 202) { setToken(''); form.reset(); }
        } catch { setMessage('连接失败，请稍后重试。'); }
        finally { setBusy(false); }
    }
    return <main className={styles.shell}><section className={styles.card} aria-labelledby="reset-title">
        <div className={styles.brand}>PAINTTRACK / ACCOUNT</div><h1 id="reset-title">重置密码</h1>
        {token ? <form className={styles.form} onSubmit={consumeReset}>
            <label htmlFor="password">新密码</label><input className={styles.input} id="password" name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} />
            <label htmlFor="confirm">再次输入新密码</label><input className={styles.input} id="confirm" name="confirm" type="password" autoComplete="new-password" required minLength={12} maxLength={128} />
            <small>至少 12 个字符，最多 128 字节。重置成功后所有现有会话都会失效。</small>
            <button className={styles.button} disabled={busy}>{busy ? '正在更新…' : '更新密码'}</button>
        </form> : <form className={styles.form} onSubmit={requestReset}>
            <p className={styles.muted}>输入账户邮箱。无论账户是否存在，页面都会显示相同的受理提示。</p>
            <label htmlFor="email">邮箱地址</label><input className={styles.input} id="email" name="email" type="email" autoComplete="email" required maxLength={254} />
            <button className={styles.button} disabled={busy}>{busy ? '正在提交…' : '发送重置请求'}</button>
        </form>}
        {message && <p className={styles.notice} role="status">{message}</p>}
        <p className={styles.links}><Link href="/login">返回登录</Link> · <Link href="/dev/mailbox">本机测试收件器</Link></p>
        <small>当前仅支持本机开发测试，不发送真实邮件。</small>
    </section></main>;
}
