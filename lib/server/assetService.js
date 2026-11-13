// Internal database service only. The caller must supply a server-verified ownerId;
// this module does not authenticate identities or verify that stored objects exist.
const ASSET_STATUS = Object.freeze({
    PENDING: 'pending', UPLOADING: 'uploading', READY: 'ready', FAILED: 'failed', DELETED: 'deleted',
});
const TRANSITIONS = Object.freeze({
    pending: Object.freeze(['uploading']),
    uploading: Object.freeze(['ready', 'failed']),
    failed: Object.freeze(['uploading']),
    ready: Object.freeze(['deleted']),
    deleted: Object.freeze([]),
});
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class AssetServiceError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'AssetServiceError';
        this.code = code;
    }
}

function assertDatabase(pool) {
    if (!pool || typeof pool.query !== 'function') throw new TypeError('pool is required');
}

function assertUuid(value, name) {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
        throw new TypeError(`${name} must be a UUID`);
    }
}

function assertStorageKey(value, name) {
    // An opaque relative object key, not a provider URL or filesystem path.
    if (typeof value !== 'string' || !value.trim() || value !== value.trim()
        || value.startsWith('/') || /[\\:\x00-\x1f\x7f?#]/.test(value)
        || value.split('/').some((part) => !part || part === '.' || part === '..')) {
        throw new TypeError(`${name} must be a relative object key`);
    }
}

async function createAsset(pool, { ownerId, mediaType, mimeType = null, sizeBytes = null, metadata = {} } = {}) {
    assertDatabase(pool);
    assertUuid(ownerId, 'ownerId');
    if (!['image', 'video', 'audio', 'document'].includes(mediaType)) {
        throw new TypeError('mediaType is invalid');
    }
    if (mimeType !== null && (typeof mimeType !== 'string' || !mimeType.trim())) {
        throw new TypeError('mimeType must be a non-empty string or null');
    }
    if (sizeBytes !== null && (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0)) {
        throw new TypeError('sizeBytes must be a non-negative safe integer or null');
    }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(metadata))) {
        throw new TypeError('metadata must be a JSON object');
    }
    const serializedMetadata = JSON.stringify(metadata);
    if (!serializedMetadata || serializedMetadata[0] !== '{') {
        throw new TypeError('metadata must serialize to a JSON object');
    }
    const result = await pool.query(
        `INSERT INTO assets (owner_id, media_type, mime_type, size_bytes, metadata, status)
         VALUES ($1::uuid, $2, $3, $4, $5::jsonb, 'pending') RETURNING *`,
        [ownerId, mediaType, mimeType, sizeBytes, serializedMetadata],
    );
    return result.rows[0];
}

async function getAsset(pool, { assetId, ownerId } = {}) {
    assertDatabase(pool);
    assertUuid(assetId, 'assetId');
    assertUuid(ownerId, 'ownerId');
    const result = await pool.query(
        'SELECT * FROM assets WHERE id = $1::uuid AND owner_id = $2::uuid',
        [assetId, ownerId],
    );
    // Deleted records remain visible to their owner for lifecycle bookkeeping.
    return result.rows[0] || null;
}

/**
 * Compare-and-set on id + owner + expected status. A retry after a successful
 * transition is a conflict, not an idempotent success. This is not an upload
 * attempt lease: stale workers across failed -> uploading retries need fencing
 * when asynchronous storage integration is introduced.
 * Soft deletion preserves keys; physical object cleanup is a separate concern.
 */
async function transitionAsset(pool, {
    assetId, ownerId, expectedStatus, status,
    storageKey, thumbnailStorageKey, checksumSha256,
} = {}) {
    assertDatabase(pool);
    assertUuid(assetId, 'assetId');
    assertUuid(ownerId, 'ownerId');
    if (!Object.hasOwn(TRANSITIONS, expectedStatus) || !TRANSITIONS[expectedStatus].includes(status)) {
        throw new AssetServiceError('INVALID_TRANSITION', 'Asset status transition is not allowed');
    }
    if (status === ASSET_STATUS.READY) {
        assertStorageKey(storageKey, 'storageKey');
        if (thumbnailStorageKey !== undefined && thumbnailStorageKey !== null) {
            assertStorageKey(thumbnailStorageKey, 'thumbnailStorageKey');
        }
        if (checksumSha256 !== undefined && checksumSha256 !== null
            && (typeof checksumSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(checksumSha256))) {
            throw new TypeError('checksumSha256 must be lowercase SHA-256 hex or null');
        }
    } else if ([storageKey, thumbnailStorageKey, checksumSha256].some((value) => value !== undefined)) {
        throw new TypeError('Object details may only be supplied when becoming ready');
    }

    const result = await pool.query(
        `UPDATE assets
         SET status = $1, updated_at = now(),
             storage_key = CASE WHEN $1 = 'ready' THEN $5::text ELSE storage_key END,
             thumbnail_storage_key = CASE WHEN $1 = 'ready' THEN $6::text ELSE thumbnail_storage_key END,
             checksum_sha256 = CASE WHEN $1 = 'ready' THEN $7::text ELSE checksum_sha256 END,
             deleted_at = CASE WHEN $1 = 'deleted' THEN now() ELSE NULL END
         WHERE id = $2::uuid AND owner_id = $3::uuid AND status = $4
         RETURNING *`,
        [status, assetId, ownerId, expectedStatus, storageKey ?? null,
            thumbnailStorageKey ?? null, checksumSha256 ?? null],
    );
    if (result.rowCount !== 1) {
        // Do not distinguish an unknown asset, a different owner, or stale state.
        throw new AssetServiceError('ASSET_CONFLICT', 'Asset is unavailable for this transition');
    }
    return result.rows[0];
}

module.exports = { ASSET_STATUS, AssetServiceError, createAsset, getAsset, transitionAsset };
