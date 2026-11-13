'use client';
import { useState } from 'react';
import Link from 'next/link';
import styles from './auth.module.css';
export default function RegisterPage() {
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    async function submit(event) {
        event.preventDefault();
        const form = event.currentTarget;
        const data = new FormData(form);
        setBusy(true); setMessage('');
        try {
            const response = await fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: data.get('email'), password: data.get('password') }) });
            setMessage(response.status === 202 ? '请求已受理。如果此邮箱可以注册，请查看验证邮件。尚未登录。'
                : response.status === 429 ? '请求过于频繁，请一分钟后再试。'
                    : response.status === 503 ? '邮件通道未启用。请使用本机注册验收启动入口；当前未完成注册。' : '请求未通过，请检查邮箱和密码格式。');
            form.elements.password.value = '';
        } catch { setMessage('连接失败，请稍后重试。'); }
        finally { setBusy(false); }
    }
    return <main className={styles.shell}><section className={styles.card} aria-labelledby="register-title">
        <div className={styles.brand}>PAINTTRACK / ACCOUNT</div><h1 id="register-title">让灵感拥有归属</h1>
        <p className={styles.muted}>创建账户的第一步：验证你的邮箱。当前为本地开发验收，不会向外部发送邮件。</p>
        <form className={styles.form} onSubmit={submit}>
            <label htmlFor="email">邮箱地址</label><input className={styles.input} id="email" name="email" type="email" autoComplete="email" required maxLength={254} placeholder="you@example.com" />
            <label htmlFor="password">设置密码</label><input className={styles.input} id="password" name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} aria-describedby="password-help" />
            <small id="password-help">至少 12 个字符，最多 128 字节。不使用真实账户密码进行测试。</small>
            <button className={styles.button} disabled={busy}>{busy ? '正在提交…' : '注册并获取验证邮件'}</button>
        </form>
        {message && <p className={styles.notice} role="status">{message}</p>}
        <p className={styles.links}><Link href="/login">已有账户？登录</Link> · <Link href="/dev/mailbox">打开本机测试收件器 →</Link></p>
        <small>这里不会自动登录，也不授予任何业务权限。请只使用虚构邮箱和测试密码。</small>
    </section></main>;
}
