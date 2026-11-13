import { createTasksHandler, createRoutedTaskHandler } from '../../../lib/server/tasks/taskHttp';
import { createLocalMockCatalog } from '../../../lib/server/tasks/localMockCatalog';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = createTasksHandler();
export async function POST(request) {
    if (process.env.PAINTTRACK_LOCAL_MOCK_ROUTING === '1') {
        // 生产或非隔离启动即拒绝，不回退旧提交路径。
        if (process.env.NODE_ENV !== 'development' || process.env.PAINTTRACK_LOCAL_INTERNAL_GUARD !== '1') {
            return Response.json({ error: { code: 'LOCAL_MOCK_ROUTING_FORBIDDEN' } }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
        }
        return createRoutedTaskHandler({ catalog: createLocalMockCatalog(process.env) })(request);
    }
    return createTasksHandler()(request);
}
