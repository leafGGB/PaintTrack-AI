'use strict';

const logicalModelId = 'local-controlled-image';
const modelPk = '24ff21a7-6da5-4b98-8117-1a1a69b33e46';
const fixtureEmail = 'controlled-image@example.test';
const descriptor = Object.freeze({ providerInstanceId: 'local-controlled-synthetic', credentialRef: 'synthetic-only',
    credentialVersion: 1, adapterType: 'myvigna-image', baseUrl: 'https://provider.example.test/v1', upstreamModel: 'gpt-image-2' });
const catalog = Object.freeze({ async getLogicalModel(id) {
    if (id !== logicalModelId) return null;
    return { id: modelPk, logicalModelId, enabled: true, mediaType: 'image', catalogVersion: 1,
        supportedOperations: ['image.generate'], bindings: [{ id: 'synthetic-binding', enabled: true, isPrimary: true, bindingVersion: 1,
            providerInstance: { id: descriptor.providerInstanceId, enabled: true, configVersion: 1, credentialVersion: 1, adapterType: descriptor.adapterType },
            providerModel: { id: 'synthetic-model', enabled: true, validationState: 'verified', mediaType: 'image',
                upstreamModelName: descriptor.upstreamModel, capabilities: { operations: ['image.generate'] },
                adapterVersion: '1', operationProfile: 'image.generate', requestMappingVersion: 1, responseMappingVersion: 1 },
        }] };
} });
const publicModel = Object.freeze({ logicalModelId, displayName: 'Controlled Synthetic Image', providerDisplayName: 'Synthetic',
    mediaType: 'image', operations: ['image.generate'], studioModeIds: ['t2i'], capabilityTemplate: null,
    parameterSchemaVersion: null, catalogVersion: 1, availability: 'available',
    description: 'Local fixture: returns a fixed PNG, not a generated image from a provider.', iconKey: null, sortOrder: 0 });

function conflictingEnvironment(environment) {
    return ['PAINTTRACK_LOCAL_MOCK_ROUTING', 'PAINTTRACK_LOCAL_WORKER', 'PAINTTRACK_WORKER_PROVIDER',
        'PAINTTRACK_CHARGED_SUBMISSION', 'PAINTTRACK_LOCAL_SETTLEMENT', 'PAINTTRACK_LOCAL_ASSET_CLEANUP']
        .some(key => environment[key] !== undefined && environment[key] !== '' && environment[key] !== '0');
}

function controlledImageOwner(environment, databaseUrl, role) {
    const { parseDatabaseTarget } = require('../db/testIsolation');
    const ownerId = environment.PAINTTRACK_CONTROLLED_IMAGE_OWNER;
    if (environment.PAINTTRACK_LOCAL_CONTROLLED_IMAGE !== '1' || environment.NODE_ENV !== 'development'
        || environment.PAINTTRACK_LOCAL_INTERNAL_GUARD !== '1' || conflictingEnvironment(environment)
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(ownerId || '')) {
        throw new Error('CONTROLLED_IMAGE_CONFIG_INVALID');
    }
    const { host, port, database, username } = parseDatabaseTarget(databaseUrl);
    const suffix = /^pt_local_auth_(ci_[0-9a-f]{12})$/.exec(database)?.[1];
    if (!['127.0.0.1', '::1'].includes(host) || port !== 5433 || !suffix
        || username !== `pt_local_${role}_${suffix}`) throw new Error('CONTROLLED_IMAGE_CONFIG_INVALID');
    return ownerId;
}

function hasControlledImageAccess(request, environment) {
    const secret = environment.PAINTTRACK_LOCAL_MAILBOX_SECRET;
    return /^[0-9a-f]{64}$/.test(secret || '') && request.headers.get('x-painttrack-local-capability') === secret
        && request.headers.get('x-painttrack-controlled-image-ready') === secret;
}

function assertControlledImageSubmission({ user, input }, ownerId) {
    const { TaskApiError } = require('./taskSubmission');
    if (user.id !== ownerId) throw new TaskApiError('FORBIDDEN', 403);
    if (input.taskType !== 'image.generate' || input.payload.logicalModelId !== logicalModelId) {
        throw new TaskApiError('MODEL_UNAVAILABLE', 409);
    }
}

const syntheticPng = 'iVBORw0KGgoAAAANSUhEUgAAAIAAAABgCAIAAABaGO0eAAAA30lEQVR42u3bMQ0AIAxFwTpBFJqQhBCMoAEHJF3a5RLmP7wbG2Kdm3pj7tSz/38hEAAAAgEAIBAAAAIBACAQAAACAQAgEAAAAhUACNq7DwAAAIEAABAIAACBAAAQCAAAgQAAEAgAAIEqAAR1EQMgEAAAAgEAIBAAAAIBACAQAAACAQAgEAD/AwR1EQMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP4HCOoiBgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/A+w7yIGwD4AAPYBALAPAIB9AADsAwBgHwAA+wDa9x8zywzPoV6JGAAAAABJRU5ErkJggg==';
function createSyntheticImageAdapter() {
    return { name: 'controlled-synthetic-fixture', async submit({ taskId }) {
        return { kind: 'completed', providerJobId: `synthetic-${taskId}`, providerState: 'succeeded',
            result: { mediaType: 'image', mimeType: 'image/png', bytes: Buffer.from(syntheticPng, 'base64') } };
    }, async query() { throw new Error('SYNTHETIC_QUERY_FORBIDDEN'); }, async cancel() { throw new Error('SYNTHETIC_CANCEL_FORBIDDEN'); } };
}

module.exports = { logicalModelId, modelPk, fixtureEmail, descriptor, catalog, publicModel, conflictingEnvironment,
    controlledImageOwner, hasControlledImageAccess, assertControlledImageSubmission, createSyntheticImageAdapter, syntheticPng };
