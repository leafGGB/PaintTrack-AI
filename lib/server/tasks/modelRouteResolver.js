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

// 只解释本切片需要的整数 schema 子集；未知约束不可静默忽略。
function acceptsInteger(schema, value, { enumeration = false } = {}) {
    if (!isPlainObject(schema) || schema.type !== 'integer'
        || Object.keys(schema).some(key => !['type', 'enum', 'minimum', 'maximum', 'multipleOf'].includes(key))) return false;
    if (!Number.isSafeInteger(value) || value <= 0) return false;
    if (enumeration || Object.hasOwn(schema, 'enum')) {
        if (!Array.isArray(schema.enum) || schema.enum.length === 0
            || !schema.enum.every(entry => Number.isSafeInteger(entry) && entry > 0)
            || !schema.enum.includes(value)) return false;
    } else if (!Number.isSafeInteger(schema.minimum) || schema.minimum <= 0
        || !Number.isSafeInteger(schema.maximum) || schema.maximum < schema.minimum) return false;
    if (Object.hasOwn(schema, 'minimum') && (!Number.isSafeInteger(schema.minimum) || value < schema.minimum)) return false;
    if (Object.hasOwn(schema, 'maximum') && (!Number.isSafeInteger(schema.maximum) || value > schema.maximum)) return false;
    if (Object.hasOwn(schema, 'multipleOf') && (!Number.isSafeInteger(schema.multipleOf)
        || schema.multipleOf <= 0 || value % schema.multipleOf !== 0)) return false;
    return true;
}

function assertGenerationParameters(logicalModel, binding, operation, payload) {
    if (operation === 'image.generate') {
        // 当前执行器/归档/真实适配器均为单结果，不因目录声称多图而放行。
        if (payload.outputCount !== 1) throw new ModelRouteError('MODEL_PARAMETERS_UNSUPPORTED');
        if (logicalModel.parameterSchema != null && (!Number.isSafeInteger(logicalModel.parameterSchemaVersion)
            || logicalModel.parameterSchemaVersion <= 0
            || !acceptsInteger(logicalModel.parameterSchema.properties?.outputCount, payload.outputCount))) {
            throw new ModelRouteError('MODEL_PARAMETERS_UNSUPPORTED');
        }
        return;
    }
    if (operation !== 'video.generate') return;
    const schema = logicalModel.parameterSchema;
    const parameters = binding.providerModel.capabilities.parameters;
    if (binding.providerInstance.adapterType !== 'mock'
        || !Number.isSafeInteger(logicalModel.parameterSchemaVersion) || logicalModel.parameterSchemaVersion <= 0
        || !isPlainObject(schema) || schema.type !== 'object' || !isPlainObject(schema.properties)
        || Object.keys(schema).some(key => !['type', 'properties', 'required', 'additionalProperties'].includes(key))
        || !Array.isArray(schema.required) || !['durationMs', 'fps'].every(key => schema.required.includes(key))
        || !schema.required.every(key => typeof key === 'string' && Object.hasOwn(payload, key))
        || (Object.hasOwn(schema, 'additionalProperties') && typeof schema.additionalProperties !== 'boolean')
        || (schema.additionalProperties === false && Object.keys(payload).some(key => !Object.hasOwn(schema.properties, key)))
        || !isPlainObject(parameters)
        || !['durationMs', 'fps'].every(key => acceptsInteger(schema.properties[key], payload[key], { enumeration: key === 'fps' })
            && acceptsInteger(parameters[key], payload[key], { enumeration: key === 'fps' }))) {
        throw new ModelRouteError('MODEL_PARAMETERS_UNSUPPORTED');
    }
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
            if ((operation === 'image.generate' && payload.outputCount !== 1)
                || (operation === 'video.generate' && !['durationMs', 'fps'].every(key => Number.isSafeInteger(payload[key]) && payload[key] > 0))) {
                throw new ModelRouteError('MODEL_PARAMETERS_UNSUPPORTED');
            }
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
            assertGenerationParameters(entry, primary, operation, payload);
            return createRouteSnapshot({ logicalModel: entry, binding: primary, operation });
        },
    });
}

module.exports = {
    ModelRouteError,
    SNAPSHOT_VERSION,
    createModelRouteResolver,
    assertGenerationParameters,
    stableStringify,
};
