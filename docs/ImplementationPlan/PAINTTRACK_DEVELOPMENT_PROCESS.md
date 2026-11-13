# PaintTrack SaaS 开发流程与验收规范

- 文档状态：项目开发基线规范
- 适用范围：PaintTrack Web SaaS、服务端 API、任务 Worker、对象存储、数据库及 Electron 辅助客户端
- 项目根目录：`F:/111/QAQ/me/AI Agent/Hub/PaintTrack/PaintTrack`
- 执行原则：按阶段、按小步骤推进；每个步骤完成后先测试、验收并记录，未获确认不得进入下一步

## 1. 目的与强制规则

本文件是 PaintTrack 后续开发、测试和发布的工作规范。所有开发工作必须遵守以下要求：

1. 一次只推进一个可独立验证的小步骤。不得把多个未验收阶段合并实施，也不得一次性完成整条路线。
2. 每一步开始前说明目标、涉及文件/模块、预期交付和验证方式。完成后执行该步适用的测试与安全检查，记录结果、问题和结论。
3. 每一步结束后暂停并向用户报告验收结果。只有用户确认或明确授权继续后，才能开始下一步。用户要求“继续”时，只推进紧接着的一个步骤。
4. 测试失败、验收标准未满足或存在未解释的安全风险时，停止推进；修复当前步骤并重新执行相关测试，直至通过。
5. 不因测试困难而跳过门禁。若测试受环境、第三方服务或凭据限制，须标记为“未验证/受阻”，说明影响和替代验证，不能宣称通过。
6. 不覆盖、重置或丢弃用户已有改动。开始前检查 Git 状态；只修改当前步骤必要文件。对与本任务无关的改动保持原样。
7. 不将密钥、口令、访问令牌、个人数据或真实支付信息写入源码、日志、测试快照和提交记录。测试使用隔离环境与合成数据。
8. 生产数据变更、真实支付、真实供应商高成本调用、不可逆迁移和发布均须先说明影响并获得用户明确批准。
9. 代码、配置、迁移和文档变更应可审查、可复现。涉及数据库结构时必须包含迁移与回滚/恢复说明；涉及账务时必须可审计且具备幂等策略。
10. 每一步完成后更新项目工作日志；长期有效的架构决策同步写入项目记忆。不得在记忆或文档中保存秘密。

## 2. 已确认产品决策

后续实现以这些决定为当前基准；如需改变，先提出差异及影响并取得用户确认。

- Web SaaS 是主要产品，Electron 是辅助客户端。
- PaintTrack 自建服务端；服务端负责身份、权限、任务、额度、供应商密钥和数据归属。
- 产品已有图片生成、视频生成、工作流等 Studio 页面；后续必须优先复用并恢复这些既有页面，不得另建平行的简化生成入口。
- 生成后端采用可配置的 Provider/API 适配层。用户可能配置多个 API 中转站；协议相同但 Base URL 不同的站点应作为同一协议适配器的不同 Provider 配置实例，不为每个域名复制一套业务适配代码。协议与兼容范围按用户提供的接口文档确认，不默认假设继续使用 MuAPI，也不把某一供应商写成产品固定前提。
- 首个参考协议为用户于 2026-11-09 提供的 MyVigna 文档：其文本接口标注 OpenAI 兼容，图片包括 `/v1/images/generations`、`/v1/images/edits`、`/v1/images/tasks`（含 JSON/multipart 与同步/异步差异），视频使用异步 `/v1/videos` 提交/查询/内容端点。不得据此宣称所有中转站、模型或媒体端点完全兼容；需按端点和模型能力验证。
- 服务端负责保存和使用 Provider 凭据，浏览器只调用 PaintTrack 自有 API。Provider 配置管理与模型绑定管理分离：管理员可添加多个中转站配置实例（协议类型、名称、Base URL、服务端凭据、健康/启用状态及配置版本）；逻辑模型（PaintTrack 对用户展示的模型）可单独绑定到一个或多个中转站的上游模型名及能力映射，并可显式切换主用路由。允许目标主机必须由服务端配置/管理员控制，禁止把请求参数中的任意 URL 直接转发，防止 SSRF；供应商的任务/结果 URL 也须按安全策略校验后访问。
- 每个生成任务必须由服务端根据逻辑模型与启用的绑定解析上游路由；客户端不得自行指定 Provider 实例、Base URL、凭据或未经授权的上游模型名。任务创建时保存不含密钥的路由快照（Provider 实例 ID/配置版本、Adapter 类型/版本、上游模型名、参数映射版本），确保排队、重试、恢复与审计可复现。路由切换默认只影响新任务；已有任务继续按快照执行。故障转移须为显式策略，并受模型能力/计费与用户授权约束，不能因配置变更静默切换上游。
- 云端任务按“检查余额 → 冻结额度 → 提交生成 → 成功结算 / 失败释放”处理。
- 供应商失败自动重试一次；仍失败则释放冻结额度。重试不得重复扣费或重复创建不可控任务。
- 首期由管理员手动充值；微信支付为后续选项，支付主体尚未确定。
- 首期邮箱登录；权限先分普通用户与管理员，结构需允许未来扩展。
- 数据库采用 PostgreSQL；文件使用对象存储；供应商 URL 仅作为临时地址，不能作为长期资产地址。
- 用户界面展示点数；后台记录人民币供应商成本。首期使用明确、可版本化的固定计费规则。
- 首期提供平台内置模板和快捷入口；工作流先内置，后续依次开放用户复制/保存和拖拽编辑。
- Electron 的 sd.cpp、Wan2GP 本地推理不扣除平台额度，必须与云端计费路径隔离。
- 任务记录长期保存；原始素材和大文件按套餐或生命周期规则管理。
- 首期内容安全范围为明显违法、侵权和敏感内容限制；上线前仍须核实适用地区的法律、平台政策和运营责任。

## 3. 当前基线与起始门禁

本规范最初根据 2026-11-03 的只读审计建立，并于 2026-11-04 记录阶段 0/1 基线。下方 3.0–3.3 保留对应时点的历史事实与证据，不代表当前工作区状态；当前阶段、已完成能力、剩余风险和开发顺序以最新的「2026-11-12 当前执行快照」（3.0.3）、第 10 节及各专题设计稿为准。`PaintTrack/docs/records/PHASE1-4_ACCEPTANCE_INDEX.md` 只负责阶段 1–4 的历史验收证据，不决定阶段 5 以后状态，也不决定当前下一步。每次开始新步骤前仍须复核 Git 与环境状态，不得沿用旧快照作为当前事实。

### 3.0.1 2026-11-07 当前执行快照（历史，已被 3.0.2 取代）

- 阶段 0、阶段 1、阶段 2 已完成；阶段 3.1–3.5 已完成。阶段 3.5 管理员初始化通过真实 PostgreSQL 16.15 隔离验收，最终报告为 `PaintTrack/.workbuddy/database-acceptance-mw5z8fxe_528a61.json`（最终状态 `passed`）。分阶段数据库设计、权限边界和验收证据见 `PaintTrack/docs/records/DB_SETUP.md`；阶段 3.4/3.5 收尾记录见 `PaintTrack/.workbuddy/memory/2026-11-07.md`。
- 阶段 3.6 当前已完成三个独立基础小步骤：认证记录保留/清理、持久邮件 outbox 基础协议、outbox 投递 worker；代码、迁移、定向测试和真实 PostgreSQL 隔离验收均通过。清理报告为 `PaintTrack/.workbuddy/database-acceptance-mw62cu9c_fac144.json`，outbox 报告为 `PaintTrack/.workbuddy/database-acceptance-mw637r95_38129e.json`，worker 报告为 `PaintTrack/.workbuddy/database-acceptance-mw64i1ah_205c15.json`。真实邮件供应商接入、加密密钥注入、生产调度、发送心跳和退信/投诉处理按用户决定延期到真正需要用户注册时，再单独启动验收。当前默认进入阶段 4 Provider 契约设计。
- 管理员正式初始化仅通过 `npm run admin:init` 和独立 bootstrap 数据库身份执行。初始化成功后，按 `DB_SETUP.md` 回收或轮换 bootstrap 身份；bootstrap 凭据不得传入 Next.js、Worker 或其他常驻应用进程。真实凭据生命周期状态须在部署/运维记录中核实，不得仅凭测试通过推断已轮换。
- 目前有管理员只读汇总 API `GET /api/admin/summary` 和 development-only 授权验收页 `/dev/authorization`，没有正式管理员后台页面。正式管理后台属于阶段 8；若要提前制作只读页面，须单独批准范围并标注为阶段 8 的前置切片。
- 当前已有身份、会话、权限基础，不代表 SaaS 业务已可对外发布。Provider 接入、任务与计费闭环、对象存储与结果归档、生产邮件、生产基础设施、安全运营和发布门禁尚未全部完成；在阶段 12 发布门禁通过前，不得表述为可面向真实用户运营的完整 SaaS。
- 本快照仅记录当前项目阶段，不覆盖 3.1–3.3 中 2026-11-04 的历史工作区、依赖和构建环境观察。任何依赖、Git 或构建状态都应在实际任务开始时重新检查。

### 3.0.2 2026-11-09 当前执行快照

- 阶段 0、1、2 与阶段 3.1–3.6 结论不变；阶段 3.6 的真实邮件供应商、加密密钥注入、生产投递、发送心跳和退信/投诉处理仍按用户决定延期，不阻塞当前路线。
- **阶段 4 小步骤 1–4 已完成**：小步骤 1 Provider 契约（`PHASE4_STEP1_PROVIDER_CONTRACT.md`）、小步骤 2 纯内存 `lib/server/providers/mockProvider.js`、小步骤 3 `providerExecution.js` 与 `resultBoundary.js`（错误分类到 `retry`/`fail`/`unknown_submission`，结果 URL/SSRF/媒体/大小边界）、小步骤 4 Provider 调用账本 `lib/server/providers/providerCallLedger.js` 与迁移 `drizzle/0011_provider_calls.sql`（表 `provider_calls`：`task_id`+`attempt_no` 唯一、`idempotency_key` 唯一、状态 CHECK、租约一致性 CHECK、恢复索引；`submitting`/`unknown`/`accepted` 可被恢复领取并累计 `recovery_attempts`）。以上模块均未接入生产 Worker，不访问真实网络，不读取凭据。调用账本已于 2026-11-09 通过真实 PostgreSQL 隔离验收：报告 `PaintTrack/.workbuddy/database-acceptance-mw8lvo2w_ce1677.json`，`status: passed`，70 项检查 66 passed / 0 failed，其中「全部迁移表列/主键/CHECK/索引与最新snapshot」与 provider_calls 账本夹具均 passed。
- 2026-11-09 修复了阶段 4 遗留的三处门禁问题，均属测试与迁移元数据一致性，不涉及业务行为变更：① `drizzle/meta/0011_snapshot.json` 过期（`provider_calls` 已写入 schema 与 SQL，但快照 `tables` 缺少该表），已按 `schema.js` 重新生成快照，与 0011 SQL 语义等价；② `databaseLifecycle.test.js` 用 journal 下标推断 snapshot 文件名，在历史迁移 0009 归档后下标与 tag 编号错位（idx 10 对应 `0011_provider_calls`），改为按 tag 前缀取文件名，并把硬编码的 `entries.length === 8` 换成「journal 与 migrations 目录 SQL 一一对应」；③ `providerCallLedger.test.js` 的恢复领取断言落后于实现，未包含 `accepted`，已更新并补充「accepted 但缺 `provider_job_id` 拒绝恢复」负例。**同日追加更正**：此前「小步骤 4 已完成」的结论并未包含一次通过的账本真实验收；本次首次跑通隔离验收，暴露并修掉三个真问题——① 验收脚本全量 DML 表断言写死 7 张表（加 `provider_calls` 后应为 8，改为按表清单推导）；② `releaseProviderCallForRecovery` 把退避写进 `lease_expires_at` 而清空租约归属列，违反 `provider_calls_lease_consistency_check`（`23514`），故新增 `available_at` 列把「谁持有」与「何时可领」拆开，恢复索引改为 `(status, available_at)`；③ 账本夹具未清理自己插入的 `generation_tasks`，污染后续 Worker 验收的「起始空表」断言，改为 `try/finally` 自清理。同时把 `beginProviderCall` 收敛为「只登记发起意图」（冲突返回 `ATTEMPT_EXISTS`，身份不符返回 `ATTEMPT_IDENTITY_MISMATCH`），接管统一走重命名后的 `claimProviderCallForRecovery`，消除「NULL 租约永远领不到」的假恢复路径。
- 2026-11-09 阶段 4.5.1–4.5.2 完成（用户选定方案 A：撤除浏览器直连、未配置即明确不可用）：① **4.5.1 客户端凭据边界棘轮** `tests/clientCredentialBoundary.test.js` + 基线 `tests/fixtures/client-credential-allowlist.json`，扫描 `app/`、`components/`、`src/` 中 `muapi_key`/`x-api-key`/`api.muapi.ai`，基线 16 文件 / 73 被扫描文件，规则为「只许减少」——新增引用或过期条目都会失败，并带扫描量下界防止空扫描假绿；已用临时探针验证它确实会变红。② **4.5.2 服务端配置边界** `lib/server/providers/providerConfig.js`：只读 `PAINTTRACK_PROVIDER_NAME`/`PAINTTRACK_PROVIDER_CREDENTIAL`，四状态 + 固定原因码，凭据不可枚举、序列化/字符串化/错误信息均脱敏，拒绝空白、超长与占位值，`requireProviderConfig()` 对不可用状态抛 `ProviderConfigError`；`.env.example` 已注明不配即 fail-closed。**历史注记：**截至 2026-11-09 4.5.1/4.5.2 完成时，这仅建立基线与服务端入口，浏览器直连仍未封锁，账本可被旁路；该缺口已由下方 4.5.3 完成记录关闭。
- 2026-11-09 实测基线：`npm test` 220 项 / 218 通过 / 0 失败 / 2 跳过（exit 0，其中新增 10 项）；`npm run lint` 0 error / 11 warning（与既有基线一致）；`npx drizzle-kit check` 输出 `Everything's fine`。日志见 `PaintTrack/.workbuddy/stage45-1-2-full-test.log`、`status-check-test.log`、`fix-full-test.log`、`fix-lint.log`、`fix-migration-check.log`。
- 2026-11-09 阶段 4.5.3 完成（撤除浏览器直连与凭据来源）：按「凭据生命周期」而非文件逐个清：① 删除 `components/ApiKeyModal.js`（唯一密钥输入弹窗），`AuthModal`/`SettingsModal` 改为纯提示与只读状态；② `components/StandaloneShell.js` 移除 `STORAGE_KEY`、localStorage 读取、cookie 写入、axios 请求拦截器、余额轮询，挂载时显式 `setApiKey(null)`；③ `src/lib/muapi.js` 由 520 行直连实现改为 fail-closed 桩；共享 SDK `packages/studio/src/muapi.js` 移除全部 34 处密钥头注入并把 `BASE_URL` 固定为同源 `/api`（原跨域 fallback 已删），`utils/generationLifecycle.js` 轮询不再带头；④ 旧版 `{Image,Video,Cinema,LipSync}Studio` 与 `UploadPicker` 改走 `isClientProviderConfigured()`（恒 false）+ 显式提示，远程恢复轮询退出、待处理任务保留；⑤ `app/agents/*` 三处移除 `STORAGE_KEY`/cookie/`x-api-key` 注入；⑥ `src/lib/i18n.js` 删除「密钥只发往 api.muapi.ai」的虚假承诺，MCP 示例去掉 `Bearer YOUR_KEY`；⑦ 删除 `uploadProxyTarget.getApiKeyFromRequest`（从请求头解析凭据的 helper，无调用方）。新增 `src/lib/providerAvailability.js`（唯一 fail-closed 出口）与 `components/ProviderNotConfigured.js`（终态页面）。
- 2026-11-09 门禁收紧（4.5.3 发现 4.5.1 有真实盲区）：扫描根目录新增 `packages/studio/src`——`/studio`、`/workflow` 实际使用的共享 SDK 此前未被扫描，等于门禁只覆盖了旧版 `src/` shell；受管模式新增 `__MUAPI_KEY__`；`tests/fixtures/client-credential-allowlist.json` 的 `entries` 清空，语义由「棘轮」变为**零容忍**；新增「第一方客户端代码零命中」与「SDK `BASE_URL` 必须为同源 `/api` 且不含外部 http(s)」两条断言；「服务端凭据模块不得被客户端引用」由裸字符串匹配改为只匹配 import/require 说明符，避免注释误报。
- 2026-11-09 实测基线（4.5.3 后）：`npm test` **222 项 / 220 通过 / 0 失败 / 2 跳过**（exit 0，门禁 7/7）；`npm run lint` **0 error / 11 warning**（与既有基线一致）；20 个改动文件经 `@babel/parser` 逐个解析通过；`npx drizzle-kit check` 仍 `Everything's fine`。日志见 `PaintTrack/.workbuddy/stage453-full-test.log`、`stage453-lint.log`、`stage45-1-2-full-test.log`。
- 未调用真实 Provider、未写入凭据、未创建云资源、未提交 Git。**阶段 4 历史计划更正（2026-11-09）：**此前将「MuAPI 服务端适配器」列为默认剩余项的描述已被第 2 节产品决策取代，不代表当前目标或供应商选择。阶段 4 的通用契约、mock、调用账本及客户端凭据边界基础已完成；尚待按用户提供的接口文档确认并实现自定义 API Adapter、与既有任务/Worker 链路集成，以及对应的结果抓取、SSRF/DNS 重绑定等安全验证。不得在接口文档未确认前臆造协议、接入真实供应商或把任意 URL 作为代理目标。
- **已知代价（方案 A 既定）**：未配置服务端 Provider 时 `/studio`、`/workflow` 明确不可用；`packages/studio/src/muapi.js` 仍保留历史业务函数骨架，但只指向同源 `/api`，相关 `cloud.blocked` 路由 fail-closed。恢复生成能力应由按用户 API 文档实现的服务端自定义 Provider Adapter 与 PaintTrack 任务接口提供，不能恢复客户端凭据或另建平行生成入口。
- 2026-11-09 **阶段 5.1 完成**（任务状态机与合法转换）：新增 `lib/server/worker/taskStateMachine.js`（五态、终态不可变、`apply`/`noop`/`conflict`、失败去留、租约过期、取消路径），`taskQueue` 改为复用同一份 `TASK_STATUS`；迁移 `drizzle/0012_task_cancellation.sql` 把 `cancelled` 纳入 `generation_tasks_status_check`，快照与 journal 同步。设计稿 `PaintTrack/PHASE5_STEP1_TASK_STATE_MACHINE.md`；定向测试 9/9；全量 `npm test` 231 项 / 229 通过 / 0 失败 / 2 跳过；lint 0 error / 11 warning；`drizzle-kit check` 通过；真实 PostgreSQL 隔离验收通过（`.workbuddy/database-acceptance-mw8nywgz_579cad.json`，71 项检查 / 67 passed / 0 failed，含 `cancelled` 正向写入与 `cancelling` 拒绝两项新检查）。本步骤未实现任务 API、未接 Provider、未接额度。
- 2026-11-09 **阶段 5.2 完成**（带认证、用户归属与幂等键的任务创建 API）：新增 `POST /api/tasks`、`lib/server/tasks/{taskSubmission,taskService,taskHttp}.js`；`generation_tasks` 增加 `owner_id`/`idempotency_key`/`request_fingerprint` 与 `(owner_id,idempotency_key)` 唯一约束（迁移 `0013_generation_task_ownership.sql`，要求表为空以避免伪造历史任务归属）；同键同请求返回原任务（`200` + `Idempotency-Replayed: true`），同键不同请求 `409`；Web 运行角色新增 `SELECT,INSERT ON generation_tasks`，领取与状态更新仍只授予 Worker 角色。本步骤不调用 Provider、不扣额度。全量 `npm test` 248 项 / 246 通过 / 0 失败 / 2 跳过；lint 0 error / 11 warning；真实 PostgreSQL 隔离验收 `.workbuddy/database-acceptance-mw8of0uy_52b6b8.json`（`passed`，72 项 / 68 passed / 0 failed，含并发同键收敛与跨 owner 隔离检查）。
- 2026-11-09 **阶段 5.3 完成**（Worker 领取、租约、执行、心跳、重试与崩溃恢复，仅 mock Provider）：新增执行器 `lib/server/worker/taskExecutor.js`（按 taskId 恢复同一提交轮次、受理后保留调用租约并轮询、成功在单事务内同时结算调用与任务、失败按 `retry`/`fail`/`unknown_submission` 分类）；`provider_calls` 增加 `acceptProviderCallHolding`/`heartbeatProviderCall`/`deferProviderCall`/`findActiveProviderCall`，`markProviderCallSucceeded` 允许 `submitting` 起步、`markProviderCallTerminal` 覆盖 `unknown`；`taskQueue.failTask` 新增 `terminal`（跳过剩余重试）与 `completeTask` 强制结果描述符；迁移 `0014_generation_task_result.sql` 增加 `generation_tasks.result jsonb` 与「成功必须有结果」「结果必须是对象」两条 CHECK；新增 `lib/server/providers/providerRegistry.js`，`PAINTTRACK_WORKER_PROVIDER` 未设置或为 `mock`+production 时 Worker 拒绝启动（fail-closed，任务留在队列）。设计稿 `PaintTrack/PHASE5_STEP3_WORKER_EXECUTION.md`；全量 `npm test` 267 项 / 265 通过 / 0 失败 / 2 跳过；lint 0 error / 11 warning；`drizzle-kit check` 通过；真实 PostgreSQL 隔离验收 `.workbuddy/database-acceptance-mw8oy85s_2ec1e9.json`（`passed`，79 项 / 75 passed / 0 failed，含 6 个执行器场景与结果约束正负例）。本步骤未接真实 Provider、未做结果归档（`archive` 恒为 `not_configured`）、未实现取消与查询接口（5.4）。
- 2026-11-09 **阶段 5.4 服务端完成**（任务列表、详情与取消）：新增 `GET /api/tasks`（keyset 分页、limit 上限 50、owner 隔离）、`GET /api/tasks/:taskId`、`POST /api/tasks/:taskId/cancel`；取消区分「queued 立即取消」与「running 协作取消」，后者只登记 `cancel_requested_at`，由持有租约的 Worker 在提交前与每次轮询前观察后写 `cancelled`；成功结算在事务内 `SELECT ... FOR UPDATE` 锁定任务行，取消先到则任务按取消终结、调用记录仍记 `succeeded`（供应商成本已发生，留给阶段 6 对账）；租约过期且已请求取消的任务恢复为 `cancelled` 而非重新排队；迁移 `0015_task_cancel_request.sql` 增加 `cancel_requested_at` 与「非空时状态必须是 queued/running/cancelled」CHECK；Web 运行角色仅获 `status`/`cancel_requested_at`/`completed_at`/`updated_at` 列级 UPDATE（真实库正负例：写 `worker_id` 返回 42501，行锁可用）。设计稿 `PaintTrack/PHASE5_STEP4_TASK_QUERY_CANCEL.md`；全量 `npm test` 296 项 / 294 通过 / 0 失败 / 2 跳过；lint 0 error / 11 warning；`drizzle-kit check` 通过；真实 PostgreSQL 隔离验收 `.workbuddy/database-acceptance-mw8pnd8v_58228d.json`（`passed`，88 项 / 84 passed / 0 failed，含 9 项取消、owner 隔离与列级权限检查）。任务中心 UI 已接入列表、详情、轮询和取消，但当前既未把现有生成控件接入 `POST /api/tasks`，也未配置真实 Provider；0015 尚未应用到 `painttrack_dev`/`painttrack_test`。
- 2026-11-09 本机开发入口整合：`npm run dev` 默认只给浏览器使用 `http://127.0.0.1:3000`。隔离启动器在3000检查loopback socket/精确Host/Origin/Fetch-Site，剥离客户端能力及转发头后注入随机能力值；Next dev 子进程仍需监听3001 loopback，因此这是一个公开入口加一个受门禁保护的内部监听，并非进程级单端口。development-only中间件要求能力值精确匹配，直接访问3001返回403。3000代理支持HTTP与HMR WebSocket；验证页面 `/register`、`/login`、`/studio` 均200，注册202→内存收件器→邮箱验证202→登录200→认证任务列表200，Studio认证后200，错误Host/跨站/伪造能力头拒绝，HMR返回101。`npm test` 尚未全量重跑；新增 `tests/localRegistrationLauncher.test.js` 与认证相关定向测试合计11/11通过，`node --check` 和 `git diff --check` 通过。真实浏览器截图、生产构建与外网部署未验证。
- 3.0.1 保留为 2026-11-07 的历史快照，不再作为当前事实来源。

### 3.0.3 2026-11-12 当前执行快照（历史，已被 3.0.4 取代）

**最终状态：阶段4.7.5 Web/Worker/Migration数据库身份拆分已完成本地实现与真实隔离库验收。** 最终报告 `PaintTrack/.workbuddy/database-acceptance-mwcyonlg_45f52d.json` 为 `passed`，108项passed、0 failed、0 skipped；4条running为已完成各段的开始事件，不是待完成检查。命令 `RUN_ADMIN_MFA_PG_ACCEPTANCE=1 npm run test:db:local` 退出0，包含MFA回归；此前默认验收报告mwcyn04y_04cf67同样passed（99 passed/1 skipped）。53项定向单测重跑全通过，6个本轮修改脚本语法检查及限定diff检查通过。

原四项未验证已由实测闭环：①真实隔离库整体验收passed；②Worker显式185项列级清单通过实际information_schema展开比对；③Web拆分后权限清单和真实正负例通过；④Worker该段越权负例按预期42501拒绝。另通过3个独立Worker后端并发12任务、真实SIGKILL与自然租约过期重领、旧token fencing、协作/非协作停止恢复及最终无遗留连接/事务。fixture建任务使用Web、执行使用Worker、准备和清理使用migration；未扩大运行授权。Provider Secret boundary仍未完成，写API仍关闭，owner/migration仍可修改审计。**以下时点记录仅为历史，不再代表当前待办或未验证结论；当前下一步见10.4。**

> 10:51 最新实测：报告 `.workbuddy/database-acceptance-mwcybt19_7ad662.json` 为failed（75 passed / 1 skipped / 7 failed记录，含5个fixture失败及汇总/终止）。原四项待验现已部分闭环：真实隔离库已重跑但整体失败；Worker列级清单及该段42501负例通过；Web权限回归通过。不得继续把这些已实测子项称为未实测，也不得称4.7.5整体通过。后续5个fixture报42501，完整Worker并发恢复未执行到；可选MFA未启用而跳过。详情和下一步以10.4最新条目为准，以下为历史快照。

> 10:09 最新实测：报告 `.workbuddy/database-acceptance-mwcwtoqq_754590.json` 为 failed，34 项 passed，停止于 Worker 列级清单比对（脚本889行，missing=[]、extra非空）。Web 拆分权限及审计正反例、Worker 独立连接结果写入已实测通过；真实验收整体未通过，Worker 完整清单与越权错误码、并发恢复仍未验证。以下为先前时点快照，以本注和10.4最新条目为准。

3.0.1、3.0.2 保留为历史记录，不再作为当前事实来源。3.0.3–3.0.11 亦已由 3.0.12 取代，仅作追溯。

> 2026-11-12 10:00 实测追加：已执行一次真实隔离验收，报告 `.workbuddy/database-acceptance-mwcwiaua_78f510.json` 为 `failed`，退出码 1，20 项检查 passed，随后在 `scripts/accept-database-local.js:405` 的 Web `INSERT INTO assets ... RETURNING id` 报 `42501` 终止。以下「未重跑」描述为本次执行前快照，现由本注及 10.4 更新：已重跑但未通过，Worker 列级权限和越权负例等后续项目仍未验证；四项均不得整体标为通过。隔离库及四个角色按脚本策略保留，未清理。

- 阶段 0–3.6、阶段 5.1–5.4、阶段 4.5.1–4.5.3、阶段 4.7.1–4.7.4 的结论不变。阶段 4 整体仍未完成，没有真实自定义 Adapter 与多 Provider 路由的生产集成；Provider 配置写 API 仍关闭。
- **阶段 4.7.5（Web/Worker/Migration 数据库身份拆分）已实现代码，但未完成真实验收，不得表述为「已完成」。** 本轮改动：
  - `lib/server/worker/index.js` 改为 fail-closed：只接受显式入参或 `PAINTTRACK_WORKER_DATABASE_URL`，删除 `getEnvironment().databaseUrl` 回退路径，缺失时抛错且不建连接。此前 Worker 可在缺少独立凭据时静默复用 Web 身份，该路径已关闭。
  - `lib/server/db/runtimePermissions.js` 拆为 `grantWebRuntimePermissions` / `grantWorkerRuntimePermissions`；旧入口 `grantRuntimePermissions(..., { worker: true })` 保留签名但直接抛错，防止合并身份被重新引入。Web 侧审计仅 `INSERT`、任务仅取消四列 `UPDATE`、`email_outbox` 仅 `INSERT`、无 `provider_calls` 权限；Worker 侧任务执行列 `UPDATE`、`provider_calls` `SELECT`+`INSERT`+执行列 `UPDATE` 但无 `DELETE`、`email_outbox` `SELECT`+`UPDATE`、保留目录路由读权限、无审计表任何权限。
  - `scripts/local-registration.js` 建 migration/runtime/worker 三角色；Worker 连接串不再进入 Next 子进程环境，改由 `createWorkerEnvironment()` 单独构造；独立 Worker 进程仅在 `PAINTTRACK_LOCAL_WORKER=1` 时启动，默认不启。
  - `scripts/accept-database-local.js` 建 `pt_worker_<suffix>` 角色与独立 URL，新增 `checkWorkerRolePrivileges`（列级清单比对 + `SET ROLE` 真实越权负例），Web 侧新增审计 append-only 真实 `INSERT` 正例与 `UPDATE`/`DELETE` 负例，`checkPostgresWorkers` 改用 Worker URL 且 `main()` 已补传此前遗漏的 `workerUrl`，`pg_stat_activity.usename` 期望值改为 Worker role。`tests/fixtures/worker-postgres.cjs` 起 Worker pool 前用独立连接执行 `SELECT current_user` 经 IPC 上报，由主验收比对实际登录角色。
- **已验证（可作为通过）**：四个改动文件 `node --check` 通过；定向单测 `localRegistrationLauncher` / `databaseLifecycle` / `serverEnvironment` / `worker` 四个文件 53 项全通过（53 pass / 0 fail）。
- **未验证（不得说成通过）**：① 真实 PostgreSQL 隔离库验收本轮未重跑；② `checkWorkerRolePrivileges` 手写的列级期望清单与 `information_schema.column_privileges` 实际展开是否逐条一致未实证；③ Web 权限清单（`checkDatabase` 中 `fullDmlTables` 那套）仍按旧合并身份书写，需按拆分后身份回归；④ Worker 越权负例的报错码是否稳定为 `42501` 未实证。
- **仍未闭环**：① Provider Secret boundary 未完成——凭据仍从 `PAINTTRACK_PROVIDER_CREDENTIAL` 等进程环境变量读取，数据库角色拆分证明不了 secret 读取隔离，任何表述都不得写成 Secret Store 隔离已完成；② 审计 append-only 仅约束 Web/Worker，表 owner 与 migration 身份仍可修改；③ 本机 Worker 默认不启动，不得表述为所有运行环境已自动完成独立 Worker 部署。
- 本轮未开放 Provider 配置写 API，未连接真实 Provider，未访问公网，未修改既有业务数据库，未覆盖工作区其它既有改动。真实验收只在脚本自建的 loopback 隔离库内运行。
- 环境注记（本轮实际踩过）：仓库根是嵌套路径 `F:/111/QAQ/me/AI Agent/Hub/PaintTrack/PaintTrack`，在父目录 `Hub/PaintTrack` 下执行 `node --check` 会报 `MODULE_NOT_FOUND`，且重定向会把日志写到父目录 `.workbuddy`，读到空文件极易误判为「检查失败」或「被沙箱拦」。所有命令先 `cd` 到嵌套根，空日志先怀疑路径。
- 交接单：`PaintTrack/docs/records/HANDOFF_PHASE4_4.7.5.md`（新会话冷启动用，含下一步命令与硬约束）。

### 3.0.4 2026-11-13 快照（历史，已被 3.0.5 取代）

**最终状态：本地 mock 生成闭环已打通「Studio 提交 → Worker 执行 → 二进制归档 → owner 授权读取 → Studio 预览」，并在真实隔离 PostgreSQL 验收通过；真实 Provider 的 URL 结果抓取与 SSRF 门禁已实现（离线验证）。** 3.0.3 保留为历史，不再代表当前事实。

**本轮完成（按依赖顺序）**

1. **Studio 接任务 API（阶段 5/9 集成切片）**：`packages/studio/src/taskClient.js` 与 `ImageStudio.jsx` 通过同源认证目录 `GET /api/catalog/models?media=image` 取逻辑模型 ID，再 `POST /api/tasks` 提交并轮询 `GET /api/tasks/:id`；本地任务模式下图生图 fail-closed。未新建平行生成页。
2. **Worker 二进制结果归档 + owner 授权读取（阶段 5.5 / 阶段 7 前置）**：新增 `lib/server/assetArchive.js`（列级 `pending` 插入 → 写私有对象 → 授权列更新为 `ready`）与 `lib/server/storage/fileObjectStore.js`（绝对根目录、路径穿越校验、临时文件原子 rename）；新增 `GET /api/assets/:id/content`（`requireOwnedAssetContent`：UUID 校验 + owner 匹配 + 未删除 + `ready` + 存在 storage_key，失败统一 `NOT_FOUND`，admin 也不能跨 owner）。Worker 新增 `assets` 列级 `INSERT`/`SELECT`/`UPDATE`，**无表级权限**；Web 资产读取仍只有表级 `SELECT`。
3. **任务成功描述符改用本地资产地址**：归档成功后 `resultUrl = /api/assets/:id/content`，外部/存储键不进入任务结果；结算事务失败时用 `assetArchive.discard` 补偿删除已写对象，避免孤儿文件。
4. **本地启动器修复（两处真实故障）**：
   - 显式透传经绝对路径校验的 `PAINTTRACK_ASSET_STORAGE_ROOT` 给 Web 与 Worker，并默认准备 `.local-assets/`（已 gitignore），消除"Web/Worker 指向不同存储根 → 任务成功但没图"。
   - **默认复用固定本地库** `pt_local_auth_000000000000`（账号、会话、任务、资产跨重启保留），`--fresh` 保留一次性随机库；角色密码仍每轮随机、不落盘；复用历史随机库时按 owner 派生角色名。
   - Worker 失败时输出脱敏 `LOCAL_TASK_FAILURE ... phase/name/code/cause` 诊断行，避免只有被折叠的 `TASK_FAILED`。
5. **修复「每条图片任务必挂」的真实缺陷**：`createTaskProcessor({ pool, ...options })` 解构把 `pool` 从选项剥离，而归档器在 `normalizeOptions` 中用 `options.pool` 构造，配置对象存储后必然抛 `pool is required`。已显式回填，并给 `ASSET_ARCHIVE_FAILED` 挂 `cause`。
6. **本地 mock 可预览**：图片 mock 返回合法 1×1 PNG 二进制（符合 `validateProviderResult` 输入形状），不再把合成文本伪装成图片；媒体类型改为按 `request.taskType` 推断，视频任务仍走摘要分支。
7. **结果 URL 抓取 + SSRF 门禁（阶段 4.3.1）**：新增 `lib/server/providers/resultFetcher.js`。真实 Adapter 只返回 `resultUrl`（`myvignaImageProvider.parseResult`），而归档分支只看 `bytes`，此前真实 Provider 接入必然"任务成功但没有图"。抓取在结算事务外进行；DNS 只解析一次并用自定义 `lookup` 把连接钉在已验证 IP（SNI/证书仍按原主机名），逐跳重定向重新校验，`Content-Type` 必须匹配声明媒体类型（缺失即拒），`Content-Length` + 流式累计双重限额，socket 空闲超时与中止；失败映射 `RESULT_FETCH_FAILED` 且可重试（调用记录停留 accepted，重试同任务号取结果，不重复提交/计费）。放宽开关 `allowInsecureResultFetch` 仅供本地测试，`NODE_ENV=production` 无条件关闭。

**已验证（可作为通过）**

- 真实隔离 PostgreSQL 报告 `.workbuddy/database-acceptance-mweebpub_346a46.json`：`passed`，113 条记录 108 passed / 1 skipped（`admin-mfa-postgres` 需开关）/ 4 条 running 开始事件 / 0 failed。含「Worker 列级授权归档二进制结果并提交任务可预览描述符」「真实 assets 本人 200 / 第二用户 404 / admin 跨用户 404 / 不存在 404 / 响应无存储键 metadata」。
- 整仓 `node --test "tests/*.test.js"`：**489 项 / 487 passed / 0 failed / 2 skipped**；ESLint 对改动文件无输出。
- 文档证据：`PaintTrack/docs/records/PHASE4_4.3.1_RESULT_FETCH_SSRF.md`、`PaintTrack/docs/records/DB_SETUP.md` 阶段 5.5 节、`PHASE1-4_ACCEPTANCE_INDEX.md` 4.3.1 行。

**未完成 / 不得写成已完成**

- **真实 Provider 出图未跑**：没有配置真实凭据、未访问公网、未消耗额度。抓取器只用 loopback fixture 与注入 resolver 验证，不能替代真实 CDN 行为。
- **未做内容签名（magic byte）校验**：只信 `Content-Type` 响应头。
- **资产生命周期未做**：对象只写不删（任务删除/失败/过期无清理），`.local-assets/` 会持续增长；阶段 7 仍为「未开始」，不得因归档链路可预览而宣告对象存储生产化。
- **Provider 配置写 API 仍关闭**；Secret boundary 仍未完成（旧 env 入口已退役，生产秘密后端/ACL 未验收）。
- **任务管理入口/页面仍暂缓**；MFA 秘钥仍每轮随机（启用 TOTP 的本地账号重启后需重新绑定）；历史 `pt_local_auth_*` 库与 `.next_local_*` 目录不会自动清理。
- 未触碰 `painttrack_dev`/`painttrack_test`/生产库；未应用任何迁移到既有业务库。

**下一步**（历史建议，已由 3.0.5 执行）：先补资产删除生命周期（B），再做真实 Provider 联调（需用户明确批准凭据与预算）。

**冷启动交接单**：`PaintTrack/docs/records/HANDOFF_2026-11-13.md`（含启动命令、当前缺口与硬约束）。

### 3.0.5 2026-11-13 快照（历史，已被 3.0.6 取代）

**最终状态：在 3.0.4 基础上新增阶段 5.6「用户发起的资产软删除」并通过真实隔离 PG 验收。** 本地 mock 闭环与结果抓取门禁不变；**物理对象清理仍未实现**，不得据此宣告资产生命周期闭环。

**本轮完成（按依赖顺序）**

1. **`DELETE /api/assets/:id`（阶段 5.6）**：新增 `createAuthorizationHandler('asset.delete')`。方法固定 `DELETE`（同路由 `GET` 走 `asset.read`，动作与方法不匹配一律 `405`），同源 `Origin` 必须精确匹配 `APP_BASE_URL`，避免预取或链接预览触发删除。
2. **单条条件更新承担归属、状态机与并发控制**：`UPDATE assets SET status='deleted', deleted_at=now(), updated_at=now() WHERE id=$1 AND owner_id=$2 AND status='ready' AND deleted_at IS NULL RETURNING id,status,deleted_at`。命中 0 行才探测一次：不属于自己（含不存在）→ `404`；已删除 → 幂等 `200`（`alreadyDeleted: true`）；`pending/uploading/failed` → `409 ASSET_NOT_DELETABLE`。并发重复删除时后到语句重新求值 `WHERE` 得 0 行，不会双写。
3. **最小列级授权**：Web 运行角色只新增 `GRANT UPDATE(status,updated_at,deleted_at) ON assets`。表级 `UPDATE/DELETE` 仍为 `false`，`mime_type`/`size_bytes`/`storage_key`/`checksum_sha256`/`owner_id` 写入仍 `42501`。验收脚本新增 assets 列级精确比对，防止将来误扩大授权。
4. **软删除保留 `storage_key` 与元数据**：数据库约束要求 `deleted` 状态仍持有存储键，且后续清理流程需要它定位对象；`requireOwnedAsset` / `requireOwnedAssetContent` 均带 `deleted_at IS NULL`，删除提交后读取立即 `404`，不依赖缓存过期。
5. **修复三处验收 fixture 漂移**（不是业务回归，均为上一轮加归档后未同步，单测发现不了）：`task-executor-postgres` 仍断言 `kind='mock-asset'`（图片 mock 已改真 PNG，应为 `'asset'`）；`local-mock-route-postgres` 缺 `objectStore`、用 Worker 身份查未授权列（Worker 只有 `id/owner_id/status` 列级 SELECT）、把 `getObject` 写成 `get`。

**已验证（可作为通过）**

- 真实隔离 PostgreSQL 报告 `.workbuddy/database-acceptance-mwekf4h9_4fd766.json`：`passed`，117 项检查 112 passed / 1 skipped（`admin-mfa-postgres` 需显式开关）/ 4 条 running 开始事件 / 0 failed。新增 4 项删除专项证据：「真实PG删除拒绝缺失/跨站Origin、他人资产、admin跨用户、不存在UUID与pending状态」「真实PG软删除保留storage_key与元数据、读取立即404、重复删除幂等200」「真实PG Web角色仅删除三列可写，对象元数据与存储键写入返回42501」「runtime的assets列级写权限仅为软删除三列」。
- 整仓 `node --test "tests/*.test.js"`：**491 项 / 489 passed / 0 failed / 2 skipped**。
- 文档证据：`PaintTrack/docs/records/DB_SETUP.md` 阶段 5.6 节、`PHASE1-4_ACCEPTANCE_INDEX.md` 阶段 5–6 指针。

**未完成 / 不得写成已完成**

- **物理对象未删除**：`deleted` 记录与存储中的文件并存，`.local-assets/` 与未来对象存储继续增长。没有清理 worker、重试队列、孤儿对象扫描（归档中途崩溃留下的 `pending` 行及其对象）、保留期限或自动过期策略。
- 没有任务删除、账号注销或配额相关的级联清理；Studio 未提供删除入口（只交付服务端契约）。
- `lib/server/assetService.js` 的 `transitionAsset` 与本接口语义一致但生产路径不经过它，两处状态机需在后续收口时合并。
- 3.0.4 的其余未完成项不变：真实 Provider 出图未跑、未做 magic byte 校验、Secret boundary 未验收、生产对象存储未接入。

**下一步**（按 10.4 最新条目执行，不越级）：先做 B1 对象清理流程（独立清理角色/进程认领 `deleted` 资产 → 幂等删除主对象与缩略图 → 失败重试与保留期），再做 B2 Studio 删除入口；真实 Provider 联调需用户明确批准凭据与预算。

**冷启动交接单**：`PaintTrack/docs/records/HANDOFF_2026-11-13.md`。

### 3.0.6 2026-11-13 快照（历史，已被 3.0.7 取代）

**最终状态：在 3.0.5 基础上新增阶段 5.7「资产对象清理与独立 cleanup 角色」并通过真实隔离 PG 验收。** 至此「用户软删除 → 独立角色物理删除对象」主路径闭环；**孤儿对象回收、保留政策、生产对象存储仍未做**，不得据此宣告阶段 7 完成。

**本轮完成（按依赖顺序）**

1. **迁移 `0022_asset_purge`**：新增 `purged_at`、`purge_attempts`、`last_purge_error` 三列。为什么必须加列：既有约束 `assets_status_storage_consistency_check` 要求 `deleted` 状态必须持有 `storage_key`，所以不能用"清空键"表示已清理。配套约束 `purge_attempts >= 0`、`purged_at IS NULL OR (status='deleted' AND purged_at >= deleted_at)`，以及部分索引 `assets_purge_pending_idx ON (deleted_at) WHERE status='deleted' AND purged_at IS NULL`。SQL 与 snapshot 均由 drizzle-kit 生成以保证与 schema 一致。
2. **`lib/server/assetPurge.js`**：`WITH claimed AS (… FOR UPDATE SKIP LOCKED) UPDATE … SET purge_attempts = purge_attempts + 1 RETURNING …` 认领；删除对象在**事务外**执行，不持锁等 IO；成功写 `purged_at`，失败只写 `阶段:码`（本地存储错误消息含绝对路径，不落库）；对象不存在视为幂等成功。超过 `purge_attempts` 上限的行不再认领，计入 `exhausted`。
3. **纵深防御**：存储键必须落在 `users/<owner_id>/{assets,thumbnails}/` 才允许删除，否则记 `verify:key_owner_mismatch` 并跳过——数据库行被写坏也不能删他人对象。
4. **独立 `cleanup` 角色**：仅 8 列可读（`id/owner_id/status/storage_key/thumbnail_storage_key/deleted_at/purged_at/purge_attempts`）、4 列可写（`purged_at/purge_attempts/last_purge_error/updated_at`）；表级权限全为 false，读不到 `users`/`generation_tasks`，改不了 `status`/`storage_key`。角色名白名单同步扩展。
5. **入口**：`scripts/asset-cleanup.js`（`--dry-run/--retention-hours/--batch-size/--max-attempts/--interval`，退出码 0/1/2，输出 JSON 事件、不含连接串与存储键）；本地 `PAINTTRACK_LOCAL_ASSET_CLEANUP=1` 以 cleanup 角色拉起常驻子进程（默认保留期 0 小时、间隔 60 秒），默认关闭。
6. **踩到的真实约束**：文件存储无法把对象嵌在另一个对象键之下（主对象本身是文件，`mkdir` 抛 `EEXIST`）。缩略图必须与主对象同级并列，写成 `users/<owner>/assets/<id>/thumb` 会失败。

**已验证（可作为通过）**

- 真实隔离 PostgreSQL 报告 `.workbuddy/database-acceptance-mwekxqi6_bdac7f.json`：`passed`，121 项检查 116 passed / 1 skipped（`admin-mfa-postgres` 需显式开关）/ 4 条 running 开始事件 / 0 failed。新增 4 项清理专项证据：「cleanup独立角色仅可读定位键、写清理进度四列；不能改status/storage_key或读用户与任务」「真实PG cleanup角色无表级权限，越权读写返回42501」「真实PG清理：对象被删除/标记完成/重跑幂等/已清理不可复活」「非空0020→0022约束与清理列迁移仅追加两条记录并保留历史快照字段」。
- 整仓 `node --test "tests/*.test.js"`：**512 项 / 510 passed / 0 failed / 2 skipped**；ESLint 对改动文件无输出。
- 文档证据：`PaintTrack/docs/records/DB_SETUP.md` 阶段 5.7 节、`PHASE1-4_ACCEPTANCE_INDEX.md` 阶段 5–6 指针、`HANDOFF_2026-11-13.md`。

**未完成 / 不得写成已完成**

- **孤儿对象未回收**：认领只覆盖 `status='deleted'`；归档中途崩溃留下的 `pending` 行及其对象不会被清理。需要单独定义"上传/归档超时"语义后才能动，否则可能删掉正在写入的对象。
- **保留期只是参数，不是产品决策**：CLI 默认 24 小时、本地常驻默认 0 小时；生产该保留多久、是否需要回收站/撤销未定。
- **清理只对本地文件存储验证**：`deleteObject` 在 S3/OSS 上的批量、限流、部分失败、版本化桶删除标记未验证。
- 认领到删除完成之间没有租约，理论上两个清理进程可能重复删除同一对象（删除幂等、代价有界，暂不引入租约列）。
- 缩略图仍未生成，`thumbnail_storage_key` 目前恒为空，相关分支只有单测覆盖。
- 没有任务删除、账号注销或配额相关的级联清理；Studio 未提供删除入口（**已由 3.0.7 补上**）。
- 3.0.5/3.0.4 的其余未完成项不变：真实 Provider 出图未跑、未做 magic byte 校验、Secret boundary 未验收、生产对象存储未接入。

**下一步**（历史建议，已由 3.0.7 执行）：B2 Studio 资产删除入口；B3 孤儿对象回收需先定义上传超时语义；真实 Provider 联调需用户明确批准凭据与预算。

**冷启动交接单**：`PaintTrack/docs/records/HANDOFF_2026-11-13.md`。

### 3.0.7 2026-11-13 当前执行快照（历史，已被 3.0.8 取代）

**最终状态：在 3.0.6 基础上新增阶段 5.8「Studio 资产删除入口」。** 用户现在可以在现有 Studio 画廊里删掉自己生成的图片，删除会真正打到 `DELETE /api/assets/:id`（服务端软删除 + 内容地址立即失效），再由 5.7 的 cleanup 角色异步清理物理对象。**孤儿对象回收、保留政策、生产对象存储仍未做；Studio 侧没有自动化 UI 测试。** 不得据此宣告阶段 7 完成。

**本轮完成**

1. **`packages/studio/src/taskClient.js`**：新增 `deleteAsset(assetId)` 与 `assetIdFromResultUrl(url)`。`deleteAsset` 校验 UUID，只发一次 `DELETE /api/assets/:id`（`credentials: 'same-origin'`），`404` 归一化为 `alreadyDeleted: true`（对本用户而言等价于"已经没有"），其它错误保留 `code`/`status` 并抛出。
2. **删除范围白名单**：只有 `/api/assets/<uuid>/content` 形态的地址才会被识别为可删除资产。外部供应商 CDN 地址一律不发起删除请求——避免误删别人的资源或把删除请求打到第三方。
3. **`packages/studio/src/components/ImageStudio.jsx`**：`handleDeleteEntry` 在移除条目前先删服务端资产；生成成功时把 `result.assetId` 写进历史条目（随 localStorage 持久化）；旧条目靠 URL 反推 ID，因此升级前生成的图片也能删。服务端失败时**保留条目**，用户可重试。
4. **文案**：删除确认改为"删除后无法恢复"；新增 `deleteNotReady`（`409 ASSET_NOT_DELETABLE` 时提示图片仍在处理中），不再把错误码直接抛给用户。
5. **入口复用**：只接现有画廊的删除按钮（桌面悬浮层 + 移动端操作菜单），没有新建平行页面或独立资产管理页。

**已验证**

- `node --test tests/studioTaskClient.test.js`：**9/9 通过**（新增 4 项：URL 白名单、单发 DELETE 与响应归一化、404 幂等、409/非法参数不伪装成功）。
- 整仓 `node --test "tests/*.test.js"`：**516 项 / 514 passed / 0 failed / 2 skipped**。
- ESLint 对 `taskClient.js` / 测试文件无输出；`ImageStudio.jsx` 不在 ESLint 配置覆盖范围（既有现状），改用 `@babel/parser` 做 JSX 语法解析门禁。

**未完成 / 不得写成已完成**

- **Studio 侧没有自动化 UI 测试**：仓库无 jsdom / testing-library，删除按钮的端到端行为只有人工本地验证。不能宣称"删除交互已被 CI 覆盖"。
- 删除仍是软删除；界面上的"已删除"不等于磁盘对象已释放，也不可撤销。
- 孤儿 `pending` 对象、保留政策、生产对象存储、任务删除与账号注销级联，均与 3.0.6 相同仍未做。

**下一步**（按 10.4 最新条目执行）：真实 Provider 联调需用户明确批准凭据与预算；B3 孤儿对象回收需先定义上传超时语义；若要补 UI 自动化，应先引入前端测试依赖（属新增依赖，需用户同意）。

**冷启动交接单**：`PaintTrack/docs/records/HANDOFF_2026-11-13.md`。

### 3.0.8 2026-11-13 执行快照（历史，已被 3.0.9 取代）

**最终状态：在 3.0.7 基础上把 Studio 的删除确认从浏览器原生 `confirm()` 换成应用内弹窗。** 服务端契约、软删除语义、清理流程一律未改；本轮只解决"弹窗不对"这一类产品级缺陷。**其余 8 个 Studio 的删除仍是原生 `confirm()`，未迁移；Studio 侧仍无自动化 UI 测试。**

**为什么必须换（原生 `confirm()` 的实际缺陷）**

1. 标题由浏览器注入，显示为「127.0.0.1:3000 显示」/「<域名> 显示」，产品侧无法去掉；
2. 按钮文案跟随**浏览器语言**（中文「确定/取消」）而正文是应用语言（英文），出现中英混排；
3. 系统灰白对话框与深色玻璃拟态 UI 完全断裂；
4. 阻塞主线程，且没有任何 in-flight 状态——请求期间可重复提交，失败即丢失上下文。

**本轮完成**

1. **新增 `packages/studio/src/components/ui/ConfirmDialog.jsx`**（仓库内第一个通用确认弹窗，放在 `components/ui/` 作为公共基元，并从 `packages/studio/src/index.js` 导出，宿主可 `import { ConfirmDialog } from 'studio'`）：`createPortal` 到 `document.body`（避开 `overflow`/`transform` 祖先裁剪）；`role="alertdialog"` + `aria-modal` + `aria-labelledby`/`aria-describedby`；Esc 取消、点遮罩取消、Tab 焦点陷阱；**打开时焦点落在「取消」**（危险操作的默认焦点不落在「删除」）；关闭后焦点还原到触发元素；打开期间锁 `body` 滚动并补偿滚动条宽度（避免背景横向跳动）；`busy` 时禁 Esc、禁遮罩点击、禁重复提交；`error` 内联渲染（不丢上下文）。**动效分层**：遮罩 200ms 入 / 150ms 出（退出延迟 30ms，让页面背景晚一点露出），面板 260ms 入（`cubic-bezier(0.16,1,0.3,1)`，ease-out-expo 收尾很软）/ 180ms 出（`ease-in`），标题行与按钮行以 40ms/90ms 阶梯上浮 6px 淡入、退出一律不延迟；所有过渡走 inline style，不依赖宿主 tailwind keyframes。**入场必须双 `requestAnimationFrame`**：单 rAF 可能和挂载落在同一次 paint，浏览器没有"闭合态"这个起始值可插值，元素会直接以终态绘制——这正是最初"啪一下出现、很生硬"的根因。`prefers-reduced-motion: reduce` 时全部时长归零。
2. **`ImageStudio.jsx`**：新增 `pendingDelete`/`deleteBusy`/`deleteError` 三个状态与 `requestDelete`/`cancelDelete`/`confirmDelete` 三个处理；桌面悬浮按钮与移动端 actions 菜单都改为**先开弹窗**，确认后才走原来的 `handleDeleteEntry`（服务端软删除 → 移除条目）。
3. **失败语义收紧**：删除失败**保留弹窗并显示原因**（`ASSET_NOT_DELETABLE` → 仍在处理中；其它 → `formatErrorMessage`），用户可重试或取消；不再只飘一条顶部提示然后把对话框关掉。
4. **文案**：`messages/{zh,en}/imageStudio.json` 的 `gallery` 新增 `deleteTitle`/`deleteDescription`/`deleteAction`/`deleteCancel`/`deleteBusy`。旧 `deleteConfirm` 保留（不删键，避免外部引用断裂），但 `ImageStudio` 已不再读取它。

**已验证**

- `@babel/parser`（`plugins: ["jsx"]`）解析 `ConfirmDialog.jsx`、`ImageStudio.jsx` 均通过；ESLint 配置仍不覆盖 `.jsx`（既存现状），因此不把 ESLint 无输出当作校验。
- `esbuild --bundle packages/studio/src/components/ImageStudio.jsx` 退出 0，产物 1.37 MB——证明 `createPortal`、新增组件与两份 JSON 文案在依赖图里都能解析；`esbuild --bundle packages/studio/src/index.js` 同样退出 0（8.7 MB），证明新的公共导出没有断链。
- 整仓 `node --test "tests/*.test.js"`：**516 项 / 514 passed / 0 failed / 2 skipped**（与 3.0.7 完全一致，无回归）。
- dev server 已实机编译：`GET /studio/image` 返回 200，`_next/static/chunks/app/studio/[[...slug]]/page.js` 内含 `alertdialog` 与 `deleteTitle` 标记，说明新组件进入了客户端依赖图（chunk 为 dev 未压缩产物，44 MB）。
- 浏览器内的最终观感仍由用户人工确认：本机无 puppeteer/Playwright，且沙箱禁止 Chrome 绑定 CDP 端口，无法自动截图。

**未完成 / 不得写成已完成**

- **其余 8 个 Studio 未迁移**：`CinemaStudio`、`VideoStudio`、`MarketingStudio`、`RecastStudio`、`LipSyncStudio`、`VibeMotionStudio`、`MotionControlStudio`、`WorkflowStudio`、`DrawModal` 仍调用原生 `confirm()`。本轮只改了截图所在的 ImageStudio。
- **Studio 侧没有自动化 UI 测试**（仓库无 jsdom/testing-library），弹窗的焦点陷阱、Esc、busy 锁定只有代码审阅 + 人工验证。
- 用户在截图里提出的另两个现象**未查**：四张卡片显示纯灰块（若为 mock 占位色则正常，否则是 `/api/assets/:id/content` 取不到；当前 `.local-assets` 为空）、四张卡按钮组疑似未悬停就同时可见（可能与 Tailwind 嵌套 `group` 有关）。
- 3.0.7 未完成项全部不变：软删除不等于对象释放、孤儿 `pending` 回收、保留政策、生产对象存储、任务删除/账号注销级联。

**下一步**：`ConfirmDialog` 已按用户决定提升为公共基元（`components/ui/` + 主入口导出），后续按同一模式逐个替换其余 8 个 Studio 的 `confirm()`；每个 Studio 独立改动、独立验证，不一次性大改。查灰块与按钮常显属于独立缺陷，需单独立项。真实 Provider 联调仍需用户明确批准凭据与预算。

**冷启动交接单**：`PaintTrack/docs/records/HANDOFF_2026-11-13.md`。

### 3.0.9 2026-11-13 执行快照（历史，已被 3.0.10 取代）

**最终状态：Studio 包内**已无任何浏览器原生 `confirm()`**；10 个带危险操作的入口全部改走 `components/ui/ConfirmDialog.jsx`，并通过新增的静态回归门禁锁死。** 服务端、软删除、对象清理、数据库权限一律未改，本轮是纯前端收敛。

**迁移清单（9 个文件 / 10 个入口）**

| 文件 | 删除链路 | 处理方式 |
|---|---|---|
| `VibeMotionStudio.jsx` | 同步 `setHistory` | `pendingDeleteIdx` |
| `LipSyncStudio.jsx` | 同步 `setInternalHistory` | `pendingDeleteIdx` |
| `CinemaStudio.jsx` | 同步 `setInternalHistory` | `pendingDeleteIdx` |
| `RecastStudio.jsx` | 同步 `setInternalHistory` | `pendingDeleteIdx`（移动端原为**硬编码英文**，已统一走本地化文案） |
| `MarketingStudio.jsx` | 同步，且仅 `!historyItems` 时生效 | `pendingDelete{id}`（保留原有 `!historyItems` 语义，未擅自扩展） |
| `MotionControlStudio.jsx` | 同步 `saveHistory` | `pendingDeleteIdx` |
| `VideoStudio.jsx` | **异步**（`onDeleteHistoryItem`） | `pendingDelete{entry,idx}` + `deleteBusy` + `deleteError`，与 ImageStudio 同构 |
| `WorkflowStudio.jsx` | **异步**（`deleteWorkflow`） | `pendingDeleteWorkflow{id,name}`，标题带工作流名；顺带**移除 `alert("Failed to delete workflow")`**，失败改为弹窗内联 |
| `DrawModal.jsx` | 非删除，清空画布 | 标题「Clear the canvas?」+ 后果说明；DrawModal 自身是 `z-[100]` 的 portal 模态，弹窗 `z-[1000]` 叠在其上 |

**新增共享文案模块（避免 18 份重复）**

- `packages/studio/src/messages/{en,zh}/confirmDialog.json`：`deleteTitle`/`deleteDescription`/`deleteAction`/`deleteCancel`/`deleteBusy`/`failed`。
- `packages/studio/src/confirmCopy.js`：`getConfirmCopy(locale)`。英文为 source of truth（与 `i18nUtils.resolveCopy` 一致）；`zh` 与 `zh-*` 命中中文，其余未知 locale 回退英文而**不是** `undefined`。同一句话此前要在 9 个屏 × 2 语言 = 18 个 JSON 里各抄一遍，必然漂移，因此集中一处。
- `DrawModal` 无 i18n 体系（该文件从未接过 `locale`），清空画布文案仍是英文内联——**这是既存现状，不是本轮引入的新债**。

**新增回归门禁 `tests/studioConfirmDialogMigration.test.js`（5 项，纯静态）**

1. 中英文案键集合一致、每个值非空、5 个渲染键 + `failed` 齐备；
2. `confirmCopy.js` 的回退契约（`locale` 空/`en` → en，`zh`/`zh-*` → zh，其它 → `en`）；
3. **components 下无原生 `confirm()`**：剥注释后按两条正则判定——裸 `confirm(`（排除 `getConfirmCopy(`/`<ConfirmDialog`/`obj.confirm(`）与 `window.confirm(`（点号会让前者漏判，而这正是宿主 `TaskCenter.js` 的写法）；
4. 10 个危险操作入口都 `import` 并**实际渲染** `<ConfirmDialog>`（只 import 不渲染也算失败）；
5. `ConfirmDialog` 的无障碍/焦点契约未被剥离（`createPortal`、`role="alertdialog"`、`aria-modal`、默认焦点落 `cancelRef`、`busy` 短路、reduced-motion 清零卸载定时器）。
   - 门禁的判定力已用 6 条样例反向自测（`.confirm(` 不误报、`window.confirm(` 能命中），不是"写完就绿"。

**已验证**

- `@babel/parser`（`plugins: ["jsx"]`）逐个解析 9 个改动文件 + `confirmCopy.js`：全通过。ESLint 配置仍不覆盖 `.jsx`，故不以 ESLint 无输出作为校验。
- `esbuild --bundle` 逐组件打包退出 0；`esbuild --bundle packages/studio/src/index.js` 退出 0（8.6 MB），证明公共导出链路未断。
- 整仓 `node --test "tests/*.test.js"`：**521 项 / 519 passed / 0 failed / 2 skipped**（上轮 516/514，+5 为新增门禁，无回归）。
- dev server 实机编译：`GET /studio/image` 返回 200。
- 观感仍需人工确认：本机无 puppeteer/Playwright，沙箱禁止 Chrome 绑定 CDP 端口，无法自动截图。

**未完成 / 不得写成已完成**

- **宿主层还有 1 处原生 `window.confirm`**：`components/TaskCenter.js:223`（取消任务）。它不属于 studio 包，本轮未动；且门禁只扫 `packages/studio/src/components`。
- `WorkflowStudio.jsx` 仍有 `alert("Failed to rename workflow")`（重命名失败，非删除路径），未改。
- **Studio 侧仍无组件级自动化测试**（仓库无 jsdom/testing-library，HANDOFF 未完成项 E 不变）；新增的 5 项门禁是**源码级**约束，不能替代"点击 → 弹窗 → 删除 → 失败重试"的交互验证。
- **截图里的两个现象**（画廊卡片纯灰块、按钮组看似常显）：用户已确认均为预期表现，不是缺陷；从待排查项中关闭，不再作为后续任务。
- 3.0.7/3.0.8 未完成项全部不变：软删除不等于对象释放、孤儿 `pending` 回收、保留政策、生产对象存储、任务删除/账号注销级联。

**下一步**：截图中的灰块与按钮显示已由用户确认是正确表现，不再排查。短期候选：① 孤儿 `pending` 对象回收（需要先定义上传超时语义，避免误删进行中的对象）；② TaskCenter 取消任务统一用应用内弹窗（需要解决宿主与 studio 包的依赖方向）；③ 前端交互自动化基建（需接受新增依赖）。真实 Provider 联调需用户另行批准凭据与预算；账本契约需要产品规则确认。按用户长期节奏，每次只推进一项并独立验收。

**冷启动交接单**：`PaintTrack/docs/records/HANDOFF_2026-11-13.md`。

### 3.0.10 2026-11-13 执行快照（历史，已被 3.0.11 取代）

**最终状态：补上 5.7 清理链路的缺口——归档中途被强杀留下的 `pending/uploading` 行与其对象现在可被回收，并在真实隔离 PostgreSQL 通过验收。** 用户删除链路（软删除 → `deleted` 清理）未改；Provider、账本、上传通道均未动。

**问题（为什么这是个真缺口，而不是"多余的清理"）**

`assetArchive` 的顺序是 `INSERT pending` → `putObject(users/<owner>/assets/<id>)` → `UPDATE ready`。进程在写完对象、还没改成 ready 时被 SIGKILL/OOM，补偿删除（catch 里的 `deleteObject`）不会执行，于是对象永留在盘上、行永停在 pending。而 `assets_status_storage_consistency_check` 要求这两种状态 `storage_key IS NULL`，**行上根本没有键可读**，所以只能按归档路径的唯一约定推导键。

**决策：新增列而不是把行标成 failed**

标记 `failed` 需要给 cleanup 角色 `UPDATE(status)`，这与「cleanup 不能改 status」的既有最小权限边界和验收负例直接冲突。因此选：

1. 迁移 `0023_orphan_asset_reclaim`：新增 `abandoned_at timestamptz`、CHECK `assets_abandoned_state_check`（只允许 pending/uploading 且不早于 created_at）、部分索引 `assets_orphan_pending_idx`（`created_at` WHERE pending/uploading AND abandoned_at IS NULL）。
2. `abandoned_at` 就是收敛信号：成功删对象后写入，该行不再被认领；行 `status` 保持原样，语义由该列承担。
3. cleanup 角色列级授权：SELECT 追加 `created_at,abandoned_at`（10 列），UPDATE 追加 `abandoned_at`（5 列）。表级权限仍全 false，仍不能改 status/storage_key，仍读不到 users/generation_tasks。

**实现**

- `lib/server/orphanReclaim.js`：`reclaimAbandonedAssets({pool,objectStore,abandonmentMs,batchSize,maxAttempts,dryRun,now})`。`FOR UPDATE SKIP LOCKED` 认领 + 认领即计数；**刻意不 bump `updated_at`**（那是真实生命周期写入时间，不该被清理流程伪造成心跳）；删除对象在事务外、幂等；缩略图同 owner 一并删，跨 owner 键记 `orphan-verify:key_owner_mismatch` 并整行跳过；失败只写 `last_purge_error='orphan-delete:<CODE>'` 且不写 `abandoned_at`，下一轮重试，达上限计入 `exhausted`。
- `scripts/asset-cleanup.js`：新增 `--orphan-hours`（默认 6）与 `--no-orphans`；一轮跑两段，事件分别为 `asset_cleanup` 与 `asset_orphan_reclaim`，两段失败都计入退出码 1。
- `scripts/local-registration.js`：常驻清理显式传 `--orphan-hours`（默认 6），并**刻意不跟随** `--retention-hours 0`。
- `scripts/accept-database-local.js`：cleanup 权限期望清单 10 读 / 5 写；新增 `abandoned_at` 正向写入探针（SAVEPOINT 回滚）；violations 增加 `abandoned_at < created_at` 的 23514 负例；迁移条数断言 0020→0023 追加三条。

**超时语义（不得含糊）**

schema 里没有上传租约/心跳，只能按 `created_at` 老化判断。当前**没有交互式上传通道**，pending 行都由归档路径在数秒内转 ready，默认 6 小时窗口不会误删在途对象。将来引入分片/长时上传必须补租约（heartbeat 或 `upload_expires_at`），**不能只把窗口调大**。

**已验证**

- 整仓 `node --test "tests/*.test.js"`：**535 项 / 533 passed / 0 failed / 2 skipped**（新增 `tests/orphanReclaim.test.js` 10 项 + CLI 4 项）。
- `npm run db:migrate:check`：`Everything's fine`。
- `tests/databaseLifecycle.test.js` 12/12：快照与 schema 双向一致、历史迁移哈希未变。注意该测试的 `previousSnapshot` 必须跟随最新迁移的前一条（本轮 0021→0022），否则会把上一版差异算进本迁移。
- 隔离 PostgreSQL 报告 `.workbuddy/database-acceptance-mwena934_77f663.json` 为 **passed**（123 checks：118 passed / 1 skipped / 4 running / 0 failed），新增「assets.abandoned_at可写在pending行上」与「真实PG孤儿回收：按推导键删对象/写abandoned_at/重跑收敛/窗口内不误删」两项证据。

**未完成 / 不得写成已完成**

- `deleteObject` 只在本地文件存储验证过；S3/OSS 的批量、限流、部分失败、版本化桶删除标记未验证。
- 回收后行仍是 `pending`（刻意不写 status），任何按状态列表展示 pending 资产的 UI 需要额外过滤 `abandoned_at IS NOT NULL`——目前没有这种列表，属预留约束。
- 上传通道、保留政策的产品决策、任务删除/账号注销级联仍未做（3.0.7–3.0.9 未完成项不变）。
- 宿主 `TaskCenter.js:223` 仍是 `window.confirm`；Studio 侧仍无 jsdom 交互测试。

~~**当时的下一步**：候选仍是 ① TaskCenter 统一弹窗（先定依赖方向）② 真实 Provider 联调（需批准凭据与预算）③ 阶段 6.2 账本契约（需产品规则）。~~ 该快照已由 3.0.12 及后续 6.2 规则确认接续；上传通道与保留政策仍属阶段 7，须另行决策。

**冷启动交接单**：`PaintTrack/docs/records/HANDOFF_2026-11-13.md`。

### 3.0.11 2026-11-13 执行快照（历史，已被 3.0.12 取代）

**最终状态：仓库内最后一处原生 `window.confirm` 已移除，宿主层与 studio 包的破坏性操作确认统一走 `ConfirmDialog`；门禁扫描范围从 `packages/studio` 扩到宿主 `components/` + `app/`。** 本轮是纯前端收尾，未触碰数据库、Provider、账本与上传通道。

**前提被证伪：依赖方向不需要"重新决定"**

上一版（3.0.10）把此事的前置写成"需先定依赖方向（宿主依赖 studio，或把 ConfirmDialog 提到共享层）"。核查后该前置不成立——宿主**早已**依赖 studio：

- 根 `package.json`：`workspaces` 含 `packages/studio`，`dependencies` 含 `"studio": "*"`；
- `components/StandaloneShell.js:6` 已有 `from 'studio'` 导入 15 个 Studio 组件；
- `next.config.mjs:3` 的 `transpilePackages` 含 `'studio'`，所以 JSX 源码可直接被 Next 编译；
- `node_modules/studio` 是指向 `packages/studio` 的符号链接，因此 `exports` 新增子路径即时生效，无需重装。

结论：新增一个导入不改变任何架构方向，**不需要**建仓库级 shared 层，也**不需要**动依赖声明。

**决策：用子路径 `studio/ConfirmDialog`，不走主入口**

`packages/studio/package.json` 的 `exports` 在 5.10 已加 `"./ConfirmDialog": "./src/components/ui/ConfirmDialog.jsx"`。选子路径而非 `from 'studio'` 的理由是依赖图：主入口是 barrel，会顺带把 15 个 Studio 与 `@xyflow/react`、`reactflow`、`react-markdown`、`react-syntax-highlighter` 一起拉进任务面板的模块图。TaskCenter 是个轻量侧栏，为一个确认框付这个代价不值。`ConfirmDialog` 只依赖 `react`（+ `react-dom` 的 portal）。

**实现**

- `components/TaskCenter.js`：新增 `pendingCancel`（待确认任务快照）与 `cancelError`；取消按钮从 `if (window.confirm(text.cancelConfirm)) cancelTask(task)` 改为 `setPendingCancel(task)`；渲染 `<ConfirmDialog>`（portal 到 body，`z-[1000]`，高于面板自身 `z-[300]`）。
- `cancelTask` 改为返回布尔值（后端接受取消 → `true`），调用方据此决定是否关闭弹窗；失败时**双写**错误：`cancelError` 进弹窗内联显示，`error` 留在面板顶部（弹窗盖住面板，二者不会同时可见），因此失败后弹窗不关闭、可就地重试——这正是原生 `confirm` 丢掉的上下文。
- `busy` 判定复用 `busyTaskId === pendingCancel.id`，与行内按钮的 disabled 同源，防止连点发出两次 `POST /cancel`。
- 文案复用宿主既有 i18n：标题 `text.cancelConfirm`（zh 由「确认取消这个任务？」收紧为「取消这个任务？」），描述给任务类型作上下文，确认/取消为 `text.cancel` / 新增 `text.keepTask`（保留任务），`text.cancelling` 作 busy 标签。**未引入** studio 的 `confirmCopy.js`——宿主有自己的 `text` 对象，强行为一处弹窗套包级 copy 反而增加耦合。
- `tests/studioConfirmDialogMigration.test.js`：5 条门禁扩到 7 条，新增「宿主层无原生 confirm」（递归扫 `components/` 与 `app/`）与「TaskCenter 走子路径 + 渲染弹窗 + busy 同源」。

**假绿防护（本轮特意加的）**

宿主扫描最容易的失效方式是"目录没扫到、于是全绿"。门禁因此先断言扫描集合里**必须**包含 `components/TaskCenter.js` 且文件数 ≥ 20，再判违规；否则路径变动会让该门禁退化成永远通过的摆设。

**已验证**

- 门禁反向自测：临时把按钮改回 `window.confirm(...)` 后**恰好 2 条失败**（宿主无原生 confirm、TaskCenter 走子路径），报错精确到 `components/TaskCenter.js`；恢复后 7/7。不是"写完就绿"。
- 整仓 `node --test "tests/*.test.js"`：**537 项 / 535 passed / 0 failed / 2 skipped**（较 3.0.10 的 535 项增加的就是这 2 条门禁）。
- `esbuild --bundle components/TaskCenter.js`（react/react-dom 外部化）：exit 0、无警告，同时证明 `studio/ConfirmDialog` 子路径可解析且未把重依赖牵进来。
- `require.resolve('studio/ConfirmDialog')` 解析到 `packages/studio/src/components/ui/ConfirmDialog.jsx`。
- `eslint components/TaskCenter.js`：exit 0，无告警。

**未完成 / 不得写成已完成**

- **没有在浏览器里真实点击验证过**：本沙箱起 Next dev server 不可靠，保障只有源码门禁 + esbuild 打包 + ESLint，不能说"取消任务的弹窗交互已被自动化或人工验证"。
- 仍无 jsdom/testing-library，Studio 与宿主都没有真实 UI 交互测试（3.0.9 起的未完成项不变）。
- `WorkflowStudio.jsx` 的重命名失败 `alert("Failed to rename workflow")` **仍未改**：它在 studio 包内，且不是删除/破坏性路径，本轮范围外。
- 5.11 的对象存储与状态消费方两个缺口不变：`deleteObject` 只验证过本地文件存储；回收后的行仍是 `pending`，按状态展示 pending 资产的 UI 必须过滤 `abandoned_at IS NOT NULL`。

**下一步**：① 阶段 6.2 点数/价格与用户账本契约（需产品规则：单位、赠送、失败退款）；② 本地体验收尾（MFA 密钥持久化、`--prune` 清理历史库与 dist）；③ 前端交互自动化基建（需接受新增 jsdom/testing-library 依赖）；④ 真实 Provider 联调（需凭据与预算批准）；⑤ S3/OSS 的 `deleteObject` 适配验证（需可丢弃测试桶）。任务面板的详情区、错误码展示等既有行为本轮未改，不需要再验收。

**冷启动交接单**：`PaintTrack/docs/records/HANDOFF_2026-11-13.md`。

### 3.0.12 2026-11-13 当前执行快照（本地开发体验收尾：MFA 密钥持久化 + `--prune`，非阶段功能）

**最终状态：修掉一个会真正锁死管理员的本地缺陷（MFA 加密密钥每次重启都变），并补上本地构建目录与历史隔离库的清理入口。** 本轮不改业务代码、不改 schema、不新增依赖。

**缺陷 1：MFA 加密密钥与数据库不同寿（真 bug，不是洁癖）**

本地启动器默认**复用**固定库 `pt_local_auth_000000000000`（账号/会话/任务/资产跨重启保留），但 `createLocalSecrets()` 每次启动都 `randomBytes(32)` 新生成 `PAINTTRACK_MFA_ENCRYPTION_KEY`。而 TOTP 密钥是以 **AES-256-GCM 密文**存在 `admin_mfa_factors` 里的（`lib/server/adminMfa.js`），恢复码只存 SHA-256 摘要。于是：

1. 第一次运行注册管理员并启用 MFA → 密文用 key A 加密落库；
2. 重启启动器 → key B；
3. 再次验证 MFA 时 `decryptSecret` 在 `decipher.final()` 抛认证失败，且**没有任何 UI 能恢复**——原始 TOTP 拿不回，恢复码是哈希，管理员被锁在自己的本地环境外。

**修复**（`scripts/local-secrets.js`）：把密钥持久化到 `.local-state/mfa-encryption.key`（gitignore、目录 0700、文件 0600）。

- 只在**复用库**时持久化；`--fresh` 走一次性库，配一次性密钥且**不写盘**（保持"不留下痕迹"的语义）。
- 写入用 `flag: 'wx'` 拒绝覆盖：两个启动器并发时落败方回读胜者密钥，而不是各写一份。
- 读到非 64 位十六进制 → 抛 `LOCAL_MFA_KEY_CORRUPT` 且**不覆盖原文件**。静默重建会永久孤立库里所有密文，这个决定必须留给人。
- **刻意不持久化 `mailboxSecret`**：邮件只存在内存里，重启后旧验证链接本来就失效，签名密钥跟着换才是一致的。
- 启动日志只输出路径与来源（`created`/`existing`/`ephemeral`），绝不输出密钥本身。
- 生产仍由 `PAINTTRACK_MFA_ENCRYPTION_KEY` 提供，本地这套只是开发便利；文档同时写明真实部署需要密钥托管与轮换计划。

**缺陷 2：本地残留无清理入口**

- `.next_local_<suffix>`：每次 `--fresh` 生成新后缀，Next 被指向 `PAINTTRACK_DIST_DIR=.next_local_<suffix>`，gitignore 覆盖但从不复用；
- 历史库 `pt_local_auth_<suffix>` 及四角色：每次 `--fresh` 留一套。

新增 `scripts/prune-local.js` 与 `node scripts/local-registration.js --prune`：

- **默认 dry-run**，只列清单；加 `--yes` 才真删。清单可先审阅，避免"一键清空"。
- 安全边界（按顺序生效）：只认精确前缀 → 默认库 `pt_local_auth_000000000000` 永远保留 → owner 必须能推导出 `pt_local_migrate_*`（证明是本启动器建的，否则跳过并报告） → 有活动连接跳过（不 kill 别人的会话） → 删库成功后才删其四角色，角色仍被引用（2BP01）则保留并记录。
- `.next/`、`.local-assets/`（用户数据）、`.local-state/`（MFA 密钥）都不可能被匹配——删掉 `.local-state` 等于再次触发缺陷 1。
- `--prune` 是维护入口，不启动任何服务、不做 Next 环境文件检查；没有 `LOCAL_DATABASE_ADMIN_URL` 时只清构建目录，不猜凭据。
- `DROP DATABASE`/`DROP ROLE` 无法参数化，所以每个库名/角色名在拼进 SQL 前**再校验一次 pattern** 并双引号引用。

**已验证**

- `tests/local-secrets.test.js` 8 项：首次创建、二次复用同一密钥、0600 权限、`--fresh` 不落盘、损坏报错且不覆盖、`wx` 拒绝覆盖、路径稳定，以及**端到端**「重启前加密的 TOTP 密文在重启后仍能解开，换任何其它密钥都解不开」。
- `tests/pruneLocal.test.js` 13 项：只匹配 `.next_local_*`、`DIST_PREFIX` 与启动器实际配置一致（防单边改名）、默认库保留、非我所有者拒绝、有连接跳过、四角色推导、dry-run 零删除、`--yes` 真删、`DROP` 失败只报不错杀、角色被引用则保留、无管理连接时只清目录，以及**占用场景给可操作提示 / 目录已消失时不给误导提示**（后两项为同日真实删除后补加）。
- 真实 dry-run（只读）：发现 **23 个历史本地库**，正确保留默认库，无越界条目，exit 0。
- 真实 `--yes`：成功删除 2 个 `.next_local_*`（约 780 MB）；第 3 个因**本沙箱**的 fs 删除被重定向为回收站操作而中断，代码正确输出 `PRUNE_DIST_FAILED ... failed=1` 并 exit 1——这不是代码缺陷，真实 shell 上 `fs.rmSync` 不走该层。
- **真实清库（同日追加，用户确认后执行）**：23 个历史库全部 `DROP`，回收 **196.2 MB**；92 个配套角色随之删除，角色总数 57 → 4；固定库 `pt_local_auth_000000000000` 删除前后核对完好（18 张表 / 22 条迁移记录 / users=1、assets=4、generation_tasks=4）。这也补上了原「角色清理只在 fake client 上验证」的缺口——真实 PG 上 `DROP ROLE` 路径已跑通。
- **构建目录被占用不是 fs bug**：第 3 个 `.next_local_93280c294680`（403 MB）两次都删不掉，排查确认是本机自 14:24 起在跑的本地开发环境（启动器 + `next dev` + worker + `asset-cleanup`）持有该目录，Windows 下 `unlink`/`rename` 均返回 EPERM，删除守卫整体 fail-closed。为此 `--prune` 新增 `PRUNE_DIST_HINT`：失败且目录仍在时提示"先停服务再重跑"，避免排查方向跑偏。
- 整仓 `node --test "tests/*.test.js"`：**558 项 / 556 passed / 0 failed / 2 skipped**（3.0.11 为 537 项；+8 +13）。

**未完成 / 不得写成已完成**

- ~~**没有对那 23 个历史库执行 DROP**~~ → **已由同日追加执行完成**（见上「真实清库」）。原文保留：这是不可逆的破坏性操作，且库里可能有用户还想留的测试数据，故当时只做到 dry-run，等用户确认。
- ~~角色清理只在 fake client 上验证过路径~~ → 已随真实清库在真实 PG 上跑通 `DROP ROLE`（含 `2BP01` 保留分支的代码路径仍在，但本次未触发）。
- 本机仍剩 1 个 `.next_local_93280c294680`（403 MB）**未清**：被运行中的本地开发环境占用，需停服务后重跑 `--prune --yes`。
- MFA 密钥文件损坏时只报错，没有提供"确认后清空 factor"的辅助命令——需要用户手工处理（删库里的 `admin_mfa_factors` 行或删除密钥文件重来）。
- 附带发现但未修：`MailboxSecret` 与固定库的组合在重启后会让**未验证的注册链接**失效（预期行为，非缺陷），但如果将来把邮件持久化，这条不持久化的决定需要重新评估。

~~**当时的下一步**：① 阶段 6.2 点数/价格与用户账本契约（需产品规则）；② 前端交互自动化基建（需新增 jsdom/testing-library）；③ 真实 Provider 联调（需凭据与预算）；④ S3/OSS 的 `deleteObject` 适配；⑤ `pending` 行 UI 过滤排查；⑥ `WorkflowStudio` 遗留 `alert`。~~ 已由后续 6.2 用户规则确认接续；当前待完成具体价格/精度/风控参数与技术设计，见 `PHASE6_ACCOUNT_CENTER_PRODUCT_DESIGN.md` §4.1–4.2。

**冷启动交接单**：`PaintTrack/docs/records/HANDOFF_2026-11-13.md`。

### 3.0 当前已知状态与例外

- 此处记录的 React / react-konva 启动兼容问题已由用户手动解决；后续工作不应重复处理该问题，除非用户重新提出或回归测试再次复现。
- 依赖版本基线见 3.1 与 5.1。未经用户确认，不得升级、放宽版本范围或重建 lockfile。
- `npm run dev` 与 production build 已分别验证，两者不可互相替代。生产构建已于 2026-11-04 实际执行通过（`Compiled successfully`、11/11 静态页、`BUILD_ID` 生成、`next start` 后路由返回 200）；但默认入口 `npm run build` 在当前受管环境中受 `.next/trace` 写入限制阻断，需用 `npm run build:notrace`（见 3.1）。这不代表源码或依赖有问题。
- `npm run lint` 当前为 0 error / 11 warnings；warning 属于已记录的既存问题，后续不得增加，除非用户接受并更新基线。
- Git 工作区含有多项未提交改动、备份与项目记忆文件；必须按 3.3 和第 4 节保护，不得将其视为可清理内容。
- 本规范现统一维护在仓库内 `docs/ImplementationPlan/PAINTTRACK_DEVELOPMENT_PROCESS.md`，作为项目总体实施计划与执行顺序的权威入口，随项目文档一并维护。
- 阶段 1–4 的逐步骤状态与证据索引位于仓库内 `PaintTrack/docs/records/PHASE1-4_ACCEPTANCE_INDEX.md`；该索引补充验收定位，不替代本规范的阶段授权与逐步验收门禁。

- 仓库：`F:/111/QAQ/me/AI Agent/Hub/PaintTrack/PaintTrack`，分支 `my-work`。
- 当时 `GIT_WORKFLOW.md` 与 `README.md` 已暂存未提交；任何后续操作不得擅自覆盖或提交这两项改动。
- 当时 `origin` 为 `https://github.com/leafGGB/PaintTrack-AI.git`，`upstream` 为原作者仓库。**2026-11-04 已确认：`origin` 保持现状，不做修改。** 理由：`origin` 已指向自有仓库，`upstream` 已正确指向原作者仓库，构成标准 fork 结构；除非实际重命名了 GitHub 仓库，否则改动远程地址只会增加出错面，不会带来收益。
- 三个 Git 子模块均已检出：`Vibe-Workflow`、`Open-Poe-AI`、`Open-AI-Design-Agent`。
- Node.js 为 `v22.22.2`、npm 为 `10.9.7`。
- 根项目元数据与 Electron 产品标识**已于 2026-11-04 统一为 PaintTrack**（详见 3.2 标识清单）；原始名称仅保留在法律与来源声明处。
- 已发现 8 个现有测试文件（共 50 个用例），集中于 Electron 本地推理/Wan2GP；当前未发现覆盖 SaaS API、认证、数据库、任务和账务的测试体系。
- 当前 Compose 仅定义单体 Next.js 服务（服务/容器名已改为 `painttrack`，映射 `3001:3000`），没有 PostgreSQL、对象存储或独立 Worker 配置；仓库无 `.env*` 文件。

### 3.1 2026-11-04 复核后的可复现基线

表中标记为“通过”的结果均已实际执行，可作为阶段 0 的起点；“未验证”项不得视为通过。任何一项状态变化都须重新测量，不得沿用旧结论。

| 项目 | 状态 | 证据 |
|---|---|---|
| 依赖安装 | 已完成 | `npm install --legacy-peer-deps` 退出码 0；React 19.2.4 / React-DOM 19.2.4 / react-konva 19.2.7 / konva 10.9.1 / next 15.5.28 |
| 开发服务器与路由 | 通过 | `npm run dev` → `Ready in 2.7s`；`/studio/[[...slug]]` 编译 3237 模块通过；`GET /studio` 返回 200。此项仅证明开发服务器启动和路由可用，不代表生产构建通过 |
| 生产构建 | 通过（附环境说明，见下） | `next build` → `Compiled successfully`、`Generating static pages (11/11)`、21 条路由、`BUILD_ID` 已生成、退出码 0；产物 766MB。生产服务器 `next start` → `Ready in 539ms`，`/studio` 200（title `Studio — PaintTrack`）、`/agents/create` 200、`/` 307→`/studio`、`/zh` 307→`/zh/studio` |
| 生产构建（默认入口） | **受阻** | 直接 `npm run build` 在受管环境中抛 `EPERM: open '.next\trace'` 并以退出码 1 终止；绕过 trace 写入后构建完全正常，说明与源码无关。详见下方「构建期 trace 写入受阻」 |
| 既有测试 | 通过 | `npm test`（= `node --test "tests/*.test.js"`）→ 50 用例，49 通过，1 跳过，0 失败，退出码 0 |
| 静态检查 | 通过（含 11 条 warning） | `npm run lint`（= `eslint .`，flat config：`eslint.config.mjs`）→ 0 error / 11 warning，退出码 0 |

- **测试入口已建立**：`"test": "node --test \"tests/*.test.js\""`。注意 `node --test tests/`（传目录）在 Node 22 下会报 `MODULE_NOT_FOUND`；glob 必须加引号交给 Node 自行展开，否则在 Windows 的 `cmd.exe` 下不会由 shell 展开。
- **静态检查已具备**：ESLint 9 + `eslint-config-next` 15.5.28（已在依赖树内，无需新增安装），通过 `FlatCompat` 桥接 legacy 配置。`lint` 脚本由 `next lint` 改为 `eslint .`——`next lint` 会进入交互式初始化，且 Next 16 将移除。11 条 warning 全部是 `@next/next/no-img-element` 与 `jsx-a11y/alt-text`，属遗留组件的既存问题，不阻断门禁；**warning 数量不得增加**。
- **构建产物不得参与检查**：子模块的 `dist` 分散在多级目录（如 `packages/Open-Poe-AI/packages/agents/dist`），若未按目录名忽略，会把编译后代码当源码检查并产生虚假 error。
- **构建期 trace 写入受阻（环境问题，非源码问题）**：`next build` 在构建早期会创建 `.next/trace` 写入性能事件；在带文件写入策略的环境（托管沙箱、部分杀毒实时防护）中该 `open` 调用返回 `EPERM`，而 Next 的 `to-json.js` 未监听该流的 `error` 事件，异常冒泡成 `uncaughtException` 直接终止进程。判定依据：① 同一路径手工 `fs.createWriteStream(file, {flags:'a'})` 写入成功；② 6 个并发子进程同时追加写同一文件全部成功；③ 仅跳过 trace 写入、不触碰任何源码或依赖，构建即 `Compiled successfully`。**`.next/trace` 只服务 Next 内部性能诊断与遥测，不参与产物生成。**
  - 规避命令：`npm run build:notrace`（= `scripts/build-notrace.mjs`，经 `NODE_OPTIONS` 注入 `scripts/trace-write-shim.cjs`，确保 worker 子进程同样生效）。日志会出现一次 `[trace-write-shim] 已跳过 Next trace 写入`。
  - **该 shim 属环境适配，不是项目缺陷的修复。若本机 `npm run build` 正常，不要使用它。** 已确认的未验证点是：本 shim 仅在当前环境验证过，尚未在干净的 Linux/CI 环境复核。

### 3.2 项目标识清单（2026-11-04 统一）

| 项 | 旧值 | 新值 |
|---|---|---|
| `package.json` `name` | `open-generative-ai` | `painttrack` |
| `build.productName` | `Open Generative AI` | `PaintTrack` |
| `build.appId` | `ai.generative.open` | `com.leafggb.painttrack` |
| `homepage` | 原作者仓库 | `https://github.com/leafGGB/PaintTrack-AI` |
| `repository` | 未定义 | `git+https://github.com/leafGGB/PaintTrack-AI.git` |
| `build.linux.maintainer` | `Open Generative AI Team` | `PaintTrack Team` |
| Debian 包名 / 命令名 / 安装目录 | `open-generative-ai` | `painttrack`（`/opt/painttrack/PaintTrack`） |
| Windows 安装目录 / 进程名 | `%LOCALAPPDATA%\Open Generative AI` | `%LOCALAPPDATA%\PaintTrack` / `PaintTrack.exe` |
| Compose 服务与容器名 | `open-generative-ai` | `painttrack` |
| 页面标题、`index.html`、i18n `brand` | 原品牌 | `PaintTrack` |

**刻意保留原名，不得修改：**

- `LICENSE` 的 `Copyright (c) 2026 Open Generative AI Contributors`——上游著作权声明，改掉等于篡改他人版权归属。
- `GIT_WORKFLOW.md`、`README.md` 中的上游仓库名与归属说明——fork 关系的真实记录。
- `electron/lib/localInference.js` 中指向上游 releases 的二进制下载地址——真实下载源，改动会直接导致本地推理不可用。
- `electron/lib/*` 中的 `User-Agent` / MCP `clientInfo.name` 标识——功能性标识，与品牌无关。

**已知遗留问题（不在本次修复范围）：** deb 打包脚本的 `INSTALL_DIR_NAME` 取 `PACKAGE_NAME`，而 `build/linux/apparmor.profile` 原先指向 `/opt/Open Generative AI/...`，二者本就不一致。本次已按脚本实际推导把 profile 路径改为 `/opt/painttrack/PaintTrack`，但 **Linux 打包链路在当前 Windows 环境无法实测**，须在阶段 12 预发布前于真实 Linux 上验证。`appId` 变更会使新旧版本的 Electron `userData` 目录不兼容，因尚未对外发布，暂无影响。

### 3.3 工作区当前改动（2026-11-04）

复核时工作区存在以下未提交内容，其中一部分来自本次启动链路修复，**提交前须逐项确认归属**：

| 路径 | 状态 | 来源 |
|---|---|---|
| `GIT_WORKFLOW.md` | 已暂存新增（A） | 用户既有改动，不得覆盖 |
| `README.md` | 已暂存修改（M） | 用户既有改动，不得覆盖 |
| `package.json` | 已修改（M） | 本次修复：React / react-konva 版本锁定；新增 `test` / `patch:submodules` / `build:notrace` 等命令；`lint` 改为 `eslint .`；**产品标识统一为 PaintTrack** |
| `package-lock.json` | 已修改（M） | 本次修复：重装后重建；根包名同步为 `painttrack` |
| `eslint.config.mjs` | 新增（未跟踪） | 本次新增：ESLint 9 flat config，**须随主仓库提交** |
| `patches/*.patch`（3 个） | 新增（??） | 本次新增：子模块版本修正补丁，**须随主仓库提交** |
| `scripts/apply-submodule-patches.js` | 新增（??） | 本次新增：补丁应用脚本，**须随主仓库提交** |
| `scripts/trace-write-shim.cjs`、`scripts/build-notrace.mjs` | 新增（??） | 本次新增：构建期 trace 写入规避（环境适配，见 3.1），**须随主仓库提交**；若目标平台无此限制可移除 |
| `.next_bak_*`、`.next_fail*`、`.next_prod_*`（多份） | 未跟踪（??） | 本次排查产生的构建缓存备份，**未经用户明确确认不得清理** |
| `app/layout.js`、`app/agents/*`、`app/studio/*`、`app/workflow/*`、`app/zh/studio/*` | 已修改（M） | 本次修复：页面 metadata 标题改为 PaintTrack |
| `messages/en/common.json`、`messages/zh/common.json` | 已修改（M） | 本次修复：i18n `brand` 与 API Key 弹窗标题 |
| `index.html` | 已修改（M） | 本次修复：Vite/Electron 入口标题与描述 |
| `electron/main.js` | 已修改（M） | 本次修复：窗口标题与错误提示 |
| `build/installer.nsh`、`build/linux/apparmor.profile`、`scripts/package-linux-deb.js` | 已修改（M） | 本次修复：打包标识与安装路径对齐 |
| `docker-compose.yml` | 已修改（M） | 本次修复：服务与容器名 |
| `lib/locales.js`、`tests/localInferenceAssets.test.js` | 已修改（M） | 本次修复：注释与测试夹具路径的命名一致性 |
| `packages/Vibe-Workflow`、`packages/Open-Poe-AI`、`packages/Open-AI-Design-Agent` | 子模块内容已修改（m） | 由 patch 产生，可随时用 `npm run patch:submodules` 复现 |
| `.next_bak_*`（3 个）、`package-lock.json.bak_*`、`.workbuddy/` | 未跟踪（??） | 构建缓存、锁文件备份与项目记忆目录；均为既有文件，未经用户明确确认不得清理、覆盖或移动 |

> 子模块 `packages/studio` 的 `src/messages/*/mcpCliStudio.json` 与 `dist/**` 内仍有原品牌文案。它属于子模块源码与编译产物，改动需要新增 patch 并重新打包，**本次未处理**；对外发布前须一并处理（见阶段 12）。

**起始门禁：**进入任何代码实施前，先复核工作区状态与文件，确认依赖安装策略和 `origin` 地址处理方式。若用户改动与计划冲突，暂停并询问。安装依赖会更改 lockfile 或生成文件，执行前说明影响；除非用户授权，不进行部署、创建云资源或访问真实供应商。

**子模块改动的持久化方案（2026-11-04 已确认：采用 patch 方案）**

本次依赖修复修改了三个子模块内部文件。子模块内的改动既不会随主仓库提交，也会被 `git submodule update --recursive` 覆盖，届时启动报错将复现。已在三个候选策略中选定 **patch 方案**：改动量仅为若干版本号，fork 三个仓库的维护成本远大于收益，手工维护则必然失效。

实现方式：

- `patches/` 目录存放三个补丁，仅包含必要的 `package.json` 版本改动，不含 `package-lock.json`（子模块 lock 在 workspace 模式下不生效，且会随安装重新生成）：
  - `0001-vibe-workflow-client-react-19.2.4.patch`
  - `0002-open-poe-ai-client-react-19.2.4.patch`
  - `0003-open-ai-design-agent-react-konva-19.2.7.patch`
- `scripts/apply-submodule-patches.js` 负责应用，具备幂等性：已应用的跳过，未应用的补丁，冲突的显式报错。
- 命令：
  - `npm run patch:submodules`：应用补丁。
  - `npm run patch:submodules:check`：只检查不写入，存在待应用项时退出码非 0。
- `npm run setup` 已改为 `git submodule update --init --recursive` → **应用补丁** → `npm install` → 构建子包。补丁必须先于依赖安装执行，否则 npm 会读到未修正的 `package.json`。

**强制要求：任何执行 `git submodule update` 之后，必须先运行 `npm run patch:submodules`，再运行 `npm install`，否则 React 版本约束会被破坏。** 若补丁应用时报告冲突，说明上游子模块内容已变更，须人工核对并更新补丁文件，不得强行跳过。

**已验证（2026-11-04）：** 将三个子模块相关文件还原至原始状态后执行补丁，五个目标文件的 md5 与手工修改结果完全一致，可确认补丁与手工改动等价。

## 4. 每一步的固定执行协议

### 开始前

1. 用简短说明界定唯一目标和不包含的内容。
2. 检查工作区状态、当前分支、相关文件和既有实现。
3. 列出将修改的文件/模块、交付物、风险和测试命令/验证办法。
4. 确认依赖的前置步骤已验收；否则不得开始。

### 工作区保护规则

1. 每项任务开始前必须执行并记录 `git status --short`；涉及远程、分支或子模块时，同时检查对应状态。
2. 不得执行 `git reset --hard`、`git checkout --`、批量删除、覆盖、清理或移动未提交文件，除非用户明确指定了目标并确认影响。
3. 不得擅自清理 `.next_bak_*`、`package-lock.json.bak_*`、`.workbuddy/`、子模块改动或其他未跟踪文件；“稳定后可清理”不等于已获授权。
4. 与当前步骤无关的用户改动必须原样保留。若改动影响当前步骤，先暂停并向用户说明冲突，不得自行回滚或猜测归属。
5. 任何会改变 `package-lock.json`、子模块内容、远程地址、分支历史或生成大量文件的操作，都必须在执行前说明影响；锁文件重建还必须遵守第 5.1 节的例外流程。

### 实施中

1. 只做本步骤所需的最小改动，沿用仓库现有风格。
2. 任何新增依赖必须说明用途、替代方案、维护风险及许可影响。
3. 数据库、额度和任务操作优先使用事务、唯一约束、幂等键和审计记录；禁止以客户端状态作为权威数据。
4. 所有服务端输入都要验证；服务端必须执行身份认证、资源归属和角色授权检查。
5. 供应商密钥仅由服务端安全配置读取；客户端不得获得长期密钥。

### 完成后

1. 执行本步骤的静态检查、单元测试、集成测试及必要的手工验证。
2. 执行适用的安全检查，至少覆盖本步骤新增或改变的攻击面。
3. 检查 Git diff，确认没有意外文件、秘密、生成物或用户改动被覆盖。
4. 对照验收标准逐项标记通过/未通过/未验证，并附命令、结果和限制。
5. 写入项目工作日志并报告结论；停止等待用户确认，不自动开始后续步骤。

### 门禁状态

- **通过：**所有强制验收项通过，没有未处理的高危/严重问题，可以请求用户批准下一步。
- **有条件通过：**仅非阻断项未验证，影响已明确且用户接受临时限制；不得将未验证项描述为通过。
- **未通过：**任何强制测试失败、权限或账务不变量不成立、出现严重安全问题；留在当前步骤修复。

## 5. 技术选型基准

以下为方案基准而非不经验证的实施命令。第一阶段须通过仓库兼容性审查后再锁定版本。引入技术替代项需先说明迁移成本并取得确认。

| 领域 | 基准选择 | 约束与理由 |
|---|---|---|
| Web 与 API | 先复用现有 Next.js 15 / React 19 | 降低初期重写成本；先盘点 App Router、Route Handler、中间件和 Electron/Vite 的边界。SaaS API 不可直接转发供应商。**React 与 react-konva 版本必须按 5.1 锁定，禁止随意升级。** |
| 语言 | 沿用仓库 JavaScript | 避免阶段初期大规模迁移；新服务端模块使用清晰边界、JSDoc/校验 schemas。是否渐进采用 TypeScript 需基线后再评估。 |
| 数据库 | PostgreSQL | 事务、约束、可靠账务和关系数据；数据库访问层/ORM 在依赖与迁移方案评估后选定，不在此预先假定。 |
| 数据库迁移 | 可审查、版本化的迁移工具 | 每次迁移可在干净数据库重放；破坏性迁移采用扩展-迁移-收缩并提供恢复预案。 |
| 对象存储 | S3 兼容对象存储接口 | 通过服务端签发短时预签名 URL；对用户文件执行归属校验、大小/MIME 校验和生命周期管理。具体云厂商待部署需求确定。 |
| 异步任务 | 持久化任务表 + 独立 Worker；队列技术在基线阶段选定 | 生成任务具备持久状态、租约/超时、重试与幂等；不能只依靠浏览器轮询或进程内内存队列。若选择 Redis/BullMQ 等，须评估持久性、运维与许可。 |
| 供应商 | 可配置的 Provider/API Adapter 接口 | 统一服务端鉴权、参数映射、提交、查询、取消（若支持）、结果解析、错误分类、重试和成本；具体协议与首个适配器按用户提供的 API 文档确认，不预设 MuAPI 或其他供应商。凭据仅服务端持有。 |
| 认证 | 邮箱登录，服务端会话 | 首期邮箱；密码哈希使用经维护的标准算法库，设置安全 Cookie、过期/撤销、登录限速和邮箱验证策略。具体认证库需在实现前评估。 |
| 测试 | Node 测试体系 + API 集成测试 + 浏览器端关键流程测试 | 结合现有项目选择可兼容工具。测试包含正常、边界、并发、故障与权限负例；第三方调用使用可控 mock。 |
| 本地客户端 | 保留 Electron/Vite 现有路径 | 本地 sd.cpp/Wan2GP 与云端 API/额度显式分流；本地模式不可调用云端扣费结算接口。 |
| 部署 | 容器化 Web/API、Worker、PostgreSQL、对象存储连接 | 按环境分离密钥；有健康检查、备份、恢复演练、日志和告警。真实云资源与生产发布必须另行批准。 |

### 5.1 前端依赖版本锁定（强制，2026-11-04 确认）

本项目存在一个**框架级版本耦合**，不清楚成因会导致反复误判和返工。以下为强制约束：

**锁定值：** `react` `19.2.4`、`react-dom` `19.2.4`、`react-konva` `19.2.7`、`konva` `10.9.1`、`next` `15.5.28`。根 `package.json` 与三个子模块内的 `client/package.json` 必须保持一致，且**使用精确版本号，不使用 `^` 范围**。

**成因：** Next.js 15.5.28 内置 vendored React 机制。webpack 会把 `react-konva` 源码中的 `import React from 'react'` 重定向到
`(ssr)/./node_modules/next/dist/server/route-modules/app-page/vendored/ssr/react.js`，
该文件为约 127 字节的转发 stub，指向 Next 构建期预编译进 `module.compiled` 的 React（19.2.x）。该 React 副本不在 `node_modules` 依赖树中，通过 `find node_modules -name react` 无法发现，只会在编译产物中现形。

**因此：**
1. 升级 React 到 19.3 及以上**不可行**——react-konva 的版本检查读到的是 Next 自带的 19.2，仍会失败。
2. 报错信息 `react-konva requires React 19.3 or later within React 19` 具有误导性，字面诱导升级，**正确方向是降级到 19.2 系**。
3. 禁止执行 `npm update`、无约束的 `npm install`，或把 React 依赖改回 `^19.0.0` 这类开放范围。

**降级/变更版本的正确操作顺序（仅适用于已批准的锁文件重建例外）：** 修改全部相关 `package.json` 为精确版本 → 先备份并记录当前 `package-lock.json` → 经用户明确批准后移走 `package-lock.json`（`^` 范围下锁文件会阻止降级）→ `npm install --legacy-peer-deps` → 审查 `package-lock.json` diff，核对 React、React-DOM、react-konva、Konva、Next.js 的最终解析版本 → 移走 `.next`（`mv` 而非删除，避免构建清场被环境策略拦截）→ 重新执行测试、lint、开发服务器验证，并在适用时单独执行 `npm run build`。除非进入上述例外流程，禁止删除、移走或重建 `package-lock.json`。

**锁文件重建例外流程：**
1. 说明重建原因、影响范围和预期版本变化；
2. 先备份现有 `package-lock.json`，记录备份路径和当前 Git 状态；
3. 获得用户明确批准后，才可移走或重建 lockfile；
4. 安装完成后检查完整 lockfile diff，确认没有无关的大范围升级；
5. 核对关键依赖最终解析版本，并运行适用的测试、lint、启动验证和生产构建验证；
6. 如验证失败或结果不符合预期，停止当前步骤，保留备份并报告，不得静默覆盖原锁文件。

**排查方法：** 遇到同类“版本已装但仍报不兼容”的问题，不要只看 `package.json` 声明版本，应直接检查编译产物中的模块引用路径（如 `.next/server/vendor-chunks/*.js` 内 `__webpack_require__` 的目标模块），确认 webpack 实际解析到了哪一份依赖。

### 服务端边界

浏览器只能调用 PaintTrack 自有 API。自有 API 负责认证、授权、额度、任务归属和审计，再调用 Provider。禁止把供应商密钥下发到浏览器、localStorage、Electron renderer 或公开日志。供应商响应、错误消息和 URL 均按不可信输入处理。

### 核心数据边界

建议至少区分用户、会话、任务、额度账户/账本、定价版本、供应商调用/成本、素材对象、模板/工作流和审计事件。实际表结构在对应步骤经评审后确定。余额必须可由账本核对；禁止只修改单个余额字段而不保留可追溯账本事件。

## 6. 分阶段路线、交付与验收

以下每个阶段仍须拆成小步骤逐个执行。阶段是顺序依赖，不是一次性任务清单。每完成一个小步骤必须停下验收；用户确认后再做下一小步骤。某阶段完成后也须独立验收，获确认后才进入下一阶段。

### 阶段 0：基线、环境与项目身份

**目标：**建立可复现的开发/测试基线，澄清仓库和品牌身份，保护现存改动。

**建议小步骤：**
1. 复核 Git 状态、远程、子模块、Node/npm 和当前未提交改动；向用户确认 `origin` 的准确目标。*（2026-11-04 已复核；`origin` 已确认保持现状）*
2. 确认 lockfile、依赖安装策略和 Node 版本约束；在确认后安装依赖。*（依赖已安装，版本按 5.1 锁定；子模块改动已采用 patch 方案，见第 3 节起始门禁）*
3. 运行现有 lint、开发服务器/路由与本地推理测试，区分源码问题、依赖问题和环境问题。*（2026-11-04 完成：开发服务器/路由、既有测试、lint 均取得有效结果；production build 亦已实际执行通过，经由 `npm run build:notrace` 绕过环境级 trace 写入限制，见 3.1）*
4. 制定项目名称、README、Electron appId/productName 与仓库地址的统一清单；经确认后逐项更新。*（2026-11-04 完成：用户授权按建议执行，清单见 3.2，标识已落盘并经验证）*
5. 建立测试命令和本地开发说明，记录可复现基线。*（2026-11-04 完成：新增 `test` 脚本与 `eslint.config.mjs`，`npm test` / `npm run lint` 均实测通过，见 3.1）*

**交付物：**基线报告、Node 版本约束、可复现依赖锁定状态、项目标识清单、基线测试记录。

**功能验收：**按文档可完成依赖安装；现有开发服务器/路由路径及 Electron 本地能力有明确结果；production build 已实际执行成功并留存产物证据（见 3.1），但其默认入口在受管环境中受 trace 写入限制阻断，须以 `npm run build:notrace` 或等价的 `NODE_OPTIONS --require scripts/trace-write-shim.cjs` 方式执行；品牌标识无未经批准的仓库地址变更。

**安全验收：**检查仓库无提交的密钥/令牌；依赖安装来源可追踪；子模块来源与固定提交可审查；用户既有改动保持不变。

**门禁：**开发服务器、测试、静态检查与 production build 基线均已取得有效结果；production build 的环境级 trace 写入限制已定性并记录规避方式（3.1）。进入依赖生产构建的打包/发布步骤前，须在目标平台复核 `npm run build` 的表现——若目标环境无该限制，应以默认入口为准，不得把 shim 当作常态。若存在其他环境限制，记录具体阻断并取得用户接受后才能进入后续架构步骤。

**2026-11-04 状态：**小步骤 1–5 全部落地，阶段 0 已具备关门条件。仍待用户确认后进入阶段 1；当前记录的遗留事项有三项，均已记录且不阻断开发基线：①默认入口 `npm run build` 在受管环境中被 trace 写入限制阻断（已定性为环境问题，构建本身经 `build:notrace` 验证通过；需在目标平台复核）；②子模块 `packages/studio` 的品牌文案未处理；③Linux 打包链路未在真实 Linux 上验证。

### 阶段 1：SaaS 架构与基础设施决策

**目标：**在编码前确认服务端边界、数据模型范围、部署形态和外部服务选择。

**建议小步骤：**
1. 梳理现有 API Route、中间件、MuAPI、上传、任务恢复及共享 studio 组件，形成可复用/不可复用清单。
2. 检查 `Vibe-Workflow` 的节点协议、执行引擎、文件传递和许可证/维护状态。
3. 形成架构图、威胁模型、数据流图和服务边界。
4. 评估 PostgreSQL 访问/迁移方案、对象存储、任务队列/Worker、邮件服务和部署环境，比较方案并确认选型。
5. 设计数据分类、保留期限、备份/恢复、监控和秘密管理策略。

**交付物：**架构决策记录（ADR）、组件边界图、初版 ERD、数据流/威胁模型、基础设施决策表、风险清单。

**功能验收：**每个产品需求都映射到服务端模块、数据实体和调用流程；本地推理与云端任务明确分开。

**安全验收：**数据流标出身份、授权、密钥、文件和供应商边界；明确 SSRF、越权、重放、资源滥用、文件滥用及供应商失败防护。

**门禁：**关键技术架构基线须经用户确认；云服务商、地域、资源规格与购买可后置，不作为本地开发和阶段 2 的前置条件。阶段 2 可在本地隔离环境中按已确认边界逐步实现和验证；不得据此创建云资源或把本地配置视为生产部署决策。涉及数据库、认证、Worker、对象存储和邮件的工作仍须按后续阶段小步骤逐项执行并验收。供应商与部署约束须在接入真实外部服务、预发布或生产部署之前完成专项评估与用户确认。

### 阶段 2：数据库、配置与服务端基础

**状态：已完成。**阶段 2 的实现与真实 PostgreSQL/Worker 验收已在后续阶段复用；具体报告及权限、恢复边界见 `PaintTrack/docs/records/DB_SETUP.md` 和各阶段记录。下列条目保留为阶段目标与验收基准，不表示仍待执行。

**目标：**提供可迁移、可测试、可恢复的 SaaS 服务端底座。

**建议小步骤：**
1. 建立环境配置 schema、启动校验和本地开发配置示例（不含真实秘密）。
2. 建立 PostgreSQL 连接、迁移、健康检查和测试数据库策略。
3. 实现最小服务端日志、请求关联 ID、错误格式和审计事件接口。
4. 建立 Worker 启动骨架与任务持久化/领取协议（暂不接真实供应商）。
5. 建立对象存储抽象和本地/测试替身（不公开对象）。

**交付物：**配置模块、数据库迁移、服务端基础模块、Worker 骨架、测试夹具、运行说明。

**功能测试：**空库迁移、重复迁移、连接失败处理、健康检查、Worker 重启后的任务恢复、测试环境隔离。

**安全测试：**缺失/错误配置应安全失败；日志不得泄露秘密或敏感请求体；数据库角色最小权限；对象访问默认私有；验证 SQL 注入防护和资源关闭。

**门禁：**迁移可从空库重放；恢复/失败路径通过；无高危安全问题；用户确认基础设施选择。

### 阶段 3：邮箱认证、用户与权限

**状态：阶段 3.1–3.6 的本地/隔离环境基础能力已完成验收；生产邮件与运维收尾未完成。**分步实现和验收依据见 `PaintTrack/docs/records/DB_SETUP.md`、`PaintTrack/docs/records/PHASE1-4_ACCEPTANCE_INDEX.md` 及 `.workbuddy` 对应报告。阶段 3.1–3.5 覆盖注册与邮箱验证、登录/登出/会话、角色和服务端授权、密码重置、独立 bootstrap CLI 管理员初始化；最终真实 PostgreSQL 隔离报告为 `PaintTrack/.workbuddy/database-acceptance-mw5z8fxe_528a61.json`，状态 `passed`，版本 16.15。阶段 3.6 的认证记录清理、持久 outbox 基础和 outbox worker 均有各自真实 PostgreSQL 隔离验收报告（索引列出）。这些报告仅证明隔离环境中的实现验收，不代表生产部署、真实邮件送达、生产认证强度或 bootstrap 凭据生命周期已验证。真实邮件及生产投递按用户决定延期；bootstrap 身份的回收/轮换仍待授权运维核实。

**阶段 3.6 范围与当前结果：**认证记录保留/清理、持久邮件 outbox 协议及 outbox 投递 worker 的隔离环境实现和真实 PostgreSQL 验收已完成；逐项报告见 `PaintTrack/docs/records/DB_SETUP.md` 与 `PaintTrack/docs/records/PHASE1-4_ACCEPTANCE_INDEX.md`。真实邮件供应商、加密密钥注入、生产投递调度、发送耗时心跳及退信/投诉处理按用户决定延期至真正需要用户注册时再另行实施和验收。认证清理初始工程候选值为 token 失效/消费后保留 7 天、撤销/过期 session 保留 30 天；这些值仅用于当前代码和隔离测试，不构成已批准的隐私政策或生产承诺。bootstrap 身份回收/轮换仍待授权运维核实；生产清理调度与生产执行须另行审查权限、目标、告警和恢复措施。

**本阶段不包含：**MFA/管理员强化认证（阶段 8）；账户导出、删除和自助清理（阶段 11）；正式管理员后台（阶段 8）。分来源生产限流和跨进程 KDF 总资源控制先在阶段 3.6 做风险与容量决策，若需代码实现则形成单独小步骤和准入标准。

**目标：**建立服务端可信身份和用户/管理员授权边界。

**已交付范围（阶段 3.1–3.5）：**
1. 用户实体、邮箱唯一性、受控注册与邮箱验证流程。
2. 密码哈希、登录、登出、固定有效期服务端会话、撤销和 Cookie 策略；没有滑动续期或“记住我”。
3. 用户与管理员角色及服务端授权策略、资源所有权检查。
4. 登录/注册/验证/密码重置的限流、密码重置和安全日志；审计记录采用固定白名单字段，当前不是数据库内持久原子审计账本。
5. 通过独立 bootstrap 身份和受控 CLI 初始化首个管理员；无 HTTP/网页升权或正式管理员后台页面。

**阶段 3.6 已完成范围与后置项：**认证记录清理、持久 outbox/重试/幂等协议及投递 worker 已完成隔离实现和真实 PostgreSQL 验收；仍使用开发内存 mailer 的注册/密码重置流程没有因此变成真实邮件投递。真实邮件供应商适配、地区与预算确认、秘密注入、发送耗时心跳、退信/投诉处理及生产调度按用户决定延期至真正需要用户注册时再单独启动。不得把当前内存收件器直接替换成未经审查的网络发送器。

**交付物：**上述认证 API/UI、权限策略、数据库迁移、账户安全说明和测试用例；正式后台 UI 属阶段 8。

**功能测试：**注册/验证/登录/登出/重置全链路；重复邮箱、过期令牌、会话撤销、管理员与普通用户访问差异。

**安全测试：**未认证访问拒绝、水平/垂直越权拒绝、会话固定/CSRF/XSS 风险检查、密码哈希参数审查、暴力尝试限速、邮箱枚举风险检查、Cookie Secure/HttpOnly/SameSite 检查。

**门禁：**所有拒绝路径和权限负例通过；管理员权限仅由服务端授予；未验证权限不得接入任务或充值 API。

### 阶段 4：服务端 Provider 适配层

**状态：阶段 4 小步骤 1–4 已完成并通过账本真实验收；4.5.1–4.5.3 全部完成（2026-11-09 复核）。**小步骤 1 的 Provider 契约、小步骤 2 的纯内存 mock Provider、小步骤 3 的错误映射和结果归档输入边界、小步骤 4 的 Provider 调用账本（`provider_calls` + 迁移 `0011_provider_calls.sql`，含 `available_at` 退避列）均已完成；账本已在真实 PostgreSQL 隔离库通过验收（`.workbuddy/database-acceptance-mw8lvo2w_ce1677.json`，`passed`）；仍未实现真实 Provider。4.5.1 建立客户端凭据门禁，4.5.2 建立服务端配置读取边界，4.5.3 已撤除浏览器凭据来源与直连路径（客户端代码对凭据模式零命中）。阶段 3.1–3.6 基础能力已完成后，路线图进入阶段 4。当前不调用真实供应商、不写入真实凭据、不创建云资源，账本与边界模块未接入生产 Worker。该迁移尚未应用到 `painttrack_dev`/`painttrack_test`，因此 `0011` 可就地修订，不产生 `0012` 补丁。

**4.7.2/4.7.3 实施状态（2026-11-10，最新复核）：**`schema.js`、0015/0016 snapshot、journal 和完整 `0016_model_catalog_routing.sql` 的离线一致性修复已完成；`accept-database-local.js` 与 `runtimePermissions.js` 语法检查通过，数据库生命周期及基础设施定向测试 18/18 通过。真实隔离验收已逐步排除脚本自身缺陷：①`provider_calls` 新增列物理顺序（`mwade7wl_838980.json`，`:93`）；②migration journal 断言错误要求条数不变（`mwaezy2u_48a61e.json`，`:179`）；③运行角色权限断言把「Web+Worker 合并角色」误当纯 Web 角色（`mwafz59l_420e8f.json`，`:245`）；④合成历史夹具未登记预 0015 那条任务导致清理残留（`mwag3x3l_20af54.json`，`:146`）。最新一轮 `mwaga00y_bfbc08.json` 首次把路由 schema 与权限部分全部跑通：15 张迁移表列/主键/CHECK/索引与 snapshot 对照、运行角色表级最小权限与 users 列级写权限、users 越权负例、注入往返、15 项 CHECK 与 NOT NULL 负例、DDL/TRUNCATE/迁移记录/身份升级负例、Drizzle 真实事务提交与回滚、独立 Web 探针角色目录投影（可读逻辑模型安全投影、读不到 Provider 上游配置）全部 passed；bootstrap 与 registration fixture 亦 passed。当前唯一失败在既有会话验收 `tests/fixtures/session-postgres.cjs:26`（`service.me()` 与预期对象 deepEqual），属既有代码、与 0016 迁移无关，具体差异字段待下一轮确认。本轮 `mwagf30x_88c6d5.json` 用脱敏差异摘要定位到唯一失败为**产品缺陷而非迁移问题**：`service.me().user.createdAt` 返回 PostgreSQL 文本 `'2026-11-10 16:54:51.954875+08'`，而预期是 `Date`。根因是 drizzle-orm 0.45 在 node-postgres 会话层把 `TIMESTAMPTZ` 内置解析器替换为原样返回（`node_modules/drizzle-orm/node-postgres/session.cjs`），raw `execute()` 不做反序列化；同一缺陷还让 `login().expiresAt` 传给 `cookieValue()` 后产生 `Expires=Invalid Date`。已在 `lib/server/session.js` 增加 `toTimestamp()`（毫秒截断、`+08`→`+08:00`、Date/数字直通）并用于 `me()`、`login()`、`cookieValue()`，新增回归单测；全量 `npm test` 315 项/313 通过/0 失败/2 跳过。同类残留：`lib/server/tasks/taskView.js` 仍直接返回 `row.created_at`，存在同一类文本外泄风险，待任务 API 收口时统一处理。修复后真实隔离验收待重跑。下一步：跑通 Worker 段，全部通过后才进入动态目录/API 实现。所有尝试均未连接或修改 `painttrack_dev`、`painttrack_test` 或生产库。
**4.7.3 追加复核（2026-11-10，报告 `database-acceptance-mwagkb0r_4c367e.json`）：**`toTimestamp()` 修复已被真实隔离库证实生效——`session` fixture 中所有服务层直调断言（第 26/39/51/73/74/77 行 `service.me()`）全部通过，`mwagf30x` 报告中的字符串时间戳差异消失。剩余唯一失败改到 `tests/fixtures/session-postgres.cjs` 的 HTTP JSON 断言：经过 `meResponse.json()` 后 `createdAt` 必然是 ISO **字符串**（`+ createdAt: '2026-11-10T08:58:55.448Z'`），而 fixture 仍用 `Date` 对象比较（`- createdAt: 2026-11-10T08:58:55.448Z`）。这是 fixture 契约写法错误，JSON 边界不存在 `Date` 类型，产品 API 返回 ISO 字符串才是正确行为。已在 fixture 内新增 `sessionBody`（把期望 `createdAt` 规范化为 `toISOString()`）用于 JSON 断言，并追加 `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/` 格式断言；同时新增 `sourceLocation()`，让 fixture 失败记录直接带出受控源码文件与行号（仅路径与行号，不含异常正文），避免继续靠推断定位。全量 `npm test` 315 项/313 通过/0 失败/2 跳过。下一轮重跑若 fixture 全通过，将首次在 0016 schema 下进入 Worker 段（12 任务并发领取、SIGKILL 后自然租约过期重领、租约 fencing、协作/非协作停止）。该段在 0016 之前的 schema 上曾多次全绿（最近一次 2026-11-09 `database-acceptance-mw8pnd8v_58228d.json`），因此主要待确认的是新增路由表/路由列与最小权限是否影响既有 Worker 行为，这是 4.7.3 最后一块。隔离验收全部通过前不得进入动态目录/API 实现；所有尝试均未连接或修改 `painttrack_dev`、`painttrack_test` 或生产库。
**4.7.2/4.7.3/4.7.4 公共目录切片结论（截至 2026-11-11）：**迁移 `0016_model_catalog_routing.sql` 于 2026-11-10 在随机 loopback 隔离库通过 88 项验收，报告 `.workbuddy/database-acceptance-mwagpqj2_9ec86c.json`。随后新增 `0017_model_catalog_public.sql` 建立 `security_barrier` 公共目录视图；snapshot/journal/schema/SQL 离线一致性由 `tests/databaseLifecycle.test.js` 与项目 `npm run db:migrate:check` 验证。2026-11-11 使用本机 PostgreSQL 16 的 loopback 管理身份运行完整隔离验收，报告 `.workbuddy/database-acceptance-mwbfpxyv_cdb4c7.json` 状态 `passed`，91 项 passed、0 failed；另有 4 条 `running` 记录仅为阶段开始标记。验收确认非空 0015→0016 与 0016→0017 分段升级各只追加对应 migration 记录且不改写旧任务/provider_calls 路由身份；目录视图与 snapshot 列一致；Web 角色可读安全视图、不能读 Provider Base URL/凭据引用/上游模型名/参数映射，未验证路由不可见；既有认证、任务、Provider ledger、Worker 并发/恢复/fencing/停止等 fixture 均通过。只创建报告列出的随机隔离库 `pt_acceptance_mwbfpxyv_cdb4c7` 与迁移/运行/bootstrap 三个角色，按验收策略保留；未连接或修改 `painttrack_dev`、`painttrack_test` 或生产库。入口现仅接受显式 `LOCAL_DATABASE_ADMIN_URL` 且限制为 loopback:5433 `/postgres`；本次使用进程级临时 URL，没有把管理员连接串或密码写入 `.env`。公共只读动态目录切片至此完成验收。**配置 API 的准入调整：**第 8 节 8.1 明确要求，在开放任何敏感后台操作前先完成管理员 MFA/强化认证；并明确在 MFA 未通过验收前不得开放供应商密钥/模型配置。因此下一步应先单独执行阶段 8.1，完成方式选择、恢复策略、实现与安全验收；在该门禁通过前，不实现或开放 Provider、Provider model、逻辑模型及 binding 的管理读取/写入端点。8.1 通过后，按本路线既有授权实现配置 API（软下线、限制删除、脱敏审计）。Studio 动态目录接入、任务创建时不可变路由快照、Worker 按任务快照选 Provider 仍未实现。

**实际执行口径（2026-11-09 记录）：**实际按「契约 → mock → 错误映射与结果边界 → Provider 调用账本」推进，与下方建议清单的编号不是一一对应：实际小步骤 3 覆盖通用结果校验与临时失败分类的前置部分；实际小步骤 4（`provider_calls` 账本）补齐任务状态权威所需的持久化基础。下方原清单曾把 MuAPI 服务端适配器和第二适配器作为默认后续项；这是历史计划，现由第 2 节产品决策取代。当前真实剩余工作是：取得并审查用户选择的 API 文档，确认协议后实现相应的自定义 API Adapter，并按小步骤完成与任务/Worker 集成和安全验收。第 6 条（封锁客户端直连与浏览器密钥路径）已拆为 4.5.1（门禁基线，已完成）、4.5.2（服务端配置入口，已完成）、4.5.3（撤除客户端直连与密钥落浏览器，**已完成**；客户端代码对 `muapi_key`/`x-api-key`/`api.muapi.ai`/`__MUAPI_KEY__` 零命中，`/studio`、`/workflow` 在未配置时明确不可用）。

**依赖与边界：**复用已完成的认证、授权、服务端底座、任务状态机、任务 API 与 Worker 能力。通用契约、mock、调用账本和客户端凭据边界基础已完成；首个参考资料为 MyVigna API 文档，目标是支持多个协议相似但 Base URL 不同的中转站配置实例。Provider 只经 PaintTrack 服务端调用，不得绕过任务状态权威或自行引入扣费逻辑；不得实现任意 URL 转发代理。真实凭据、真实供应商调用、预算或云资源仍须单独评估并获明确授权。

**目标：**使用户可配置并由服务端安全调用其选定的自定义 API，供现有 Studio 功能使用；不预设供应商协议，不另建平行生成入口。

**建议小步骤：**
1. 收集并审查用户选定 API 的接口文档，确认图片/视频提交、鉴权、请求/响应格式、同步或异步协议、查询/取消、结果格式、错误和限流行为；形成协议决策记录。文档不足时列出待确认项，不臆造协议。
2. 根据已确认协议扩展服务端 Provider 配置 schema：Provider 标识、Base URL、凭据及必要能力配置；明确凭据存储/注入方式、允许的目标主机策略、超时和响应大小限制。浏览器只读可用状态，不读取或持有凭据。
3. 为确认的协议实现服务端 Adapter 和可控 mock，覆盖参数映射、鉴权注入、同步/异步状态转换、错误分类、轮询/取消（若支持）与结果解析。
4. 将 Adapter 接入现有任务/Worker/调用账本；验证幂等、重试、未知提交恢复、取消竞态和成本记录边界，不实现或暗示未完成的额度结算。
5. 按实际需要决定是否增加第二种协议 Adapter；这不是首个自定义 API 接入的前置条件，须另行界定范围与验收。
6. 保持客户端直连和浏览器密钥路径封锁；保持 Electron 本地推理与云端 Provider 路径独立。

**交付物：**经确认的 API 协议决策记录、Provider 配置 schema、对应自定义 API Adapter、mock、错误映射与安全边界说明、迁移/兼容说明。

**功能测试：**参数映射、成功/失败/超时/未知状态、轮询停止条件、结果解析、重复请求、供应商 4xx/5xx/限流、可选取消行为。

**安全测试：**浏览器 bundle/网络请求/存储中不存在供应商密钥；检查认证、请求大小/超时、SSRF、响应 URL 和内容验证、日志脱敏；确认不能通过任意 URL 代理访问内网。

**门禁：**云端请求只经服务端；密钥无客户端暴露；Provider 契约对同步/异步任务均有确定行为；本地模式仍不进入云端账务。

### 阶段 5：任务 API、队列与状态恢复

**状态：阶段 5.1、5.2、5.3、5.4（服务端）已完成（2026-11-09）。**5.1 交付任务状态机设计与纯函数模块 `lib/server/worker/taskStateMachine.js`、迁移 `drizzle/0012_task_cancellation.sql`（`generation_tasks_status_check` 纳入 `cancelled`）及定向测试 9/9；设计稿见 `PaintTrack/PHASE5_STEP1_TASK_STATE_MACHINE.md`。5.2 交付带认证、用户归属与幂等键的 `POST /api/tasks`，迁移 `0013_generation_task_ownership.sql` 增加 `owner_id`/`idempotency_key`/`request_fingerprint` 与 owner 范围内唯一约束，Web 运行角色获得必要的 `SELECT,INSERT`，设计稿见 `PaintTrack/PHASE5_STEP2_TASK_CREATION_API.md`。5.3 交付执行器 `lib/server/worker/taskExecutor.js`（提交、受理、轮询、失败分类、崩溃恢复与成功原子落库）、Provider 选择 `lib/server/providers/providerRegistry.js`（未配置 fail-closed）、迁移 `drizzle/0014_generation_task_result.sql`（`generation_tasks.result` 与两条约束），设计稿见 `PaintTrack/PHASE5_STEP3_WORKER_EXECUTION.md`。5.4 服务端交付 `GET /api/tasks`（keyset 分页）、`GET /api/tasks/:id`、`POST /api/tasks/:id/cancel`，迁移 `0015_task_cancel_request.sql` 增加 `cancel_requested_at` 与一致性 CHECK；取消区分 `queued` 立即取消与 `running` 协作取消，执行器在提交前与每次轮询前观察取消意图，成功结算在事务内锁定任务行以消除「取消与结果落库」竞态，租约过期且已请求取消的任务恢复为 `cancelled`；Web 运行角色只获得 `status`/`cancel_requested_at`/`completed_at`/`updated_at` 列级 UPDATE，无法写租约或结果；设计稿见 `PaintTrack/PHASE5_STEP4_TASK_QUERY_CANCEL.md`。5.4 前端小步新增 `components/TaskCenter.js`：在 `/studio` 工作台顶栏提供任务入口，Provider 未配置页也保留任务入口；使用项目既有黑底、低对比边框与青色强调样式，支持中英文、任务列表 keyset 翻页、详情、5 秒轮询与取消按钮。该面板只消费已有查询/详情/取消 API，不伪造任务创建，也不接管现有 Studio 生成回调；当前生成入口仍待真实服务端 Provider 链路接通。5.1–5.4 都只使用 mock Provider，未调用真实供应商、未接额度、未做结果归档（`result.archive` 恒为 `not_configured`）。阶段 5.5（真实 MuAPI 与端到端沙箱）按既定决定延期。开发环境的 Next 缓存使用 `PAINTTRACK_DIST_DIR=.next_local_<12位十六进制>` 隔离目录，避免 WorkBuddy 沙箱清理默认 `.next` 时触发安全删除保护；旧缓存只允许改名保留，不做递归删除。真实 PostgreSQL 隔离验收 `.workbuddy/database-acceptance-mw8pnd8v_58228d.json`（`passed`，88 项 / 84 passed / 0 failed，含 9 项取消、隔离与列级权限检查）。

**目标：**可靠创建和跟踪用户任务，不依赖浏览器持有供应商 request ID 作为权威状态。阶段 5.1–5.4 已完成；这是任务基础设施，不是独立生成产品入口。

**建议小步骤：**
1. 定义任务状态机与合法转换、超时和终态规则。
2. 实现带认证、用户归属、幂等键的任务创建 API（先使用 mock Provider）。
3. Worker 领取、租约、执行、心跳、重试和崩溃恢复。
4. 用户任务列表/详情/取消（仅供应商支持时）接口与前端轮询/SSE 等状态同步。
5. 在阶段 4 自定义 API Adapter 按已确认协议完成后，由现有 Studio 页面调用 PaintTrack 任务 API 并执行端到端沙箱测试；本步骤不得新增平行的简化生成入口。

**交付物：**任务状态机、API、Worker、任务持久化、运行监控和故障操作说明。

**功能测试：**重复提交、并发提交、Worker 中断、重复消息、供应商超时、重启恢复、状态乱序、取消、结果迟到及用户隔离。

**安全测试：**不能读取或修改他人任务；伪造任务 ID 无效；限制提交频率、并发数、文件量和供应商开销；请求体和任务参数严格验证。

**门禁：**每个任务在故障后可解释、可恢复或明确终止；用户隔离通过；重试有上限且不会无限循环。

### 阶段 6：账户中心、额度账本、计费和人工充值

**目标：**提供用户可理解的账户身份与使用情况入口，并实现可审计、并发安全、幂等的点数预扣与结算。账户中心 UI 可先以明确的未接入/不可用状态完成，但任何余额或账单数值都必须来自服务端权威账本，禁止静态伪造或把 Provider 上游余额冒充用户余额。

**账户中心信息架构（产品范围）：**
1. **账户概览**：已验证邮箱、用户 ID（可复制）、账户角色、注册/验证状态、会话状态；个人资料字段未实现前不虚构姓名或头像。
2. **额度与账单**：可用额度、冻结额度、累计使用、充值/调整记录、账单流水、退款/失败释放说明；账本未接通时显示明确的“额度服务尚未启用”，不得用 `0` 或假余额造成误解。
3. **使用记录**：任务时间、Studio/任务类型、逻辑模型、状态、消耗额度、失败/退款结果；从用户可见任务与账务流水关联，不展示 Provider 凭据、内部成本或其他用户数据。
4. **安全与会话**：修改密码/重置密码入口、当前会话与有效期、登出；多设备会话管理和账户删除待相应后端、隐私与恢复流程成熟后再开放。
5. **支持与政策**：帮助/问题反馈、额度计价说明、退款/数据保留政策版本及生效时间。

**界面入口：**Studio 顶栏用户菜单显示邮箱或稳定的用户标识，提供账户中心和登出；任务中心与设置保持现有独立入口。阶段 6.1 已落地 `/account` 与 `/zh/account` 单页概览，包含身份信息、额度未启用与使用记录未接入状态。后续再按真实 API 和产品规则拆分“概览、额度与账单、使用记录、安全”导航；小屏幕保持触控可达，不新增与现有工作区重复的生成入口。

**数据与信任边界：**
- `GET /api/auth/me` 只扩展返回最少用户身份字段（如规范化邮箱、ID、role、email_verified_at/安全的状态标记）；不返回密码、会话 token、Provider 凭据或假造的余额。
- UI 与 API 先行阶段只实现真实可证实的身份信息、路由骨架、空状态和错误状态；额度组件显示“未启用”，不渲染假数值。用户资料可编辑字段须有明确 schema、校验、审计和隐私策略后再开放。
- 用户额度与供应商成本分离：用户额度使用独立账户及不可变账本；`provider_calls` 只用于上游调用状态/恢复，不是余额来源。任何余额必须可由账本重算，可用/冻结分别定义，所有变动有任务或管理员调整来源。
- 余额/账单 API 必须从服务端会话确定 owner；客户端不得提交 owner_id、余额、扣费金额或账务事件。充值/人工调整先仅限受审计的管理员操作；支付接入需另行确定收款主体、退款和合规条件。

**建议小步骤：**
1. **6.1 已完成（2026-11-10）：**账户中心产品壳与身份展示（邮箱、ID、角色、邮箱验证状态/账户创建时间）、Studio 顶栏账户菜单、服务端登出、`/account` 与 `/zh/account` 路由；额度与使用记录显示明确未启用状态，不造假数据。未新增数据库迁移，登录响应仍只返回 `id/role`，扩展字段仅由 no-store 的 `/api/auth/me` 按已认证会话提供。定向测试与全量门禁记录见当日 `.workbuddy/memory`。
2. **6.2 计价与账本技术契约（规则已确认，技术设计已形成，待评审/参数收口）**：按模型动态定价由后台管理员维护，具体金额、参数分档和数量系数不写死在代码中；图片基础模板为“分辨率分档 + 输出数量”，视频基础模板为“视频时长 + 帧率”，任务创建时固定不可变报价快照；账本最小单位为 **0.1 credit**，以整数十分之一 credit 原子单位存储，禁止浮点余额；注册成功赠送由管理员控制开关/额度，只影响新用户，并在 grant 前阻断脚本批量注册/一次性邮箱滥用；确定未 dispatch 的系统失败全额释放；Provider 已调用后应用侧错误不自动退款，上游明确失败释放冻结额度、明确成功结算、结果未知保持冻结并对账。详见 `PaintTrack/docs/records/PHASE6_ACCOUNT_CENTER_PRODUCT_DESIGN.md` §4.1–4.2。
3. **6.2 评审与实现前置**：已确定最小单位为 **0.1 credit**，账本使用整数十分之一 credit 原子单位；积分可由人民币充值获得但不可兑换/提现为人民币，充值兑换比例暂定；注册赠送默认关闭；Provider 结果未知持续冻结，直到明确结果或受审计的人工对账。报价精度与舍入已确认：固定价配置为 0.1 credit 的整数倍，参数化价格使用定点整数计算，正向非整数费用向上取整至 0.1 credit，非零最低 0.1 credit，异常参数 fail closed。其余仍待确定各模型的具体价格、图片分辨率档位与数量规则、视频时长/帧率分档与系数、价格生效/报价有效期、赠送额度/有效期、反滥用信号与阈值/申诉、上游长期未知的人工处置 SLA。图片和视频模板结构已确定，具体配置仍由后台管理员动态发布，不进入代码常量。技术方案明确：available/reserved 双余额投影 + append-only ledger；reserve/settle/release 按 task 幂等；dispatch intent 持久化后崩溃按“可能已调用”保守冻结，不能自动退款；真实 PG 并发、崩溃恢复、余额重算与 DB 最小权限为阻断验收。
4. **6.3 任务冻结绑定（后续独立授权）**：在一个事务/可靠协调内创建 task、quote、reservation 和账本事件；锁账户防超扣，同幂等请求返回原任务，不允许重复赠送或重复 reserve。
5. **6.4 结算与对账（后续独立授权）**：按上游可证实终态结算或释放；未知结果保留冻结并进入受限对账；覆盖取消竞态、多 attempt 重试、迟到结果、Worker 崩溃和幂等恢复。
6. **6.5 用户账单与用量**：从真实账本/API读取，不由客户端计算余额；真实账务门禁通过前保持“未启用”状态。
7. **6.6 管理员账务配置与调整**：版本化价格、赠送策略、人工调整各走最小权限、强认证与审计；支付回调/充值主体与合规条件另行确认。
8. **6.7 对账及账户生命周期**：提供余额重算、异常 reservation 修复和受限争议查询；账户导出/删除需先定义账务凭证保留与关联数据处理。
8. 另行规划多会话管理、账户导出/删除及隐私流程；未完成恢复、保留期和关联数据处理前不提供不可逆自助删除。

**交付物：**账户中心页面与身份 API、账本模型、计价规则版本、冻结/结算/释放服务、用户账单/用量 API、管理充值流程、对账报表和故障手册。

**功能测试：**余额不足、精确边界、并发扣费、重复回调/重试、成功结算、失败释放、长时间处理中、管理员重复充值、账本余额核对。

**安全测试：**客户端不能指定扣费金额、余额或用户 ID；管理员充值强授权和审计；防止负数、溢出、重放和重复请求；账务事件不可静默篡改。

**门禁：**账本余额与可用/冻结余额可重算；并发不超扣；所有状态转换幂等；每项额度变化有来源任务或管理员审计。账务不变量失败属于阻断级。

### 阶段 7：上传、对象存储与生成结果归档

**目标：**安全接收用户文件并将生成结果归档到可控的用户资产空间。

**建议小步骤：**
1. 确认支持格式、最大大小、保留周期和用户删除规则。
2. 实现认证后预签名上传、上传完成确认和对象元数据记录。
3. 验证 MIME/扩展名/文件大小；按需求增加恶意文件扫描或解码验证。
4. 实现供应商临时结果抓取、限制目标地址、归档到对象存储。
5. 实现短时受控下载、权限检查、生命周期清理和删除流程。

**当前进度（2026-11-13）**：第 4、5 步的「归档 + 生命周期清理」已部分实现——生成结果归档、owner 受控读取、软删除（5.6）、`deleted` 对象清理（5.7）与 `pending` 孤儿回收（5.11，迁移 0023）均已在真实隔离 PG 验收；用户侧的破坏性操作确认（5.12：Studio 包 + 宿主 TaskCenter）已全部改为应用内弹窗，仓库内不再有原生 `confirm()`；第 1–3 步的交互式上传通道、格式/大小实际内容校验与保留政策**仍未做**。

**交付物：**上传 API/UI、对象元数据、存储适配器、访问策略、清理作业和保留政策。

**功能测试：**合法/非法文件、上传中断、重复确认、对象不存在、结果归档失败、过期对象、用户删除和恢复策略。

**安全测试：**跨用户对象访问拒绝、预签名 URL 过期、公开访问关闭、路径穿越、MIME 欺骗、恶意内容、SSRF/重定向、超大文件和配额绕过。

**门禁：**所有对象默认私有；所有读取验证用户归属；供应商 URL 不被当作长期资产；生命周期规则可验证。

### 阶段 8：管理后台与运营治理

**状态：8.1 管理员 MFA 与服务端门禁已完成验收。**TOTP 重放保护、恢复码一次性消费、敏感操作 step-up、因子撤销与全部 session 撤销、管理员双语账户中心 MFA 管理 UI 已实现。真实隔离 PostgreSQL 报告 `.workbuddy/database-acceptance-mwbp3al1_b04283.json` 通过，覆盖同一 TOTP/恢复码并发单赢家、事务回滚、enrollment、恢复码重签/消费、step-up、撤销和 Origin/角色拒绝；管理员 MFA/session/authorization/task/catalog/login/启动器定向回归最终为 52/52 通过，生产构建已有通过证据。用户已在本机隔离实例完成管理员注册、MFA 设置、密码登录后的 TOTP/恢复码提权、Studio 进入及账户中心管理操作验证，并报告“测试完毕，没问题”；该条为用户手动验收报告，不伪称为浏览器自动化日志。已补齐 `MFA_SESSION_REJECTED` 错误常量；管理员 password-level 会话访问管理员汇总、模型目录和任务 API 时统一由服务端拒绝 `MFA_REQUIRED`，MFA-level 会话通过，普通用户流程保持不变。已确认 `elevateMfa` 内部原语没有代码调用方，不构成当前可达绕过。管理员 MFA session 仍为固定 8 小时；本轮保留固定绝对期限，后续若需更短时长须单独设计并测试。8.1 验收完成不等于开放 Provider 配置写 API；该 API 继续关闭，待后续配置服务小步骤单独设计、实现和验收。

**依赖关系：**管理页面可在基础认证/授权完成后做受限只读切片，但用户、任务、供应商成本、充值、任务处置及配置管理分别依赖阶段 4–7 的真实能力。未完成相应后端和权限审查前，不得以静态展示或前端状态模拟这些运营能力。若提前制作管理员页面，须单独批准范围，限定为现有 API 可支持的只读功能，并作为阶段 8 前置切片记录。

**目标：**支持最小运营能力，同时限制高权限操作和供应商成本风险。

**实施顺序与准入：**本阶段在阶段 4–7 的相应数据/API 能力具备后实施完整后台；可先做只读后台切片，但必须使用真实授权 API，不伪造数据。建议子步骤为：8.1 管理员 MFA/强化认证与恢复策略（在开放任何敏感后台操作前完成）；8.2 正式后台登录保护、导航和只读用户/汇总视图；8.3 依赖阶段 5 的任务列表与处置；8.4 依赖阶段 6 的充值、账务和对账；8.5 依赖阶段 4–7 的供应商、成本和资产治理配置。阶段 3.5 CLI bootstrap 不属于日常管理员登录或 MFA。阶段 6 用户账户中心不属于阶段 8 管理后台；用户侧页面不得获得管理员查询/写入权限。

**MFA/强化认证范围：**评估 TOTP/WebAuthn 等方案、恢复码安全存储与一次性消费、管理员会话期限/撤销、敏感操作重新认证、CSRF/重放和审计；选择方式、运维恢复责任和备份策略确认后实施。MFA 未通过验收前不得开放充值、批量导出、供应商密钥/模型配置或任务强制处置。

**8.1 方案决策（2026-11-11）：**第一版采用 TOTP 作为管理员强认证因子，服务端使用加密存储的 TOTP 密钥并拒绝向浏览器回传明文密钥；恢复码仅保存不可逆摘要，每个恢复码只能成功消费一次，并纳入失败尝试限流与审计。WebAuthn 作为后续可选增强，不阻塞 TOTP 版本验收。管理员登录先建立短时普通会话，完成 TOTP/恢复码后提升为 MFA 会话；管理员敏感操作另需短时 step-up 认证，step-up 不得通过客户端字段自报。MFA 会话和 step-up 状态绑定服务端会话记录，密码重置、MFA 因子变更、恢复码重置、管理员主动撤销时立即撤销受影响会话。所有 MFA、恢复、step-up、撤销事件写入不含密钥/恢复码原文的审计记录，并校验 Origin、Cookie、重放、并发消费和速率限制。运维恢复必须由受控管理员流程执行，不能通过数据库手工写入或公开接口绕过。阶段 8.1 验收通过前继续禁止充值、批量导出、供应商密钥/模型配置和任务强制处置。

**建议小步骤：**
0. 完成管理员登录后的 MFA 提权入口：密码登录后先建立 password-level 会话；管理员必须在账户中心通过 TOTP 或一次性恢复码提升会话，普通用户流程不变；成功后刷新 `/api/auth/me` 并继续安全的 `next` 路径；错误输入、重放、跨源和缺失因子必须失败关闭。真实隔离 PostgreSQL HTTP fixture 与用户手动浏览器交互验收均已完成；用户报告流程无问题。管理员 password-level 会话访问管理员汇总、模型目录和任务 API 时由服务端统一拒绝 `MFA_REQUIRED`，MFA-level 会话通过；定向回归 52/52 通过，Provider 写 API 保持关闭。8.1 小步骤完成。
1. 用户、任务、供应商健康和成本的只读管理视图。
2. 手动充值、任务失败重试/终止等敏感操作及二次确认。
3. 供应商启停、模型选项和计价配置管理（每种配置单独验收）。
4. 操作审计、筛选导出和管理员告警。

**交付物：**管理后台、角色策略、审计视图、运营手册和告警规则。

**功能测试：**管理列表筛选、充值、任务处置、配置更新、权限差异及审计可追溯。

**安全测试：**管理员 MFA/强化认证评估、CSRF/XSS、导出数据最小化、越权、审计日志防篡改、敏感操作复核。

**门禁：**普通用户不可访问管理能力；高风险操作有明确确认和审计；配置错误不会将密钥暴露给客户端。

### 阶段 9：内置生成模板与前端产品流程

**目标：**把现有 ImageStudio/VideoStudio 等正式生成页面接入已确认的自定义 API Adapter 与 PaintTrack 任务链路，并完善既有流程；不得新增平行的简化生成入口。

**依赖与边界：**依赖阶段 4 已按用户 API 文档实现并验收的服务端 Adapter，以及阶段 5 任务 API/Worker。协议与 Adapter 未完成前不得接真实 Provider。阶段 9 可先完成不产生收费承诺的现有 Studio 到任务 API 的 mock/沙箱接线；**真实计费生成、余额预估、扣费及退款展示必须等待阶段 6 相应账务能力验收**。阶段 7 未完成时不得承诺结果长期保存或通过私有资产库下载；可按阶段 4 的受控临时结果边界测试短期结果，不把供应商 URL 当作资产。现有 Studio 页面是正式生成入口；任务中心仅承担任务列表、详情、状态同步与取消。

**建议小步骤：**
1. 绘制现有 ImageStudio/VideoStudio、共享 studio 组件、PaintTrack 自有 API、服务端 Adapter 与云端/本地流程图，确认既有组件和回调的复用边界。
2. 选择一个现有图片生成流程，将其现有表单/生成操作映射到 PaintTrack 任务 API；保持原有 Studio 页面和交互，不另建入口。
3. 添加服务端能力约束与按版本维护的模板/参数定义；前端仅呈现服务端允许的选项，服务端重新校验。
4. 依次把现有视频生成、图生图、图生视频及其他既有场景接入；每类独立验收，不删除或替代现有页面。
5. 完善既有页面内的任务状态、错误提示、额度预估和结果下载；额度展示须等待阶段 6 能力，不得使用前端模拟数据。

**交付物：**现有 Studio 流程到自有任务 API 的接入、服务端能力约束、错误和空/加载状态、使用说明；不交付新的平行生成页面。

**功能测试：**现有 Studio 流程的模板参数组合、PaintTrack 任务 API 创建与状态回填、失败重试、历史记录、移动/桌面布局、可访问性及 Electron 云端/本地切换。预估与实际扣费展示依赖阶段 6；未完成前不得伪造额度数据。

**安全测试：**客户端不信任隐藏字段；服务端重新验证模型/参数；限制敏感 prompt/文件；避免把供应商错误原样呈现或泄露内部信息。

**门禁：**核心生成流程端到端通过；用户只看到授权资产；本地推理始终不扣点数。

### 阶段 10：内置工作流及用户可编辑能力

**目标：**先利用内置流程交付价值，再按风险逐级开放用户自定义。

**建议小步骤：**
1. 确认 `Vibe-Workflow` 许可、协议、执行器和维护成本；未确认前不直接接入生产。
2. 以固定内置工作流定义节点、输入输出、版本和权限。
3. 运行服务端工作流时，复用任务、额度、文件授权和审计机制。
4. 开放用户复制/保存，建立所有者隔离和版本管理。
5. 最后开放拖拽编辑、节点白名单、资源限制和发布/回滚。

**交付物：**工作流契约、节点白名单、内置模板、执行器适配、保存/版本/编辑界面和治理规则。

**功能测试：**工作流输入输出、失败恢复、节点状态、文件传递、版本兼容、复制和所有者隔离。

**安全测试：**节点表达式/代码执行隔离、SSRF、文件越权、循环/递归、资源消耗上限、恶意工作流、跨用户读取、供应商密钥访问阻断。

**门禁：**任何用户定义内容均在受控节点白名单内执行；资源有上限；工作流调用仍经统一任务与计费层。未完成隔离评估前不得开放任意代码节点。

### 阶段 11：内容安全、隐私和可靠性加固

**目标：**为上线建立与目标地区、供应商政策和数据类型匹配的控制。

**账户导出、删除与自助清理实施归属：**阶段 1 已形成数据分类、建议保留期和删除/备份补偿原则；本阶段负责把这些原则落实为用户可执行、可追踪、可验证的功能。阶段 7 必须先提供资产/对象生命周期删除接口；阶段 6 必须定义账务保留和去标识化边界；阶段 9 可开发账户设置中的请求入口与导出下载交互；本阶段负责统一后端删除工作流、导出包范围、访问控制、幂等重试、失败告警、备份过期/恢复后补偿和完成核验。未确定服务地区、法定保留、供应商删除能力、备份窗口和负责人前，不承诺具体完成期限或立即物理抹除。

**建议小步骤：**
1. 明确服务地区、用户年龄/内容政策、举报/申诉和删除流程。
2. 建立输入、上传、生成结果和分享环节的内容政策及处置记录。
3. 增加速率、并发、成本、存储和异常行为限额。
4. 增加供应商熔断、超时、退避、队列积压处理和人工处置路径。
5. 执行备份恢复、数据导出/删除、灾难恢复和隐私检查。

**交付物：**内容政策、隐私与保留说明、限流/成本策略、告警、备份恢复记录和事件响应手册。

**功能测试：**举报/处置、账户删除、超限拒绝、服务商故障、积压恢复和告警触发。

**安全测试：**OWASP Top 10 相关检查、依赖漏洞、秘密扫描、权限回归、速率限制、日志隐私和备份访问控制；依风险安排独立渗透测试。

**门禁：**严重/高危漏洞为零，或有用户明确接受且有期限的风险例外；关键数据有已演练恢复方案；内容和隐私责任有明确运营负责人。

### 阶段 12：预发布、灰度与正式发布

**目标：**在受控环境证明端到端可用、可观测、可恢复后再开放真实用户。

**建议小步骤：**
1. 建立独立 staging 环境、合成数据和供应商沙箱凭据。
2. 执行全量 CI：静态检查、单元、集成、端到端、迁移、权限和安全检查。
3. 执行负载/并发/队列积压/超时测试，核对成本保护阈值。
4. 演练备份恢复、部署回滚、密钥轮换和事故响应。
5. 小范围灰度，观察成功率、延迟、失败原因、余额账本、供应商成本和告警。
6. 经用户明确批准后再正式发布；支付能力在支付主体、退款和对账方案确定前不得上线。

**交付物：**发布清单、CI 结果、运行手册、回滚记录、灰度报告和正式发布批准记录。

**功能验收：**注册到生成、扣费结算、失败退款/释放、结果归档和下载全链路通过；桌面端本地能力回归通过。

**安全验收：**生产秘密隔离、HTTPS/Cookie/访问控制检查、依赖和镜像扫描、权限负例、备份恢复、告警及事件响应演练通过。

**门禁：**不存在未处理严重/高危问题；账务对账一致；回滚与恢复演练成功；关键指标有负责人；用户明确批准发布。

## 7. 功能测试标准

所有新增功能至少按风险覆盖以下层次：

- **单元测试：**纯逻辑、状态机、计价、权限策略、Provider 错误映射和参数校验。
- **集成测试：**数据库事务/迁移、认证会话、对象存储适配、队列和 Worker；外部供应商使用 mock 或沙箱。
- **端到端测试：**用户真实操作路径，至少覆盖主流程、失败流程和权限拒绝流程。
- **回归测试：**每次改动运行受影响模块测试；涉及共享 API、认证、计费、存储或 Electron 边界时运行相关全量回归。
- **并发与故障测试：**对任务、额度、回调、Worker 重启和上传等有状态能力覆盖重复、并发、超时和部分失败。
- **可访问性与兼容性：**关键表单键盘操作、标签/错误提示、不同窗口尺寸；必要时覆盖主流浏览器和 Electron。

测试必须确定性、可重复，不依赖真实高成本 API 或真实支付。每条关键测试说明它验证的业务不变量，不仅验证实现细节。

## 8. 安全测试基准

按改动面执行，至少覆盖：

- **身份与授权：**匿名拒绝、角色隔离、对象级所有权校验、管理员操作授权。
- **输入与注入：**schema 校验、SQL 注入、命令/模板注入、路径穿越、XSS、CSRF。
- **网络边界：**SSRF、重定向、内网地址访问、供应商 URL 验证、超时及响应大小限制。
- **密钥与隐私：**服务端秘密存储、日志脱敏、浏览器 bundle/localStorage/错误响应泄露检查、密钥轮换。
- **滥用与成本：**登录/任务/上传限流、并发限制、额度不足、模型白名单、费用上限和队列配额。
- **文件：**内容类型与大小验证、恶意文件策略、对象私有访问、短时链接、跨用户隔离、删除和生命周期。
- **账务：**幂等键、防重放、并发原子性、账本不可变性、管理员操作审计、重算与对账。
- **依赖与供应链：**依赖漏洞、许可证、锁文件、子模块来源和构建产物检查。
- **部署与运维：**HTTPS、Cookie 属性、CORS、CSP/安全头、最小权限、备份加密、告警与事故响应。

发现严重/高危问题必须阻断当前步骤及发布。中低危问题需记录影响、缓解措施、责任人和修复期限；不能因测试扫描工具无告警就推断系统绝对安全。

## 9. 通用验收记录模板

每个小步骤在工作记录或交付说明中采用以下结构：

```text
步骤编号与名称：
目标与范围：
前置条件：
修改文件/模块：
交付物：
功能测试：命令/场景及结果
安全测试：命令/场景及结果
Git diff 检查：
未验证项/风险：
验收结论：通过 / 有条件通过 / 未通过
用户确认：待确认 / 已确认
```

测试结果必须如实报告命令与退出状态。跳过测试时写明原因和影响，不可用“看起来正常”替代结果。

## 10. 全流程顺序与当前入口（2026-11-09 统一版）

本节是唯一的执行顺序索引；阶段章节定义范围与验收门禁，专题设计稿细化对应步骤。旧段落和验收索引中的“下一步”如与本节冲突，一律视为历史记录，以本节为准。阶段编号代表领域和依赖，不意味着必须严格按编号串行；允许用户明确批准的独立前置切片，但不能越过其业务依赖或伪造尚不存在的数据。

### 10.1 已完成的基础

1. 阶段 0–3.6：本地/隔离环境基线、服务端底座、认证授权和持久邮件 outbox 基础已完成相应验收。真实邮件生产投递及 bootstrap 身份运维核实仍后置。
2. 阶段 4 前置安全/账本基础：Provider 契约、mock、错误/结果边界、调用账本、服务端配置边界和客户端凭据撤除已完成；**阶段 4 整体仍未完成**，没有真实自定义 Adapter、多 Provider 路由和生产 Worker 集成。
3. 阶段 5.1–5.4：状态机、任务创建/查询/取消 API、mock Worker 与 TaskCenter 已完成所记录的隔离验收；不等于现有生成控件已接入，也不等于真实生成闭环。迁移 `0015_task_cancel_request.sql` 未应用到 `painttrack_dev`/`painttrack_test`，不得因路线记录而擅自应用。
4. 阶段 5.5 首个协议切片：MyVigna `gpt-image-2` 异步图片 Provider Adapter 已按用户指南完成，并通过 loopback mock HTTP 测试 7/7；任务提交的比例/尺寸映射已集中到 `lib/server/tasks/imagePayload.js`，Provider Registry 已支持 `myvigna-image`，`.env.example` 已补充服务端配置示例。此切片仅用于验证首个协议，不代表产品限定为单一模型。根据 2026-11-10 用户确认的多模型管理方案，后续先完成逻辑模型目录、Provider 实例、Provider 上游模型、路由绑定和任务快照的数据/接口设计，再实现动态目录和管理员配置能力，随后接入既有 ImageStudio/VideoStudio。当前尚未实现任务路由快照与按任务动态 Provider 选择，未配置真实凭据、未访问公网，也未完成真实数据库、对象存储或生产 Provider 验收。
4. 首页/登录路径已调整：根路径先登录；Studio shell 在展示工作区前检查会话。阶段 6.1 账户身份切片已于 2026-11-10 实现（具体范围与门禁见第 6 阶段及 `PaintTrack/docs/records/PHASE6_ACCOUNT_CENTER_PRODUCT_DESIGN.md`）；真实账务仍未接入。Provider 未配置只阻止生成调用，不应替换整个工作区，也不得恢复客户端持有供应商密钥。

### 10.2 主业务依赖链

以下依赖描述可运营 SaaS 的正确闭环；每个子步骤仍须单独授权、验收和暂停。

1. **账户中心身份切片（阶段 6.1，已于 2026-11-10 实现）**：扩展会话身份 API 的最小安全投影，提供顶栏账号菜单、真实邮箱/用户 ID/角色/验证状态、账户中心基础页面、登出和未启用空状态。此切片不做余额写入、充值、扣费、个人资料编辑或假数据。
2. **阶段 4 多模型目录与 Provider 路由设计**：先完成逻辑模型、Provider 实例、Provider 上游模型、路由绑定、能力/参数 schema、配置版本、启用/下线/删除保护及任务路由快照的数据和接口设计。模型不限定为单个图片模型；图片、视频及不同生成模式均按能力 profile 管理。静态 Studio 模型目录暂作展示/参数兼容模板，后续由服务端动态目录决定可用模型；协议文本 OpenAI-compatible 不代表所有图像/视频接口兼容。专题顺序以 `PHASE4_MULTI_PROVIDER_ROUTING_CONTRACT.md` 为准。
3. **阶段 4 运行时配置与动态目录**：在设计验收后实现受管理员授权的 Provider 实例、逻辑模型、上游模型及绑定配置服务/API；Studio 目录仅暴露启用且有有效路由的逻辑模型，不暴露密钥、Base URL 或不必要的上游信息。默认支持手动主路由切换，故障转移需显式策略。
4. **阶段 4 Adapter 与安全**：按协议和 endpoint/operation profile 逐一实现 Adapter + mock，覆盖服务端密钥边界、SSRF/DNS/重定向防护、参数映射、结果验证和配置审计；首个 MyVigna `gpt-image-2` Adapter 仅是已验证协议切片，不构成模型范围限制。真实上游验收须另获用户对凭据、预算和测试范围的确认。
5. **阶段 5 与阶段 4 的端到端整合**：按任务创建时解析的路由快照选择 Provider/上游模型，复用现有状态机、任务 API、Worker、provider_calls 与 TaskCenter，验证幂等、未知提交、取消竞态和恢复固定路由。然后逐步接现有 ImageStudio/VideoStudio 的各模型能力；不得新建平行生成入口。该工作是阶段 5/9 的集成收口，不代表原 5.1–5.4 未完成。
4. **阶段 6 计价与用户账本契约**：在任何面向用户的真实收费生成前，确认点数单位、服务定价、精度/舍入、失败/取消/未知状态/退款策略、免费额度和版本生效规则。用户收费与 Provider 成本分离；`provider_calls` 不作为用户余额账本。
   **已确认规则（2026-11-13）**：① 按模型定价，因部分模型价格浮动，版本化价格规则由管理员设置，任务创建固定报价快照；② 最小单位 **0.1 credit**，账本以整数十分之一 credit 原子单位记账、禁止浮点余额；人民币可充值为积分，积分不可兑换/提现为人民币，充值兑换比例暂定；③ 注册成功可发赠送，管理员可配置开关与额度、默认关闭、只影响新用户，赠送前必须防脚本批量注册/一次性邮箱滥用且幂等只发一次；④ 可确定未调用 Provider 的系统失败全额释放冻结额度；⑤ Provider 已调用后不因应用侧错误自动退款——上游明确成功则结算、明确失败则释放冻结额度、未知持续冻结直到明确结果或受审计对账。仍待确认：充值兑换比例、各模型具体价格与档位/系数（由管理员动态配置）、价格生效与 quote 时效、赠送额度与有效期、反滥用信号/阈值与申诉、未知状态人工处置 SLA。报价精度与舍入已确认，不再列为待确认。
5. **阶段 6 账务实现**：建立可重算的不可变用户额度账本、冻结/预扣、结算/释放/退款、幂等和 Provider 成本对账；与任务创建/状态转换形成事务或明确可恢复的协调协议。接着实现用户账单/用量 API、管理员人工充值/调整及审计。只有此处的真实账务门禁通过后，才允许展示真实余额、预估扣点、实际扣费、退款和充值入口。
6. **阶段 7 资产闭环**：按数据策略实现真实对象存储、用户归属、受控上传/下载和结果归档。阶段 4 可以先对临时上游结果做受控安全验证；在阶段 7 完成前，不承诺长期保存、资产库或持久下载链接。
7. **阶段 9 产品流程收口**：完成现有 Studio 的图片/视频/编辑等流程接线、模型能力呈现、任务状态、错误和结果下载。阶段 4+5 是真实生成前置；阶段 6 是任何真实额度/计费 UI 与收费承诺的前置；阶段 7 是持久资产和正式下载承诺的前置。可先用 mock/沙箱验收非收费 UI，但不得让用户误以为真实生产生成或收费已启用。
8. **阶段 8 运营后台**：管理员强化认证先于敏感操作；只在对应阶段 4–7 API/数据真实具备后，分别开放 Provider 配置、用户/任务只读、充值账务、成本/资产治理。阶段 8 是管理员侧，与阶段 6 用户账户中心分开。
9. **阶段 10 工作流**：在许可、安全执行隔离、统一任务/额度/资产边界具备后，依次做内置流程、用户复制保存、编辑能力。
10. **阶段 11 隐私与可靠性**：完成内容安全、容量/成本控制、备份恢复、数据导出/删除与补偿工作流；账户删除依赖阶段 6 账务保留边界和阶段 7 资产删除能力。
11. **阶段 12 预发布与发布**：所有实际启用的端到端闭环、账务对账、资产/隐私、安全和运维门禁通过后，进入 staging/灰度；正式发布须用户另行明确批准。

### 10.3 并行与禁止越级

- 账户中心身份切片可独立先行；界面允许展示“额度服务尚未启用”和明确空状态，但不能展示伪造余额、虚构流水或无后端支持的充值按钮。
- Provider 协议/路由设计可与账户身份 UI 并行；真实 Provider 接入需凭据、预算和供应商政策另行批准。
- Studio 的 mock/沙箱接线可在额度账本前做，但任何真实收费生成、余额预估、扣点/退款 UI 均等待阶段 6；任何长期资产承诺等待阶段 7。
- 阶段 8 可在其依赖 API 已存在时做受限只读切片；敏感管理员操作等待 MFA/强化认证及账务/Provider/资产相应门禁。
- 阶段 3.6 真实邮件生产服务按用户原决定延期；阶段 11 账户导出/删除不能以只有 UI 的假流程提前宣称完成。
- 云厂商、部署地域、支付主体和预算未确认前，不创建云资源、不上线支付；不影响纯本地的设计、mock 和隔离测试。

### 10.4 当前状态与下一步

- **2026-11-13 本地开发体验收尾：MFA 密钥持久化 + `--prune`（非阶段功能，最新，当前入口）**：修掉一个会真正锁死管理员的本地缺陷——启动器默认**复用**固定库 `pt_local_auth_000000000000`，却每次启动都新生成 `PAINTTRACK_MFA_ENCRYPTION_KEY`；而 TOTP 密钥以 AES-256-GCM 密文存在 `admin_mfa_factors`、恢复码只存哈希，换密钥后 `decryptSecret` 在 `decipher.final()` 抛认证失败，重启即把管理员锁在自己的本地环境外且无 UI 可恢复。新增 `scripts/local-secrets.js` 把密钥持久化到 `.local-state/mfa-encryption.key`（gitignore、目录 0700、文件 0600、`flag:'wx'` 拒绝覆盖、并发落败方回读）；**只在复用库时持久化**，`--fresh` 走一次性库配一次性密钥且不写盘；读到损坏报 `LOCAL_MFA_KEY_CORRUPT` 且**不覆盖原文件**（静默重建会永久孤立所有密文）；**刻意不持久化 `mailboxSecret`**（邮件只在内存，重启后旧链接本就失效，密钥跟着换才一致）；日志只输出路径与来源，不输出密钥。新增 `scripts/prune-local.js` + `node scripts/local-registration.js --prune`：**默认 dry-run，加 `--yes` 才删**；只认 `.next_local_*` 与 `pt_local_auth_*`；默认库永远保留、owner 必须可推导 `pt_local_migrate_*`、有活动连接跳过、删库成功后才删四角色（2BP01 则保留并记录）；`.next/`、`.local-assets/`、`.local-state/` 都不可能被匹配（删 `.local-state` 等于重新触发该缺陷）；`DROP` 语句无法参数化，故每个名字拼进 SQL 前再校验 pattern 并双引号引用；无管理连接时只清构建目录、不猜凭据。证据：`tests/local-secrets.test.js` 8 项（含**端到端**「重启前加密的 TOTP 密文重启后仍可解、换任何其它密钥都解不开」）、`tests/pruneLocal.test.js` 11 项（含 `DIST_PREFIX` 与启动器实际配置一致性防单边改名）、整仓 **556 项/554 passed/0 failed/2 skipped**；真实只读 dry-run 发现 **23 个历史本地库**且正确保留默认库、无越界条目；真实 `--yes` 删掉 2 个 `.next_local_*`（约 780 MB），第 3 个因**本沙箱**把 fs 删除重定向为回收站而中断，代码正确输出 `PRUNE_DIST_FAILED` 并 exit 1（非代码缺陷）。**限制：没有对那 23 个历史库执行 DROP——不可逆且可能含用户想保留的测试数据，命令已就绪由用户决定；角色清理只在 fake client 上验证过；密钥损坏时只能报错，未提供"确认后清空 factor"的辅助命令。** **同日后续（已执行，2026-11-13，取代上句"没有执行 DROP"的结论）**：用户确认后真实清库——23 个历史库全部 `DROP`，回收 **196.2 MB**，92 个配套角色随之删除（角色总数 57 → 4），固定库删除前后核对完好（18 张表 / 22 条迁移记录 / users=1、assets=4、generation_tasks=4）；真实 PG 上 `DROP ROLE` 路径就此跑通，补掉"只在 fake client 验证"的缺口。同时查明第 3 个构建目录删不掉**不是 fs 缺陷**：本机自 14:24 起在跑的本地开发环境（启动器 + `next dev` + worker + `asset-cleanup`）持有 `.next_local_93280c294680`，Windows 下 `unlink`/`rename` 均返回 EPERM 且删除守卫整体 fail-closed；为此 `--prune` 补 `PRUNE_DIST_HINT`（失败且目录仍在时提示先停服务），`tests/pruneLocal.test.js` 增至 13 项，整仓 **558 项 / 556 passed / 0 failed / 2 skipped**。该目录（403 MB）仍待停服务后清理。

- **2026-11-13 宿主 TaskCenter 取消任务改用应用内确认（阶段 5.12，已由本地体验收尾接续，仅作追溯）**：仓库内最后一处原生 `window.confirm` 已移除（`components/TaskCenter.js:223`）。**先纠正 5.11 的错判**：上一版把「需先定依赖方向（宿主依赖 studio，或把 ConfirmDialog 提到共享层）」写成前置，实际宿主**早已**依赖 studio——根 `package.json` 的 `workspaces` 含 `packages/studio` 且 `dependencies` 有 `"studio": "*"`，`components/StandaloneShell.js:6` 早已 `from 'studio'` 导入 15 个 Studio，`next.config.mjs` 的 `transpilePackages` 含 `'studio'`，`node_modules/studio` 是指向 `packages/studio` 的符号链接（故 5.10 新增的 `exports` 子路径即时生效、无需重装）；因此**不建**仓库级 shared 层、**不动**依赖声明。**用子路径 `studio/ConfirmDialog` 而非主入口**：barrel 会顺带把 15 个 Studio 与 `@xyflow/react`/`reactflow`/`react-markdown`/`react-syntax-highlighter` 拉进任务侧栏，而 `ConfirmDialog` 只依赖 react/react-dom（portal）。实现：新增 `pendingCancel`（待确认任务快照）与 `cancelError`；取消按钮由 `if (window.confirm(...)) cancelTask(task)` 改为 `setPendingCancel(task)`；`cancelTask` 改为返回布尔值（后端接受 → `true`），失败时**双写**错误——`cancelError` 进弹窗内联、`error` 留面板顶部（弹窗盖住面板，故不会同时可见），失败后弹窗不关闭、可就地重试，这正是原生 confirm 丢掉的上下文；`busy` 复用 `busyTaskId === pendingCancel.id`，与行内按钮 disabled 同源，防连点重复 `POST /cancel`；文案复用宿主 `text` 对象（`cancelConfirm` 的 zh 由「确认取消这个任务？」收紧为「取消这个任务？」，新增 `keepTask` 保留任务），**未引入** studio 的 `confirmCopy.js`——宿主已有自己的 i18n 对象，为一处弹窗套包级 copy 反而增加耦合。门禁 `tests/studioConfirmDialogMigration.test.js` 由 5 条扩到 7 条：递归扫宿主 `components/` + `app/` 确认无原生 `confirm()`，并锁定 TaskCenter 走子路径 + 渲染 `<ConfirmDialog>` + busy 同源；**并加假绿防护**——先断言扫描集合包含 `components/TaskCenter.js` 且文件数 ≥ 20，否则路径变动会让该门禁退化成永远通过的摆设。证据：反向自测（临时改回 `window.confirm` → 恰好 2 条失败并精确报出 `components/TaskCenter.js`，恢复后 7/7，非「写完就绿」）、整仓 **537 项/535 passed/0 failed/2 skipped**（5.11 为 535 项，+2 即新门禁）、`esbuild --bundle components/TaskCenter.js` exit 0 且无警告（同时证明子路径可解析、未牵入重依赖）、`require.resolve('studio/ConfirmDialog')` 解析到 `packages/studio/src/components/ui/ConfirmDialog.jsx`、`eslint components/TaskCenter.js` exit 0。**限制：没有在浏览器里真实点击验证过**（本沙箱 Next dev server 不可靠），保障只有源码门禁 + 打包 + ESLint；`WorkflowStudio.jsx` 的重命名失败 `alert("Failed to rename workflow")` 仍未改（studio 包内、非破坏性路径，本轮范围外）；仍无 jsdom/testing-library；5.11 的两项缺口（`deleteObject` 仅本地文件存储验证、回收后行仍为 pending 需 UI 过滤 `abandoned_at`）不变。

- **2026-11-13 孤儿 pending 对象回收（阶段 5.11，已由 5.12 接续，仅作追溯）**：补上 5.7 的缺口——归档中途被强杀会留下「对象已写入、行仍 pending」的组合，而 `assets_status_storage_consistency_check` 强制该状态 `storage_key IS NULL`，行上无键可读，只能按归档路径约定推导 `users/<owner_id>/assets/<asset_id>`。迁移 `0023_orphan_asset_reclaim` 新增 `abandoned_at`、CHECK `assets_abandoned_state_check`（只允许 pending/uploading 且不早于 created_at）与部分索引 `assets_orphan_pending_idx`。**刻意不把行标成 `failed`**：那需要给 cleanup 角色 `UPDATE(status)`，与「cleanup 不能改 status」的既有最小权限边界和验收负例冲突；改用 `abandoned_at` 作收敛信号，行 status 保持原状。新增 `lib/server/orphanReclaim.js`（`FOR UPDATE SKIP LOCKED` 认领、认领即计数、**不 bump `updated_at`**、事务外幂等删对象、跨 owner 键拒绝、失败记 `orphan-delete:<CODE>` 可重试、达上限计 exhausted）；CLI 新增 `--orphan-hours`（默认 6）与 `--no-orphans`，一轮两段事件分开输出；本地注册器显式传 `--orphan-hours 6` 且**不跟随** `--retention-hours 0`。cleanup 列级权限增至 10 读 / 5 写（新增 `created_at` 只读、`abandoned_at` 读写），表级仍全 false。**超时语义**：schema 无上传租约/心跳，只能用 `created_at` 老化；当前无交互式上传通道，默认 6 小时不会误删在途对象，将来做长时上传必须补租约而不是调大窗口。证据：新增 `tests/orphanReclaim.test.js` 10 项 + CLI 4 项，整仓 **535 项/533 passed/0 failed/2 skipped**；`db:migrate:check` 通过；隔离 PG 报告 `.workbuddy/database-acceptance-mwena934_77f663.json` 为 **passed**（123 checks：118 passed / 1 skipped / 4 running / 0 failed），含「abandoned_at 可写在 pending 行」正向探针与「pending 行按推导键删对象/重跑收敛/窗口内不误删」专项。**限制：`deleteObject` 只在本地文件存储验证；回收后行仍为 pending（按状态展示 pending 的 UI 需额外过滤）；上传通道、保留政策、任务删除与账号注销级联仍未做。**

- **2026-11-13 ConfirmDialog 全站推广 + 回归门禁（阶段 5.10，已由 5.11 接续，仅作追溯）**：Studio 包内**已无原生 `confirm()`**。`VibeMotion`/`LipSync`/`Cinema`/`Recast`/`Marketing`/`MotionControl` 六个同步删除入口用 `pendingDeleteIdx` 开弹窗、确认后才改列表；`VideoStudio`（`onDeleteHistoryItem`）与 `WorkflowStudio`（`deleteWorkflow`）两个异步入口按 ImageStudio 同构加 `deleteBusy`/`deleteError`，失败内联可重试；`WorkflowStudio` 顺带移除 `alert("Failed to delete workflow")`，弹窗标题带工作流名；`DrawModal` 的清空画布（非删除）也换掉，弹窗 `z-[1000]` 叠在其 `z-[100]` 模态之上。`RecastStudio` 移动端原本是**硬编码英文**，已统一到本地化文案。为避免 9 屏 × 2 语言各抄 5 个键造成漂移，新增共享 `packages/studio/src/messages/{en,zh}/confirmDialog.json` 与 `packages/studio/src/confirmCopy.js`（`getConfirmCopy(locale)`：`zh`/`zh-*` 命中中文，未知 locale 回退英文而非 `undefined`）。新增 `tests/studioConfirmDialogMigration.test.js` 5 项静态门禁：文案键对齐、resolver 回退契约、**components 下无原生 `confirm()`**（剥注释后判裸 `confirm(` 与 `window.confirm(` 两式，后者因点号会漏判）、10 个入口都 import **并渲染** `<ConfirmDialog>`、可访问性/焦点契约未被剥离；门禁用 6 条样例反向自测过判定力。证据：9 文件逐个 `@babel/parser` 解析通过、逐组件与 `index.js` 打包退出 0（8.6 MB）、整仓 **521 项/519 passed/0 failed/2 skipped**（上轮 516/514，+5 为门禁）、`GET /studio/image` 200。**限制：宿主 `components/TaskCenter.js:223` 取消任务仍是 `window.confirm`（不在 studio 包内）；`WorkflowStudio` 的 `alert("Failed to rename workflow")` 未改；仍无 jsdom，门禁是源码级约束而非交互验证；截图里的灰块与「按钮常显」仍未查。**

- **2026-11-13 删除确认改为应用内弹窗（阶段 5.9，已由 5.10 取代，仅作追溯）**：新增 `packages/studio/src/components/ui/ConfirmDialog.jsx`（仓库第一个通用确认弹窗，已移入 `components/ui/` 作为公共基元并自 `packages/studio/src/index.js` 导出；`createPortal` 到 `body`、`role="alertdialog"`、Esc/遮罩取消、Tab 焦点陷阱、默认焦点落「取消」、关闭还原焦点、body 滚动锁、`busy` 期间禁 Esc/禁遮罩/禁重复提交、`error` 内联）；`ImageStudio.jsx` 用 `pendingDelete`/`deleteBusy`/`deleteError` 承载状态，桌面与移动两处入口都改成「先开弹窗，确认后再删」，失败保留弹窗显示原因可重试。起因是原生 `confirm()` 的四个硬缺陷：标题被浏览器写成「127.0.0.1:3000 显示」、按钮跟随浏览器语言导致中英混排、系统灰白样式与深色 UI 断裂、阻塞且无 in-flight 状态。动效：遮罩 200ms 入 / 150ms 出、面板 260ms 入（ease-out-expo）/ 180ms 出、标题与按钮行 40ms/90ms 阶梯上浮；入场必须双 `requestAnimationFrame`——单 rAF 可能与挂载落在同一次 paint，浏览器没有"闭合态"起始值可插值，弹窗会直接以终态绘制（这就是最初"生硬"的根因）；`prefers-reduced-motion: reduce` 时全部时序归零。文案 `gallery` 新增 `deleteTitle`/`deleteDescription`/`deleteAction`/`deleteCancel`/`deleteBusy`（旧 `deleteConfirm` 保留但不再读取）。证据：JSX 解析两文件通过、`esbuild --bundle` 退出 0（1.37 MB）、整仓 516 项/514 passed/0 failed/2 skipped 与 3.0.7 一致、dev chunk 内含 `alertdialog`/`deleteTitle`。**限制：其余 8 个 Studio（Cinema/Video/Marketing/Recast/LipSync/VibeMotion/MotionControl/Workflow/DrawModal）仍是原生 `confirm()`；无 jsdom，弹窗交互只有人工验证；截图里的灰块与「按钮常显」两项未查。**
- **2026-11-13 Studio 资产删除入口（阶段 5.8，已被 5.9 接续）**：`packages/studio/src/taskClient.js` 新增 `deleteAsset`/`assetIdFromResultUrl`，`ImageStudio.jsx` 的 `handleDeleteEntry` 在移除条目前先调 `DELETE /api/assets/:id`，成功（含 404 幂等）才移除、失败保留可重试；只识别 `/api/assets/<uuid>/content` 形态，外部 CDN 地址不发删除请求；生成结果把 `result.assetId` 写入历史条目（旧条目靠 URL 反推）；文案改为「删除后无法恢复」并新增 `deleteNotReady`（409 提示）。证据：`tests/studioTaskClient.test.js` 9/9（新增 4 项）、整仓 516 项/514 passed/0 failed/2 skipped。**限制：仓库无 jsdom/testing-library，Studio 交互只有 JSX 语法门禁 + 人工验证，不能说「删除按钮已被 CI 覆盖」；软删除不等于对象已释放，也不可撤销。**
- **2026-11-13 资产对象清理（阶段 5.7，已被 5.8 接续）**：迁移 `0022_asset_purge` 新增 `purged_at`/`purge_attempts`/`last_purge_error`、两条 CHECK 与部分索引 `assets_purge_pending_idx`（部分索引让认领只扫待处理行）。为什么必须新增列而不是清空 `storage_key`：既有 `assets_status_storage_consistency_check` 要求 `deleted` 状态必须持有存储键。`lib/server/assetPurge.js` 以 `WITH claimed AS (… ORDER BY deleted_at LIMIT n FOR UPDATE SKIP LOCKED) UPDATE … SET purge_attempts = purge_attempts + 1 RETURNING …` 认领（**认领即计数**，进程崩溃也不会无限重试，超限行计入 `exhausted`），删除对象在**事务外**执行不持锁等 IO；删除幂等（对象不存在视为成功），成功写 `purged_at`，失败只写 `阶段:码`（本地存储错误消息含绝对路径，不落库）。键必须落在 `users/<owner_id>/{assets,thumbnails}/` 才允许删除，否则记 `verify:key_owner_mismatch` 并跳过——数据库行被写坏也不能删他人对象。新增**独立 `cleanup` 角色**：仅 8 列可读、4 列可写（`purged_at/purge_attempts/last_purge_error/updated_at`），表级权限全为 false，读不到 `users`/`generation_tasks`，改不了 `status`/`storage_key`。入口为 `scripts/asset-cleanup.js`（`--dry-run/--retention-hours/--batch-size/--max-attempts/--interval`，退出码 0 无失败 / 1 有失败条目 / 2 配置错误，输出 JSON 事件不含连接串与存储键）与本地 `PAINTTRACK_LOCAL_ASSET_CLEANUP=1`（默认关闭，开启后以 cleanup 角色常驻，本地保留期 0 小时、间隔 60 秒）。踩到的真实约束：**文件存储无法把对象嵌在另一个对象键之下**（主对象本身是文件，`mkdir` 抛 `EEXIST`），缩略图必须与主对象同级并列。真实隔离 PG 报告 `.workbuddy/database-acceptance-mwekxqi6_bdac7f.json` 为 `passed`（121 项检查 116 passed / 1 skipped / 4 running 开始事件 / 0 failed），新增 4 项清理专项证据；整仓 512 项 510 passed / 0 failed / 2 skipped。**未做**：孤儿对象回收（认领只覆盖 `status='deleted'`，归档崩溃留下的 `pending` 行及其对象不会被清理）、保留期限的产品决策（24h/0h 都只是参数）、S3/OSS 上的删除行为、认领与删除之间的租约（删除幂等故暂不引入）、缩略图生成、任务删除/账号注销级联、Studio 删除入口。下一步 B2 Studio 去删除入口（复用现有页面）；B3 孤儿回收需先定义上传超时语义；真实 Provider 联调需用户明确批准凭据与预算。
- **2026-11-13 资产软删除（阶段 5.6，已被 5.7 接续）**：新增 `DELETE /api/assets/:id`（`createAuthorizationHandler('asset.delete')`），方法固定 `DELETE`、同源 `Origin` 精确匹配、动作与方法不匹配一律 `405`。删除实现为单条条件更新 `WHERE id AND owner_id AND status='ready' AND deleted_at IS NULL`：归属判断与写入同语句，并发重复删除不会双写；命中 0 行才探测一次——不属于自己/不存在 → `404`（与"不存在"不可区分，admin 跨 owner 也一样），已删除 → 幂等 `200`（`alreadyDeleted: true`），`pending/uploading/failed` → `409 ASSET_NOT_DELETABLE`。软删除保留 `storage_key` 与元数据（数据库约束要求 `deleted` 仍持有存储键，且清理流程需要它定位对象），读取接口因 `deleted_at IS NULL` 立即 `404`。Web 运行角色只新增 `GRANT UPDATE(status,updated_at,deleted_at) ON assets`；表级 `UPDATE/DELETE` 仍为 false，`mime_type/size_bytes/storage_key/checksum_sha256/owner_id` 写入仍 `42501`，验收脚本新增 assets 列级精确比对防漂移。真实隔离 PG 报告 `.workbuddy/database-acceptance-mwekf4h9_4fd766.json` 为 `passed`（117 项检查 112 passed / 1 skipped / 4 running 开始事件 / 0 failed），新增 4 项删除专项证据；整仓 491 项 489 passed / 0 failed / 2 skipped。同时修正三处**验收 fixture 漂移**（不是业务回归，是上一轮加归档后未同步，单测发现不了）：`task-executor-postgres` 仍断言 `kind='mock-asset'`（图片 mock 已改真 PNG，应为 `'asset'`）、`local-mock-route-postgres` 缺 `objectStore`、用 Worker 身份查未授权列、把 `getObject` 写成 `get`。**未做**：物理对象清理（无清理 worker、重试队列、孤儿对象扫描、保留期/自动过期）、任务删除与账号注销级联、Studio 删除入口（只交付服务端契约）；3.0.4 其余未完成项（真实 Provider 出图、magic byte、Secret boundary、生产对象存储）不变。下一步 B1 对象清理流程（独立清理角色/进程认领 `deleted` 资产 → 幂等删除主对象与缩略图 → 失败重试与保留期），再做 B2 Studio 删除入口；真实 Provider 联调需用户明确批准凭据与预算。

- **2026-11-13 本地 mock 生成闭环打通 + 结果 URL 抓取/SSRF 门禁（历史，已由上方资产软删除条目更新）**：Studio 已通过同源认证目录 + `/api/tasks` 提交并轮询；Worker 二进制结果完成列级归档，`GET /api/assets/:id/content` 按 owner 授权读取；真实隔离 PG 报告 `.workbuddy/database-acceptance-mweebpub_346a46.json` 为 `passed`（113 条记录 108 passed / 1 skipped / 4 running 开始事件 / 0 failed），含归档二进制并提交可预览描述符、owner 200/他人 404/admin 跨用户 404/无存储键。新增 `lib/server/providers/resultFetcher.js` 补齐真实 Adapter 只给 `resultUrl` 的缺口：抓取在结算事务外、DNS 只解析一次并钉住已验证 IP、逐跳重定向校验、`Content-Type` 必须匹配（缺失即拒）、双重大小限额、空闲超时与中止；失败记 `RESULT_FETCH_FAILED` 可重试且不落对象。修掉 `createTaskProcessor` 剥离 `pool` 导致每条图片任务 `pool is required` 的真实缺陷。本地启动器默认复用固定库（`--fresh` 保留一次性库）、自动准备 `.local-assets/`、失败输出脱敏诊断行。整仓 489 项 487 passed/0 failed/2 skipped。**未做**：真实 Provider 出图（无凭据、未访问公网、未耗额度）、magic byte 内容校验、资产生命周期删除、Provider 写 API（仍关闭）、Secret boundary 生产闭环。下一步建议先补资产删除生命周期，再在用户明确批准凭据与预算后做真实 Provider 联调；任务管理入口/页面仍暂缓。

- **2026-11-13 本地mock路由快照fixture真实PG验收通过**：第三次运行报告 `.workbuddy/database-acceptance-mweb6dgr_e1f6d4.json` 为 `passed`，112 条检查 107 passed / 1 skipped（`admin-mfa-postgres` 需 `RUN_ADMIN_MFA_PG_ACCEPTANCE=1`）/ 4 条 `running` 开始事件 / 0 failed，退出 0。库 `pt_acceptance_mweb6dgr_e1f6d4` 与四个 `pt_*_mweb6dgr_e1f6d4` 角色由脚本自建并按策略保留。覆盖：三身份事实校验、四列临时授权、快照落库与重放零 resolver、同键并发只产生一个任务、image/video 执行、Web/Worker 快照 UPDATE 均 42501、落库篡改并重算 hash 仍拒发、未知提交恢复保留调用 ID/轮次/幂等键、历史 provider_name 冲突零 Provider 调用、migration 按精确 ID 清理并撤销授权。前两次失败均系 fixture 自身判定写法（8 条件合一无诊断、回环地址白名单过严），未改动被测代码路径；被修正的两版断言均保留历史记录，可回溯。新增 `scripts/cleanup-acceptance-databases.js` 用于清理失败运行遗留的隔离库与四角色：库名须严格匹配 `pt_acceptance_<后缀>`、角色名由后缀推导，无法指向既有业务库或生产库；有活动连接跳过、库不存在只探测、先删库再删角色、2BP01 记为受阻、无事务包裹、缺管理变量在建连前退出且不读 `.env`。证据：`tests/acceptanceCleanup.test.js` 6 项、全量 `npm test` 459 项 457 pass/0 fail/2 skipped、退出 0（`.workbuddy/full-test-after-cleanup-script.log`）。真实删除须由用户持显式管理连接执行，本轮未连库。下一步接 Studio 主流程（共享 ImageStudio/VideoStudio 走 `/api/tasks`，不新建平行生成页）；任务管理入口/页面仍暂缓、Provider 配置写 API 保持关闭、生产部署与秘密 ACL 后置。

- **2026-11-13 本地mock真实PG第二次运行定位到回环地址判定过严并修正**：第二次报告 `.workbuddy/database-acceptance-mweb19lu_3c31d4.json` 仍 failed，唯一失败子项 `local-mock-route-postgres`，`line` 32，`hint` 为 `<redacted> identity[0] fields: address`——即 migration 连接的 `database/role/session_role/database_owner/port/privileged/has_membership` 七项全部匹配，只有服务器端地址一项不符，角色/库名/库主/端口/无高权限/无成员关系均已确认正确。根因是判定写法不一致：验收脚本 `withClient` 用 `::1 || startsWith('127.')` 且一直通过，fixture 却只认 `'127.0.0.1'`、`'::1'` 两个精确字符串，导致 127/8 内其它地址、IPv4 映射回环 `::ffff:127.x`、带 `/32` 掩码的 inet 文本被误判为身份不合格。修正为 `isLoopbackAddress`：接受 `::1`、`::ffff:127.x.x.x`、整个 `127.0.0.0/8`，容忍 `/32`、`/128`；`172.17.x`/`192.0.2.x`/域名形如 `127.0.0.1.example.com`/空串/null 仍拒绝；只有 `address` 项在失败信息里回显实际 IP（非凭据），其余字段仍只报字段名。证据：fixture 单测 6/6，全量 `npm test` 453 项 451 pass/0 fail/2 skipped、退出0（`.workbuddy/full-test-after-loopback-fix.log`）。均为离线证据，不得计为真实 PG 通过。下一步再跑一次 `node scripts/accept-database-local.js`（该机 PowerShell 执行策略禁止 `npm.ps1`，用 node 直接调同一脚本）争取 passed，再进 Studio。未碰既有业务库/公网/真实 Provider，任务页面暂缓、写 API 关闭、生产秘密 ACL 未完成。

- **2026-11-13 本地mock真实PG首跑失败定位到身份断言，已加字段级诊断**：真实隔离库报告 `.workbuddy/database-acceptance-mwea3nkn_60b7d6.json` 为 failed，唯一失败子项 `local-mock-route-postgres`，报告只留 `LOCAL_CHECK_FAILED` 与 `tests/fixtures/local-mock-route-postgres.cjs:25`；该行属 `assertAcceptanceIdentities`，且该 fixture 的前置通过记录 `本地mock快照准备` 缺失，可确认失败发生在四列授权与任何写入之前。其余 89 项（管理员只读探测、四角色与空库创建、迁移链、Web/Worker 列级权限正反例、执行器、撤销与授权）全部 passed，MFA 未开 skipped，环境本身正常。原实现把 8 个条件压成同一个错误，只能看到行号；现改为逐字段比对并抛 AssertionError，消息形如 `identity[1] fields: database_owner`，只含身份序号与字段名，不含库名、角色名、连接串或字段值，且未放宽任何判据（同后缀验收库、current_user/session_user 一致、migration 为库主、loopback:5433、无高权限、无角色成员关系）。新增一项离线断言校验该消息不泄露身份值。证据：三文件 `node --test` 29/29，全量 `npm test` 452 项 450 pass/0 fail/2 skipped、退出0（`.workbuddy/full-test-after-identity-diag.log`）。均为离线证据，不得计为真实 PG 通过。下一步用显式 `LOCAL_DATABASE_ADMIN_URL` 重跑一次 `npm run test:db:local`，按新报告 hint 的字段名修真正原因并复跑至 passed，再接 Studio。未碰既有业务库/公网/真实 Provider，任务页面暂缓、写 API 关闭、生产秘密 ACL 未完成。

- **2026-11-12 本地mock真实PG验收代码就绪、执行受阻**：新增tests/fixtures/local-mock-route-postgres.cjs并接入accept-database-local现有随机新隔离库流程；先查实际数据库/三身份/session_user/owner/loopback:5433/无高权限与成员关系，再临时授予Web四列快照INSERT，migration精确清理并撤销授权。断言包括image/video真实service提交与快照持久化、重放不解析/同键冲突、双事务同键屏障、Worker领取执行、Web/Worker快照UPDATE为42501、落库篡改且重算hash仍拒发、未知提交恢复保留调用及幂等键、历史Provider冲突零派发。验收入口取消隐式读取.env，只接收显式管理连接。新增4项离线守卫测试，9文件72/72通过、无失败/取消/跳过（local-mock-route-offline-20261112.log），3文件语法通过（local-mock-route-syntax-20261112.log），日志已读回。当前LOCAL_DATABASE_ADMIN_URL不存在，未运行真实PG，以上DB断言均待实测，不计数据库验收通过。限制：同类型残留任务可影响领取；并发屏障5秒；mock恢复为同进程内存实例，不是跨Worker进程重启；provider_calls完整路由审计字段未覆盖。下一步在显式loopback:5433/postgres管理连接可用时运行现有test:db:local随机隔离验收并按报告修复，再接Studio。未碰既有业务库/公网/真实Provider，任务页面暂缓、写API关闭、生产秘密ACL未完成。

- **2026-11-12 Worker本地快照选路（最新）**：localMockCatalog新增可信selector，启动时预计算固定image/video批准快照；逐任务精确比对模型FK、业务模型ID、operation、版本、hash及完整快照，返回受信mock实例，不查询实时目录、不接受任务提供的目标。taskExecutor在账本/取消SQL之前校验带快照任务，缺selector或不匹配则固定码拒绝且零SQL，旧四列均NULL任务兼容；历史恢复核对provider_name，不匹配不dispatch/改写/重提，调用租约自然到期。local-registration仅显式mockRouting选项向独立Worker传双guard，CLI在Pool建立前装配selector。7文件定向93/93通过（`.workbuddy/worker-local-route-test.log`，退出0，无失败/取消/跳过），6文件语法通过（worker-local-route-syntax.log）；新增4测试涵盖两媒体成功/未知恢复同键、篡改/部分快照/缺selector零SQL、历史Provider冲突及环境传递。使用内存账本/SQL替身，未运行真实PG/Next/Studio/公网/真实Provider；mock选择器只是固定合成Provider，不等于任意生产多Provider选路。下一步补本地真实隔离DB任务创建→快照→Worker结果/幂等验收，再接Studio；当前缺显式管理连接须待可用，不能猜凭据。任务管理页面暂缓、Provider写API关闭、生产秘密ACL仍未完成。以下旧条目“Worker固定/未选路”由本条更新。

- **2026-11-12 本地 mock 目录与 app 路由接线（最新）**：新增 localMockCatalog 固定图片/视频合成目录，仅 development + 本地内部 guard + 显式 mock routing 开关同时满足时装配；app/api/tasks POST 在该模式使用可信 routed handler，开关未启用保留兼容路径，非法环境返回503。启动器向新隔离库写入禁用的合成 logical_models FK 身份，并仅对本次新建本地 Web 角色额外授予 logical_model_pk/route_snapshot/route_snapshot_version/route_snapshot_hash 四列 INSERT；不授予快照 UPDATE，不变更通用 runtimePermissions。发现并修复该四列授权漏项，同时冻结合成源身份。上一轮55/55，本轮6文件57/57通过、无失败/取消/跳过（`.workbuddy/local-mock-routing-final-test.log`），4文件语法检查退出0。SQL授权验证使用替身，尚非真实PG权限验收；显式管理URL存在性预检为false（`.workbuddy/local-mock-routing-db-precheck.log`），未认证数据库、创建资源、重启Next或访问Provider。Worker仍固定mock，Studio未接任务API，公共目录fixture仍禁用；并发同键/真实落库/完整mock闭环未验收。下一步实现Worker按快照校验并选择本地mock Provider，管理连接可用后补真实隔离DB验收；任务管理页面暂缓，Provider写API关闭，生产部署及秘密ACL后置。以下旧条目的“app未接线/任务无快照”仅描述此前状态，以本条为准。

- **2026-11-12 受控HTTP路由边界切片**：taskHttp新增createRoutedTaskHandler，仅由可信宿主注入catalog，工厂拥有resolver和提交service，拒绝serviceFactory/routeResolverFactory覆盖；不从请求/env/Web pool建立内部配置读取能力。路由固定白名单错误码映射HTTP，后端异常脱敏。新增3测试，与resolver/任务回归共43/43通过（`.workbuddy/routed-http-boundary-test.log`，退出0），内存SQL证明无路由时ROLLBACK且零INSERT/零内部Provider表查询。正式app路由尚未切换，专用目录通道、并发同键/真实PG及Worker按快照选路未完成；Web权限不变，写API关闭、任务入口暂缓，无DB/公网/真实Provider。下一步实现最小本地可信目录通道并明确宿主装配，而非仅继续新增未接线工厂。

- **2026-11-12 路由快照最小切片**：核查到工作区已有未收尾modelRouteResolver及taskQueue/taskService/taskHttp注入分支。本轮修正强制resolver/请求格式造成的既有API回归，兼容路径保留；显式注入resolver时按可信catalog选择启用且verified主绑定、生成冻结的无密钥快照和稳定hash。新增请求模型身份一致性及多主绑定拒绝，补3项resolver/内存SQL组合测试。最终四文件回归40/40、无失败/取消/跳过，日志 `.workbuddy/task-route-snapshot-verified.log`；首轮测试失败保留，组合夹具补齐尺寸后通过。Web权限未扩大、无DB/Provider/网络访问、配置写API关闭。正式HTTP未装配可信catalog/resolver，Worker未按快照选路；本次不是动态路由端到端完成。下一步需明确受控路由目录服务边界并装配，补无路由零写入、并发同键及真实DB约束验收，不能将内存SQL替身当真实持久化通过。任务入口继续暂缓。

- **2026-11-12 用户补充范围约束**：任务管理/任务中心前端入口与页面暂缓完善；用户表示此前可能要求移除，当前页面也未见入口，本轮未核验其隐藏/移除状态，不据此恢复入口或改页面。保留任务API、Worker及状态恢复基础，先推进其余多模型路由和既有Studio主流程，之后再回头确定任务管理呈现。用户报告本地其余检查无问题，此为用户手动反馈，不代表自动化端到端验收；此前开发进程OOM根因及重启稳定性仍未独立核验。

- **当前入口（4.7.5收尾）**：数据库身份拆分已完成本地实现和真实隔离验收；最终报告 `.workbuddy/database-acceptance-mwcyonlg_45f52d.json` 为passed，108 passed/0 failed/0 skipped（另4个段落开始事件running），含可选MFA。53项定向单测、6文件语法及限定diff检查均通过。失败fixture的身份冲突已修复，完整Worker并发/强杀恢复/fencing/停止/连接释放通过。当前不再需要用户提供管理密码或手工执行命令。
- **Secret boundary当前进度**：第16.4第1项合成秘密进程/IPC切片已实现（secretBoundary.js、secretBoundaryProcess.cjs及8项新测试），连同配置/registry/启动器回归22 pass/0 fail，日志 `.workbuddy/secret-boundary-ipc-test.log` 退出0，3文件语法检查通过。覆盖授权、Web模拟通道拒绝、精确引用/版本、撤销、关闭、超时及请求上限；未启动真实Web、未强杀注入、未全链路泄漏审计。第2项registry显式resolver切片也已实现：绑定可信目标/实例/ref/version，缺解析器不回退env，真实Adapter+内存fetch贯通合成秘密；新增6项与回归共28项通过（日志 `.workbuddy/secret-boundary-registry-test.log`）。原Worker CLI尚未切换，未测poll/result完整链或全链路泄漏。第3项部分实现：提取createNextEnvironment，在资源创建前及Next spawn前拒绝四类开发.env文件（lstat检查，探测错误拒绝启动）；启动器6项测试及秘密边界关联回归共30 pass/0 fail/0 cancelled/0 skipped，日志 `.workbuddy/local-registration-test.log`，语法检查通过。随后补充local-next-env-preload.cjs：可信NODE_OPTIONS在CLI/fork预加载无文件@next/env facade，首次/forceReload不读文件，非空processEnv拒绝，安装失败终止；合成真实模块对照组读取8次、保护组0次，fork及Next选项格式化、快照兼容和失败拒绝均通过。新增AST客户端传递静态导入门禁，扫描237源码/50入口/116节点，无根lib/server导入链；支持别名/workspace/reexport等，变量计算导入和第三方依赖不覆盖。综合8文件60 pass/0 fail/0 cancelled/0 skipped，日志 `.workbuddy/secret-boundary-environment-final.log`。随后最小Next真实CLI/watcher/重编译集成独立复跑1/1通过（secret-boundary-next-integration-final.log）；第4项离线泄漏回归19/19通过（secret-boundary-leakage.log），含实际secret=canary的submit/poll/result内存协议及输出脱敏。此为本地最小应用，不是完整业务链或生产隔离。本轮Worker CLI仅源码审查：旧provider解析在new Pool之前，首次连接在claimNextTask；计划可信启动方显式传descriptor/approvedBindings/resolver并在Pool之前异步预检，mock单独保留，缺可信能力拒绝且不得回退env。具体方案/待验收见设计稿16.9，未改运行代码或运行测试。异步引导已实现：bootstrapWorker显式resolver预检在Pool前完成，委派生命周期finally释放；CLI仅非production mock保留，非mock旧env即使齐全也以WORKER_TRUSTED_BOOTSTRAP_REQUIRED拒绝。新增12项及关联回归66 pass/0 fail/0 cancelled/0 skipped（worker-secret-bootstrap-test.log），顺序及预检失败零Pool/connect/claim通过。生产可信宿主尚未接线，旧registry/env函数仍保留；具体见16.10。真实秘密进程初始化/READY后并发pending强制终止已验收，21/21回归通过（secret-boundary-process-failure.log，16.11）；测试用发送屏障，不证明已交付Adapter凭据失效。旧env盘点确认providerConfig及同步registry非mock分支仍保留，当前Worker仅mock调用旧registry；旧分支现已退役：providerConfig兼容API固定PROVIDER_ENV_CREDENTIAL_RETIRED，不读环境、不返回秘密；同步registry真实分支固定拒绝，mock/显式resolver保留。getter/canary零读取零构造负例及回归93/93通过（provider-env-retirement-test.log，16.12），旧使用说明同步。可信宿主/部署契约设计已记16.13：固定受控宿主显式注入批准绑定及Worker专属resolver，独立OS/容器身份，Web/migration无Provider秘密读取权；已有Adapter缓存明文不能靠resolver撤销收回。未实现生产宿主/选择秘密后端或部署验收。合成运行中撤销实测已完成（16.14），55项回归通过（secret-boundary-revocation.log）：新解析拒绝但旧Adapter在revoke/close后仍可请求，stop阻止后续claim却允许当前处理器继续query；这是已验证限制，不是即时撤销实现。下一步明确正常轮换排空与紧急撤销策略/正式宿主接线；正式接线前需确认平台/地域/账户、秘密后端/身份、预算及撤销轮换时限。旧env路径及生产OS/Secret Store ACL仍待处理，整体秘密边界未完成；不引入云服务、不触碰数据库、不使用真实凭据。
- **调用闸门最新验收（16.15）**：bootstrap 已向执行器注入 gate Provider，控制句柄留给可信宿主；历史 unknown/submitting 拒发仍保持未知及同一幂等键，当前新调用才允许确定未发送终结。预中止、同步撤销、dispatch/结果 deadline、单 timer 清理及跨调用错误复用六项问题已修复。旧修复日志保留首轮82/83及最终83/83；本次独立五文件复跑78 pass/0 fail/0 cancelled/0 skipped、退出0，日志 `.workbuddy/provider-invocation-gate-verified.log`。gate/executor/ledger 组合使用内存SQL替身，不是本轮真实PG验收。已发送请求/非协作Adapter副作用不能收回，不能宣称明文失效或生产Secret Store隔离完成。
- **可信宿主生命周期切片已完成（16.16）**：实际runWorkerProcess提供onHostLifecycle的rotate/revoke/getState，正常轮换先drain再stop，紧急撤销先revoke再stop，支持升级/重复调用，finally关闭Pool/gate/委派秘密；可信bootstrap信号采用撤销，mock保留stop。新增4项实际Worker+内存队列组合测试，连同恢复回归82/82通过、退出0（`.workbuddy/worker-host-lifecycle-final.log`），两文件语法通过。未做真实PG或OS信号实测；shutdownGraceMs可能早于drain期限，非协作Adapter副作用不能收回，不自动启动新版本Worker。
- **2026-11-12 用户路线调整：生产部署后置，先本机单实例内部验证。** 平台/地域、秘密后端、Worker身份及生产ACL验收延期且保持未完成，不作为本地mock检查的强制前置；不因此开放Provider写API或绕过既有秘密/路由门禁。先核查启动条件和Studio接线，再按多模型架构完成本地mock闭环，不固定接单一模型、不新增平行生成页。
- **本地预检已完成，启动受阻**：日志 `.workbuddy/local-preview-preflight.log`（退出0）确认Node v22.22.2、Next/pg已安装，3000/3001无监听、5433有监听；仅TCP探测，不证明数据库认证可用。当前进程无LOCAL_DATABASE_ADMIN_URL，仓库根存在.env（未读取内容）。启动器会拒绝该文件，且provision仍写死无密码postgres管理连接，未使用显式管理URL，因此本轮未启动、未认证数据库或创建资源。启动器现已改为仅接受显式LOCAL_DATABASE_ADMIN_URL，复用parseDatabaseTarget严格校验loopback:5433/postgres、拒绝连接覆盖参数并规范化数值loopback；三角色派生URL沿用批准端点，不再硬编码无密码管理员。新增URL/派生连接及真实CLI早拒绝3项测试，与环境隔离回归共26/26通过（`.workbuddy/local-admin-url-test.log`），两文件语法通过；缺失/非法URL在env文件探测、端口与pg加载前拒绝，未尝试数据库认证。.env边界继续拒绝，下一步启动仍需提供显式管理URL并明确根.env文件处理方式，不能自动读取/移动后绕过。Studio由StandaloneShell复用共享studio；taskService尚无路由解析/快照，Worker仍固定Provider，不能称生成闭环已接通。
- **生产宿主接线仍待后续准入**：选型确认后再接实际后端并取得ACL/隔离证据；确认前不创建资源或虚构生产接线。旧同步env凭据入口已退役，本地显式resolver已接入bootstrap；完整生产秘密边界尚未完成。配置事务服务/Provider写API及任务快照路由不在本次4.7.5范围，写API继续关闭。既有dev/test/生产库不应用迁移、不变更角色；隔离库/角色按报告保留，不自动清理。

以下10:00–10:51记录为故障排查历史，不是当前入口：

- **最新实测优先（2026-11-12 10:51）**：补齐Worker清单后重跑一次 `npm run test:db:local`，退出1，报告 `.workbuddy/database-acceptance-mwcybt19_7ad662.json` 为failed，75 passed / 1 skipped / 7 failed记录（5个fixture失败+汇总+终止，并非7个独立根因）。Worker列级清单及该段真实42501越权负例已通过，Web权限回归已通过；完整Worker并发恢复未执行到。5个fixture以42501失败：email-outbox第9行、provider-call-ledger第38行、task-executor第210行、task-cancel第33行、authorization第39行；MFA可选验收因未设置开关skipped。下一小步只定位fixture连接身份与夹具准备的权限冲突，不扩大授权、不自动重跑。4.7.5仍实现中，未完成。以下旧快照由本条取代。

- **最新实测优先（2026-11-12 10:09）**：修正验收身份分工后运行一次 `npm run test:db:local`，退出码 1；报告 `.workbuddy/database-acceptance-mwcwtoqq_754590.json` 为 failed，34 项 passed。Web 资产/任务执行列越权、审计 INSERT 与 UPDATE/DELETE 42501 负例、安全目录投影、migration 结构约束、Worker 独立连接结果写入及 Drizzle 事务均通过。当前停止于脚本 889 行 Worker 列级权限清单比对（LOCAL_CHECK_FAILED，missing=[]，extra 非空，报告 hint 截断），Worker 后续越权负例及完整并发/恢复验收未完成。10:12 已离线定位：按0021 snapshot展开当前授权为185项，期望155项，missing=[]、extra30项（email_outbox9、logical_models2、provider_calls INSERT19），来源为表级授权与手写窄列集期望不一致。当前实时探针因管理变量缺失blocked，离线结果不冒充数据库实测；10:47 已按15.1既有边界补齐显式期望清单30项（155→185），不改授权、不动态同源生成expected，越权负例保留；node --check、脚本diff --check均退出0，离线对照185/185且missing/extra均为空（日志 `.workbuddy/phase4-4.7.5-worker-expectation-offline.log`）。未重跑数据库或程序单测，下一小步待确认后运行一次真实隔离验收；4.7.5 仍实现中、验收失败。以下早期下一步描述由本条取代。

- **当前入口（2026-11-12）**：阶段 4.7.5 Web/Worker/Migration 数据库身份拆分的代码改动已落地，语法与 53 项定向单测通过；**真实 PostgreSQL 隔离库验收尚未重跑，因此该小步骤只能记为「实现中」，不得记为「已完成」**。2026-11-12 10:00 已取得管理连接并执行一次 `npm run test:db:local`，退出码 1；报告 `.workbuddy/database-acceptance-mwcwiaua_78f510.json` 为 `failed`（20 项 passed，终止于 `scripts/accept-database-local.js:405` 的 Web 身份 `INSERT INTO assets ... RETURNING id`，错误码 `42501`）。Worker 权限及后续验收未执行到，四项未验证不得视为通过；当前为真实验收失败待修正。只读定位已确认验收身份矛盾：Web assets 仅 SELECT 的权限清单已通过，后续却期望该身份 INSERT/UPDATE assets，以及 UPDATE 任务 result 成功。不得为旧验收扩大 Web 授权。附加实时权限探针因当前调用未取得 LOCAL_DATABASE_ADMIN_URL 被阻断，无新数据库实测。验收脚本身份分工修正已落地（Web 正反权限、Worker 独立连接执行正例、migration 结构约束探测与夹具清理），保留原有覆盖，并将 Drizzle 提交夹具清理由 Web DELETE 改为 migration 精确清理。`node --check` 与限定脚本 `git diff --check` 均退出 0（日志 `.workbuddy/phase4-4.7.5-identity-fix-check.log`）；未重跑数据库验收，实际权限与正反例仍待实测。下一步经单步确认后运行一次真实隔离验收，再按报告失败项修正 `checkWorkerRolePrivileges` 的列级期望清单与 Web 表级权限清单，重跑至 `status: passed` 后回填 `PHASE4_STEP2_MODEL_CATALOG_ROUTING_DATA_DESIGN.md` 第 15 节。冷启动细节见 `PaintTrack/docs/records/HANDOFF_PHASE4_4.7.5.md`，当前快照见 3.0.3。
- **门禁不变**：Provider Secret boundary 未完成（旧env入口已退役，本地显式resolver已接入，但生产秘密后端和ACL尚未验收），Provider 配置写 API 继续关闭；Secret Store 或等价专用服务边界落地前，不得开放写 API，也不得把数据库角色拆分表述为 secret 读取隔离已完成。

- 阶段 4/5 当前已实现一个 MyVigna `gpt-image-2` 异步 T2I Adapter 协议切片，并通过 loopback mock HTTP 定向测试；共享 ImageStudio 尚未调用 PaintTrack `/api/tasks`，Worker 仍是进程级固定 Provider，任务尚无不可变路由快照。该首个 Adapter 用于协议验证，不能作为产品只支持单模型的限制。
- **2026-11-10 用户确认多模型后台配置方案**：项目现有多张图片/视频模型应可由管理员后台管理，支持添加、编辑、启用/下线逻辑模型，并将其绑定到不同 Provider 实例下的精确上游模型；可配置主路由与备用绑定，切换只影响新任务。模型范围涵盖多个图片/视频模型及其 T2I、I2I、T2V、I2V 等能力，不固定为 `gpt-image-2`。现有 `packages/studio/src/models.js`、`modelFamilies.js` 等暂作展示、参数与兼容模板，服务端动态目录将决定可调用模型；后续逐步迁移，避免一次重写既有参数交互。
- **执行顺序调整**：①阶段 4.7.1 多模型目录/路由数据/API 设计已完成；②阶段 4.7.2 Drizzle schema、0015/0016 snapshot、journal 与 `0016_model_catalog_routing.sql` 已完成离线实现与一致性验收；③阶段 4.7.3 **已完成**：报告 `.workbuddy/database-acceptance-mwagpqj2_9ec86c.json` 在 loopback 随机隔离库取得 `passed`，88 项全通过（空库/非空库迁移、历史路由身份保持 NULL、journal/hash、15 表结构与 snapshot 对照、运行角色表级/列级最小权限与越权负例、注入与 CHECK 负例、Drizzle 事务回滚、独立 Web 探针目录安全投影、9 组 fixture，以及 Worker 段在 0016 下的 12 任务并发领取、SIGKILL 后自然租约过期重领、fencing、协作/非协作停止与无遗留连接）；④阶段 4.7.4 管理员配置 API 准入设计已完成：首版限定逻辑模型、Provider 实例、Provider 上游模型和路由绑定四类资源；写请求要求 MFA，高影响变更要求 step-up，配置/审计/秘密/版本/并发/SSRF 边界已固化，当前只读审查未实现写 API；⑤阶段 4.7.5 独立 Web/Worker/Migration 权限拆分已完成本地实现及真实隔离库验收（报告mwcyonlg_45f52d，108 passed/0 failed/0 skipped，含MFA）；Worker fail-closed、三身份权限、真实列级比对/越权负例及完整Worker恢复验收通过，第15节已回填；⑥Secret Store 或等价专用服务边界仍未落地，Provider Secret boundary 未完成，写 API 继续关闭；⑦再实现配置事务服务和 HTTP 写 API；⑧随后实现按任务快照路由的 Worker；⑨最后将现有 ImageStudio/VideoStudio 各模型能力接入任务 API 并分批验收。完整后台 UI 在 API 稳定后实施。不得先把 Studio 固定接到单一模型后再重构。0016 迁移尚未应用到 `painttrack_dev`/`painttrack_test`/生产库，该应用属独立授权步骤。
- 下线模型默认采用软禁用；已有任务、路由快照或审计引用时禁止物理删除。Provider 凭据始终服务端保存；Studio 只提交逻辑模型 ID 和业务参数。任务创建时固定无密钥路由快照，切换路由只影响新任务；默认关闭自动故障转移，未知提交不得换 Provider 重提。
- 阶段 6.1 身份 UI 已实现并通过测试；真实账务与数据库账本尚未实现。阶段 6.2 核心产品规则已确认，技术契约设计基线已补（详见 `PHASE6_ACCOUNT_CENTER_PRODUCT_DESIGN.md` §4.1–4.2）：版本化模型报价快照、signup grant + 反滥用、append-only ledger/available-reserved、task 级幂等 reserve/settle/release、dispatch intent 后 unknown 保守冻结及真实 PG 验收门禁。仍待评审和精度/定价公式/赠送默认值/风控阈值/未知状态 SLA 等参数收口；迁移与账本代码未实现、未授权。
- 阶段 4.7.1 与 4.7.2 设计稿分别见 `PaintTrack/docs/records/PHASE4_STEP2_MODEL_CATALOG_ROUTING_DATA_DESIGN.md`、`PaintTrack/docs/records/PHASE4_STEP3_SCHEMA_MIGRATION_DESIGN.md`。4.7.2 本轮只完成候选 schema/migration 设计，没有修改 `schema.js`、SQL migration、snapshot/journal、运行代码或数据库，没有运行程序测试或隔离数据库验收。审查发现当前 `runtimePermissions.js` 通过同一运行角色叠加 worker 权限，不能证明 Web/Worker DB 层隔离；独立运行身份与秘密边界须在动态路由实施前明确并以真实权限负例验收。下一步按单步门禁对本设计进行文档/实现评审；验收后另行进入 schema/migration 实施与隔离库正负例，不应用到既有 `painttrack_dev`/`painttrack_test`。
- 阶段 6.1 身份 UI 已实现并通过测试；真实账务与数据库账本尚未实现。阶段 6.2 核心产品规则已确认，技术契约设计基线已补（详见 `PHASE6_ACCOUNT_CENTER_PRODUCT_DESIGN.md` §4.1–4.2）：版本化模型报价快照、signup grant + 反滥用、append-only ledger/available-reserved、task 级幂等 reserve/settle/release、dispatch intent 后 unknown 保守冻结及真实 PG 验收门禁。仍待评审和精度/定价公式/赠送默认值/风控阈值/未知状态 SLA 等参数收口；迁移与账本代码未实现、未授权。

### 当前能力边界与上线判断

认证、会话和管理员权限基础已完成并通过本地/隔离数据库验收；这不等于 SaaS 业务端到端或生产部署已完成。真实 Provider/任务整合、用户额度账务、对象存储和结果归档、管理员 MFA/正式后台、真实邮件、隐私闭环、生产基础设施与发布演练仍须按上述依赖完成并验收。阶段 12 发布门禁通过且获明确发布批准前，不得对外宣称完整 SaaS 已可运营。

管理员 bootstrap 是一次性受控 CLI 能力。上线或长期运行前必须核实 bootstrap 身份已撤销或轮换，且凭据未进入 Web/Worker 环境；验收报告通过本身不证明该运维动作已完成。

### 阶段状态速查

| 阶段 | 当前状态 | 下一动作/说明 |
|---|---|---|
| 0：基线与项目身份 | 已完成 | 历史记录见第 3 节；开始任务时仍检查当前 Git/环境 |
| 1：架构与基础设施决策 | 已完成 | 云服务商、部署地域和采购仍按实际需要另行确认 |
| 2：数据库与服务端基础 | 已完成 | 详见 `PaintTrack/docs/records/DB_SETUP.md` |
| 3.1–3.5：认证与管理员初始化 | 已完成 | 最终 PG 报告见第 3.0.1 节 |
| 3.6：账户安全收尾 | 当前基础小步骤已完成 | 真实供应商邮件按用户决定延期；bootstrap 身份仍待运维核实 |
| 4：Provider 适配 | 4.7.1–4.7.5已完成；**4.3.1 结果 URL 抓取与 SSRF 门禁已实现（离线 13/13 + 执行器 2/2）**；本地调用闸门及可信宿主生命周期切片通过定向验收，阶段4整体未完成；最新状态见 3.0.12 与 10.4 首条 | 本地优先路线已确认：启动器已完成显式管理连接校验、固定库复用、资产存储根透传；Studio 与本地 mock 闭环已在真实隔离 PG 通过（报告 mweebpub_346a46，108 passed）。真实 Provider 出图需用户批准凭据与预算，未跑；未做 magic byte 校验。生产宿主后端/身份/ACL 待选型验收，写 API 关闭；不保证非协作 Adapter 撤回或明文清除。旧 env 凭据入口已退役。此前切片证据： 4.7.5最终报告mwcyonlg_45f52d passed（108项，无失败/跳过）；Secret boundary合成秘密进程/IPC切片已实现，22项定向测试通过；registry显式resolver及内存Adapter贯通已实现，28项回归通过；启动环境切片部分实现：Web环境构造与.env启动前拒绝，30项关联回归通过；已补无文件Next preload首次/forceReload/fork实测及客户端AST传递导入门禁，综合60项通过；随后真实Next 15.5.29最小App在loopback启动并完成环境文件运行中创建/变更后的watcher重载与服务端重编译，接口始终返回合成canary不可见，stdout/stderr无合成键值，独立复跑1/1通过，日志 `.workbuddy/secret-boundary-next-integration-final.log` 及证据 `.workbuddy/secret-boundary-next-integration.log`。第4项离线泄漏负例已补：实际secret等于canary，覆盖resolver/factory/非法凭据、Web拒绝/错引用/撤销、submit/poll/result内存传输错误、序列化错误及网络/数据库入口guard自检，19/19通过，日志 `.workbuddy/secret-boundary-leakage.log`；fork timeout/exit仍是模拟故障，不是强杀实测。第3项本地集成和第4项离线泄漏切片已完成；Worker可信异步bootstrap及CLI非mock旧env拒绝已实现，66项离线回归通过（16.10）；生产宿主未接线、旧registry/env工具仍存在。真实秘密子进程初始化/并发pending强制终止已验收，21项回归通过（16.11）；旧providerConfig读取及同步真实registry已固定退役拒绝，93项回归通过（16.12），兼容导出不读环境；可信宿主契约/部署门槛已设计（16.13），生产平台/秘密后端未选，宿主未接线；运行中撤销现状已实测（16.14，55项通过）：旧Adapter仍持明文，优雅stop不阻断在途后续请求。下一步轮换/紧急撤销策略及宿主接线，正式部署需用户确认选型，整体Secret boundary未完成。完整业务Web/Worker链与生产OS/Secret Store ACL仍未闭环；旧CLI env路径已退役，bootstrap使用显式resolver。整体秘密边界未完成，写API关闭；任务快照路由及多模型Studio接入尚待实施 |
| 5：任务与状态恢复 | 5.1–5.4 已完成；**5.5 图片结果归档与 owner 授权读取已落地并在真实隔离 PG 通过**；Studio 已接 `/api/tasks` 并跑通"提交→执行→归档→预览"；5.6 资产软删除、5.7 对象清理（独立 cleanup 角色）、5.8 Studio 删除入口、5.9 删除确认改应用内弹窗（10 个入口全量迁移 + 静态回归门禁）、5.11 孤儿 pending 对象回收（迁移 0023）与 5.12 宿主 TaskCenter 取消任务改用同一弹窗（仓库内已无原生 `confirm()`，门禁扫描范围已扩到宿主）已落地 | 报告 mweebpub_346a46 `passed`（108 passed / 1 skipped MFA / 0 failed），含 Worker 列级归档与 owner 200 / 他人 404 / admin 跨用户 404。新增 `resultFetcher` 处理真实 Adapter 的 URL 结果。未完成：孤儿对象回收与保留政策、真实 Provider 出图、生产多 Provider 路由。任务管理入口/页面暂缓；既有 dev/test 库未应用迁移 |
| 6：账户中心与额度账本 | 6.1 身份 UI 已完成；6.2 产品规则已确认且技术契约设计基线已形成，待评审/剩余参数收口；账本/迁移/计费尚未实现；6.3–6.7 未开始 | 已确认：按模型动态定价（管理员配置具体金额/档位/系数并版本化，任务创建固定报价快照）；最小单位 **0.1 credit**，以整数十分之一 credit 原子单位记账、禁止浮点余额；图片计价模板为「分辨率分档 + 输出数量」、视频为「视频时长 + 帧率」，具体配置由管理员发布；报价规则为定点整数计算、正向费用向上取整至 0.1 credit、非零最低 0.1 credit、异常参数 fail closed；人民币可充值为积分但积分不可兑换/提现为人民币，兑换比例暂定；注册赠送仅影响新用户且默认关闭，管理员可开启/定额并需反滥用；确定未 dispatch 的系统失败全额释放；Provider 已调用后应用侧错误不自动退款，上游明确失败释放冻结额度、成功结算、未知持续冻结直至明确结果/受审计对账。设计基线：append-only ledger + available/reserved 投影、task 级幂等 reserve/settle/release、dispatch intent 后崩溃按未知保守冻结、真实 PG 并发/恢复/重算/最小权限验收。下一步收口管理员计价模板落地细节、价格生效/quote 时效、赠送额度/有效期、风控阈值与未知状态人工 SLA，评审通过后另行授权迁移实现；真实余额/计费须账本与结算验收后 |
| 7：上传与结果归档 | 部分完成：私有文件对象存储 + 结果归档 + owner 受控读取 + 软删除、独立角色对象清理与 Studio 画廊删除入口已实现（清理在真实隔离 PG 验收，UI 侧无组件级自动化测试；删除确认已在 Studio 包内全量换成应用内弹窗并有源码级门禁，宿主 TaskCenter 已在 5.12 迁移，仓库内不再有原生 `confirm()`）；**孤儿 pending 对象已可回收**（迁移 0023 `abandoned_at` + `orphanReclaim` + CLI `--orphan-hours`，真实隔离 PG 通过）；上传通道、生产对象存储与保留政策未做 | 归档与清理只在本地文件存储验证；Studio 交互无 jsdom/testing-library 覆盖；任务删除/账号注销级联无清理；孤儿窗口依赖 `created_at` 老化（无上传租约），引入长时上传前必须补心跳；.local-assets/ 仍可能增长。阶段 7 整体不得标为完成；存储供应商与保留策略须按实际部署另行确认 |
| 8：管理后台与管理员强化认证 | 8.1已完成；4.7.4准入设计及4.7.5数据库身份拆分已完成本地验收 | 最终报告mwcyonlg_45f52d passed（108项，含MFA、无失败/跳过）；下一步Provider Secret boundary。Provider写API仍关闭，owner/migration仍可修改审计，尚无生产部署完成结论 |
| 9：用户产品流程 | 尚未开始 | 阶段 4+5 后复用现有 Studio 接任务 API；收费/余额 UI 依赖阶段 6，持久资产/下载依赖阶段 7；不得另建平行生成入口 |
| 10：工作流 | 尚未开始 | 按阶段依赖推进 |
| 11：内容安全、隐私与可靠性 | 尚未开始 | 实施用户数据导出、删除、自助清理及备份补偿闭环 |
| 12：预发布与发布 | 尚未开始 | 全链路验收后另行明确批准正式发布 |

### 记录与证据归档规则

- 本开发流程文档记录阶段状态、顺序依赖、通用门禁和下一步；阶段状态变更时同步更新本节及速查表。
- `PaintTrack/docs/records/DB_SETUP.md` 记录数据库架构、迁移、角色权限、运行边界及数据库验收细节；不以本文件取代它。
- `.workbuddy/memory/YYYY-MM-DD.md` 记录当天已完成工作、持久决策和重要结论；只追加，不把它作为唯一验收证据。
- 阶段 3.6 的当前清理实现说明和生产执行边界同步记录在 `PaintTrack/docs/records/DB_SETUP.md` 的阶段 3.6 节。
- `.workbuddy/database-acceptance-*.json` 等机器报告保存真实验收结构化结果；阶段结论引用具体报告路径和最终状态。测试日志是辅助证据，不能取代报告或被摘要误写成测试通过。
- 任何历史状态保留时标注日期和“历史记录”；不得用旧的版本、Git 状态、端口或环境限制推断当前情况。

**仍待确认的产品/运维决策：**真实邮件服务及投递架构、部署服务商/地域与资源、生产 RPO/RTO、预算、支付主体、内容与隐私运营责任等。仅在对应阶段真正需要时提出决策，不提前创建资源、不隐式选择供应商。
