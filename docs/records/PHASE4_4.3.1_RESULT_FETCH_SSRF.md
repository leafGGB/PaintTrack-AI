# 阶段 4.3.1：结果 URL 服务端抓取与 SSRF 门禁

- 日期：2026-11-13
- 状态：已实现并完成离线验证；未接入真实公网供应商
- 前置：`PHASE4_STEP1_PROVIDER_CONTRACT.md`（结果契约）、`resultBoundary.js`（结果描述符边界）
- 动因：真实图片 Adapter 只返回 `resultUrl`（`myvignaImageProvider.js` 的 `parseResult`），而 Worker 归档分支只在存在 `bytes` 时执行。缺了这一步，"真实 Provider 出图"必然表现为"任务成功但没有图"。

## 1. 范围

新增 `createResultFetcher()`，把供应商结果 URL 抓成受大小约束的二进制，交给既有 `assetArchive` 归档；架构不变，不新增下载端点、不改动数据库。

不包含：真实公网供应商联调、Provider 侧限速与重试对账、内容签名（magic byte）校验、图片解码或转码。

## 2. 门禁设计

按"越早拒绝越好"排列，任何一步失败都不发起或立即中断连接：

1. **URL 形状**：仅 `http(s)`、禁止 URL 内嵌凭据、`hash` 剥离；非本地测试模式强制 HTTPS 与 80/443 端口。
2. **主机策略**：拒绝回环、RFC1918 私网、CGNAT（100.64/10）、链路本地（169.254/24）、组播与保留段、IPv6 ULA/链路本地，以及 IPv4 映射形式的 IPv6（`::ffff:10.0.0.1`、`::ffff:7f00:1`）。字面量 IP 与解析结果走同一策略，不因"已经是 IP"而跳过。
3. **DNS 重绑定**：只解析一次，随后通过自定义 `lookup` 把连接钉在已验证的那个地址上；HTTPS 的 SNI 与证书校验仍按原主机名进行。这样不存在"校验一个地址、连接另一个地址"的时间窗，也不需要概率性测试去碰运气。
4. **重定向**：不自动跟随。每一跳重新做 1–3 步校验，超过 `maxRedirects` 或缺少 `Location` 即失败。
5. **内容校验**：`Content-Type` 必须与声明的 `mediaType` 前缀匹配；缺失 `Content-Type` 直接拒绝，不做猜测。
6. **体积与时间**：`Content-Length` 预检 + 流式累计双重限额（超限即销毁连接）；socket 空闲超时（持续无数据即失败，不限制总下载时长）；支持 `AbortSignal` 中止，映射为固定错误码。

## 3. 执行器接线

- 抓取发生在**结算事务之外**：供应商 CDN 可能很慢，不能在持有任务行锁时等网络。
- 仅在"已配置归档器且结果只有 URL"时抓取；没有归档器时保持原行为（描述符只记 URL）。
- 抓取失败映射为 `RESULT_FETCH_FAILED`，标记为**可重试**：调用记录停在 accepted，重试会用同一任务号重新取结果，不会重复提交或重复计费。原始原因挂在 `cause` 上，只供本地脱敏诊断输出。
- 归档成功后，任务结果的 `resultUrl` 一律替换为 `/api/assets/:assetId/content`；外部供应商地址不进入任务结果。
- `allowInsecureResultFetch` 是唯一放宽开关（回环 + 明文 + 非常规端口），并且与 `resultBoundary` 共用；`NODE_ENV=production` 时无条件关闭。

## 4. 验证

- `tests/resultFetcher.test.js`（13 项）：正常下载与 MIME、私网/回环拒绝、生产环境强制关闭放宽、URL 形状、DNS 解析到私网且零连接、混合记录只取合规地址并钉住、重定向逐跳校验与上限、相对跳转、Content-Type 三态（匹配/不匹配/缺失）、双重量限额、404/超时/中止、参数校验、地址分类表。
- `tests/taskExecutor.test.js` 新增 2 项：URL-only 结果 → 抓取 → `pending→ready` 归档且描述符替换为授权内容地址；抓取 404 → `RESULT_FETCH_FAILED` 可重试、不开启结算事务、不落任何对象。
- 整仓 `node --test "tests/*.test.js"`：**489 项 / 487 passed / 0 failed / 2 skipped**；ESLint 对改动文件无输出。

## 5. 已知限制

- 未用真实公网供应商与真实 CDN 验证；loopback 测试不能替代对真实网络抖动、CDN 限速、超大文件行为的观察。
- 未做内容签名校验：`Content-Type` 与实际字节是否一致仅由响应头保证。
- 抓取失败的可重试会消耗任务 `max_attempts`；若供应商结果链接本身短期有效，可能三次都失败，需要供应商侧或后续步骤的策略补充。
- 本轮未运行真实 PostgreSQL 隔离验收（本机无 `LOCAL_DATABASE_ADMIN_URL`），数据库路径沿用已通过的归档实现。
