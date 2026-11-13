'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import styles from '../register/auth.module.css';
export default function VerifyEmailPage() {
    const [token, setToken] = useState('');
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    useEffect(() => {
        const value = window.location.hash.slice(1);
        window.history.replaceState(null, '', window.location.pathname);
        if (/^[A-Za-z0-9_-]{43}$/.test(value)) setToken(value);
        else setMessage('验证链接缺失或格式不正确，请从测试邮件打开。');
    }, []);
    async function verify() {
        setBusy(true);
        try {
            const response = await fetch('/api/auth/verify-email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
            setMessage(response.status === 202 ? '验证请求已受理。仅有效且未过期的链接会完成邮箱验证；此响应不代表登录成功。'
                : response.status === 429 ? '请求过于频繁，请一分钟后重试。' : '暂时无法验证，请稍后重试。');
            if (response.status === 202) setToken('');
        } catch { setMessage('连接失败，请稍后重试。'); }
        finally { setBusy(false); }
    }
    return <main className={styles.shell}><section className={styles.card}>
        <div className={styles.brand}>PAINTTRACK / VERIFY</div><h1>确认邮箱验证</h1>
        <p className={styles.muted}>只有点击下面的按钮才会提交验证。链接有效期 15 分钟，只可消费一次。</p>
        <button className={styles.button} disabled={!token || busy} onClick={verify}>{busy ? '正在提交…' : '确认验证邮箱'}</button>
        {message && <p className={styles.notice} role="status">{message}</p>}
        <p className={styles.links}><Link href="/login">验证后登录</Link> · <Link href="/register">返回注册</Link></p>
    </section></main>;
}
