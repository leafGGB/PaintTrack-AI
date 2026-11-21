'use strict';

// 仅供 analytics UI 开发的固定演示响应，不是数据库失败时的回退数据。
function readAdminAnalyticsMock() {
  return {
    models: [
      { logicalModelPk: '00000001-0000-4000-8000-000000000000', logicalModelId: 'demo.image-studio', taskCount: '120', succeededTaskCount: '90' },
      { logicalModelPk: '00000002-0000-4000-8000-000000000000', logicalModelId: 'demo.video-motion', taskCount: '75', succeededTaskCount: '50' },
      { logicalModelPk: '00000003-0000-4000-8000-000000000000', logicalModelId: 'demo.image-lite', taskCount: '35', succeededTaskCount: '20' },
    ],
    users: [
      { userId: '10000001-0000-4000-8000-000000000000', email: null, profileAvailable: false, taskCount: '110', succeededTaskCount: '80', settledTenths: '1801' },
      { userId: '10000002-0000-4000-8000-000000000000', email: null, profileAvailable: false, taskCount: '80', succeededTaskCount: '55', settledTenths: '0' },
      { userId: '10000003-0000-4000-8000-000000000000', email: null, profileAvailable: false, taskCount: '50', succeededTaskCount: '31', settledTenths: '699' },
      { userId: '10000004-0000-4000-8000-000000000000', email: null, profileAvailable: false, taskCount: '0', succeededTaskCount: '0', settledTenths: '20' },
    ],
    totals: { taskCount: '240', succeededTaskCount: '166', settledTenths: '2520', modelCount: '3', userCount: '4' },
    unclassified: {
      taskCount: '10', succeededTaskCount: '6',
      reasons: {
        missing_route: { taskCount: '6', succeededTaskCount: '4' },
        unsupported_version: { taskCount: '3', succeededTaskCount: '1' },
        invalid_identity: { taskCount: '1', succeededTaskCount: '1' },
      },
    },
    window: { from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z', asOf: '2026-11-01T00:00:00.000000Z', timeZone: 'UTC', interval: '[from,to)', defaultDays: 31, maxDays: 31 },
    timeBasis: {
      taskCount: 'generation_tasks.created_at',
      succeededTaskCount: 'generation_tasks.created_at; current status=succeeded',
      settledTenths: 'credit_ledger_events.created_at; kind=settle',
    },
    unitVersion: 'credit_tenths_v1', topLimit: 10, orderBy: 'taskCount DESC, identity ASC',
    capabilities: { attemptsAvailable: false, attemptCount: null, reason: '当前读取边界未开放 Provider attempt' },
    modelAttribution: 'persisted_identity_structure_only',
    scope: 'image.generate/video.generate; includes local mock; 模型任务量（非实际上游请求数）',
  };
}

module.exports = { readAdminAnalyticsMock };
