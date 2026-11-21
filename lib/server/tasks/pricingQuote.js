'use strict';

const { createHash } = require('node:crypto');
const { stableStringify, validateCreateTaskRequest } = require('./taskSubmission');

const MAX_ATOMS = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_INTERMEDIATE = (1n << 256n) - 1n;
const MAX_TIME_US = 253402300799999999n;
const DEFAULT_VALIDITY_MS = 30 * 60 * 1000;
const CLOCK_SOURCE = 'postgresql.clock_timestamp';
// 历史独立于单版本档位的256项上限；超过容量须先扩展实现，绝不截断历史或回退旧头。
const MAX_PRICING_VERSIONS = 10000;

class PricingError extends Error {
    constructor(reason) {
        super('PRICING_UNAVAILABLE');
        this.name = 'PricingError';
        this.code = 'PRICING_UNAVAILABLE';
        Object.defineProperty(this, 'reason', { value: reason });
    }

    toJSON() { return { code: this.code }; }
}

function fail(reason = 'CONFIG_INVALID') { throw new PricingError(reason); }

function object(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
}

function keys(value, required, optional = []) {
    object(value);
    if (required.some(key => !Object.hasOwn(value, key))
        || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail();
}

// 拒绝访问器、循环和非 JSON 值；复制后才验证，外部原地修改不能改写报价依据。
function copyJson(value, state = { nodes: 0 }, depth = 0) {
    if (++state.nodes > 20000 || depth > 12) fail();
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string' && value.length <= 20000) return value;
    if (typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0)) return value;
    if (typeof value !== 'object' || value === null) fail();
    if (!Array.isArray(value)) object(value);
    const result = Array.isArray(value) ? [] : {};
    for (const key of Reflect.ownKeys(value)) {
        if (Array.isArray(value) && key === 'length') continue;
        if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) fail();
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
        result[key] = copyJson(descriptor.value, state, depth + 1);
    }
    if (Array.isArray(value) && (result.length !== value.length
        || Object.keys(result).length !== value.length)) fail();
    return result;
}

function freezeDeep(value) {
    if (value && typeof value === 'object') {
        for (const child of Object.values(value)) freezeDeep(child);
        Object.freeze(value);
    }
    return value;
}

function hash(value) { return createHash('sha256').update(stableStringify(value)).digest('hex'); }

function copyFrozenQuoteSnapshot(value) { return freezeDeep(copyJson(value)); }

function integer(value, minimum = 1) {
    if (!Number.isSafeInteger(value) || value < minimum || Object.is(value, -0)) fail();
    return value;
}

// 金额、比例与时间只接收规范十进制整数字符串，不接收浮点或指数表示。
function decimal(value, maximum = MAX_ATOMS) {
    if (typeof value !== 'string' || value.length > 18 || !/^(0|[1-9][0-9]*)$/.test(value)) fail();
    const parsed = BigInt(value);
    if (parsed > maximum) fail();
    return parsed;
}

function timestamp(value) { return decimal(value, MAX_TIME_US); }
function nullableTime(value) { return value === null ? null : timestamp(value); }

function identifier(value, model = false) {
    if (typeof value !== 'string' || !(model ? /^[a-z0-9][a-z0-9._-]{1,127}$/
        : /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/).test(value)) fail();
}

function enabled(value) { if (typeof value !== 'boolean') fail(); }

function list(value) { if (!Array.isArray(value) || value.length === 0 || value.length > 256) fail(); }

function unique(values) { if (new Set(values).size !== values.length) fail(); }

function validateBands(bands, start, end, validateItem) {
    list(bands);
    for (const band of bands) {
        object(band);
        integer(band.start, 0);
        integer(band.end);
        validateItem(band);
    }
    bands.sort((a, b) => a.start - b.start);
    let cursor = start;
    for (const band of bands) {
        if (band.start !== cursor || band.end <= band.start) fail();
        cursor = band.end;
    }
    if (cursor !== end) fail();
}

function validateConfig(config) {
    const common = ['modelId', 'modelVersion', 'pricingVersion', 'enabled', 'templateType',
        'currencyUnit', 'roundingMode', 'precisionVersion', 'roundingModeVersion'];
    const optional = ['quoteValidityMs'];
    if (config.templateType === 'image_resolution_quantity') {
        keys(config, [...common, 'quantityMode', 'maxOutputCount', 'resolutions'], optional);
        integer(config.maxOutputCount);
        if (config.maxOutputCount === Number.MAX_SAFE_INTEGER) fail();
        if (!['per_unit', 'base_plus_increment', 'tiered_total'].includes(config.quantityMode)) fail('TEMPLATE_MISMATCH');
        list(config.resolutions);
        for (const item of config.resolutions) {
            const priceFields = config.quantityMode === 'per_unit' ? ['unitPriceTenths']
                : config.quantityMode === 'base_plus_increment' ? ['basePriceTenths', 'incrementPriceTenths'] : ['quantityBands'];
            keys(item, ['resolutionKey', 'enabled', ...priceFields]);
            if (typeof item.resolutionKey !== 'string' || !/^[1-9][0-9]{0,7}x[1-9][0-9]{0,7}$/.test(item.resolutionKey)) fail();
            enabled(item.enabled);
            if (config.quantityMode === 'tiered_total') {
                validateBands(item.quantityBands, 1, config.maxOutputCount + 1, band => {
                    keys(band, ['start', 'end', 'totalPriceTenths']);
                    decimal(band.totalPriceTenths);
                });
            } else for (const field of priceFields) decimal(item[field]);
        }
        unique(config.resolutions.map(item => item.resolutionKey));
        config.resolutions.sort((a, b) => a.resolutionKey < b.resolutionKey ? -1 : a.resolutionKey > b.resolutionKey ? 1 : 0);
    } else if (config.templateType === 'video_duration_fps') {
        keys(config, [...common, 'durationMode', 'minDurationMs', 'maxDurationMs', 'durationBands', 'fpsRates'],
            [...optional, 'frameRemainderMode']);
        integer(config.minDurationMs);
        integer(config.maxDurationMs);
        if (config.maxDurationMs < config.minDurationMs || config.maxDurationMs === Number.MAX_SAFE_INTEGER) fail();
        if (!['per_second', 'band_total', 'per_frame'].includes(config.durationMode)) fail('TEMPLATE_MISMATCH');
        if (config.durationMode === 'per_frame') {
            if (config.frameRemainderMode !== 'require_exact') fail('TEMPLATE_MISMATCH');
        } else if (Object.hasOwn(config, 'frameRemainderMode')) fail();
        validateBands(config.durationBands, config.minDurationMs, config.maxDurationMs + 1, band => {
            keys(band, ['start', 'end', 'enabled', 'unitPriceTenths']);
            enabled(band.enabled);
            decimal(band.unitPriceTenths);
        });
        list(config.fpsRates);
        for (const rate of config.fpsRates) {
            keys(rate, ['fps', 'enabled', 'numerator', 'denominator']);
            integer(rate.fps);
            enabled(rate.enabled);
            decimal(rate.numerator);
            if (decimal(rate.denominator) === 0n) fail();
        }
        unique(config.fpsRates.map(rate => rate.fps));
        config.fpsRates.sort((a, b) => a.fps - b.fps);
    } else fail('TEMPLATE_MISMATCH');
    identifier(config.modelId, true);
    integer(config.modelVersion);
    identifier(config.pricingVersion);
    enabled(config.enabled);
    // 本切片的精度版本是毫秒/1000 精确有理数，舍入版本只允许最终 ceil。
    if (config.currencyUnit !== 'credit_tenths' || config.roundingMode !== 'ceil_to_atom'
        || config.precisionVersion !== 'integer_rational_ms_v1' || config.roundingModeVersion !== 'ceil_to_atom_v1') fail();
    if (Object.hasOwn(config, 'quoteValidityMs')) {
        integer(config.quoteValidityMs);
        if (config.quoteValidityMs < 300000 || config.quoteValidityMs > 86400000) fail();
    }
    return freezeDeep(config);
}

function prepareVersion(record) {
    keys(record, ['config', 'publishedAtUs', 'effectiveFromUs', 'revokedAtUs', 'cancelledAtUs']);
    object(record.config);
    const published = nullableTime(record.publishedAtUs);
    const effective = timestamp(record.effectiveFromUs);
    const revoked = nullableTime(record.revokedAtUs);
    const cancelled = nullableTime(record.cancelledAtUs);
    if (effective % 1000000n !== 0n || (published !== null && published > effective)
        || (revoked !== null && cancelled !== null)
        || (revoked !== null && (published === null || revoked < published))
        || (cancelled !== null && (published === null || cancelled < published || cancelled >= effective))) fail();
    const config = validateConfig(record.config);
    return freezeDeep({ ...record, config, configHash: hash(config) });
}

function databaseSample(value) {
    keys(value, ['source', 'epochMicroseconds']);
    if (value.source !== CLOCK_SOURCE) fail('DATABASE_TIME_REQUIRED');
    return timestamp(value.epochMicroseconds);
}

function selectVersion(versions, modelId, selectionAt) {
    // 必须先选唯一时间轴头，随后判撤销，禁止撤销后回退旧价。
    const candidates = versions.filter(version => version.config.modelId === modelId
        && version.publishedAtUs !== null && timestamp(version.publishedAtUs) <= selectionAt
        && timestamp(version.effectiveFromUs) <= selectionAt && version.cancelledAtUs === null);
    candidates.sort((a, b) => a.effectiveFromUs === b.effectiveFromUs ? 0
        : timestamp(a.effectiveFromUs) > timestamp(b.effectiveFromUs) ? -1 : 1);
    const head = candidates[0];
    if (!head || !head.config.enabled || (head.revokedAtUs !== null && timestamp(head.revokedAtUs) <= selectionAt)) fail('NO_ACTIVE_VERSION');
    return head;
}

function multiply(...values) {
    let result = 1n;
    for (const value of values) {
        result *= value;
        if (result > MAX_INTERMEDIATE) fail('RESULT_OVERFLOW');
    }
    return result;
}

function calculate(config, taskType, payload) {
    if (taskType === 'image.generate') {
        if (config.templateType !== 'image_resolution_quantity') fail('TEMPLATE_MISMATCH');
        if (payload.outputCount !== 1) fail('OUTPUT_COUNT_INVALID');
        if (payload.outputCount > config.maxOutputCount) fail('OUTPUT_COUNT_EXCEEDS_LIMIT');
        const item = config.resolutions.find(item => item.resolutionKey === payload.size && item.enabled);
        if (!item) fail('RESOLUTION_UNMAPPED');
        const n = BigInt(payload.outputCount);
        let numerator;
        if (config.quantityMode === 'per_unit') numerator = multiply(decimal(item.unitPriceTenths), n);
        else if (config.quantityMode === 'base_plus_increment') {
            numerator = decimal(item.basePriceTenths) + multiply(decimal(item.incrementPriceTenths), n - 1n);
        } else numerator = decimal(item.quantityBands.find(band => payload.outputCount >= band.start
            && payload.outputCount < band.end).totalPriceTenths);
        return { input: { resolutionKey: payload.size, outputCount: payload.outputCount,
            outputCountSource: 'server_task_type_image_generate_single_v1' }, numerator, denominator: 1n };
    }
    if (taskType !== 'video.generate' || config.templateType !== 'video_duration_fps') fail('TEMPLATE_MISMATCH');
    if (payload.durationMs < config.minDurationMs || payload.durationMs > config.maxDurationMs) fail('DURATION_INVALID');
    const band = config.durationBands.find(band => payload.durationMs >= band.start && payload.durationMs < band.end && band.enabled);
    if (!band) fail('DURATION_UNMAPPED');
    const rate = config.fpsRates.find(rate => rate.fps === payload.fps && rate.enabled);
    if (!rate) fail('FPS_UNMAPPED');
    let units = 1n;
    let divisor = 1n;
    if (config.durationMode === 'per_second') { units = BigInt(payload.durationMs); divisor = 1000n; }
    if (config.durationMode === 'per_frame') {
        const frameNumerator = multiply(BigInt(payload.durationMs), BigInt(payload.fps));
        if (frameNumerator % 1000n !== 0n) fail('DURATION_INVALID');
        units = frameNumerator / 1000n;
    }
    return { input: { durationMs: payload.durationMs, fps: payload.fps },
        numerator: multiply(decimal(band.unitPriceTenths), units, decimal(rate.numerator)),
        denominator: multiply(divisor, decimal(rate.denominator)) };
}

/**
 * 仅可信服务端宿主装配；versions 不得来自客户端。没有 HTTP 接线。
 * pricingPersistence 内部宿主在同一事务持有模型锁后读完整时间轴，再采样 clock_timestamp() 调用。
 * 本接口只能校验采样形状，无法证明调用方实际持锁、时间来源可信或配置已持久化。
 * task/quote/reserve 原子写入及派发前历史 intent/到期裁决均由未来事务协调器负责。
 */
function createTrustedQuoteService({ versions } = {}) {
    if (!Array.isArray(versions) || versions.length === 0) fail();
    if (versions.length > MAX_PRICING_VERSIONS) fail('VERSION_HISTORY_LIMIT');
    if (Reflect.ownKeys(versions).length !== versions.length + 1) fail();
    const prepared = [];
    for (let index = 0; index < versions.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(versions, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
        // 每个版本各自受JSON节点/深度限制，避免累计历史触发单个配置的节点预算。
        prepared.push(prepareVersion(copyJson(descriptor.value)));
    }
    unique(prepared.map(record => `${record.config.modelId}:${record.config.pricingVersion}`));
    unique(prepared.filter(record => record.publishedAtUs !== null)
        .map(record => `${record.config.modelId}:${record.effectiveFromUs}`));
    freezeDeep(prepared);
    return Object.freeze({
        quote(args) {
            const copied = copyJson(args);
            keys(copied, ['request', 'databaseTime']);
            const selectionAt = databaseSample(copied.databaseTime);
            let request;
            try {
                request = validateCreateTaskRequest(copied.request);
                const fields = request.taskType === 'image.generate'
                    ? ['logicalModelId', 'prompt', 'aspectRatio', 'size', 'outputCount']
                    : ['logicalModelId', 'prompt', 'durationMs', 'fps'];
                keys(request.payload, fields);
            } catch { fail('INPUT_INVALID'); }
            const version = selectVersion(prepared, request.payload.logicalModelId, selectionAt);
            const config = version.config;
            const { input, numerator, denominator } = calculate(config, request.taskType, request.payload);
            const atoms = numerator / denominator + (numerator % denominator === 0n ? 0n : 1n);
            if (atoms > MAX_ATOMS) fail('RESULT_OVERFLOW');
            const validityMs = config.quoteValidityMs ?? DEFAULT_VALIDITY_MS;
            const expiresAt = selectionAt + BigInt(validityMs) * 1000n;
            if (expiresAt > MAX_TIME_US) fail('RESULT_OVERFLOW');
            const snapshot = {
                snapshotVersion: 1, taskType: request.taskType, modelId: config.modelId,
                modelVersion: config.modelVersion, pricingVersion: config.pricingVersion,
                configHash: version.configHash, pricingConfig: config,
                normalizedInput: input, currencyUnit: config.currencyUnit,
                precisionVersion: config.precisionVersion, roundingMode: config.roundingMode,
                roundingModeVersion: config.roundingModeVersion,
                exactResult: { numerator: numerator.toString(), denominator: denominator.toString() },
                credit_tenths: atoms.toString(),
                databaseTime: { source: CLOCK_SOURCE, unit: 'unix_microseconds', sampledAtUs: selectionAt.toString(),
                    requiredContext: 'after_model_lock_in_creation_transaction' },
                createdAtUs: selectionAt.toString(), expiresAtUs: expiresAt.toString(), quoteValidityMs: validityMs,
                expiryPolicy: 'before_first_dispatch_intent_only_no_auto_requote',
                versionLifecycle: { publishedAtUs: version.publishedAtUs, effectiveFromUs: version.effectiveFromUs,
                    revokedAtUs: version.revokedAtUs, cancelledAtUs: version.cancelledAtUs },
            };
            return freezeDeep({ ...snapshot, snapshotHash: hash(snapshot) });
        },
    });
}

// 持久化宿主复用同一配置校验与规范化，不能另造宽松的发布规则。
function preparePricingVersion(record) { return prepareVersion(copyJson(record)); }

module.exports = { createTrustedQuoteService, preparePricingVersion, copyFrozenQuoteSnapshot, PricingError };
