'use strict';

const { createHash } = require('node:crypto');
const { PricingError } = require('./pricingQuote');
const { stableStringify } = require('./taskSubmission');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 只接受可信解析器产出、且哈希自洽的完整路由快照：缺一即拒绝，不能带着空路由建任务或冻结额度。
 * 哈希必须在应用侧重算——数据库无法发现「改快照不改哈希」。
 */
function assertTrustedRoute(resolved, normalized) {
    const fail = (reason) => { throw new PricingError(reason); };
    if (!resolved || typeof resolved !== 'object') fail('MODEL_ROUTE_REQUIRED');
    const { logicalModelPk, routeSnapshot, routeSnapshotVersion, routeSnapshotHash } = resolved;
    if (typeof logicalModelPk !== 'string' || !UUID_PATTERN.test(logicalModelPk)) fail('MODEL_ROUTE_INVALID');
    if (!routeSnapshot || typeof routeSnapshot !== 'object' || Array.isArray(routeSnapshot)) fail('MODEL_ROUTE_INVALID');
    if (!Number.isSafeInteger(routeSnapshotVersion) || routeSnapshotVersion <= 0) fail('MODEL_ROUTE_INVALID');
    if (typeof routeSnapshotHash !== 'string' || !/^[0-9a-f]{64}$/.test(routeSnapshotHash)) fail('MODEL_ROUTE_INVALID');
    if (routeSnapshot.snapshotVersion !== routeSnapshotVersion) fail('MODEL_ROUTE_INVALID');
    if (createHash('sha256').update(stableStringify(routeSnapshot)).digest('hex') !== routeSnapshotHash) {
        fail('MODEL_ROUTE_HASH_MISMATCH');
    }
    if (routeSnapshot.logicalModelId !== normalized.payload.logicalModelId
        || routeSnapshot.capabilitySnapshot?.operation !== normalized.taskType) fail('MODEL_ROUTE_INVALID');
    return Object.freeze({ logicalModelPk, routeSnapshot, routeSnapshotVersion, routeSnapshotHash });
}

module.exports = { assertTrustedRoute, UUID_PATTERN };
