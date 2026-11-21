'use strict';

const models = [
  {
    id: 'demo-image-standard', name: '演示图像 · 标准', type: 'image', enabled: true,
    capabilities: ['text-to-image', 'image-to-image'], tiers: ['1024 × 1024', '1536 × 1024'],
    providerBindings: ['演示 Provider A / 图像绑定'], pricingStatus: 'configured',
  },
  {
    id: 'demo-image-draft', name: '演示图像 · 草稿', type: 'image', enabled: false,
    capabilities: ['text-to-image'], tiers: ['512 × 512'],
    providerBindings: [], pricingStatus: 'unconfigured',
  },
  {
    id: 'demo-video-motion', name: '演示视频 · 动态', type: 'video', enabled: true,
    capabilities: ['text-to-video', 'image-to-video'], tiers: ['5 秒 / 24 fps', '10 秒 / 24 fps'],
    providerBindings: ['演示 Provider B / 视频绑定'], pricingStatus: 'draft',
  },
  {
    id: 'demo-video-preview', name: '演示视频 · 预览', type: 'video', enabled: false,
    capabilities: ['image-to-video'], tiers: [], providerBindings: [], pricingStatus: 'unconfigured',
  },
];

function readAdminModelsMock() {
  return { models: models.map(row => ({ ...row, capabilities: [...row.capabilities], tiers: [...row.tiers], providerBindings: [...row.providerBindings] })) };
}

module.exports = { readAdminModelsMock };
