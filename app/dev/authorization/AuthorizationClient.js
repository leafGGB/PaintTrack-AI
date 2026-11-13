'use client';
import { useState } from 'react';
import styles from '../../register/auth.module.css';
export default function AuthorizationClient() {
    const [result, setResult] = useState('点击按钮读取服务端结果。');
    const [busy, setBusy] = useState(false);
    async function check(path) {
        setBusy(true);
        try {
            const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
            const body = await response.json();
            setResult(`HTTP ${response.status}\n${JSON.stringify(body, null, 2)}`);
        } catch { setResult('暂时无法连接服务。'); }
        finally { setBusy(false); }
    }
    return <div>
        <p><button className={styles.button} disabled={busy} onClick={() => check('/api/auth/me')}>刷新当前身份</button></p>
        <p><button className={styles.button} disabled={busy} onClick={() => check('/api/admin/summary')}>检查管理员只读权限</button></p>
        <pre aria-live="polite" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{result}</pre>
    </div>;
}
