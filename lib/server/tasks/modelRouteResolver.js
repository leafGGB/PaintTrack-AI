'use strict';

const { createHash } = require('node:crypto');

const LOGICAL_MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,127}$/;
const UUID_OR_OPAQUE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,255}$/;
const SNAPSHOT_VERSION = 1;

class ModelRouteError extends Error {
    constructor(code, message = code, status = 409) {
        super(message);
        this.name = 'ModelRouteError';
        this.code = code;
        this.status = status;
    }
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (isPlainObject(value)) {
        return `{${Object.keys(value).sort()
            .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
            .join(',')}}`;
    }
    return JSON.stringify(value);
}

function freezeDeep(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) freezeDeep(child);
    return Object.freeze(value);
}

function requiredOpaque(value, name) {
    if (typeof value !== 'string' || !UUID_OR_OPAQUE_PATTERN.test(value)) {
        throw new ModelRouteError('MODEL_ROUTE_INVALID', `${name} is invalid`, 503);
    }
    return value;
}

function requiredPositiveInteger(value, name) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new ModelRouteError('MODEL_ROUTE_INVALID', `${name} is invalid`, 503);
    }
    return value;
}

function operationFor(taskType) {
    if (taskType === 'image.generate' || taskType === 'image.edit'
        || taskType === 'video.generate' || taskType === 'video.generate_from_image'
        || taskType === 'video.edit') return taskType;
    throw new ModelRouteError('MODEL_ROUTE_UNSUPPORTED_OPERATION', 'Task operation is not routable', 400);
}

function assertRouteEntry(entry) {
    if (!isPlainObject(entry)) throw new ModelRouteError('MODEL_ROUTE_INVALID', 'Route entry is invalid', 503);
    const logicalModelId = requiredOpaque(entry.logicalModelId, 'logicalModelId');
    if (!LOGICAL_MODEL_ID_PATTERN.test(logicalModelId)) {
        throw new ModelRouteError('MODEL_ROUTE_INVALID', 'logicalModelId is invalid', 503);
    }
    if (entry.enabled !== true) throw new ModelRouteError('MODEL_UNAVAILABLE', 'Logical model is disabled', 409);
    if (!['image', 'video'].includes(entry.mediaType)) {
        throw new ModelRouteError('MODEL_ROUTE_INVALID', 'mediaType is invalid', 503);
    }
    const operations = Array.isArray(entry.supportedOperations) ? entry.supportedOperations : [];
    const bindings = Array.isArray(entry.bindings) ? entry.bindings : [];
    return { entry, logicalModelId, operations, bindings };
}

function usableBinding(binding, logicalModel, operation) {
    if (!isPlainObject(binding) || binding.enabled !== true || binding.isPrimary !== true) return false;
    const provider = binding.providerInstance;
    const providerModel = binding.providerModel;
    return isPlainObject(provider) && provider.enabled === true
        && isPlainObject(providerModel) && providerModel.enabled === true
        && providerModel.validationState === 'verified'
        && providerModel.mediaType === logicalModel.mediaType
        && providerModel.capabilities && isPlainObject(providerModel.capabilities)
        && Array.isArray(providerModel.capabilities.operations)
        && providerModel.capabilities.operations.includes(operation);
}

function createRouteSnapshot({ logicalModel, binding, operation }) {
    const provider = binding.providerInstance;
    const providerModel = binding.providerModel;
    const snapshot = {
        snapshotVersion: SNAPSHOT_VERSION,
        logicalModelId: logicalModel.logicalModelId,
        logicalModelVersion: requiredPositiveInteger(logicalModel.catalogVersion, 'catalogVersion'),
        providerInstanceId: requiredOpaque(provider.id, 'providerInstanceId'),
        providerConfigVersion: requiredPositiveInteger(provider.configVersion, 'providerConfigVersion'),
        credentialRefVersion: requiredPositiveInteger(provider.credentialVersion, 'credentialVersion'),
        providerModelId: requiredOpaque(providerModel.id, 'providerModelId'),
        upstreamModelName: requiredOpaque(providerModel.upstreamModelName, 'upstreamModelName'),
        adapterType: requiredOpaque(provider.adapterType, 'adapterType'),
        adapterVersion: requiredOpaque(providerModel.adapterVersion, 'adapterVersion'),
        operationProfile: requiredOpaque(providerModel.operationProfile, 'operationProfile'),
        bindingId: requiredOpaque(binding.id, 'bindingId'),
        bindingVersion: requiredPositiveInteger(binding.bindingVersion, 'bindingVersion'),
        requestMappingVersion: requiredPositiveInteger(providerModel.requestMappingVersion, 'requestMappingVersion'),
        responseMappingVersion: requiredPositiveInteger(providerModel.responseMappingVersion, 'responseMappingVersion'),
        capabilitySnapshot: {
            operation,
            mediaType: logicalModel.mediaType,
        },
    };
    const routeSnapshotHash = createHash('sha256').update(stableStringify(snapshot)).digest('hex');
    return Object.freeze({
        logicalModelPk: requiredOpaque(logicalModel.id, 'logicalModelPk'),
        routeSnapshot: freezeDeep(snapshot),
        routeSnapshotVersion: SNAPSHOT_VERSION,
        routeSnapshotHash,
    });
}

function createModelRouteResolver({ catalog } = {}) {
    if (!catalog || typeof catalog.getLogicalModel !== 'function') {
        throw new TypeError('trusted model catalog is required');
    }

    return Object.freeze({
        async resolve({ taskType, payload } = {}) {
            if (!isPlainObject(payload) || typeof payload.logicalModelId !== 'string'
                || !LOGICAL_MODEL_ID_PATTERN.test(payload.logicalModelId)) {
                throw new ModelRouteError('LOGICAL_MODEL_REQUIRED', 'A logical model is required', 400);
            }
            const operation = operationFor(taskType);
            const logicalModel = await catalog.getLogicalModel(payload.logicalModelId);
            if (!logicalModel) throw new ModelRouteError('MODEL_UNAVAILABLE', 'Logical model is unavailable', 409);
            if (logicalModel.logicalModelId !== payload.logicalModelId) throw new ModelRouteError('MODEL_ROUTE_INVALID');
            const { entry, operations, bindings } = assertRouteEntry(logicalModel);
            if (!operations.includes(operation)) {
                throw new ModelRouteError('MODEL_OPERATION_UNSUPPORTED', 'Logical model does not support this operation', 409);
            }
            const candidates = bindings.filter((binding) => usableBinding(binding, entry, operation));
            if (candidates.length > 1) throw new ModelRouteError('MODEL_ROUTE_AMBIGUOUS');
            const primary = candidates[0];
            if (!primary) throw new ModelRouteError('MODEL_ROUTE_UNAVAILABLE', 'No enabled primary route is available', 409);
            return createRouteSnapshot({ logicalModel: entry, binding: primary, operation });
        },
    });
}

module.exports = {
    ModelRouteError,
    SNAPSHOT_VERSION,
    createModelRouteResolver,
    stableStringify,
};
