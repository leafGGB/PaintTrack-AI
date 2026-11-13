# PaintTrack 阶段 1–4 状态与验收索引

- 更新日期：2026-11-10
- 用途：集中查看阶段 1–4 的实现证据、验收证据与未覆盖边界；本索引不是当前开发顺序或后续阶段状态来源。
- 口径：`已完成` 仅指本索引所列范围；本地测试或真实 PostgreSQL 隔离验收不等于生产部署、安全认证或外部服务验收。
- 规范入口：仓库外工作区文档 `../ImplementationPlan/PAINTTRACK_DEVELOPMENT_PROCESS.md` 第 10 节是唯一当前执行顺序；本索引及同目录 `DB_SETUP.md` 为仓库内证据入口。

## 总览

| 阶段 | 当前判断 | 结论 |
| --- | --- | --- |
| 1. 架构与基础设施决策 | 基线已完成，生产选型后置 | 设计和风险基线已形成；云服务商、地域、预算、RPO/RTO 等未构成已批准的生产部署决策。 |
| 2. 数据库、配置与服务端基础 | 本地/隔离环境实现已完成 | PostgreSQL、迁移、权限、Worker 与基础恢复有真实隔离验收；对象存储仍是抽象/测试替身，生产运维未验收。 |
| 3. 邮箱认证、用户与权限 | 3.1–3.6 本地/隔离基础已完成 | 认证、授权、清理与持久 outbox 有实现及隔离验收；真实邮件、bootstrap 运维核实、生产认证仍未完成。 |
| 4. 服务端 Provider 适配层 | 部分完成，阶段整体未收口 | 契约、mock、错误/结果边界（含 4.3.1 结果抓取与 SSRF 门禁）、账本和客户端凭据撤除已完成；本地 mock 任务链已闭环，但真实 Provider 与生产对象存储尚未接入。 |

## 阶段 1：架构与基础设施决策

| 步骤 | 状态 | 主要交付/证据 | 验收边界与后置项 |
| --- | --- | --- | --- |
| 1.1 现有能力盘点 | 已完成（文档审查） | `PHASE1_STEP1_CAPABILITY_MATRIX.md` | 源码层审查，不是动态安全测试；列明旧云端 BYO-key 与缺失的 SaaS 权威能力。 |
| 1.2 Vibe-Workflow 审查 | 已完成（文档审查） | `PHASE1_STEP2_VIBE_WORKFLOW_REVIEW.md` | 记录可复用 UI/协议及不可直接用于 SaaS 的执行边界；集成前仍须核验许可证、维护状态及安全隔离。 |
| 1.3 架构与威胁模型 | 已完成（设计基线） | `PHASE1_STEP3_ARCHITECTURE_THREAT_MODEL.md` | 含架构、数据流、概念 ERD、威胁和 ADR；动态渗透/负载测试未包含。 |
| 1.4 基础设施方案 | 已完成（方向确认） | `PHASE1_STEP4_INFRASTRUCTURE_OPTIONS.md` | PostgreSQL、独立 Worker、私有对象存储接口、事务邮件等方向已形成；未确认具体云账户、服务商、地域、规格和购买。 |
| 1.5 数据治理与运维 | 已完成（原则基线） | `PHASE1_STEP5_DATA_GOVERNANCE_OPERATIONS.md` | 数据分类、保留/删除、备份恢复、日志和秘密管理原则已形成；法定期限、实际保留期、RPO/RTO 和责任人未获生产批准。 |

## 阶段 2：数据库、配置与服务端基础

| 步骤/能力 | 状态 | 主要证据 | 验收边界与后置项 |
| --- | --- | --- | --- |
| 配置校验、数据库连接和迁移 | 已完成（本地/隔离） | `DB_SETUP.md`；迁移目录与 `drizzle-kit check` | 迁移工具检查不代表生产库已迁移；`painttrack_dev`/`painttrack_test` 与生产环境隔离。 |
| 健康检查、请求 ID、日志、错误与审计接口 | 已完成（代码/测试） | 应用服务端基础模块及测试；详见路线与工作日志 | 当前审计输出不是数据库内持久原子审计账本；生产日志平台、告警和留存未接入。 |
| 持久任务表与 Worker 租约/恢复 | 已完成（真实 PostgreSQL 隔离验收） | `DB_SETUP.md` 第 11–17 行；报告 `.workbuddy/database-acceptance-mw4l8p2i_781611.json` | 3 个 Worker/12 个任务并发、崩溃恢复、lease fencing 等通过；不代表已部署生产 Worker 或接入 Provider。 |
| 资产元数据与对象存储抽象 | 部分完成（基础/替身 + 软删除 + 对象清理 + Studio 删除入口 + 应用内删除确认全量 + 宿主 TaskCenter 接入） | `DB_SETUP.md` 阶段 5.5–5.11、`lib/server/assetPurge.js`、对象存储适配器、授权与清理测试、`packages/studio/src/taskClient.js`、`packages/studio/src/components/ui/ConfirmDialog.jsx`、`packages/studio/src/confirmCopy.js`、`components/TaskCenter.js`、`tests/studioConfirmDialogMigration.test.js` | 已有 owner 软删除（`DELETE /api/assets/:id`）、独立 cleanup 角色的可重试对象清理（`purged_at`/`purge_attempts`）、Studio 画廊删除入口、**Studio 包内 10 个危险操作入口 + 宿主 `components/TaskCenter.js` 取消任务统一走应用内确认弹窗（仓库内已无原生 `confirm()`，由 7 项源码门禁锁定，扫描范围含宿主 `components/` 与 `app/`）**与最小列级授权；仍缺预签名上传/下载、实际内容检测（magic byte）、孤儿对象（`pending` 行）的 UI 侧过滤、保留政策与生产对象存储闭环。5.12 无数据库变更。 |

## 阶段 3：邮箱认证、用户与权限

| 步骤 | 状态 | 主要证据 | 验收边界与后置项 |
| --- | --- | --- | --- |
| 3.1 注册与邮箱验证 | 已完成（隔离验收） | 综合报告 `.workbuddy/database-acceptance-mw5z8fxe_528a61.json`；本地 HTTP 验收记录 `.workbuddy/phase34-acceptance-20261107.json` | 邮件由显式注入的开发内存 mailer 支持；不代表真实邮件送达。 |
| 3.2 登录、登出与会话 | 已完成（测试/隔离验收） | 认证测试、阶段验收日志及上述综合报告 | Cookie/会话逻辑有本地证据；生产域名、TLS、反向代理和身份攻击演练未验收。 |
| 3.3 角色、授权与所有权 | 已完成（测试/隔离验收） | 授权测试、`/api/admin/summary` 边界与上述综合报告 | 有只读管理 API；无正式管理员后台。 |
| 3.4 密码重置 | 已完成（隔离验收） | `.workbuddy/phase34-acceptance-20261107.json` 指向 `.workbuddy/database-acceptance-mw5sudyi_745bd4.json` | 真实邮件发送仍未接入。 |
| 3.5 Bootstrap 管理员初始化 | 已完成（真实 PostgreSQL 隔离验收） | `.workbuddy/database-acceptance-mw5z8fxe_528a61.json` | 报告不能证明 bootstrap 角色目前已禁用、删除或轮换；须由获授权运维核实。 |
| 3.6a 认证记录清理 | 已完成（真实 PostgreSQL 隔离验收） | `.workbuddy/database-acceptance-mw62cu9c_fac144.json` | 当前 CLI 仅允许 loopback 的 test/acceptance 目标；没有生产清理调度。保留窗口是工程候选值，不是批准的隐私承诺。 |
| 3.6b 持久邮件 outbox | 已完成（真实 PostgreSQL 隔离验收） | `.workbuddy/database-acceptance-mw637r95_38129e.json` | 证明持久队列、幂等键和权限基础；真实供应商、生产秘密注入未接入。 |
| 3.6c outbox 投递 Worker | 已完成（真实 PostgreSQL 隔离验收） | `.workbuddy/database-acceptance-mw64i1ah_205c15.json` | 至少一次尝试，不保证 exactly-once；发送耗时心跳、退信/投诉和生产调度未实现。 |

**阶段 3 明确后置项：**真实邮件供应商、加密密钥注入、生产投递/调度、发送心跳、退信/投诉处理按用户决定延期至真正需要用户注册时；bootstrap 身份回收/轮换待运维核实；MFA/管理员强化认证和正式后台属于阶段 8；账户导出、删除及自助清理属于阶段 11。

## 阶段 4：服务端 Provider 适配层

| 步骤 | 状态 | 主要实现/证据 | 验收边界与后置项 |
| --- | --- | --- | --- |
| 4.1 Provider 契约 | 已完成（设计审查） | `PHASE4_STEP1_PROVIDER_CONTRACT.md` 第 1–14 节 | 契约定义边界；不等于适配器已实现。 |
| 4.2 纯内存 mock Provider | 已完成（定向测试） | `lib/server/providers/mockProvider.js`；`tests/mockProvider.test.js`，5/5 | 不访问网络/数据库、不读取凭据、不接生产 Worker。 |
| 4.3 错误映射与结果输入边界 | 已完成（定向测试） | `lib/server/providers/providerExecution.js`、`resultBoundary.js` 及对应测试 | 校验输入/候选结果；真实 URL 抓取见 4.3.1，动态 SSRF 负例已覆盖，DNS 重绑定以"解析后钉 IP"消除而非概率性测试。 |
| 4.3.1 结果 URL 服务端抓取与 SSRF 门禁 | 已完成（离线：`resultFetcher` 13/13、执行器集成 2/2、整仓 487 passed/0 failed）；记录 `PHASE4_4.3.1_RESULT_FETCH_SSRF.md` | `lib/server/providers/resultFetcher.js`、`tests/resultFetcher.test.js`、`taskExecutor` 抓取接线 | 仅 https（本地测试模式可放宽到回环）、拒绝凭据/非常规端口/私网/链路本地/CGNAT/云元数据/IPv4 映射 IPv6；DNS 只解析一次并把连接钉在已验证 IP 上，逐跳重定向重新校验；Content-Type 必须与声明媒体类型匹配（缺失即拒）、声明长度与流式累计双重限额、socket 空闲超时与中止。抓取在结算事务外进行，失败按可重试处理且不落对象。未覆盖：真实公网供应商、CDN 侧限速/大文件真实表现、内容签名（magic byte）校验未做。 |
| 4.4 Provider 调用账本 | 已完成（真实 PostgreSQL 隔离验收） | `providerCallLedger.js`、`drizzle/0011_provider_calls.sql`；报告 `.workbuddy/database-acceptance-mw8lvo2w_ce1677.json`（70 项，66 passed/0 failed） | 账本和迁移未接入生产 Worker；`0011` 尚未应用至 `painttrack_dev`/`painttrack_test`，避免把隔离验收误作开发库/生产迁移。 |
| 4.5.1 客户端凭据门禁 | 已完成（负向验证） | `tests/clientCredentialBoundary.test.js`、`tests/fixtures/client-credential-allowlist.json` | 扫描覆盖含 `packages/studio/src`；清单零容忍。门禁通过不等于真实网络渗透测试。 |
| 4.5.2 服务端配置入口 | 已完成（单测） | `lib/server/providers/providerConfig.js`、`tests/providerConfig.test.js` | 仅定义服务端环境配置读取与脱敏；当前无已启用真实 Provider。 |
| 4.5.3 撤除客户端凭据/直连 | 已完成（全量测试与静态检查） | `src/lib/providerAvailability.js`、客户端 SDK 和调用点；2026-11-09 `npm test` 222 项/220 通过/0 失败/2 跳过，lint 0 error/11 warning，Drizzle check 通过 | 浏览器密钥路径不得恢复；Provider 未配置只阻止生成调用。早期整页 `ProviderNotConfigured` 占位 UI 已于 2026-11-09 移除，Studio 工作区保留。 |
| 4.6 MyVigna 图片 Adapter 协议切片 | 已实现；loopback mock HTTP 测试 7/7 | `lib/server/providers/myvignaImageProvider.js`、`tests/myvignaImageProvider.test.js`、`lib/server/tasks/imagePayload.js` | 首个协议验证使用 `gpt-image-2` T2I 的 `POST /v1/images/tasks`、Bearer + Idempotency-Key、poll/result URL/Base64 解析。该切片不把产品限制为单模型；未接 Studio/任务级动态路由，未用真实凭据或公网。 |
| 4.7.1 多模型目录与路由数据/API 设计 | 已形成设计稿，待用户评审 | `PHASE4_STEP2_MODEL_CATALOG_ROUTING_DATA_DESIGN.md`；关联 `PHASE4_MULTI_PROVIDER_ROUTING_CONTRACT.md` | 覆盖逻辑模型、Provider 实例、Provider 上游模型、绑定、任务快照、provider_calls 身份扩展、目录/管理 API、权限和迁移策略；无代码/数据库变更。 |
| 4.7.2 Schema/migration 设计与离线实施 | 已完成（0015–0017 离线一致性及隔离验收通过） | `PHASE4_STEP3_SCHEMA_MIGRATION_DESIGN.md`、`drizzle/0016_model_catalog_routing.sql`、`drizzle/0017_model_catalog_public.sql`、`tests/databaseLifecycle.test.js` | 已同步 schema、0015–0017 snapshot、journal 和 SQL；数据库生命周期测试、项目 `db:migrate:check` 及 0017 隔离 PostgreSQL 升级验收均通过。 |
| 4.7.3 Schema/migration 隔离数据库验收 | **passed（0016 88 项；0017 本轮 91 项通过）** | `.workbuddy/database-acceptance-mwagpqj2_9ec86c.json`、`.workbuddy/database-acceptance-mwbfpxyv_cdb4c7.json` | 0016 于 2026-11-10 通过 88 项验收；2026-11-11 在随机 loopback 隔离库完成 0017 扩展验收，91 项 passed、0 failed。新增验证非空 0015→0016 与 0016→0017 分段升级只追加对应迁移、历史任务/provider_calls 路由字段保持 NULL、Web 角色只读安全目录视图且隐藏未验证路由和上游敏感配置，并重跑认证/任务/Worker 等既有 fixture。报告中 4 条 `running` 是阶段开始标记，不是失败项。只创建报告列出的隔离库和三个随机角色；未连接或修改 `painttrack_dev`、`painttrack_test` 或生产库。 |
| 4.7.4 动态目录和配置 API 实现 | **部分完成：公共只读动态目录已完成；管理员配置写 API 等待 8.1 最终验收** | `lib/server/modelCatalog.js`、`lib/server/catalogHttp.js`、`app/api/catalog/models/route.js`、`model_catalog_public` 视图、报告 `.workbuddy/database-acceptance-mwbfpxyv_cdb4c7.json` | 公共目录只暴露安全逻辑模型字段，含认证、Origin 校验、过滤、ETag/304 和私有缓存；不返回 Provider ID、Base URL、凭据引用、上游模型名、mapping、成本或备用路由。定向测试 24/24、真实隔离验收 91/91 通过。管理员配置写 API（Provider 实例、上游模型、逻辑模型、绑定的增删改、启停、版本和审计）属于本步骤剩余工作，因第 8.1 节 MFA/强化认证门禁暂不开放。**Studio 接入与任务路由快照已于 2026-11-13 完成**（Studio 走 `/api/tasks`、Worker 按快照选路、本地 mock 闭环真实 PG 通过），此句原"仍未实现"为当时状态。 |

**阶段 4 未完成项：**用户选择的自定义服务端 API Adapter、多 Provider 配置/逻辑模型路由、与阶段 5 任务 API/Worker 的生产闭环尚未完成；真实结果抓取、动态 SSRF/DNS 重绑定测试、结果写入真实对象存储和供应商成本对账未完成。阶段 4 只能标为“前置安全与账本能力完成，整体未收口”。历史资料中的 MuAPI 计划不再是产品默认目标。

## 阶段 5–6 状态指针（不替代主路线）

阶段 5.1–5.4 已完成；详细状态机、任务 API、Worker、取消语义及证据见开发流程第 3.0.2/第 10 节、`DB_SETUP.md` 和 `PHASE5_STEP4_TASK_QUERY_CANCEL.md`。**阶段 5.5（图片结果归档与 owner 授权读取）已于 2026-11-13 完成并在真实隔离 PG 验收**：报告 `.workbuddy/database-acceptance-mweebpub_346a46.json` 为 `passed`（108 passed / 1 skipped / 0 failed），含 Worker 列级归档与 owner 200 / 他人 404 / admin 跨用户 404；Studio 已通过 `/api/tasks` 跑通"提交→执行→归档→预览"。细节见 `DB_SETUP.md` 阶段 5.5 节、`PHASE4_4.3.1_RESULT_FETCH_SSRF.md`。**阶段 5.6（用户发起的资产软删除）已于 2026-11-13 完成并通过真实隔离 PG 验收**：`DELETE /api/assets/:id` 仅允许本人 `ready` 资产，单条条件更新同时承担归属判断与并发控制；重复删除幂等 `200`，他人/admin 跨用户/不存在 UUID 统一 `404`，`pending/uploading/failed` 返回 `409`；Web 运行角色只新增 `status/updated_at/deleted_at` 三列写权限，对象元数据列仍 `42501`，软删除保留 `storage_key` 且读取立即失效。报告 `.workbuddy/database-acceptance-mwekf4h9_4fd766.json` 为 `passed`（112 passed / 1 skipped / 0 failed / 117 checks），新增 4 项删除专项证据。**阶段 5.7（资产对象清理）已于 2026-11-13 完成并通过真实隔离 PG 验收**：迁移 `0022_asset_purge` 新增 `purged_at`/`purge_attempts`/`last_purge_error` 与部分索引；`purgeDeletedAssets` 以 `FOR UPDATE SKIP LOCKED` 认领、事务外幂等删除主对象与缩略图、失败只存错误码并可按上限重试；新增独立 `cleanup` 角色（仅 8 列可读、4 列可写，表级权限全无，读不到 `users`/`generation_tasks`），入口为 `scripts/asset-cleanup.js` 与 `PAINTTRACK_LOCAL_ASSET_CLEANUP=1`。报告 `.workbuddy/database-acceptance-mwekxqi6_bdac7f.json` 为 `passed`（116 passed / 1 skipped / 0 failed / 121 checks），新增 4 项清理专项证据。**阶段 5.8（Studio 资产删除入口）已于 2026-11-13 完成**：画廊删除按钮在条目带 `assetId` 或 `url` 为 `/api/assets/<uuid>/content` 时先调 `DELETE /api/assets/:id`，成功（含 404 幂等）后才移除条目，失败保留条目可重试；外部 CDN 地址不发请求。证据为 `tests/studioTaskClient.test.js` 9/9（新增 4 项），前端无组件测试基建，UI 侧只有语法门禁与人工验证。**阶段 5.9（删除确认改为应用内弹窗）已于 2026-11-13 完成**：新增 `packages/studio/src/components/ui/ConfirmDialog.jsx`（portal 到 body、`role="alertdialog"`、Esc/遮罩取消、Tab 焦点陷阱、默认焦点落「取消」、关闭还原焦点、滚动锁、busy 期间禁重复提交、错误内联），`ImageStudio.jsx` 用 `pendingDelete`/`deleteBusy`/`deleteError` 承载状态，桌面与移动两处入口都改为先开弹窗；替代原生 `confirm()` 的四个硬缺陷（主机名标题、按钮跟随浏览器语言、样式断裂、无 in-flight 状态）。证据：JSX 解析两文件通过、`esbuild --bundle` 退出 0（1.37 MB）、整仓 516 项/514 passed/0 failed/2 skipped、dev chunk 内含 `alertdialog`/`deleteTitle`。**阶段 5.10（ConfirmDialog 全站推广 + 回归门禁）已于 2026-11-13 完成**：`Cinema`/`Video`/`Marketing`/`Recast`/`LipSync`/`VibeMotion`/`MotionControl`/`Workflow`/`DrawModal` 共 9 个文件、10 个入口全部改用 `<ConfirmDialog>`，`VideoStudio` 与 `WorkflowStudio` 两个异步入口带 `deleteBusy`/`deleteError` 并可失败重试，`WorkflowStudio` 顺带移除删除失败的 `alert`，`RecastStudio` 移动端硬编码英文已统一；新增共享文案 `confirmCopy.js` + `messages/{en,zh}/confirmDialog.json`（避免 9 屏 × 2 语言各抄 5 键而漂移）。证据：新增 `tests/studioConfirmDialogMigration.test.js` 5 项源码门禁（文案键对齐、resolver 回退、**components 下无原生 `confirm()`**、10 个入口都 import 并渲染、可访问性契约）且用 6 条样例自测过判定力；9 文件解析通过、逐组件与 `index.js` 打包退出 0、整仓 **521 项/519 passed/0 failed/2 skipped**。**仍未完成：宿主 `components/TaskCenter.js:223` 取消任务仍是 `window.confirm`、`WorkflowStudio` 重命名失败仍用 `alert`、孤儿对象与保留政策、任务删除与账号注销级联、真实 Provider 出图、生产对象存储、Studio 侧无组件级自动化 UI 测试（门禁是源码级，不等于交互验证）。**本索引早期“阶段 5 是建议下一入口”及“仅列出 5.1–5.3”的文字均为历史，不再作为当前状态。

**阶段 5.11（孤儿 `pending` 对象回收）已于 2026-11-13 完成并通过真实隔离 PG 验收**：迁移 `0023_orphan_asset_reclaim` 新增 `abandoned_at`、CHECK `assets_abandoned_state_check` 与部分索引；`reclaimAbandonedAssets` 按 `(owner_id, asset_id)` 推导键回收「对象已落盘、行仍 `pending`」的孤儿（该状态被约束禁止携带 `storage_key`，故只能推导），`FOR UPDATE SKIP LOCKED` 认领且认领即计数、**不 bump `updated_at`**、失败只写错误码并可重试；cleanup 角色扩至 10 读 / 5 写（新增 `abandoned_at`），表级权限仍全 false、仍不能改 `status`。报告 `.workbuddy/database-acceptance-mwena934_77f663.json` 为 `passed`（118 passed / 1 skipped / 0 failed / 123 checks），含「`abandoned_at` 可写在 `pending` 行」正向探针与「按推导键删对象 / 重跑收敛 / 窗口内不误删」专项。

**阶段 5.12（宿主 TaskCenter 取消任务改用应用内确认）已于 2026-11-13 完成**：`components/TaskCenter.js` 改用**子路径** `studio/ConfirmDialog`（不走 `studio` barrel，避免把 15 个 Studio 与 reactflow/react-markdown/syntax-highlighter 拉进任务侧栏）；`cancelTask` 改为返回布尔值以决定是否关闭弹窗，失败时错误内联在弹窗内、可原地重试，`busy` 与行内按钮 disabled 同源以防重复 `POST /cancel`。**仓库内原生 `confirm()` 已清零**。门禁由 5 项扩到 7 项并把扫描范围扩到宿主 `components/` + `app/`，含**假绿防护**（必须先扫到 `components/TaskCenter.js` 且文件数 ≥ 20）；用「临时改回 `window.confirm` → 恰好 2 条失败并精确报出该文件」反向自测过判定力。证据：整仓 **537 项 / 535 passed / 0 failed / 2 skipped**、`esbuild --bundle components/TaskCenter.js` 与 `eslint` 均 exit 0、`require.resolve('studio/ConfirmDialog')` 解析成功。**仍未完成：Studio 与宿主都没有 jsdom/testing-library，也没有做过浏览器真实点击验证（门禁是源码级，不等于交互验证）；`WorkflowStudio` 重命名失败仍用 `alert`；孤儿行的 UI 侧过滤、保留政策、任务删除与账号注销级联、真实 Provider 出图、生产对象存储、S3/OSS 的 `deleteObject` 均未做。**

阶段 6 账户中心与额度账本：身份 UI（阶段 6.1）已于 2026-11-10 实现；真实计价/额度账本（6.2 起）仍只有规划稿 `PHASE6_ACCOUNT_CENTER_PRODUCT_DESIGN.md`，必须等产品规则确认，并与阶段 4/5 的 Provider/任务闭环协调。该账户中心属于用户侧，不等于阶段 8 管理后台；未有权威账本前不得展示余额数字或充值功能。

当前唯一开发顺序以仓库外 `../ImplementationPlan/PAINTTRACK_DEVELOPMENT_PROCESS.md` 第 10 节为准。本索引只记录阶段 1–4 验收事实，不授权阶段 5 以后实现。

## 生产与发布边界

以下事实不得从上述本地或隔离验收推断：

- 生产数据库已创建/迁移、生产数据库认证已加固、备份恢复达到承诺的 RPO/RTO。
- 真实邮件已发送且投递/退信/投诉流程可运行。
- 真实 Provider 已接入、生产 Worker 已调用 Provider、结果已归档并可授权下载。
- 对象存储已生产化（清理只在本地文件存储验证过，S3/OSS 未接入）；资产生命周期只覆盖"软删除 → 清理"主路径，孤儿对象、保留政策、任务删除与账号注销级联仍未做。
- bootstrap 凭据已回收/轮换，或正式管理员后台/MFA 已上线。
- 项目已达到真实用户运营或阶段 12 发布门禁。

启动后续阶段前仍须遵守 `../ImplementationPlan/PAINTTRACK_DEVELOPMENT_PROCESS.md` 第 4 节的逐步授权与验收规则；本索引不指定下一开发入口，也不自动授权阶段 5 以后实现。唯一当前执行顺序见该开发流程第 10 节。

## 后续阶段

阶段 5 起的状态与证据按步骤记录，不复用本索引的阶段 4 结论。当前已交付：`PHASE5_STEP1_TASK_STATE_MACHINE.md`（5.1 任务状态机与迁移 0012）、`PHASE5_STEP2_TASK_CREATION_API.md`（5.2 任务创建 API、归属与幂等，迁移 0013）、`PHASE5_STEP3_WORKER_EXECUTION.md`（5.3 Worker 执行、心跳、重试与崩溃恢复，迁移 0014）。本索引不用于推断阶段 5 及之后的完成度。
