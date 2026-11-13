/** @type {import('next').NextConfig} */
const nextConfig = {
    // WorkBuddy 沙箱会拦截 Next 清理默认 .next；开发/验证时使用一次性的
    // 隔离目录，保留旧缓存并避免启动阶段触发批量删除保护。
    ...(process.env.NODE_ENV === 'development' && /^\.next_local_[a-f0-9]{12}$/.test(process.env.PAINTTRACK_DIST_DIR || '')
        ? { distDir: process.env.PAINTTRACK_DIST_DIR } : {}),
};

module.exports = nextConfig;
