# AGENTS.md — PaintTrack AI 会话入口

任何 AI 编码会话在本仓库动手之前，先读这三份，按序：

1. `docs/ImplementationPlan/PAINTTRACK_ONBOARDING.md` — 项目现状、文档地图、环境搭建、常见坑
2. `docs/ImplementationPlan/PAINTTRACK_DEVELOPMENT_PROCESS.md` — 总体执行顺序与门禁（先看 §10.4 和文末「阶段状态速查」）
3. `docs/records/HANDOFF_2026-11-13.md` — 最近一次交接

要动具体阶段，再加读 `docs/records/PHASE*.md`；涉及数据库加读 `docs/records/DB_SETUP.md`。

## 当前阶段

阶段 0–3 已完成，阶段 5.1–5.12 已完成，阶段 6.1 已完成。当前在 **阶段 6.2 设计收口**：产品规则与技术契约已定，剩余参数待确认。**额度账本、数据库迁移、支付与收费代码均未实现，也未获授权。**

## 硬约束

- **单步推进**：一次只做一个可独立验证的小步骤，完成后停下等用户确认。不要连续跨阶段施工。
- **文档同步**：每步完成后更新总体实施计划、对应阶段设计稿、`docs/records/HANDOFF_*.md`、`.workbuddy/memory/YYYY-MM-DD.md`。历史结论保留并标注「已被取代」，不得直接改写。
- **证据分层**：`npm test` 通过 ≠ 真实 PostgreSQL 验收通过。真实 DB 结论只能引用 `.workbuddy/database-acceptance-*.json` 的 `status`。不得把内存替身当持久化验收。
- **权限不得为通过而放宽**：Web / Worker / cleanup 的表级与列级授权边界不可为让验收变绿而扩大。
- **未批准不得引入**：真实 Provider 凭据与预算、云服务、生产部署平台/地域、支付渠道、新增重型依赖，都需用户明确同意。
- **禁止创建根目录 `.env`**：启动器会拒绝 `.env`、`.env.local`、`.env.development`、`.env.development.local` 并直接退出。配置用命令行内联环境变量。
- **写 API 保持关闭**：Provider 配置写 API、真实余额与计费 UI，在对应门禁通过前不得开放。
- **不得夸大**：不得声称完整 SaaS 已可运营、可收费，或某阶段「已完成」而实际只有离线证据。

## 环境速记

```bash
npm run setup    # 子模块 + 补丁 + 依赖 + 构建，新机器必跑
LOCAL_DATABASE_ADMIN_URL="postgresql://postgres:<密码>@127.0.0.1:5433/postgres" npm run dev
```

Node 22；PostgreSQL 监听 127.0.0.1:5433。

细节见 `docs/ImplementationPlan/PAINTTRACK_ONBOARDING.md`。新会话的开场提示词模板见 `docs/ImplementationPlan/NEW_SESSION_PROMPT.md`。
