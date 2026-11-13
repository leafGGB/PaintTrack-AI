'use client';
import { useState } from 'react';
import Link from 'next/link';
import styles from '../../register/auth.module.css';
export default function MailboxPage() {
    const [messages, setMessages] = useState([]);
    const [notice, setNotice] = useState('点击刷新读取当前进程的测试邮件。');
    const [busy, setBusy] = useState(false);
    async function load(clear = false) {
        setBusy(true);
        try {
            const response = await fetch('/api/dev/mailbox', { method: clear ? 'DELETE' : 'GET', cache: 'no-store' });
            if (!response.ok) { setMessages([]); setNotice('收件器不可用：仅专用本机开发入口允许访问。'); return; }
            setMessages(clear ? [] : (await response.json()).messages);
            setNotice(clear ? '当前进程内的测试邮件已清空；数据库中的用户及令牌未删除。' : '已刷新。这里只展示本机合成测试数据，重启后邮件不保留。');
        } catch { setNotice('读取失败，请检查本机开发服务。'); }
        finally { setBusy(false); }
    }
    return <main className={styles.shell}><section className={styles.card}>
        <div className={styles.brand}>DEVELOPMENT ONLY</div><h1>本机测试收件器</h1>
        <p className={styles.muted}>非真实邮箱。邮件仅在当前开发进程内保存，最多 100 封，验证邮件 15 分钟、重置邮件 30 分钟过期。请勿输入个人资料。</p>
        <button className={styles.button} disabled={busy} onClick={() => load()}>刷新邮件</button>{' '}
        <button className={styles.button} disabled={busy} onClick={() => load(true)}>清空测试邮件</button>
        <p className={styles.notice} role="status">{notice}</p>
        {messages.map((message) => <article className={styles.message} key={message.path}>
            <strong>{message.email}</strong><p className={styles.muted}>PaintTrack {message.type === 'password-reset' ? '密码重置' : '邮箱验证'} · 有效至 {new Date(message.expiresAt).toLocaleTimeString('zh-CN')}</p>
            <a href={message.path} referrerPolicy="no-referrer">打开{message.type === 'password-reset' ? '重置' : '验证'}页面 →</a>
        </article>)}
        <p className={styles.links}><Link href="/register">返回注册</Link></p>
    </section></main>;
}
