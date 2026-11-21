'use strict';

const { readAdminModelsMock } = require('./adminModelsMock');

const operations = {
  image: ['image.generate', 'image.edit'],
  video: ['video.generate', 'video.generate_from_image', 'video.edit'],
};
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const positive = value => Number.isSafeInteger(value) && value > 0;
const invalid = () => { throw new Error('ADMIN_MODELS_DATA_INVALID'); };

async function readAdminModelsApi(params = {}, { signal, fetcher = globalThis.fetch } = {}) {
  const query = new URLSearchParams();
  for (const key of ['q', 'type', 'enabled', 'limit', 'cursor']) {
    if (params[key] != null && params[key] !== '') query.set(key, params[key]);
  }
  const response = await fetcher(`/api/admin/models?${query}`, { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal, redirect: 'error' });
  if (!response.ok) {
    const error = new Error('ADMIN_MODELS_UNAVAILABLE');
    error.status = response.status;
    throw error;
  }
  return response.json();
}

function createAdminModelsGateway({ transport = readAdminModelsApi } = {}) {
  return Object.freeze({ async read(params = {}, options) {
    const body = await transport(params, options);
    const meta = body?.meta;
    const data = body?.data;
    if (body?.ok !== true || body.error !== null || meta?.source !== 'api' || meta.mock !== false
      || meta.writesAvailable !== false || meta.contractVersion !== 'admin_models_read_v1'
      || meta.timeZone !== 'UTC' || meta.scope !== 'current_admin_catalog'
      || typeof meta.asOf !== 'string' || !Number.isFinite(Date.parse(meta.asOf))
      || typeof meta.requestId !== 'string' || !meta.requestId || body.requestId !== meta.requestId
      || meta.capabilities?.catalogRead !== true || meta.capabilities.bindingsRead !== true
      || meta.capabilities.pricingRead !== false || meta.capabilities.historyRead !== false
      || !Array.isArray(meta.orderBy) || meta.orderBy.length !== 2
      || meta.orderBy[0] !== 'logicalModelId:C:asc' || meta.orderBy[1] !== 'logicalModelPk:asc'
      || !Array.isArray(data?.models) || data.models.length > 50
      || !(data.nextCursor === null || (typeof data.nextCursor === 'string' && /^[A-Za-z0-9_-]{1,1536}$/.test(data.nextCursor)))) invalid();
    const seen = new Set();
    const seenPks = new Set();
    const models = data.models.map(row => {
      if (!row || typeof row.logicalModelId !== 'string' || !idPattern.test(row.logicalModelId)
        || seen.has(row.logicalModelId) || typeof row.displayName !== 'string' || typeof row.enabled !== 'boolean'
        || !row.displayName.trim() || typeof row.logicalModelPk !== 'string' || !uuid.test(row.logicalModelPk) || seenPks.has(row.logicalModelPk)
        || !Object.hasOwn(operations, row.type) || !positive(row.catalogVersion) || row.logicalModelVersion !== row.catalogVersion
        || !(row.parameterSchemaVersion === null || positive(row.parameterSchemaVersion))
        || !Array.isArray(row.capabilities) || !row.capabilities.every(value => operations[row.type].includes(value))
        || new Set(row.capabilities).size !== row.capabilities.length
        || row.capabilitiesState !== (row.capabilities.length ? 'known' : 'unsupported')
        || row.bindings?.readable !== true || !Array.isArray(row.bindings.data) || row.bindings.data.length > 50
        || row.pricing?.readable !== false || row.pricing.reason !== 'NOT_AUTHORIZED' || row.pricing.data !== null) invalid();
      const template = row.capabilityTemplate;
      if (template !== null && (typeof template?.key !== 'string' || !template.key.trim() || !positive(template.version))) invalid();
      seen.add(row.logicalModelId);
      seenPks.add(row.logicalModelPk);
      const bindings = row.bindings.data.map(binding => {
        if (!binding || typeof binding.providerInstanceId !== 'string' || typeof binding.providerModelId !== 'string'
          || !uuid.test(binding.providerInstanceId) || !uuid.test(binding.providerModelId)
          || !['primary', 'secondary'].includes(binding.routeRole) || !positive(binding.routeOrder)
          || !positive(binding.bindingVersion) || typeof binding.active !== 'boolean') invalid();
        const { providerInstanceId, providerModelId, routeRole, routeOrder, bindingVersion, active } = binding;
        return { providerInstanceId, providerModelId, routeRole, routeOrder, bindingVersion, active };
      });
      return { id: row.logicalModelId, name: row.displayName, type: row.type, enabled: row.enabled,
        catalogVersion: row.catalogVersion, logicalModelPk: row.logicalModelPk, capabilities: [...row.capabilities],
        capabilitiesState: row.capabilitiesState, parameterSchemaVersion: row.parameterSchemaVersion,
        capabilityTemplate: template === null ? null : { key: template.key, version: template.version }, bindings };
    });
    return { source: 'api', mock: false, writesAvailable: false, models, nextCursor: data.nextCursor,
      meta: { requestId: meta.requestId, asOf: meta.asOf, timeZone: 'UTC' } };
  } });
}

const capabilityOptions = {
  image: [['text-to-image', '文生图'], ['image-to-image', '图生图']],
  video: [['text-to-video', '文生视频'], ['image-to-video', '图生视频']],
};
const pricingLabels = { configured: '已配置（演示）', draft: '草稿（演示）', unconfigured: '未配置（演示）' };
const idPattern = /^[a-z0-9][a-z0-9._-]{1,127}$/;

function validateModelDraft(draft, models = []) {
  const id = typeof draft.id === 'string' ? draft.id.trim() : '';
  const name = typeof draft.name === 'string' ? draft.name.trim() : '';
  const errors = {};
  if (!idPattern.test(id)) errors.id = '稳定 ID 须为 2–128 位小写字母、数字、点、下划线或短横线，并以字母或数字开头。';
  else if (models.some(row => row.id === id)) errors.id = '稳定 ID 已存在，请更换；演示也不允许重复。';
  if (!name || name.length > 80) errors.name = '名称须为 1–80 个字符，不能仅为空白。';
  const allowed = Object.hasOwn(capabilityOptions, draft.type) ? capabilityOptions[draft.type].map(([key]) => key) : [];
  if (!allowed.length) errors.type = '请选择 image 或 video 类型。';
  if (!Array.isArray(draft.capabilities) || !draft.capabilities.length || !draft.capabilities.every(key => allowed.includes(key))) {
    errors.capabilities = '请至少选择一项与模型类型一致的能力。';
  }
  return { errors, value: { id, name, type: draft.type, capabilities: Array.isArray(draft.capabilities) ? [...new Set(draft.capabilities)] : [] } };
}

function adaptAdminModels(data, source) {
  if (source !== 'mock') throw new Error('Mock 模型数据来源必须明确为 mock；API 请使用独立 gateway');
  if (!Array.isArray(data.models)) throw new Error('模型目录结构无效');
  const models = [];
  for (const row of data.models) {
    if (Object.keys(validateModelDraft(row, models).errors).length || typeof row.enabled !== 'boolean'
      || !Array.isArray(row.tiers) || !row.tiers.every(value => typeof value === 'string')
      || !Array.isArray(row.providerBindings) || !row.providerBindings.every(value => typeof value === 'string')
      || !Object.hasOwn(pricingLabels, row.pricingStatus)) throw new Error('模型目录条目无效');
    // 隔离 Mock 专用旧展示契约；真实读取必须走独立 API gateway。
    models.push({
      ...validateModelDraft(row).value, enabled: row.enabled,
      tiers: [...row.tiers], providerBindings: [...row.providerBindings], pricingStatus: row.pricingStatus,
    });
  }
  return { source, models };
}

async function loadAdminModels({ read = readAdminModelsMock, source = 'mock' } = {}) {
  if (source !== 'mock') throw new Error('Mock 模型数据来源必须明确为 mock；API 请使用独立 gateway');
  return adaptAdminModels(await read(), source);
}

function filterAdminModels(models, { search = '', type = 'all', enabled = 'all' } = {}) {
  const needle = search.trim().toLowerCase();
  return models.filter(row => (!needle || row.id.includes(needle) || row.name.toLowerCase().includes(needle))
    && (type === 'all' || row.type === type)
    && (enabled === 'all' || String(row.enabled) === enabled));
}

function addMockModel(data, draft) {
  if (data.source !== 'mock') throw new Error('仅允许操作隔离 Mock 演示数据');
  const { errors, value } = validateModelDraft(draft, data.models);
  if (Object.keys(errors).length) return { data, errors };
  const model = { ...value, enabled: false, tiers: [], providerBindings: [], pricingStatus: 'unconfigured' };
  return { data: { ...data, models: [...data.models, model] }, model, errors: {} };
}

function setMockModelEnabled(data, id, enabled) {
  if (data.source !== 'mock') throw new Error('仅允许操作隔离 Mock 演示数据');
  if (typeof enabled !== 'boolean' || !data.models.some(row => row.id === id)) throw new Error('演示模型或启用状态无效');
  return { ...data, models: data.models.map(row => row.id === id ? { ...row, enabled } : row) };
}

module.exports = { capabilityOptions, pricingLabels, validateModelDraft, adaptAdminModels, loadAdminModels, readAdminModelsApi, createAdminModelsGateway, filterAdminModels, addMockModel, setMockModelEnabled };
