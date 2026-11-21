'use strict';

const MAX_TENTHS = 9007199254740991n;
const errors = Object.freeze({
  INPUT_INVALID: '输入无效。', AMOUNT_INVALID: '金额须为非负十进制，最多一位小数，且不超过 900719925474099.1 credit。',
  EFFECTIVE_TIME_INVALID: '生效点须为有效 UTC 整秒时间，并晚于页面标注的时钟。',
  VERSION_CONFLICT: '版本名或已发布生效点冲突，请追加其他版本。', LIFECYCLE_INVALID: '当前版本不允许此操作。',
  NOT_FOUND: '模型或版本不存在。', WRITES_UNAVAILABLE: '当前数据源未开放命令。',
  SOURCE_MISMATCH: '数据源标识不一致，已停止操作。', CONTRACT_INVALID: '定价接口返回结构无效。',
  TRANSPORT_FAILED: '定价接口暂时不可用；未回退到 Mock。', ABORTED: '请求已取消。',
});
const fail = code => { throw Object.assign(new Error(errors[code]), { pricingCode: code }); };
const clone = value => JSON.parse(JSON.stringify(value));
const idValid = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value);
function isWholeSecond(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value.replace('Z', '.000Z');
}
function assertTenths(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,15})$/.test(value) || BigInt(value) > MAX_TENTHS) fail('AMOUNT_INVALID');
  return value;
}
function parsePricingAmount(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,14})(\.\d)?$/.test(value.trim())) fail('AMOUNT_INVALID');
  const [whole, fraction = '0'] = value.trim().split('.');
  return assertTenths((BigInt(whole) * 10n + BigInt(fraction)).toString());
}
function formatPricingTenths(value) {
  const atoms = BigInt(assertTenths(value));
  return `${atoms / 10n}.${atoms % 10n}`;
}
function versionStatus(row, asOf) {
  if (row.publishedAt === null) return 'draft';
  if (row.cancelledAt !== null) return 'cancelled';
  if (row.revokedAt !== null && row.revokedAt <= asOf) return 'revoked';
  return row.effectiveFrom > asOf ? 'scheduled' : 'effective';
}
function selectPricingHead(data, modelId) {
  // 先选最新头，再判撤销；不能过滤撤销行后回退旧版本。
  const head = data.versions.filter(row => row.config.modelId === modelId && row.publishedAt !== null
    && row.publishedAt <= data.clock.asOf && row.effectiveFrom <= data.clock.asOf && row.cancelledAt === null)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
  return { head: head || null, available: !!head && head.revokedAt === null && head.config.enabled };
}
function preparePricingDraft(data, form) {
  const model = data.models.find(row => row.id === form.modelId);
  if (!model) fail('NOT_FOUND');
  if (!idValid(form.pricingVersion)) fail('INPUT_INVALID');
  if (!isWholeSecond(form.effectiveFrom) || form.effectiveFrom <= data.clock.asOf) fail('EFFECTIVE_TIME_INVALID');
  return { action: 'createDraft', modelId: model.id, pricingVersion: form.pricingVersion,
    effectiveFrom: form.effectiveFrom, unitPriceTenths: parsePricingAmount(form.amount) };
}

// v1 是明确受限的展示/最小表单 DTO，不是所有定价模板的编辑器。
function adaptSnapshot(raw) {
  if (!raw || !isWholeSecond(raw.clock?.asOf) || raw.clock.timeZone !== 'UTC' || typeof raw.clock.fixed !== 'boolean'
    || !Array.isArray(raw.models) || !Array.isArray(raw.versions)) fail('CONTRACT_INVALID');
  const models = raw.models.map(row => {
    if (!idValid(row.id) || typeof row.name !== 'string' || !row.name.trim() || !['image', 'video'].includes(row.type)) fail('CONTRACT_INVALID');
    return { id: row.id, name: row.name, type: row.type };
  });
  if (new Set(models.map(row => row.id)).size !== models.length) fail('CONTRACT_INVALID');
  const versions = raw.versions.map(row => {
    const c = row.config;
    const model = models.find(model => model.id === c?.modelId);
    if (!model || !idValid(c.pricingVersion) || !Number.isSafeInteger(c.modelVersion) || c.modelVersion < 1
      || typeof c.enabled !== 'boolean' || c.currencyUnit !== 'credit_tenths' || c.roundingMode !== 'ceil_to_atom'
      || c.precisionVersion !== 'integer_rational_ms_v1' || c.roundingModeVersion !== 'ceil_to_atom_v1'
      || !isWholeSecond(row.effectiveFrom)) fail('CONTRACT_INVALID');
    const config = { modelId: c.modelId, modelVersion: c.modelVersion, pricingVersion: c.pricingVersion, enabled: c.enabled,
      templateType: c.templateType, currencyUnit: c.currencyUnit, roundingMode: c.roundingMode,
      precisionVersion: c.precisionVersion, roundingModeVersion: c.roundingModeVersion };
    if (model.type === 'image' && c.templateType === 'image_resolution_quantity' && c.quantityMode === 'per_unit'
      && c.maxOutputCount === 1 && Array.isArray(c.resolutions) && c.resolutions.length > 0) {
      Object.assign(config, { quantityMode: c.quantityMode, maxOutputCount: c.maxOutputCount,
        resolutions: c.resolutions.map(band => {
          if (!/^[1-9]\d{0,7}x[1-9]\d{0,7}$/.test(band.resolutionKey) || typeof band.enabled !== 'boolean') fail('CONTRACT_INVALID');
          return { resolutionKey: band.resolutionKey, enabled: band.enabled, unitPriceTenths: assertTenths(band.unitPriceTenths) };
        }) });
    } else if (model.type === 'video' && c.templateType === 'video_duration_fps' && c.durationMode === 'per_second'
      && Number.isSafeInteger(c.minDurationMs) && c.minDurationMs > 0 && Number.isSafeInteger(c.maxDurationMs) && c.maxDurationMs >= c.minDurationMs
      && Array.isArray(c.durationBands) && c.durationBands.length > 0 && Array.isArray(c.fpsRates) && c.fpsRates.length > 0) {
      let cursor = c.minDurationMs;
      const durationBands = c.durationBands.map(band => {
        if (band.start !== cursor || !Number.isSafeInteger(band.end) || band.end <= band.start || typeof band.enabled !== 'boolean') fail('CONTRACT_INVALID');
        cursor = band.end;
        return { start: band.start, end: band.end, enabled: band.enabled, unitPriceTenths: assertTenths(band.unitPriceTenths) };
      });
      if (cursor !== c.maxDurationMs + 1) fail('CONTRACT_INVALID');
      Object.assign(config, { durationMode: c.durationMode, minDurationMs: c.minDurationMs, maxDurationMs: c.maxDurationMs, durationBands,
        fpsRates: c.fpsRates.map(rate => {
          if (!Number.isSafeInteger(rate.fps) || rate.fps < 1 || typeof rate.enabled !== 'boolean' || assertTenths(rate.denominator) === '0') fail('CONTRACT_INVALID');
          return { fps: rate.fps, enabled: rate.enabled, numerator: assertTenths(rate.numerator), denominator: rate.denominator };
        }) });
    } else fail('CONTRACT_INVALID');
    const times = {};
    for (const field of ['publishedAt', 'cancelledAt', 'revokedAt']) {
      if (row[field] !== null && !isWholeSecond(row[field])) fail('CONTRACT_INVALID');
      times[field] = row[field];
    }
    if ((times.cancelledAt && times.revokedAt) || (times.publishedAt === null && (times.cancelledAt || times.revokedAt))
      || (times.publishedAt && times.publishedAt > row.effectiveFrom)
      || (times.cancelledAt && (times.cancelledAt < times.publishedAt || times.cancelledAt >= row.effectiveFrom))
      || (times.revokedAt && times.revokedAt < times.publishedAt)) fail('CONTRACT_INVALID');
    return { config, effectiveFrom: row.effectiveFrom, ...times };
  });
  const names = versions.map(row => `${row.config.modelId}:${row.config.pricingVersion}`);
  const points = versions.filter(row => row.publishedAt !== null).map(row => `${row.config.modelId}:${row.effectiveFrom}`);
  if (new Set(names).size !== names.length || new Set(points).size !== points.length) fail('CONTRACT_INVALID');
  return { clock: { asOf: raw.clock.asOf, timeZone: 'UTC', fixed: raw.clock.fixed }, models, versions };
}

// transport: {meta, read({}, {signal}), command(commandDTO, {signal})}。
// 两方法统一返回 {ok,data,error,meta}；成功 data 均为完整快照，不含类/BigInt/凭据。
// 真实 HTTP transport 须自行提供服务端鉴权、step-up、事务、幂等与持久审计，本模块不实现这些门禁。
function createAdminPricingGateway({ transport } = {}) {
  const selected = transport === undefined ? require('./adminPricingMock').createAdminPricingMockTransport() : transport;
  const source = selected?.meta?.source;
  if (!['mock', 'api'].includes(source) || selected.meta.mock !== (source === 'mock')
    || typeof selected.meta.writesAvailable !== 'boolean' || typeof selected.read !== 'function') throw new TypeError('定价 transport 契约无效');
  const meta = Object.freeze({ source, mock: source === 'mock', writesAvailable: selected.meta.writesAvailable, contractVersion: 'admin_pricing_v1' });
  async function invoke(method, input, { signal } = {}) {
    try {
      if (signal?.aborted) fail('ABORTED');
      if (method === 'command' && (!meta.writesAvailable || typeof selected.command !== 'function')) fail('WRITES_UNAVAILABLE');
      const result = await selected[method](clone(input), { signal });
      if (signal?.aborted) fail('ABORTED');
      if (!result?.meta || result.meta.source !== source || result.meta.mock !== meta.mock || result.meta.writesAvailable !== meta.writesAvailable) fail('SOURCE_MISMATCH');
      if (result.ok === false && result.data === null && Object.hasOwn(errors, result.error?.code)) fail(result.error.code);
      if (result.ok !== true || result.error !== null) fail('CONTRACT_INVALID');
      const data = adaptSnapshot(result.data);
      if (data.clock.fixed !== meta.mock) fail('SOURCE_MISMATCH');
      return { ok: true, data, error: null, meta };
    } catch (error) {
      const code = signal?.aborted || error?.name === 'AbortError' ? 'ABORTED'
        : Object.hasOwn(errors, error?.pricingCode) ? error.pricingCode : 'TRANSPORT_FAILED';
      return { ok: false, data: null, error: { code, message: errors[code] }, meta };
    }
  }
  return Object.freeze({ meta, read: (input = {}, options) => invoke('read', input, options), command: (input, options) => invoke('command', input, options) });
}

module.exports = { createAdminPricingGateway, adaptSnapshot, parsePricingAmount, formatPricingTenths, preparePricingDraft,
  versionStatus, selectPricingHead, isWholeSecond, assertTenths, errors };
