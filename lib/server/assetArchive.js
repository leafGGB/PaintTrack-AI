'use strict';

const { randomUUID, createHash } = require('node:crypto');

const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MIME_BY_MEDIA = Object.freeze({ image: 'image/png', video: 'video/mp4', audio: 'audio/mpeg', document: 'application/octet-stream' });
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createAssetArchive({ pool, objectStore, maxBytes = MAX_ARCHIVE_BYTES } = {}) {
    if (!pool || typeof pool.query !== 'function') throw new TypeError('pool is required');
    if (!objectStore || typeof objectStore.putObject !== 'function' || typeof objectStore.deleteObject !== 'function') {
        throw new TypeError('private objectStore is required');
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_ARCHIVE_BYTES) {
        throw new TypeError('maxBytes must be between 1 and 50 MiB');
    }

    return Object.freeze({
        async discard({ storageKey } = {}) {
            if (typeof storageKey === 'string') await objectStore.deleteObject({ key: storageKey }).catch(() => {});
        },
        async archive({ ownerId, mediaType, mimeType, bytes, metadata = {}, client = pool } = {}) {
            if (!client || typeof client.query !== 'function') throw new TypeError('archive client is required');
            if (typeof ownerId !== 'string' || !UUID_PATTERN.test(ownerId)) throw new TypeError('ownerId must be a UUID');
            if (!['image', 'video', 'audio', 'document'].includes(mediaType)) throw new TypeError('mediaType is invalid');
            if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw new TypeError('bytes must be binary');
            const body = Buffer.from(bytes);
            if (body.byteLength === 0 || body.byteLength > maxBytes) throw new RangeError('asset bytes are empty or too large');
            let assetId;
            let storageKey;
            const checksum = createHash('sha256').update(body).digest('hex');
            let objectWritten = false;
            try {
                const inserted = await client.query(
                    `INSERT INTO assets (owner_id,media_type,mime_type,size_bytes,metadata,status)
                     VALUES ($1::uuid,$2,$3,$4,$5::jsonb,'pending')
                     RETURNING id`,
                    [ownerId, mediaType, mimeType || MIME_BY_MEDIA[mediaType], body.byteLength, JSON.stringify(metadata)],
                );
                if (inserted.rowCount !== 1) throw new Error('ASSET_INSERT_FAILED');
                assetId = inserted.rows[0].id;
                storageKey = `users/${ownerId}/assets/${assetId}`;
                await objectStore.putObject({
                    key: storageKey,
                    body,
                    acl: 'private',
                    metadata: { assetId, ownerId, checksumSha256: checksum },
                });
                objectWritten = true;
                const updated = await client.query(
                    `UPDATE assets SET status='ready',storage_key=$1,checksum_sha256=$2,updated_at=now()
                     WHERE id=$3::uuid AND owner_id=$4::uuid AND status='pending' RETURNING id`,
                    [storageKey, checksum, assetId, ownerId],
                );
                if (updated.rowCount !== 1) throw new Error('ASSET_READY_TRANSITION_FAILED');
                return Object.freeze({
                    assetId,
                    storageKey,
                    mediaType,
                    mimeType: mimeType || MIME_BY_MEDIA[mediaType],
                    sizeBytes: body.byteLength,
                    checksumSha256: checksum,
                    resultUrl: `/api/assets/${assetId}/content`,
                    archive: 'ready',
                });
            } catch (error) {
                if (objectWritten) await objectStore.deleteObject({ key: storageKey }).catch(() => {});
                throw error;
            }
        },
    });
}

module.exports = { MAX_ARCHIVE_BYTES, MIME_BY_MEDIA, createAssetArchive };
