const { sql } = require('drizzle-orm');
const { getDatabase } = require('./db');
const { authPolicy, checkOrigin } = require('./authPolicy');
const { RegistrationError } = require('./registration');
const { requireUser, requireRole, requireAdminMfa, requireOwnedAsset, requireOwnedAssetContent, softDeleteOwnedAsset } = require('./authorization');
const { createFileObjectStore } = require('./storage/fileObjectStore');
const { createErrorResponse, getRequestId, writeLog, emitAuditEvent } = require('./observability');

const ACTIONS = Object.freeze(['admin.summary', 'asset.read', 'asset.content', 'asset.delete', 'cloud.blocked']);
// 每个动作只接受一个 HTTP 方法，避免用 GET 触发状态变更或让删除接口被预取。
const METHOD_BY_ACTION = Object.freeze({ 'asset.delete': 'DELETE' });

function createAuthorizationHandler(action, { database = getDatabase, environment = process.env, sink = console, objectStore } = {}) {
    if (!ACTIONS.includes(action)) throw new TypeError('无效授权操作');
    const contentStore = action === 'asset.content'
        ? (objectStore || (environment.PAINTTRACK_ASSET_STORAGE_ROOT
            ? createFileObjectStore({ rootDirectory: environment.PAINTTRACK_ASSET_STORAGE_ROOT })
            : null))
        : null;
    return async (request, context = {}) => {
        const requestId = getRequestId(request.headers.get('x-request-id'));
        const headers = { 'Cache-Control': 'no-store', Vary: 'Cookie', 'Referrer-Policy': 'no-referrer', 'x-request-id': requestId };
        let user;
        try {
            checkOrigin(request, authPolicy(environment), !['GET', 'HEAD'].includes(request.method));
            const db = typeof database === 'function' ? database() : database;
            user = await requireUser(request, db);
            if (action === 'cloud.blocked') throw new RegistrationError('NOT_IMPLEMENTED', 503);
            if (request.method !== (METHOD_BY_ACTION[action] || 'GET')) throw new RegistrationError('METHOD_NOT_ALLOWED', 405);
            const params = await context.params;
            if (action === 'asset.content') {
                if (!contentStore) throw new RegistrationError('ASSET_STORAGE_UNAVAILABLE', 503);
                const asset = await requireOwnedAssetContent(db, user, params?.id);
                const stored = await contentStore.getObject({ key: asset.storage_key });
                if (!stored) throw new RegistrationError('NOT_FOUND', 404);
                emitAuditEvent({ action, actorId: user.id, outcome: 'accepted', requestId }, sink);
                return new Response(stored.body, {
                    status: 200,
                    headers: {
                        ...headers,
                        'Content-Type': asset.mime_type || 'application/octet-stream',
                        'Content-Length': String(stored.sizeBytes),
                        'X-Content-Type-Options': 'nosniff',
                        'Cache-Control': 'private, no-store',
                    },
                });
            }
            if (action === 'asset.delete') {
                // 只做软删除与授权；对象清理是独立可重试流程，不在请求路径内执行。
                const asset = await softDeleteOwnedAsset(db, user, params?.id);
                emitAuditEvent({ action, actorId: user.id, outcome: 'accepted', requestId }, sink);
                return Response.json({ asset }, { headers });
            }
            let body;
            if (action === 'admin.summary') {
                requireAdminMfa(user);
                // 显式授权管理员仅查看聚合数量，不提供跨用户资产详情或凭据。
                const result = await db.execute(sql`SELECT (SELECT count(*)::int FROM users) AS users,
                    (SELECT count(*)::int FROM assets WHERE deleted_at IS NULL) AS assets`);
                body = { summary: result.rows[0] };
            } else {
                body = { asset: await requireOwnedAsset(db, user, params?.id) };
            }
            emitAuditEvent({ action, actorId: user.id, outcome: 'accepted', requestId }, sink);
            return Response.json(body, { headers });
        } catch (error) {
            const known = error instanceof RegistrationError;
            const code = known ? error.code : 'AUTH_UNAVAILABLE';
            const status = known ? error.status : 503;
            emitAuditEvent({ action, actorId: user?.id, outcome: 'rejected', requestId }, sink);
            writeLog(status >= 500 ? 'error' : 'warn', { service: 'authorization', event: 'request.rejected', errorCode: code, requestId }, sink);
            return Response.json(createErrorResponse({ code, requestId }).body, { status, headers });
        }
    };
}
module.exports = { createAuthorizationHandler };
