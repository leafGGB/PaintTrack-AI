'use strict';

// 全部金额均为虚构测试值，不是建议或默认商业价格；时钟永不推进。
const AS_OF = '2026-11-19T08:00:00Z';
const meta = Object.freeze({ source: 'mock', mock: true, writesAvailable: true });
const copy = value => JSON.parse(JSON.stringify(value));
function config(modelId, pricingVersion, type, unitPriceTenths) {
  const common = { modelId, pricingVersion, modelVersion: 1, enabled: true, currencyUnit: 'credit_tenths',
    roundingMode: 'ceil_to_atom', precisionVersion: 'integer_rational_ms_v1', roundingModeVersion: 'ceil_to_atom_v1' };
  return type === 'image' ? { ...common, templateType: 'image_resolution_quantity', quantityMode: 'per_unit', maxOutputCount: 1,
    resolutions: [{ resolutionKey: '1024x1024', enabled: true, unitPriceTenths }, { resolutionKey: '1536x864', enabled: true, unitPriceTenths }] }
    : { ...common, templateType: 'video_duration_fps', durationMode: 'per_second', minDurationMs: 1, maxDurationMs: 6000,
      durationBands: [{ start: 1, end: 3000, enabled: true, unitPriceTenths }, { start: 3000, end: 6001, enabled: true, unitPriceTenths }],
      fpsRates: [{ fps: 24, enabled: true, numerator: '1', denominator: '1' }, { fps: 30, enabled: true, numerator: '3', denominator: '2' }] };
}
function readAdminPricingMock() {
  const row = (id, version, type, amount, effectiveFrom, changes = {}) => ({ config: config(id, version, type, amount),
    effectiveFrom, publishedAt: '2026-11-01T00:00:00Z', cancelledAt: null, revokedAt: null, ...changes });
  return { clock: { asOf: AS_OF, timeZone: 'UTC', fixed: true },
    models: [{ id: 'demo-price-image', name: '演示图片模型', type: 'image' }, { id: 'demo-price-video', name: '演示视频模型', type: 'video' }],
    versions: [
      row('demo-price-image', 'demo-v1', 'image', '7', '2026-11-02T00:00:00Z'),
      row('demo-price-image', 'demo-v2', 'image', '11', '2026-11-18T00:00:00Z'),
      row('demo-price-image', 'demo-v3', 'image', '13', '2026-11-20T00:00:00Z'),
      row('demo-price-image', 'demo-cancelled', 'image', '0', '2026-11-21T00:00:00Z', { cancelledAt: AS_OF }),
      row('demo-price-video', 'demo-v1', 'video', '3', '2026-11-02T00:00:00Z'),
      row('demo-price-video', 'demo-v2', 'video', '9', '2026-11-18T00:00:00Z', { revokedAt: AS_OF }),
    ] };
}

function createAdminPricingMockTransport() {
  const { adaptSnapshot, assertTenths, isWholeSecond, versionStatus, errors } = require('./adminPricingData');
  let state = readAdminPricingMock();
  const reject = code => { throw Object.assign(new Error(errors[code]), { pricingCode: code }); };
  const result = () => ({ ok: true, data: copy(state), error: null, meta: { ...meta } });
  function aborted(signal) { if (signal?.aborted) reject('ABORTED'); }
  return Object.freeze({ meta,
    async read(input, { signal } = {}) { aborted(signal); return result(); },
    async command(input, { signal } = {}) {
      try {
        aborted(signal);
        if (this?.meta !== meta || this.meta.source !== 'mock') reject('SOURCE_MISMATCH');
        const fields = input?.action === 'createDraft' ? ['action', 'modelId', 'pricingVersion', 'effectiveFrom', 'unitPriceTenths'] : ['action', 'modelId', 'pricingVersion'];
        if (!input || fields.some(field => !Object.hasOwn(input, field)) || Object.keys(input).some(field => !fields.includes(field))) reject('INPUT_INVALID');
        const next = copy(state);
        const model = next.models.find(row => row.id === input?.modelId);
        if (!model) reject('NOT_FOUND');
        const row = next.versions.find(row => row.config.modelId === input.modelId && row.config.pricingVersion === input.pricingVersion);
        if (input.action === 'createDraft') {
          if (typeof input.pricingVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(input.pricingVersion)) reject('INPUT_INVALID');
          assertTenths(input.unitPriceTenths);
          if (!isWholeSecond(input.effectiveFrom) || input.effectiveFrom <= AS_OF) reject('EFFECTIVE_TIME_INVALID');
          if (row) reject('VERSION_CONFLICT');
          next.versions.push({ config: config(model.id, input.pricingVersion, model.type, input.unitPriceTenths),
            effectiveFrom: input.effectiveFrom, publishedAt: null, cancelledAt: null, revokedAt: null });
        } else {
          if (!row) reject('NOT_FOUND');
          const status = versionStatus(row, AS_OF);
          if (input.action === 'publish') {
            if (status !== 'draft') reject('LIFECYCLE_INVALID');
            if (row.effectiveFrom <= AS_OF) reject('EFFECTIVE_TIME_INVALID');
            if (next.versions.some(other => other !== row && other.config.modelId === model.id && other.publishedAt !== null && other.effectiveFrom === row.effectiveFrom)) reject('VERSION_CONFLICT');
            row.publishedAt = AS_OF;
          } else if (input.action === 'cancel') {
            if (status !== 'scheduled') reject('LIFECYCLE_INVALID');
            row.cancelledAt = AS_OF;
          } else if (input.action === 'revoke') {
            // UI 只演示已生效撤销，不冒充 CLI 支持的全部生命周期操作。
            if (status !== 'effective') reject('LIFECYCLE_INVALID');
            row.revokedAt = AS_OF;
          } else reject('INPUT_INVALID');
        }
        adaptSnapshot(next);
        aborted(signal);
        state = next;
        return result();
      } catch (error) {
        const code = Object.hasOwn(errors, error.pricingCode) ? error.pricingCode : 'INPUT_INVALID';
        return { ok: false, data: null, error: { code, message: errors[code] }, meta: { ...meta } };
      }
    },
  });
}

module.exports = { readAdminPricingMock, createAdminPricingMockTransport };
