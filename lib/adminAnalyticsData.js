'use strict';

const { readAdminAnalyticsMock } = require('./adminAnalyticsMock');

function formatCreditTenths(value) {
  const amount = BigInt(value);
  return `${amount / 10n}.${amount % 10n}`;
}

function adaptAdminAnalytics(data, source) {
  if (!['mock', 'api'].includes(source)) throw new Error('分析数据来源必须明确');
  if (data.unitVersion !== 'credit_tenths_v1') throw new Error('不支持的积分单位');
  const maximum = data.models.reduce((max, row) => BigInt(row.taskCount) > max ? BigInt(row.taskCount) : max, 0n);
  return {
    ...data,
    source,
    models: data.models.map(row => ({
      ...row,
      // 仅将已限制在 0..100 的可视宽度转为样式字符串，计数不转 Number。
      barWidth: `${maximum === 0n ? 0n : BigInt(row.taskCount) * 100n / maximum}%`,
    })),
    users: data.users.map(row => ({ ...row, settledCredits: formatCreditTenths(row.settledTenths) })),
    totals: { ...data.totals, settledCredits: formatCreditTenths(data.totals.settledTenths) },
  };
}

// 将来真实 fetch 只替换这里的读取来源和 source；异常必须上抛，禁止回退 mock。
async function loadAdminAnalytics({ read = readAdminAnalyticsMock, source = 'mock' } = {}) {
  return adaptAdminAnalytics(await read(), source);
}

module.exports = { loadAdminAnalytics, adaptAdminAnalytics, formatCreditTenths };
