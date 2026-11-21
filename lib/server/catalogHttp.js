'use strict';

const { getDatabase } = require('./db');
const { authPolicy, checkOrigin } = require('./authPolicy');
const { requireUser, requireAdminMfa } = require('./authorization');
const { RegistrationError } = require('./registration');
const { createErrorResponse, emitAuditEvent, getRequestId, writeLog } = require('./observability');
const { parseMediaFilter, createModelCatalogService } = require('./modelCatalog');
const { createHash } = require('node:crypto');
const { controlledImageOwner, hasControlledImageAccess, publicModel } = require('./tasks/controlledImageDevelopment');

function localMockImageCatalog(environment, mediaType) {
    if (environment.NODE_ENV !== 'development'
        || environment.PAINTTRACK_LOCAL_INTERNAL_GUARD !== '1'
        || environment.PAINTTRACK_LOCAL_MOCK_ROUTING !== '1'
        || (mediaType !== null && mediaType !== 'image' && mediaType !== 'video')) return null;
    const models = mediaType === 'video' ? [{
        logicalModelId: 'local-mock-video',
        displayName: 'Local Mock Video',
        providerDisplayName: 'Synthetic',
        mediaType: 'video',
        operations: ['video.generate'],
        studioModeIds: ['t2v'],
        capabilityTemplate: null,
        parameterSchemaVersion: 1,
        catalogVersion: 1,
        availability: 'available',
        description: 'Synthetic local video task execution; generated media preview is not archived.',
        iconKey: null,
        sortOrder: -1,
    }] : [{
        logicalModelId: 'local-mock-image',
        displayName: 'Local Mock Image',
        providerDisplayName: 'Synthetic',
        mediaType: 'image',
        operations: ['image.generate'],
        studioModeIds: ['t2i'],
        capabilityTemplate: null,
        parameterSchemaVersion: null,
        catalogVersion: 1,
        availability: 'available',
        description: 'Synthetic local task execution; generated media preview is not archived.',
        iconKey: null,
        sortOrder: -1,
    }];
    const serialized = JSON.stringify({ models, catalogVersions: [1] });
    const digest = createHash('sha256').update(serialized).digest('hex');
    return { catalogVersion: digest, etag: `\"${digest}\"`, models };
}

function headersFor(requestId, etag) {
    return {
        'Cache-Control': 'private, max-age=60, must-revalidate',
        ETag: etag,
        Vary: 'Cookie, Accept-Encoding',
        'Referrer-Policy': 'no-referrer',
        'x-request-id': requestId,
    };
}

function createCatalogHandler({
    database = getDatabase, environment = process.env, sink = console, serviceFactory,
} = {}) {
    return async (request) => {
        const requestId = getRequestId(request.headers.get('x-request-id'));
        let user;
        try {
            checkOrigin(request, authPolicy(environment), false);
            if (request.method !== 'GET') throw new RegistrationError('METHOD_NOT_ALLOWED', 405);
            const mediaType = parseMediaFilter(new URL(request.url).searchParams);
            if (mediaType === undefined) throw new RegistrationError('INVALID_CATALOG_FILTER', 400);
            const db = typeof database === 'function' ? database() : database;
            user = await requireUser(request, db);
            if (user.role === 'admin') requireAdminMfa(user);
            const pool = db.$client;
            if (!pool) throw new Error('Catalog requires a PostgreSQL pool');
            const controlled = environment.PAINTTRACK_LOCAL_CONTROLLED_IMAGE !== undefined;
            let catalog;
            if (controlled) {
                const ownerId = controlledImageOwner(environment, environment.DATABASE_URL, 'runtime');
                if (!hasControlledImageAccess(request, environment)) throw new RegistrationError('CONTROLLED_IMAGE_HOST_UNAVAILABLE', 503);
                const models = user.id === ownerId && mediaType !== 'video' ? [publicModel] : [];
                const digest = createHash('sha256').update(JSON.stringify(models)).digest('hex');
                catalog = { models, catalogVersion: digest, etag: `"${digest}"` };
            } else {
                const localMockCatalog = localMockImageCatalog(environment, mediaType);
                const service = serviceFactory ? serviceFactory({ pool }) : createModelCatalogService({ pool });
                catalog = localMockCatalog || await service.list({ mediaType });
            }
            const headers = headersFor(requestId, catalog.etag);
            if (controlled) headers['Cache-Control'] = 'no-store';
            if (request.headers.get('if-none-match') === catalog.etag) {
                emitAuditEvent({ action: 'catalog.models.read', actorId: user.id, outcome: 'accepted', requestId }, sink);
                return new Response(null, { status: 304, headers });
            }
            emitAuditEvent({ action: 'catalog.models.read', actorId: user.id, outcome: 'accepted', requestId }, sink);
            return Response.json({ catalogVersion: catalog.catalogVersion, models: catalog.models }, { headers });
        } catch (error) {
            const known = error instanceof RegistrationError;
            const code = known ? error.code : 'CATALOG_UNAVAILABLE';
            const status = known ? error.status : 503;
            emitAuditEvent({ action: 'catalog.models.read', actorId: user?.id, outcome: 'rejected', requestId }, sink);
            writeLog(status >= 500 ? 'error' : 'warn', {
                service: 'catalog', event: 'request.rejected', errorCode: code, requestId,
            }, sink);
            const response = createErrorResponse({ code, requestId });
            return Response.json(response.body, {
                status,
                headers: { ...response.headers, 'Cache-Control': 'no-store', Vary: 'Cookie' },
            });
        }
    };
}

module.exports = { createCatalogHandler };
