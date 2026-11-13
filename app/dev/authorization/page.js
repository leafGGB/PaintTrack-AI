import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { allowed } from '../../../lib/server/developmentMailbox';
import AuthorizationClient from './AuthorizationClient';
import styles from '../../register/auth.module.css';
export const dynamic = 'force-dynamic';
export default async function AuthorizationPage() {
    const email = process.env.PAINTTRACK_DEV_ADMIN_FIXTURE_EMAIL;
    if (!allowed({ headers: await headers() }) || !/^admin-[a-f0-9]{12}@example\.test$/.test(email || '')) notFound();
    return <main className={styles.shell}><section className={styles.card}>
        <div className={styles.brand}>PAINTTRACK / DEVELOPMENT ONLY</div>
        <h1>阶段 3.3 本机权限验收</h1>
        <p>本页面只适用于本次新建的隔离库。旧 3211 / 3212 账户不能用于此处。</p>
        <ol><li>先在本端口注册任意普通虚构邮箱，自己设置至少12字符密码；去测试收件器验证后登录。</li>
            <li>点击下方管理员只读检查，普通用户应得到 403。</li>
            <li>登出后，以 <strong>{email}</strong> 注册，密码由你自行设置，再验证邮箱并登录。</li>
            <li>启动器会在邮箱验证后为这一合成账户准备管理员角色；刷新身份后应看到 admin，管理员只读检查为 200。若仍是 user，稍后刷新。</li></ol>
        <p>这是 development-only fixture，不是生产管理员初始化。没有升权接口；管理员也不能读取他人资产。资源归属的双用户及数据库故障负例由自动化真实 HTTP 验收覆盖。</p>
        <AuthorizationClient />
        <p className={styles.links}><Link href="/register">注册</Link> · <Link href="/dev/mailbox">测试收件器</Link> · <Link href="/login">登录 / 登出</Link></p>
    </section></main>;
}
