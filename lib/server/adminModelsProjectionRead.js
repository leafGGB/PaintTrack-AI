'use strict';

const { sql } = require('drizzle-orm');
const { getDatabase } = require('./db');

const CONTRACT_VERSION = 'admin_models_read_v1';
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,127}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAPABILITIES = Object.freeze({
    image: new Set(['image.generate', 'image.edit']),
    video: new Set(['video.generate', 'video.generate_from_image', 'video.edit']),
});

function fail(code) {
    const error = new Error(code);
    error.code = code;
    throw error;
}

function parseLimit(value) {
    if (value === null) return DEFAULT_LIMIT;
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > MAX_LIMIT) fail('INVALID_ADMIN_MODEL_QUERY');
    return Number(value);
}

function parseQuery(params = new URLSearchParams()) {
    if (!(params instanceof URLSearchParams)) fail('INVALID_ADMIN_MODEL_QUERY');
    const allowed = new Set(['q', 'type', 'enabled', 'limit', 'cursor']);
    for (const key of params.keys()) {
        if (!allowed.has(key) || params.getAll(key).length !== 1) fail('INVALID_ADMIN_MODEL_QUERY');
    }
    const q = params.get('q');
    const type = params.get('type') || 'all';
    const enabled = params.get('enabled') || 'all';
    if (q !== null && (q.trim().length < 1 || q.trim().length > 128)) fail('INVALID_ADMIN_MODEL_QUERY');
    if (!['all', 'image', 'video'].includes(type) || !['all', 'true', 'false'].includes(enabled)) fail('INVALID_ADMIN_MODEL_QUERY');
    const search = q === null ? '' : q.trim();
    const cursor = decodeCursor(params.get('cursor'));
    if (cursor && (cursor.q !== search || cursor.type !== type || cursor.enabled !== enabled)) fail('INVALID_ADMIN_MODEL_QUERY');
    return { q: search, type, enabled, limit: parseLimit(params.get('limit')), cursor };
}

function encodeCursor(row, query) {
    const value = JSON.stringify({ v: 1, id: row.logical_model_id, pk: row.id, q: query.q, type: query.type, enabled: query.enabled });
    return Buffer.from(value, 'utf8').toString('base64url');
}

function decodeCursor(value) {
    if (value === null) return null;
    if (typeof value !== 'string' || value.length > 1536 || !/^[A-Za-z0-9_-]+$/.test(value)) fail('INVALID_ADMIN_MODEL_QUERY');
    let parsed;
    try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); } catch { fail('INVALID_ADMIN_MODEL_QUERY'); }
    if (!parsed || parsed.v !== 1 || !ID_PATTERN.test(parsed.id) || !UUID_PATTERN.test(parsed.pk)
        || typeof parsed.q !== 'string' || !['all', 'image', 'video'].includes(parsed.type)
        || !['all', 'true', 'false'].includes(parsed.enabled)) fail('INVALID_ADMIN_MODEL_QUERY');
    return parsed;
}

function normalizeCapabilities(type, value) {
    if (!Array.isArray(value)) return { capabilities: [], capabilitiesState: 'unsupported' };
    const allowed = CAPABILITIES[type] || new Set();
    const capabilities = [...new Set(value.filter(item => typeof item === 'string' && allowed.has(item)))].sort();
    return { capabilities, capabilitiesState: capabilities.length ? 'known' : 'unsupported' };
}

function projectModel(row) {
    if (!row || !UUID_PATTERN.test(String(row.id)) || !ID_PATTERN.test(String(row.logical_model_id))
        || !['image', 'video'].includes(row.media_type) || !Number.isSafeInteger(Number(row.catalog_version))
        || Number(row.catalog_version) < 1 || typeof row.display_name !== 'string' || typeof row.enabled !== 'boolean') fail('ADMIN_MODELS_DATA_INVALID');
    const capability = normalizeCapabilities(row.media_type, row.supported_operations);
    const templatePair = row.capability_template_key === null && row.capability_template_version === null
        ? null
        : (typeof row.capability_template_key === 'string' && Number.isSafeInteger(Number(row.capability_template_version)) && Number(row.capability_template_version) > 0
            ? { key: row.capability_template_key, version: Number(row.capability_template_version) }
            : fail('ADMIN_MODELS_DATA_INVALID'));
    const parameterSchemaVersion = row.parameter_schema_version === null ? null : Number(row.parameter_schema_version);
    if (parameterSchemaVersion !== null && (!Number.isSafeInteger(parameterSchemaVersion) || parameterSchemaVersion < 1)) fail('ADMIN_MODELS_DATA_INVALID');
    return {
        logicalModelId: row.logical_model_id,
        logicalModelPk: row.id,
        logicalModelVersion: Number(row.catalog_version),
        catalogVersion: Number(row.catalog_version),
        displayName: row.display_name,
        type: row.media_type,
        ...capability,
        enabled: row.enabled,
        capabilityTemplate: templatePair,
        parameterSchemaVersion,
        bindings: null,
        pricing: { readable: false, reason: 'NOT_AUTHORIZED', data: null },
    };
}

function projectBinding(row) {
    if (!row || !UUID_PATTERN.test(String(row.provider_instance_id)) || !UUID_PATTERN.test(String(row.provider_model_id))
        || !['primary', 'secondary'].includes(row.route_role) || !Number.isSafeInteger(Number(row.route_order))
        || Number(row.route_order) < 1 || !Number.isSafeInteger(Number(row.binding_version))
        || Number(row.binding_version) < 1 || typeof row.active !== 'boolean') fail('ADMIN_MODELS_DATA_INVALID');
    return {
        providerInstanceId: row.provider_instance_id,
        providerModelId: row.provider_model_id,
        routeRole: row.route_role,
        routeOrder: Number(row.route_order),
        bindingVersion: Number(row.binding_version),
        active: row.active,
    };
}

function projectionQuery(query) {
    const terms = [sql`TRUE`];
    if (query.type !== 'all') terms.push(sql`lm.media_type = ${query.type}`);
    if (query.enabled !== 'all') terms.push(sql`lm.enabled = ${query.enabled === 'true'}`);
    if (query.q) {
        const escaped = query.q.replace(/[\\%_]/g, char => `\\${char}`);
        terms.push(sql`(lm.logical_model_id ILIKE ${`%${escaped}%`} ESCAPE '\\' OR lm.display_name ILIKE ${`%${escaped}%`} ESCAPE '\\')`);
    }
    if (query.cursor) terms.push(sql`(lm.logical_model_id COLLATE "C", lm.id) > (${query.cursor.id}, ${query.cursor.pk})`);
    return sql`SELECT lm.id, lm.logical_model_id, lm.display_name, lm.media_type,
        lm.supported_operations, lm.capability_template_key, lm.capability_template_version,
        lm.parameter_schema_version, lm.enabled, lm.catalog_version
      FROM public.logical_models AS lm
      WHERE ${sql.join(terms, sql` AND `)}
      ORDER BY lm.logical_model_id COLLATE "C" ASC, lm.id ASC
      LIMIT ${query.limit + 1}`;
}

async function readBindingProjection(tx, logicalModelPks) {
    if (!Array.isArray(logicalModelPks) || logicalModelPks.length > MAX_LIMIT) fail('ADMIN_MODELS_DATA_INVALID');
    if (!logicalModelPks.length) return [];
    const result = await tx.execute(sql`SELECT logical_model_pk, provider_instance_id, provider_model_id,
        route_role, route_order, binding_version, active
      FROM public.admin_model_bindings_read(${sql.param(logicalModelPks)}::uuid[])`);
    return result.rows;
}

async function databaseClock(tx) {
    const result = await tx.execute(sql`SELECT to_char(pg_catalog.clock_timestamp() AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS as_of`);
    return result.rows[0]?.as_of;
}

function createAdminModelsProjectionRead({ database = getDatabase, readBindings = readBindingProjection, clock = databaseClock } = {}) {
    if (typeof readBindings !== 'function' || typeof clock !== 'function') throw new TypeError('投影读取依赖必须是函数');
    return Object.freeze({
        async read(params = new URLSearchParams()) {
            const query = parseQuery(params);
            const db = typeof database === 'function' ? database() : database;
            return db.transaction(async tx => {
                await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
                const asOf = await clock(tx);
                const result = await tx.execute(projectionQuery(query));
                const pageRows = result.rows.slice(0, query.limit);
                const hasMore = result.rows.length > query.limit;
                const models = pageRows.map(projectModel);
                const bindings = await readBindings(tx, pageRows.map(row => row.id));
                if (!Array.isArray(bindings)) fail('ADMIN_MODELS_DATA_INVALID');
                const grouped = new Map(pageRows.map(row => [String(row.id), []]));
                for (const row of bindings) {
                    if (!grouped.has(String(row.logical_model_pk))) fail('ADMIN_MODELS_DATA_INVALID');
                    grouped.get(String(row.logical_model_pk)).push(projectBinding(row));
                }
                for (const model of models) {
                    const rows = grouped.get(model.logicalModelPk).sort((a, b) => a.routeOrder - b.routeOrder || a.providerModelId.localeCompare(b.providerModelId));
                    if (rows.length > 50) fail('ADMIN_MODELS_DATA_INVALID');
                    model.bindings = { readable: true, data: rows };
                }
                const last = pageRows.at(-1);
                return {
                    ok: true,
                    data: { models, nextCursor: hasMore && last ? encodeCursor(last, query) : null },
                    error: null,
                    meta: {
                        source: 'api', mock: false, writesAvailable: false, contractVersion: CONTRACT_VERSION,
                        requestId: null, asOf: typeof asOf === 'string' ? asOf : null, timeZone: 'UTC', scope: 'current_admin_catalog',
                        capabilities: { catalogRead: true, bindingsRead: true, pricingRead: false, historyRead: false },
                        orderBy: ['logicalModelId:C:asc', 'logicalModelPk:asc'],
                    },
                };
            }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
        },
    });
}

module.exports = { CONTRACT_VERSION, DEFAULT_LIMIT, MAX_LIMIT, parseQuery, projectModel, projectBinding, projectionQuery, createAdminModelsProjectionRead };
