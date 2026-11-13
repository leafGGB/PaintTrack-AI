const { sql } = require('drizzle-orm');
const { RegistrationError } = require('./registration');
const { createSessionService, sessionCookie } = require('./session');

// 资产 ID 必须是规范 UUID。非规范输入与"不存在"共用同一个 404，
// 避免通过响应差异探测资产是否存在。
const ASSET_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertAssetReader(user) {
    if (!user || !['user', 'admin'].includes(user.role)) throw new RegistrationError('FORBIDDEN', 403);
}

function assertAssetId(id) {
    if (!ASSET_ID_PATTERN.test(id || '')) throw new RegistrationError('NOT_FOUND', 404);
}

async function requireUser(request, database) {
    const { user } = await createSessionService({ database }).me(sessionCookie(request));
    if (!user) throw new RegistrationError('UNAUTHENTICATED', 401);
    if (!['user', 'admin'].includes(user.role)) throw new RegistrationError('FORBIDDEN', 403);
    return user;
}
function requireRole(user, role) {
    if (!['user', 'admin'].includes(role) || !user || user.role !== role) throw new RegistrationError('FORBIDDEN', 403);
    return user;
}
function requireAdminMfa(user) {
    requireRole(user, 'admin');
    if (user.authLevel !== 'mfa') throw new RegistrationError('MFA_REQUIRED', 403);
    return user;
}
function requireAdminStepUp(user, maxAgeSeconds = 300) {
    requireAdminMfa(user);
    const verifiedAt = user.stepUpVerifiedAt instanceof Date ? user.stepUpVerifiedAt.getTime() : Date.parse(user.stepUpVerifiedAt || '');
    if (!Number.isFinite(verifiedAt) || Date.now() - verifiedAt > maxAgeSeconds * 1000) {
        throw new RegistrationError('STEP_UP_REQUIRED', 403);
    }
    return user;
}
async function requireOwnedAsset(database, user, id) {
    // 管理员同样必须是所有者；只返回元数据，不返回存储键、URL或任意metadata。
    assertAssetReader(user);
    assertAssetId(id);
    const result = await database.execute(sql`SELECT id,media_type,mime_type,size_bytes,status,created_at
        FROM assets WHERE id=${id} AND owner_id=${user.id} AND deleted_at IS NULL`);
    if (!result.rows.length) throw new RegistrationError('NOT_FOUND', 404);
    return result.rows[0];
}

async function requireOwnedAssetContent(database, user, id) {
    assertAssetReader(user);
    assertAssetId(id);
    const result = await database.execute(sql`SELECT id,media_type,mime_type,size_bytes,status,storage_key
        FROM assets WHERE id=${id} AND owner_id=${user.id} AND deleted_at IS NULL`);
    if (!result.rows.length || result.rows[0].status !== 'ready' || !result.rows[0].storage_key) {
        throw new RegistrationError('NOT_FOUND', 404);
    }
    return result.rows[0];
}

/**
 * 用户发起的资产软删除（仅 ready -> deleted）。
 *
 * 单个条件 UPDATE 承担授权、状态机与并发控制：owner_id 进 WHERE 决定归属，
 * status='ready' AND deleted_at IS NULL 决定可删状态。并发下 PostgreSQL 会让
 * 后到的 UPDATE 重新求值 WHERE，命中 0 行，因此不会出现两条语句都成功。
 *
 * 命中 0 行时才探测一次，用于区分三种互斥结果：不属于自己（含不存在）、
 * 已经删过（幂等成功）、当前状态不可删。重复 DELETE 因此返回成功而不是冲突，
 * 符合 HTTP 删除的幂等语义，也避免客户端重试被误判为失败。
 *
 * 这里只改状态与时间戳，保留 storage_key：物理对象清理必须由独立的、
 * 可重试的清理流程完成，不能在请求路径里同步删除（删除失败会留下悬空记录）。
 */
async function softDeleteOwnedAsset(database, user, id) {
    assertAssetReader(user);
    assertAssetId(id);
    const updated = await database.execute(sql`UPDATE assets
        SET status='deleted', deleted_at=now(), updated_at=now()
        WHERE id=${id} AND owner_id=${user.id} AND status='ready' AND deleted_at IS NULL
        RETURNING id,status,deleted_at`);
    if (updated.rows.length === 1) {
        return Object.freeze({
            id: updated.rows[0].id,
            status: 'deleted',
            deletedAt: updated.rows[0].deleted_at,
            alreadyDeleted: false,
        });
    }
    const existing = await database.execute(sql`SELECT id,status,deleted_at
        FROM assets WHERE id=${id} AND owner_id=${user.id}`);
    if (!existing.rows.length) throw new RegistrationError('NOT_FOUND', 404);
    if (existing.rows[0].status === 'deleted') {
        return Object.freeze({
            id: existing.rows[0].id,
            status: 'deleted',
            deletedAt: existing.rows[0].deleted_at,
            alreadyDeleted: true,
        });
    }
    // pending/uploading/failed 还没有可交付对象，删除它们需要单独的对象孤儿回收语义，
    // 这里明确拒绝而不是静默改变状态机。
    throw new RegistrationError('ASSET_NOT_DELETABLE', 409);
}

module.exports = {
    requireUser,
    requireRole,
    requireAdminMfa,
    requireAdminStepUp,
    requireOwnedAsset,
    requireOwnedAssetContent,
    softDeleteOwnedAsset,
};

