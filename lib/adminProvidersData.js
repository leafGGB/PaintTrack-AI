'use strict';

const { readAdminProvidersMock } = require('./adminProvidersMock');

const healthLabels = { healthy: '正常（固定演示）', degraded: '降级（固定演示）', unchecked: '未检查（固定演示）' };
const verificationLabels = { verified: '已验证（固定演示）', pending: '待验证（固定演示）', unverified: '未验证（固定演示）' };
const idPattern = /^[a-z0-9][a-z0-9._-]{1,127}$/;
const validIdentity = row => row && typeof row.id === 'string' && idPattern.test(row.id) && typeof row.name === 'string' && row.name.trim().length > 0 && row.name.length <= 80;

function validateProviderPriority(input) {
  const text = typeof input === 'number' || typeof input === 'string' ? String(input).trim() : '';
  const value = Number(text);
  return /^\d{1,3}$/.test(text) && Number.isInteger(value) && value >= 1 && value <= 100
    ? { value, error: null } : { value: null, error: '演示优先级须为 1–100 的整数，数值越小越优先。' };
}

function adaptAdminProviders(data, source) {
  if (!['mock', 'api'].includes(source)) throw new Error('Provider 数据来源必须明确');
  if (!data || !['providers', 'models', 'routes'].every(key => Array.isArray(data[key]))) throw new Error('Provider 目录结构无效');
  const providers = [];
  for (const row of data.providers) {
    if (!validIdentity(row) || providers.some(item => item.id === row.id) || typeof row.enabled !== 'boolean'
      || typeof row.priority !== 'number' || validateProviderPriority(row.priority).error
      || !Object.hasOwn(healthLabels, row.health) || !Object.hasOwn(verificationLabels, row.verification)
      || !(row.lastCheckedAt === null || (typeof row.lastCheckedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(row.lastCheckedAt) && Number.isFinite(Date.parse(row.lastCheckedAt))))) {
      throw new Error('Provider 条目无效');
    }
    // 白名单投影，不把内部配置或连接字段传入组件。
    providers.push({ id: row.id, name: row.name, enabled: row.enabled, priority: row.priority, health: row.health, verification: row.verification, lastCheckedAt: row.lastCheckedAt });
  }
  const models = [];
  for (const row of data.models) {
    if (!validIdentity(row) || models.some(item => item.id === row.id)) throw new Error('演示关联模型无效');
    models.push({ id: row.id, name: row.name });
  }
  const routes = [];
  for (const row of data.routes) {
    if (!row || typeof row.id !== 'string' || !idPattern.test(row.id) || routes.some(item => item.id === row.id || item.modelId === row.modelId)
      || !models.some(item => item.id === row.modelId) || row.primaryProviderId === row.backupProviderId
      || ![row.primaryProviderId, row.backupProviderId].every(id => providers.some(item => item.id === id))) throw new Error('演示路由无效');
    routes.push({ id: row.id, modelId: row.modelId, primaryProviderId: row.primaryProviderId, backupProviderId: row.backupProviderId });
  }
  return { source, providers, models, routes };
}

async function loadAdminProviders({ read = readAdminProvidersMock, source = 'mock' } = {}) {
  return adaptAdminProviders(await read(), source);
}

function getProviderRoutes(data, providerId) {
  return data.routes.filter(route => [route.primaryProviderId, route.backupProviderId].includes(providerId)).map(route => ({
    ...route, model: data.models.find(model => model.id === route.modelId),
    primary: data.providers.find(provider => provider.id === route.primaryProviderId),
    backup: data.providers.find(provider => provider.id === route.backupProviderId),
    role: route.primaryProviderId === providerId ? '主路由' : '备用路由',
  }));
}

function filterAdminProviders(data, { search = '', enabled = 'all', modelId = 'all' } = {}) {
  const needle = search.trim().toLowerCase();
  return data.providers.filter(row => (!needle || row.id.toLowerCase().includes(needle) || row.name.toLowerCase().includes(needle))
    && (enabled === 'all' || String(row.enabled) === enabled)
    && (modelId === 'all' || getProviderRoutes(data, row.id).some(route => route.modelId === modelId)));
}

function requireMock(data) {
  if (data.source !== 'mock') throw new Error('仅允许操作隔离 Mock 演示数据');
}

function setMockProviderEnabled(data, id, enabled) {
  requireMock(data);
  if (typeof enabled !== 'boolean' || !data.providers.some(row => row.id === id)) throw new Error('演示 Provider 或状态无效');
  return { ...data, providers: data.providers.map(row => row.id === id ? { ...row, enabled } : row) };
}

function setMockProviderPriority(data, id, input) {
  requireMock(data);
  const checked = validateProviderPriority(input);
  if (checked.error || !data.providers.some(row => row.id === id)) throw new Error(checked.error || '演示 Provider 无效');
  return { ...data, providers: data.providers.map(row => row.id === id ? { ...row, priority: checked.value } : row) };
}

function swapMockProviderRoute(data, routeId) {
  requireMock(data);
  if (!data.routes.some(row => row.id === routeId)) throw new Error('演示路由无效');
  // 只交换演示角色；启停和优先级不会触发自动切换，也不会触发调用。
  return { ...data, routes: data.routes.map(row => row.id === routeId ? { ...row, primaryProviderId: row.backupProviderId, backupProviderId: row.primaryProviderId } : row) };
}

module.exports = { healthLabels, verificationLabels, validateProviderPriority, adaptAdminProviders, loadAdminProviders, getProviderRoutes, filterAdminProviders, setMockProviderEnabled, setMockProviderPriority, swapMockProviderRoute };
