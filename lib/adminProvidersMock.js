'use strict';

function readAdminProvidersMock() {
  return {
    providers: [
      { id: 'demo-provider-a', name: '演示 Provider A', enabled: true, priority: 10, health: 'healthy', verification: 'verified', lastCheckedAt: '2026-11-19T08:00:00Z' },
      { id: 'demo-provider-b', name: '演示 Provider B', enabled: true, priority: 20, health: 'degraded', verification: 'pending', lastCheckedAt: '2026-11-19T08:00:00Z' },
      { id: 'demo-provider-c', name: '演示 Provider C', enabled: false, priority: 30, health: 'unchecked', verification: 'unverified', lastCheckedAt: null },
      { id: 'demo-provider-idle', name: '演示 Provider · 未关联', enabled: false, priority: 100, health: 'unchecked', verification: 'unverified', lastCheckedAt: null },
    ],
    models: [
      { id: 'demo-image-standard', name: '演示图像 · 标准' },
      { id: 'demo-video-motion', name: '演示视频 · 动态' },
    ],
    routes: [
      { id: 'demo-route-image', modelId: 'demo-image-standard', primaryProviderId: 'demo-provider-a', backupProviderId: 'demo-provider-b' },
      { id: 'demo-route-video', modelId: 'demo-video-motion', primaryProviderId: 'demo-provider-b', backupProviderId: 'demo-provider-c' },
    ],
  };
}

module.exports = { readAdminProvidersMock };
