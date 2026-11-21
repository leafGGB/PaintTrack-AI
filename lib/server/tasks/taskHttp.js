const { getDatabase } = require('../db');
const { authPolicy, checkOrigin } = require('../authPolicy');
const { requireUser, requireAdminMfa } = require('../authorization');
const { RegistrationError } = require('../registration');
const { createErrorResponse, emitAuditEvent, getRequestId, writeLog } = require('../observability');
const {
    MAX_BODY_BYTES, TaskApiError, parseIdempotencyKey, validateCreateTaskRequest,
} = require('./taskSubmission');
const { createTaskSubmissionService } = require('./taskService');
const { createChargedSubmissionService } = require('./chargedSubmission');
const { createModelRouteResolver, ModelRouteError } = require('./modelRouteResolver');
const { createTaskQueryService } = require('./taskQuery');
const { createTaskCancellationService } = require('./taskCancellation');

async function readJsonBody(request) {
    if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
        throw new TaskApiError('INVALID_CONTENT_TYPE', 415);
    }
    const declared = Number(request.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        throw new TaskApiError('BODY_TOO_LARGE', 413);
    }
    const reader = request.body?.getReader();
    if (!reader) throw new TaskApiError('INVALID_TASK_REQUEST', 400);
    let size = 0;
    const chunks = [];
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_BODY_BYTES) {
                await reader.cancel();
                throw new TaskApiError('BODY_TOO_LARGE', 413);
            }
            chunks.push(Buffer.from(value));
        }
    } catch (error) {
        if (error instanceof TaskApiError) throw error;
        throw new TaskApiError('INVALID_TASK_REQUEST', 400);
    } finally {
        reader.releaseLock();
    }
    try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    } catch {
        throw new TaskApiError('INVALID_TASK_REQUEST', 400);
    }
}

// Next.js 15 的 route params 是 Promise；测试里也可能是普通对象，两种都接受。
async function routeParam(context, name) {
    const params = context && context.params;
    const resolved = params && typeof params.then === 'function' ? await params : params;
    return resolved ? resolved[name] : undefined;
}

function requestHeaders(requestId) {
    return {
        'Cache-Control': 'no-store',
        Vary: 'Cookie',
        'Referrer-Policy': 'no-referrer',
        'x-request-id': requestId,
    };
}

function reject(error, {
    requestId, headers, sink, action, actorId, fallbackCode,
}) {
    const known = error instanceof TaskApiError || error instanceof RegistrationError;
    // 路由错误只公开固定白名单码，不透传目录后端异常。
    const routeCodes = new Set(['LOGICAL_MODEL_REQUIRED', 'MODEL_UNAVAILABLE', 'MODEL_OPERATION_UNSUPPORTED',
        'MODEL_ROUTE_UNAVAILABLE', 'MODEL_ROUTE_INVALID', 'MODEL_ROUTE_AMBIGUOUS', 'MODEL_ROUTE_UNSUPPORTED_OPERATION',
        'MODEL_PARAMETERS_UNSUPPORTED']);
    if (error instanceof ModelRouteError && routeCodes.has(error.code)) {
        error = new TaskApiError(error.code, error.status);
    }
    const publicKnown = known || error instanceof TaskApiError;
    const code = publicKnown ? error.code : fallbackCode;
    const status = publicKnown ? error.status : 503;
    emitAuditEvent({ action, actorId, outcome: 'rejected', requestId }, sink);
    writeLog(status >= 500 ? 'error' : 'warn', {
        service: 'tasks', event: 'request.rejected', errorCode: code, requestId,
    }, sink);
    const response = createErrorResponse({ code, requestId });
    return Response.json(response.body, {
        status,
        headers: {
            ...headers,
            ...response.headers,
            ...(status === 429 ? { 'Retry-After': '60' } : {}),
        },
    });
}

// 可信宿主传入目录能力；不从请求、环境或Web数据库构建内部配置读取能力。
// 目录只需提供无秘密的选路元数据，不能把秘密解析器交给HTTP处理器。
function createRoutedTaskHandler({ catalog, ...options } = {}) {
    if (options.serviceFactory || options.routeResolverFactory) throw new TypeError('Routed handler owns its submission service');
    const resolver = createModelRouteResolver({ catalog });
    return createTaskHandler({ ...options, routeResolverFactory: () => resolver });
}

// 收费入口与合成路由共用同一个可信目录，只是把提交实现换成「报价 + 冻结」的事务版本。
function createChargedTaskHandler({ catalog, ...options } = {}) {
    if (options.serviceFactory || options.routeResolverFactory) throw new TypeError('Charged handler owns its submission service');
    const resolver = createModelRouteResolver({ catalog });
    return createTaskHandler({
        ...options,
        routeResolverFactory: () => resolver,
        serviceFactory: ({ pool, routeResolver }) => createChargedSubmissionService({ pool, routeResolver }),
    });
}

function createTaskHandler({
    database = getDatabase, environment = process.env, sink = console, serviceFactory, routeResolverFactory, authorizeSubmission,
} = {}) {
    return async (request) => {
        const requestId = getRequestId(request.headers.get('x-request-id'));
        const headers = requestHeaders(requestId);
        let user;
        try {
            const mutation = !['GET', 'HEAD'].includes(request.method);
            checkOrigin(request, authPolicy(environment), mutation);
            if (request.method !== 'POST') throw new TaskApiError('METHOD_NOT_ALLOWED', 405);

            const idempotencyKey = parseIdempotencyKey(request.headers.get('idempotency-key'));
            const input = validateCreateTaskRequest(await readJsonBody(request));

            const db = typeof database === 'function' ? database() : database;
            user = await requireUser(request, db);
            if (user.role === 'admin') requireAdminMfa(user);
            if (authorizeSubmission) await authorizeSubmission({ user, input });

            const pool = db.$client;
            if (!pool) throw new Error('Task submission requires a PostgreSQL pool');
            const routeResolver = routeResolverFactory ? routeResolverFactory({ pool }) : null;
            const service = serviceFactory
                ? serviceFactory({ pool, routeResolver })
                : createTaskSubmissionService({ pool, routeResolver });

            const { task, replayed, credit } = await service.submit({
                ownerId: user.id,
                idempotencyKey,
                taskType: input.taskType,
                payload: input.payload,
            });

            emitAuditEvent({
                action: 'task.create',
                actorId: user.id,
                resourceType: 'generation_task',
                resourceId: task.id,
                outcome: 'accepted',
                requestId,
            }, sink);
            return Response.json(credit ? { task, credit } : { task }, {
                status: replayed ? 200 : 201,
                headers: { ...headers, 'Idempotency-Replayed': replayed ? 'true' : 'false' },
            });
        } catch (error) {
            return reject(error, {
                requestId, headers, sink, action: 'task.create', actorId: user?.id, fallbackCode: 'TASK_SUBMISSION_UNAVAILABLE',
            });
        }
    };
}

// 集合资源同时承载创建与列表：GET 只读，不需要 CSRF Origin 校验与幂等键。
function createTasksHandler({
    database = getDatabase, environment = process.env, sink = console, serviceFactory, queryFactory,
} = {}) {
    const create = createTaskHandler({
        database, environment, sink, serviceFactory,
    });
    return async (request) => {
        if (request.method !== 'GET') return create(request);

        const requestId = getRequestId(request.headers.get('x-request-id'));
        const headers = requestHeaders(requestId);
        let user;
        try {
            checkOrigin(request, authPolicy(environment), false);
            const db = typeof database === 'function' ? database() : database;
            user = await requireUser(request, db);
            if (user.role === 'admin') requireAdminMfa(user);
            const pool = db.$client;
            if (!pool) throw new Error('Task list requires a PostgreSQL pool');

            const service = queryFactory ? queryFactory({ pool }) : createTaskQueryService({ pool });
            const { searchParams } = new URL(request.url);
            const input = {
                ownerId: user.id,
                limit: searchParams.get('limit') ?? undefined,
                cursor: searchParams.get('cursor') ?? undefined,
            };
            if (searchParams.get('view') === 'studio-history') {
                const { items, nextCursor } = await service.listStudioHistory({
                    ...input,
                    media: searchParams.get('media'),
                });
                return Response.json({ accountId: user.id, items, nextCursor }, { status: 200, headers });
            }
            const page = await service.list(input);
            return Response.json({ tasks: page.tasks, nextCursor: page.nextCursor }, { status: 200, headers });
        } catch (error) {
            return reject(error, {
                requestId, headers, sink, action: 'task.list', actorId: user?.id, fallbackCode: 'TASK_QUERY_UNAVAILABLE',
            });
        }
    };
}

function createTaskDetailHandler({
    database = getDatabase, environment = process.env, sink = console, queryFactory,
} = {}) {
    return async (request, context) => {
        const requestId = getRequestId(request.headers.get('x-request-id'));
        const headers = requestHeaders(requestId);
        let user;
        try {
            checkOrigin(request, authPolicy(environment), false);
            if (request.method !== 'GET' && request.method !== 'HEAD') {
                throw new TaskApiError('METHOD_NOT_ALLOWED', 405);
            }
            const db = typeof database === 'function' ? database() : database;
            user = await requireUser(request, db);
            if (user.role === 'admin') requireAdminMfa(user);
            const pool = db.$client;
            if (!pool) throw new Error('Task detail requires a PostgreSQL pool');

            const service = queryFactory ? queryFactory({ pool }) : createTaskQueryService({ pool });
            const task = await service.get({ ownerId: user.id, taskId: await routeParam(context, 'taskId') });
            if (!task) throw new TaskApiError('TASK_NOT_FOUND', 404);
            return Response.json({ task }, { status: 200, headers });
        } catch (error) {
            return reject(error, {
                requestId, headers, sink, action: 'task.read', actorId: user?.id, fallbackCode: 'TASK_QUERY_UNAVAILABLE',
            });
        }
    };
}

function createTaskCancelHandler({
    database = getDatabase, environment = process.env, sink = console, serviceFactory,
} = {}) {
    return async (request, context) => {
        const requestId = getRequestId(request.headers.get('x-request-id'));
        const headers = requestHeaders(requestId);
        let user;
        try {
            // 取消是变更请求：必须校验 Origin，防止跨站表单代用户取消任务。
            checkOrigin(request, authPolicy(environment), true);
            if (request.method !== 'POST') throw new TaskApiError('METHOD_NOT_ALLOWED', 405);
            const db = typeof database === 'function' ? database() : database;
            user = await requireUser(request, db);
            if (user.role === 'admin') requireAdminMfa(user);
            const pool = db.$client;
            if (!pool) throw new Error('Task cancellation requires a PostgreSQL pool');

            const service = serviceFactory ? serviceFactory({ pool }) : createTaskCancellationService({ pool });
            const { task, outcome } = await service.cancel({
                ownerId: user.id,
                taskId: await routeParam(context, 'taskId'),
            });

            emitAuditEvent({
                action: 'task.cancel',
                actorId: user.id,
                resourceType: 'generation_task',
                resourceId: task.id,
                outcome: 'accepted',
                requestId,
            }, sink);

            // 202 表示"意图已登记、状态由执行方推进"，与"已取消"严格区分。
            const pending = outcome === 'requested';
            return Response.json({ task, cancelRequested: pending }, {
                status: pending ? 202 : 200,
                headers,
            });
        } catch (error) {
            return reject(error, {
                requestId, headers, sink, action: 'task.cancel', actorId: user?.id, fallbackCode: 'TASK_CANCELLATION_UNAVAILABLE',
            });
        }
    };
}

module.exports = {
    createChargedTaskHandler,
    createRoutedTaskHandler,
    createTaskCancelHandler,
    createTaskDetailHandler,
    createTaskHandler,
    createTasksHandler,
    readJsonBody,
};
