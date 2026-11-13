import { headers } from 'next/headers';
import Link from 'next/link';
import { createAuthorizationHandler } from '../../lib/server/authorizationHttp';
const blocked = createAuthorizationHandler('cloud.blocked');
export default async function CloudUnavailable() {
    const response = await blocked({ method: 'GET', headers: await headers() });
    const { error } = await response.json();
    return <main><h1>云端 Agent 暂未开放</h1>
        <p>{error.code === 'UNAUTHENTICATED' ? '请先登录。' : error.code === 'NOT_IMPLEMENTED'
            ? '平台额度与供应商门禁尚未完成，当前无法调用云端 Agent。' : '服务暂时不可用。'}</p>
        <p>状态：{response.status} / {error.code}</p><Link href="/login">登录 / 查看身份</Link></main>;
}
