'use strict';

const { createHash } = require('node:crypto');

const MEDIA_TYPES = Object.freeze(['image', 'video']);

function parseMediaFilter(searchParams) {
    const values = searchParams.getAll('media');
    if (values.length === 0) return null;
    if (values.length !== 1) return undefined;
    return MEDIA_TYPES.includes(values[0]) ? values[0] : undefined;
}

const OPERATION_MODE_IDS = Object.freeze({
    'image.generate': 't2i',
    'image.edit': 'i2i',
    'video.generate': 't2v',
    'video.generate_from_image': 'i2v',
    'video.edit': 'v2v',
});

function studioModeIdsFor(operations) {
    return [...new Set(operations.map((operation) => OPERATION_MODE_IDS[operation]).filter(Boolean))];
}

function createModelCatalogService({ pool }) {
    if (!pool || typeof pool.query !== 'function') throw new TypeError('PostgreSQL pool is required');

    return {
        async list({ mediaType } = {}) {
            if (mediaType !== undefined && !MEDIA_TYPES.includes(mediaType)) {
                throw new TypeError('mediaType must be image or video');
            }
            const result = await pool.query(`
                SELECT logical_model_id, display_name, provider_display_name, media_type,
                       supported_operations, capability_template_key, capability_template_version,
                       parameter_schema_version, description, icon_key, sort_order, catalog_version
                FROM model_catalog_public
                WHERE ($1::text IS NULL OR media_type = $1)
                ORDER BY sort_order ASC, logical_model_id ASC`,
            [mediaType ?? null]);

            const models = result.rows.map((row) => ({
                logicalModelId: row.logical_model_id,
                displayName: row.display_name,
                providerDisplayName: row.provider_display_name,
                mediaType: row.media_type,
                operations: row.supported_operations,
                studioModeIds: studioModeIdsFor(row.supported_operations),
                capabilityTemplate: row.capability_template_key === null ? null : {
                    key: row.capability_template_key,
                    version: row.capability_template_version,
                },
                parameterSchemaVersion: row.parameter_schema_version,
                catalogVersion: row.catalog_version,
                availability: 'available',
                description: row.description,
                iconKey: row.icon_key,
                sortOrder: row.sort_order,
            }));
            const serialized = JSON.stringify({
                models,
                catalogVersions: result.rows.map((row) => row.catalog_version),
            });
            const digest = createHash('sha256').update(serialized).digest('hex');
            return {
                catalogVersion: digest,
                etag: `\"${digest}\"`,
                models,
            };
        },
    };
}

module.exports = { MEDIA_TYPES, parseMediaFilter, createModelCatalogService };
