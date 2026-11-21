import { createChargedTaskHandler, createTasksHandler, createRoutedTaskHandler } from '../../../lib/server/tasks/taskHttp';
import { createLocalMockCatalog } from '../../../lib/server/tasks/localMockCatalog';
import { catalog as controlledCatalog, controlledImageOwner, hasControlledImageAccess, assertControlledImageSubmission } from '../../../lib/server/tasks/controlledImageDevelopment';
import { TaskApiError } from '../../../lib/server/tasks/taskSubmission';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = createTasksHandler();
export async function POST(request) {
    if (process.env.PAINTTRACK_LOCAL_CONTROLLED_IMAGE !== undefined) {
        let ownerId;
        try { ownerId = controlledImageOwner(process.env, process.env.DATABASE_URL, 'runtime'); }
        catch { return Response.json({ error: { code: 'CONTROLLED_IMAGE_CONFIG_INVALID' } }, { status: 503, headers: { 'Cache-Control': 'no-store' } }); }
        return createRoutedTaskHandler({ catalog: controlledCatalog, authorizeSubmission(context) {
            assertControlledImageSubmission(context, ownerId);
            if (!hasControlledImageAccess(request, process.env)) throw new TaskApiError('CONTROLLED_IMAGE_HOST_UNAVAILABLE', 503);
        } })(request);
    }
    // 收费开关只替换提交实现；当前唯一可信目录是本地合成目录，正式目录接入后再解除这一组合。
    const charged = process.env.PAINTTRACK_CHARGED_SUBMISSION === '1';
    if (process.env.PAINTTRACK_LOCAL_MOCK_ROUTING === '1') {
        // 生产或非隔离启动即拒绝，不回退旧提交路径。
        if (process.env.NODE_ENV !== 'development' || process.env.PAINTTRACK_LOCAL_INTERNAL_GUARD !== '1') {
            return Response.json({ error: { code: 'LOCAL_MOCK_ROUTING_FORBIDDEN' } }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
        }
        const catalog = createLocalMockCatalog(process.env);
        return (charged ? createChargedTaskHandler : createRoutedTaskHandler)({ catalog })(request);
    }
    // 开关打开却没有可信目录时必须显式失败：静默回退成免费提交等于绕过计费。
    if (charged) {
        return Response.json({ error: { code: 'CHARGED_SUBMISSION_UNAVAILABLE' } }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
    return createTasksHandler()(request);
}
