import { createTaskDetailHandler } from '../../../../lib/server/tasks/taskHttp';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = createTaskDetailHandler();
