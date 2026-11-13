# Local PostgreSQL setup

The application does not run migrations during startup. Install PostgreSQL locally and create separate `painttrack_dev` and `painttrack_test` databases. Use a runtime login and a distinct migration login for each database; the runtime role must not own the schema or have DDL privileges. Never reuse production credentials.

Set `DATABASE_URL` to the development runtime role and `MIGRATION_DATABASE_URL` to the migration role on the same database target. For PostgreSQL integration tests, set `TEST_DATABASE_URL` and `TEST_MIGRATION_DATABASE_URL` to separate runtime and migration roles on a dedicated loopback database whose name contains `test` or `acceptance`. Never point tests at production or a database containing user data. `.env.example` contains local-only placeholders; replace them with credentials configured in your local PostgreSQL instance.

Run `npm run db:migrate` after configuring both development URLs. The migration runner requires the dedicated `MIGRATION_DATABASE_URL`, uses Drizzle's `__drizzle_migrations` journal and an advisory lock, then closes its connection after success or failure. Review migration SQL before applying it. If a migration fails, inspect the PostgreSQL error and migration journal, restore the local database from a backup if needed, then correct the migration in a new version; do not edit an already-applied migration. For a disposable local database, recreate it only after confirming it contains no needed data, then rerun migrations from an empty database.

Run `npm run test:db` only after setting both test URLs. The integration test rejects missing `TEST_MIGRATION_DATABASE_URL` and refuses a test database matching the runtime or migration target; it does not silently substitute runtime credentials. Run `npm test` for database-independent tests. `GET /api/health/database` returns 200 only when `SELECT 1` succeeds; otherwise it returns 503 without exposing connection details.

要运行完整本地隔离验收，在同一个 PowerShell 会话中配置 loopback:5433 的 `LOCAL_DATABASE_ADMIN_URL`，然后执行 `npm run test:db:local`（等价于 `node scripts/accept-database-local.js`）。入口只对既有本地身份做创建权限只读检查；没有合法管理员连接或 CREATEDB/CREATEROLE 权限时，状态为 blocked，不猜测凭据。不要在终端输出连接字符串。

正式管理员初始化使用 `BOOTSTRAP_DATABASE_URL` 指向同一目标数据库上的独立 bootstrap 登录身份；该变量只在执行 `npm run admin:init` 的受控终端中临时提供，不写入 Next.js/Worker 环境。bootstrap 身份必须不是超级用户、不能拥有 DDL、UPDATE/DELETE/TRUNCATE 或继承运行/迁移角色，仅拥有读取 users 和插入 email/password_hash/email_verified_at/role 的权限；成功后应回收或轮换该身份。初始化服务在事务内使用固定 advisory lock，只允许数据库中尚无管理员时插入全新邮箱，直接拒绝已有管理员或已占用邮箱，不通过 HTTP、网页、开发 fixture 或运行角色完成。密码仅在 TTY 中输入，不作为命令行参数、URL、日志或报告输出。

每次运行都会新建唯一空隔离库、迁移角色和最小权限运行角色；先验收迁移、权限、事务和连接池，再把本次随机 runtimeUrl 仅通过子进程环境传给真实 Node/pg Worker。子进程不继承管理员连接、PG*、NODE_OPTIONS 或其他应用配置。Worker 验收包含 3 个并发进程处理 12 个任务且无重复领取、SIGKILL 终止后按 PostgreSQL 时钟等待租约自然过期并重新领取、过期及重领后旧 token 的 heartbeat/complete/fail 均被 fencing 拒绝、有效心跳续租、空闲/协作停止，以及非协作停止非零退出。每轮并发领取从 pg_stat_activity 确认 3 个独立 PostgreSQL 后端均使用本次运行角色且已释放领取事务，并核对任务 worker_id 对应子进程 PID；最终断言全部 15 个验收任务成功。逐项检查数据库状态、停止后恢复和 pg_stat_activity 连接释放；正常完成后通过管理员连接确认本次隔离库无遗留连接/事务。Windows 协作停止通过 IPC 触发进程内 SIGTERM 处理器，强制终止使用 child.kill('SIGKILL')。不调用 Provider 或云服务，不使用 JSON/Map/连接池替身。已有 `workerProcess.test.js` 的文件替身测试仍只是离线证据。

报告保存在 `.workbuddy/database-acceptance-*.json`，只记录安全的检查名称、结果和资源名称，不打印或保存随机角色密码。成功创建的数据库、角色和本次验收任务均保留；不要复用上次报告的库（随机凭据未保存），也不要为重跑修改已有业务库。资源删除须另行明确审查；当前入口不清理数据库资源。只有包含真实 Worker 各项检查、管理员初始化检查且最终为 passed 的新报告才补齐本轮完整证据；旧版 passed 报告不包含阶段3.5检查。

## 阶段 3.6：认证记录保留与清理

阶段 3.6 的首个代码小步新增 `npm run auth:cleanup`。默认 dry-run，仅汇总候选数量；显式 `--apply` 才执行删除，并且当前实现强制目标为本机命名含 `test` 或 `acceptance` 的 loopback 隔离数据库。CLI 使用应用 runtime 身份执行受限表删除，独立 migration 身份只负责迁移；两身份必须不同且连接同一目标。当前隔离验收运行角色有这些认证表的 DML 权限；生产 runtime 权限是否应保留 DELETE 尚需单独最小权限评估，本 CLI 不开放生产目标，因此不得据此给生产 runtime 扩权。当前版本不提供生产清理开关，也没有部署定时器。

工程默认窗口暂按数据治理建议值：email verification/password reset token 在消费或过期后保留 7 天；已撤销或过期 session 保留 30 天。该默认值仅用于代码/隔离测试，不代表已批准的隐私政策、生产承诺或已配置的生命周期任务。每次最多 5,000 行/批、默认最多 10 批/表；事务 advisory lock 防止并发清理，查询使用数据库时钟、部分索引和 `FOR UPDATE SKIP LOCKED`。日志只记录聚合计数和固定 action/outcome，不记录用户标识、token hash 或连接信息。

迁移 `0008_auth_record_cleanup_indexes.sql` 增加到期/消费及到期/撤销部分索引；应用到任何既有数据库前，须按本文件通用迁移规则备份并确认目标。阶段验收必须使用本地隔离入口新建的随机数据库；不得在既有开发库、保留的历史验收库或生产库上运行 `--apply`。在生产执行方案、专用维护身份、调度平台、告警、保留期限和恢复计划明确并获批准前，不部署定时生产清理。

阶段 3.6 当前认证记录清理小步骤真实 PostgreSQL 隔离验收已通过：报告 `.workbuddy/database-acceptance-mw62cu9c_fac144.json`，PostgreSQL 16.15，认证记录清理检查通过，覆盖 dry-run 不删除、按数据库时钟和保留窗口清理过期/已撤销记录、保留有效 token/session、并发互斥和批次上限。该报告创建的随机数据库及 migration/runtime/bootstrap 角色按既有策略保留，未修改 `painttrack_dev`、`painttrack_test` 或历史验收资源。

阶段 3.6 持久 outbox 基础小步骤已完成真实 PostgreSQL 隔离验收：报告 `.workbuddy/database-acceptance-mw637r95_38129e.json`，PostgreSQL 16.15。新增 `email_outbox` 表、幂等键唯一约束、状态/类型/租约一致性约束、投递索引和事务内 enqueue 接口；运行角色权限已覆盖该表，迁移、表结构、列级权限和完整既有数据库验收通过。

阶段 3.6 outbox 投递 worker 小步骤已完成真实 PostgreSQL 隔离验收：报告 `.workbuddy/database-acceptance-mw64i1ah_205c15.json`，PostgreSQL 16.15。worker 使用 `FOR UPDATE SKIP LOCKED` 并发领取，支持过期租约恢复、成功标记、失败重试和最大尝试次数后的 `failed` 状态；验收覆盖并发互斥、租约恢复、重试和错误码脱敏。当前投递语义是至少一次尝试，不能宣称严格一次送达；真实供应商、密钥解密实现、发送耗时心跳、退信/投诉处理和生产调度仍未接入。注册/密码重置流程仍使用显式注入的开发内存 mailer。

Bootstrap 凭据回收/轮换：最终管理员初始化验收报告只证明 bootstrap 角色用于测试并按报告策略保留，不能证明其当前可登录或已禁用。由于没有获授权的当前目标数据库连接，本次只记录为待运维核实，不禁用/删除/改密任何既有角色。后续须在确认目标库、角色用途和恢复办法后，以授权数据库管理员身份验证并执行，再记录不含凭据的角色状态与操作时间。

## 阶段 4 小步骤 1–4：Provider 契约、错误边界与调用账本

阶段 4 小步骤 1 的设计稿见 `PHASE4_STEP1_PROVIDER_CONTRACT.md`。本步骤只完成服务端 Provider Adapter 的契约和供应商边界审查，不修改数据库 schema、迁移、运行角色权限或认证流程，也不调用真实供应商。

契约明确：Provider 只能由服务端 Worker 调用；供应商 request ID 不是客户端任务权威；Provider 不负责 PaintTrack 任务终态、用户授权、额度冻结/结算/释放或长期资产身份；同步/异步、查询、取消、媒体类型、幂等、结果和成本均通过能力声明表达。供应商状态、错误、URL、媒体和成本均按不可信外部输入处理。

设计稿覆盖规范化输入/输出、submit/query/cancel、状态映射、固定错误分类与重试边界、请求/总体/租约三层超时、AbortSignal 取消、未知提交结果、任务/Provider调用/结果归档三层幂等、结果 URL 的 SSRF 限制、密钥与日志脱敏和成本观测边界。随后新增 `lib/server/providers/mockProvider.js` 和 `tests/mockProvider.test.js`：纯内存验证同步/异步状态、查询、取消、错误分类、幂等、未知提交恢复和 AbortSignal，定向测试 5/5 passed。阶段 4 小步骤 3 新增 `lib/server/providers/providerExecution.js` 与 `lib/server/providers/resultBoundary.js`：固定 Provider 错误映射为 `retry`、`fail` 或 `unknown_submission`，并在归档前校验结果 URL、协议、端口、禁止目标、媒体类型、字节来源和大小上限；定向测试 5/5 passed。以上 mock 和边界模块均不接入生产 Worker、不访问真实网络、不读取凭据、不写数据库。真实 Provider、MuAPI 适配器、网络抓取、动态 SSRF 测试和真实密钥接入仍未开始；旧客户端 `muapi_key`/`x-api-key` 路径仍需阶段 4 后续步骤单独迁移或封锁。

阶段 4 小步骤 4 新增 Provider 调用账本。迁移 `0011_provider_calls.sql` 新建 `provider_calls` 表：`task_id` + `attempt_no` 唯一、`idempotency_key` 唯一、状态 CHECK 限定 `submitting`/`unknown`/`accepted`/`succeeded`/`failed`/`cancelled` 六态、租约一致性 CHECK 要求 `worker_id`/`lease_token`/`lease_expires_at` 同时为空或同时存在、`accepted`/`succeeded`/`cancelled` 必须有 `provider_job_id`、错误码 CHECK 限定 `^[A-Z][A-Z0-9_]{0,63}$`，并建立 `(status, available_at)` 恢复索引。表内刻意把「租约」和「下次可领取时间」拆成两组字段：`worker_id`/`lease_token`/`lease_expires_at` 回答「谁现在持有」，`available_at`（`NOT NULL DEFAULT now()`）回答「什么时候可以被领取」；释放租约时租约三列同时置空，重试退避只写 `available_at`。接口位于 `lib/server/providers/providerCallLedger.js`：`beginProviderCall` 只做发起意图登记（`ON CONFLICT (task_id, attempt_no) DO NOTHING`，冲突时回读校验身份，一致则返回 `ATTEMPT_EXISTS`、不一致返回 `ATTEMPT_IDENTITY_MISMATCH`），**不再自己抢租约**；接管与恢复的唯一入口是 `claimProviderCallForRecovery`，覆盖 `submitting`（提交途中崩溃）、`unknown`（结果不明）与 `accepted`（已受理待轮询），条件为「租约 NULL 或已过期」且 `available_at <= now()`，使用 `FOR UPDATE SKIP LOCKED` 单条领取、每次领取累计 `recovery_attempts`，并在 SQL 层排除「`accepted` 但缺 `provider_job_id`」的脏数据；`releaseProviderCallForRecovery` 清空租约并把 `available_at` 推到退避窗口之后。所有状态转换（受理、终态、释放待恢复）都要求持有当前有效 worker 租约，旧租约写入返回 `LEASE_LOST`。该模块同样未接入生产 Worker、未调用真实供应商、未写入凭据。

2026-11-09 一致性修复（不改业务行为）：`drizzle/meta/0011_snapshot.json` 原先缺失 `provider_calls`（`lib/server/db/schema.js` 与 `0011_provider_calls.sql` 已包含该表），已按 schema 重新生成快照，重新生成的差异语句与现有 SQL 语义等价（仅 `CREATE TABLE/INDEX IF NOT EXISTS` 写法差异）。同时修正 `tests/databaseLifecycle.test.js`：快照文件名改为按 journal 条目的 tag 前缀定位——历史迁移 `0009` 归档后 journal 下标与 tag 编号不再相等（idx 10 对应 `0011_provider_calls`），原先用 `padStart(4, '0')` 推断会读到 `0010_snapshot.json`；迁移清单校验由硬编码条数改为「journal 与 migrations 目录中的 SQL 一一对应」。当前基线：`npm test` 209 项 / 207 通过 / 0 失败 / 2 跳过，`npm run lint` 0 error / 11 warning，`npx drizzle-kit check` 输出 `Everything's fine`。

2026-11-09 阶段 4 小步骤 4 真实隔离验收：报告 `.workbuddy/database-acceptance-mw8lvo2w_ce1677.json`，`status: passed`，70 项检查中 66 项 passed、0 项 failed（其余为过程记录项），其中「全部迁移表列/主键/CHECK/索引与最新snapshot」与「provider_calls 持久化未知提交、稳定幂等键、恢复互斥、退避窗口、accepted轮询恢复及租约fencing通过」均 passed。前三次失败暴露的三个真问题已分别修掉，记录在此避免复发：① `scripts/accept-database-local.js` 的全量 DML 表断言写死 7 张表，新增 `provider_calls` 后应为 8 张，已改为按表清单推导；② `releaseProviderCallForRecovery` 原先把重试退避写进 `lease_expires_at` 而清空 `worker_id`/`lease_token`，直接违反 `provider_calls_lease_consistency_check`（`23514`），故拆出 `available_at` 列；③ 账本夹具在共享隔离库插入的 `generation_tasks` 未清理，污染后续「Worker 验收起始空表」断言，已改为 `try/finally` 自清理。另修正两处「测试替实现作弊」：`accepted` 调用的自然状态是 NULL 租约，`lease_expires_at <= now()` 对 NULL 恒为 NULL，原先靠手工改租约时间才能领取，现已改为直接走 `claimProviderCallForRecovery`；同理删除了手工只改 `lease_expires_at` 的写法。该迁移尚未应用到 `painttrack_dev`/`painttrack_test`（两张库 `to_regclass('public.provider_calls')` 均为 NULL），0011 因此可就地修订而不产生 0012 补丁。

## 阶段 4.5.1–4.5.2：客户端凭据边界与服务端 Provider 配置（2026-11-09）

背景：本仓库继承的上游 UI 采用 BYO-key 模式，`src/lib/muapi.js` 在生产构建里硬编码 `https://api.muapi.ai` 并用浏览器 `localStorage`/非 HttpOnly cookie 里的 key 直连，`src/lib/i18n.js` 甚至向用户承诺「密钥只发往 api.muapi.ai」。这与 Provider 契约（只允许服务端 Worker 调用）直接冲突，且使 `provider_calls` 账本、幂等键与成本观测可被旁路。用户已选择「撤除直连、未配置即明确不可用」（方案 A）。

4.5.1 客户端凭据边界棘轮：`tests/clientCredentialBoundary.test.js` 扫描 `app/`、`components/`、`src/` 下的 `.js/.jsx/.ts/.tsx/.mjs/.cjs`（跳过 `node_modules`、`.next`、`dist`、`build`、`out`、`coverage`），对 `muapi_key`、`x-api-key`、`api.muapi.ai` 三类模式做四项断言：① 允许清单外出现任意命中即失败；② 允许清单条目过期（文件已删或模式已清理）也失败，强制「只许减少」；③ 扫描文件数低于 60 或任一扫描根目录零产出即失败，防止目录改名造成空扫描假绿；④ 允许清单条目必须带可审查原因且模式必须属于受管集合。基线写入 `tests/fixtures/client-credential-allowlist.json`，当前 16 个文件（73 个被扫描源文件）。已做负向验证：临时插入含 `muapi_key`/`x-api-key`/`api.muapi.ai` 的探针文件后测试确实变为 `not ok`，探针已删除。

**旧环境凭据入口已退役（2026-11-12）**：以下 4.5.2 段落是历史实现记录，不再是启动指引。不要通过 `.env` 或进程环境中的 `PAINTTRACK_PROVIDER_NAME` / `PAINTTRACK_PROVIDER_CREDENTIAL` 启动真实 Provider。`loadProviderConfig()` 固定返回 `ok: false`、`status: not_configured`、`reason: PROVIDER_ENV_CREDENTIAL_RETIRED`，`requireProviderConfig()` 固定抛出同码错误，均不读取环境；同步 `resolveWorkerProvider()` 的 `myvigna-image` 分支同码拒绝，旧非秘密环境常量仅保留兼容导出。直接 Worker CLI 只允许非 production 显式 mock，任何非 mock 都返回 `WORKER_TRUSTED_BOOTSTRAP_REQUIRED`。真实 Provider 需可信宿主显式调用 `bootstrapWorker({ descriptor, approvedBindings, secretResolver, ...workerOptions })`，先完成绑定与秘密解析再启动 Worker；当前尚无生产宿主或正式秘密后端接线，不能视为生产启动方案或 Secret boundary 整体完成。

4.5.2 历史服务端 Provider 配置边界：新增 `lib/server/providers/providerConfig.js`，当时只从进程环境读取 `PAINTTRACK_PROVIDER_NAME` 与 `PAINTTRACK_PROVIDER_CREDENTIAL`，四种状态 `configured`/`not_configured`/`incomplete`/`invalid` 与固定原因码 `PROVIDER_NOT_CONFIGURED`/`PROVIDER_CONFIG_INCOMPLETE`/`PROVIDER_CONFIG_INVALID`。规则：名称必须匹配 `^[a-z][a-z0-9-]{2,31}$`；凭据禁止任何空白字符（含尾部换行）、长度 16–512；常见占位值（`changeme` 等）按无效处理；凭据以不可枚举属性存放，`JSON.stringify`、`String()`、`describe()`、`toJSON()` 与错误信息一律不含明文，`describe()` 只输出 `[credential len=N]`；配置对象冻结；`requireProviderConfig()` 对不可用状态抛出带原因码的 `ProviderConfigError`。`.env.example` 已补充两组注释变量并注明「不配即 fail-closed、禁止 `NEXT_PUBLIC_*`、禁止从 cookie/localStorage 读取」。定向测试 5/5。

**当前边界（不要误读）**：4.5.1 与 4.5.2 只建立了「基线冻结 + 服务端读取入口」，**4.5.3 才真正撤除浏览器凭据来源**（见下节）。

## 阶段 4.5.3：撤除浏览器直连与凭据来源（2026-11-09）

目标：让「浏览器不持有供应商凭据、也不直连供应商域名」成为代码事实，而不是配置约定。未配置服务端 Provider 时，生成入口明确不可用，不再提供「粘贴密钥即可用」的逃生通道。

撤除内容（按凭据生命周期，而不是按文件）：

- **凭据收集入口**：删除 `components/ApiKeyModal.js`（StandaloneShell 唯一的密钥输入弹窗）。`src/components/AuthModal.js` 改为纯提示弹窗（无输入框、不写存储），`src/components/SettingsModal.js` 的 API 面板改为只读的「服务端 Provider」状态展示。
- **凭据存储与转发**：`components/StandaloneShell.js` 移除 `STORAGE_KEY`、localStorage 读取、`document.cookie` 写入、axios 请求拦截器（原先把浏览器密钥注入所有内部代理请求）、30 秒余额轮询与余额查询；挂载时显式 `setApiKey(null)`，防止历史值经 state 回流。
- **客户端 SDK**：`src/lib/muapi.js` 由 520 行直连实现改为 fail-closed 桩（保留方法签名、`getDimensionsFromAR` 纯计算保留，其余一律抛 `ProviderUnavailableError`）。共享 SDK `packages/studio/src/muapi.js` 移除全部 34 处密钥请求头注入（含 `fetch`、`XMLHttpRequest`、`Headers.set`）并把 `BASE_URL` 固定为同源 `/api`，删除跨域 fallback；`packages/studio/src/utils/generationLifecycle.js` 轮询不再附带密钥头。
- **旧版 shell 生成入口**：`src/components/{Image,Video,Cinema,LipSync}Studio.js` 与 `UploadPicker.js` 不再读取本地密钥，改为调用 `isClientProviderConfigured()`（恒 false）并提示不可用；远程任务恢复轮询直接退出，待处理任务保留在本地存储。
- **Agent 页面**：`app/agents/{[agent_id],create,edit/[id]}/*Client.js` 移除 `STORAGE_KEY`、cookie 读取与 `x-api-key` 注入（此前服务端路由并不读取该头，属惰性注入）。
- **误导性文案**：`src/lib/i18n.js` 删除「密钥仅存储在本地，除 api.muapi.ai 外不会发送」这类与原实现不符、撤除后更不成立的承诺，改为「凭据由服务端配置，浏览器不保存任何密钥」。`McpCliStudio`（`src` 与 `packages/studio/src` 两处）移除带 `Bearer YOUR_KEY` 的直连示例。
- **上传代理**：`src/lib/uploadProxyTarget.js` 删除 `getApiKeyFromRequest`（从入站请求头解析供应商凭据的helper，全仓无调用方）。

新增文件：`src/lib/providerAvailability.js`（唯一 fail-closed 出口：`isClientProviderConfigured()`、`ProviderUnavailableError`、`getProviderUnavailableMessage()`、`notifyProviderUnavailable()`，不读存储、不发请求）。**历史 UI 注记：**当时曾新增 `components/ProviderNotConfigured.js` 作为未配置整页；该占位 UI 已于 2026-11-09 按产品要求移除，当前 Studio 工作区保留，仅生成调用 fail-closed。

门禁收紧：`tests/clientCredentialBoundary.test.js` 的扫描根目录新增 `packages/studio/src`（4.5.1 遗漏了这个 `/studio` 页面真正使用的共享 SDK，属真实盲区）；受管模式新增 `__MUAPI_KEY__`；允许清单 `tests/fixtures/client-credential-allowlist.json` 的 `entries` 已清空，语义从「棘轮」变为**零容忍**；新增两条断言：第一方客户端代码必须零命中、`packages/studio/src/muapi.js` 的 `BASE_URL` 必须为同源 `'/api'` 且不得含外部 http(s) 地址；「服务端凭据模块不得被客户端引用」由裸字符串匹配改为只匹配 `import`/`require`/动态 import 说明符（注释里提到路径不会把服务端模块打进 bundle）。

验证：`npm test` **222 项 / 220 通过 / 0 失败 / 2 跳过**（门禁 7/7，含新增两条）；`npm run lint` **0 error / 11 warning**（与既有基线一致）；上述 20 个改动文件用 `@babel/parser` 逐个解析通过。未调用真实供应商、未写入真实凭据、未创建云资源、未改数据库 schema 与迁移。

**当前边界（不要误读）**：`/studio`、`/workflow` 在未配置服务端 Provider 时**不可用**，这是方案 A 的既定代价。`packages/studio/src/muapi.js` 仍保留大量业务函数（余额、工作流、Agent API）的调用骨架，它们现在只指向同源 `/api`，而 `app/api/{api/v1,v1,app,agents,workflow}/**` 早已是 `cloud.blocked` 的 fail-closed 路由，因此这些调用一律被服务端拒绝；真正的恢复必须由阶段 4.6 的服务端 MuAPI 适配器 + 任务接口提供，不能靠恢复客户端凭据。


## 阶段 5.1：任务状态机与 cancelled 终态迁移（2026-11-09）

设计稿见 `PHASE5_STEP1_TASK_STATE_MACHINE.md`。本步骤只定义任务状态与合法转换，不实现任务创建/查询/取消 API，不接 Provider，不接额度。

`generation_tasks.status` 语义收敛为 `queued`（等待领取，含失败后退避重排）、`running`（持有租约执行中）、`succeeded`、`failed`、`cancelled`（后三者终态）。终态不可再变：重复写同一终态按 `noop` 幂等处理，写另一个终态返回 `conflict` 并保留原终态（典型为取消后供应商结果迟到）；`queued → succeeded`、`queued → failed` 等跳过执行的组合一律 `ILLEGAL_TRANSITION`。未引入 `cancelling`：取消意图与任务状态分离，执行中取消必须由持有租约的执行方协作停止后才写 `cancelled`，避免出现没有执行方推进的伪状态。

失败去留与现有 `failTask` 语义保持一致：领取时 `attempts` 自增，`attempts < max_attempts` 回 `queued`，否则写 `failed`；`attempts > max_attempts` 视为数据损坏直接报错。租约过期只对 `running` 有意义，`running` 缺租约视为 `LEASE_INCONSISTENT`。

迁移 `0012_task_cancellation.sql` 替换 `generation_tasks_status_check`，把 `cancelled` 纳入允许值；`drizzle/meta/0012_snapshot.json` 与 journal 同步。该迁移只改约束，不改列、不迁移数据。`taskQueue.js` 改为复用 `taskStateMachine.js` 的 `TASK_STATUS`，消除两处枚举漂移。

验收：定向测试 `tests/taskStateMachine.test.js` 9/9；全量 `npm test` 231 项 / 229 通过 / 0 失败 / 2 跳过；lint 0 error / 11 warning；`drizzle-kit check` 通过。真实 PostgreSQL 隔离验收报告 `.workbuddy/database-acceptance-mw8nywgz_579cad.json`（`passed`，71 项检查 / 67 passed / 0 failed），新增两项针对性检查——「generation_tasks 接受 cancelled 终态写入」（SAVEPOINT 内正向探测后回滚，不把 `cancelled → queued` 这种非法转换留在夹具里）与 `cancelling` 仍被约束拒绝（CHECK 负例由 11 项增至 12 项）。「全部迁移表列/主键/CHECK/索引与最新 snapshot」同时通过，证明约束名与定义均与快照一致。

边界：本步骤未验证 `cancelled` 的写入路径由哪个 API 触发（属 5.4），也未验证供应商不支持取消时的成本后果（属阶段 6 结算与 5.4 共同处理）。迁移尚未应用到 `painttrack_dev`/`painttrack_test`。


## 阶段 5.2：任务创建 API 的归属与幂等（2026-11-09）

设计与错误码见 `PHASE5_STEP2_TASK_CREATION_API.md`。本步骤只实现 `POST /api/tasks`：已认证用户创建任务、任务归属只来自会话、`Idempotency-Key` 必填，不调用 Provider、不扣额度、不创建云资源。

**数据模型**：迁移 `0013_generation_task_ownership.sql` 为 `generation_tasks` 增加 `owner_id uuid NOT NULL`、`idempotency_key text NOT NULL`、`request_fingerprint text NOT NULL`，建立唯一索引 `(owner_id, idempotency_key)` 与查询索引 `(owner_id, created_at)`，并新增幂等键格式、指纹格式两条 CHECK。迁移要求 `generation_tasks` 为空：旧任务没有可归属用户，宁可明确失败，也不伪造归属或删除历史数据。三列在 `schema.js` 中定义于表末尾，与增量迁移的物理列顺序一致。

**幂等语义**：请求指纹为 `sha256(stableStringify({taskType,payload}))`，对象键排序后再计算。同 owner、同键、同指纹返回原任务（`200`，`Idempotency-Replayed: true`）；同键不同指纹返回 `409 IDEMPOTENCY_KEY_REUSED`，不覆盖旧任务；不同 owner 可使用相同键。并发同键提交由唯一索引决胜，`INSERT ... ON CONFLICT DO NOTHING` 后在同一事务内读回原行。

**输入边界**：请求体 ≤ 64 KiB、JSON 严格解码；payload 为非空对象、≤ 32 KiB、最大深度 8、最多 1000 节点、字符串 ≤ 4096，任意层级禁用 `__proto__`/`constructor`/`prototype`；任务类型仅 `image.generate`、`video.generate`；客户端不能设置 `owner_id`、状态、尝试次数、租约或 Provider 字段。`max_attempts` 固定为 3。

**权限**：Web 运行角色新增 `SELECT, INSERT ON generation_tasks`，仅用于创建与幂等读回；任务领取、状态更新和删除仍只授予 Worker 角色（`grantRuntimePermissions(..., { worker: true })`）。

**验收**：全量 `npm test` 248 项 / 246 通过 / 0 失败 / 2 跳过（新增 `tests/taskSubmission.test.js`、`tests/taskApi.test.js`）；`npm run lint` 0 error / 11 warning；`drizzle-kit check` 通过。真实 PostgreSQL 隔离验收报告 `.workbuddy/database-acceptance-mw8of0uy_52b6b8.json`（`passed`，72 项检查 / 68 passed / 0 failed），含 0013 迁移、列/索引/CHECK 与快照比对、「同一 owner 并发同键提交收敛为一个任务且不同 owner 互不影响」及原有 Worker/权限回归。

**边界**：本步骤未提供任务查询/详情/取消接口（5.4），未实现 Worker 执行与 mock Provider 调用（5.3），未引入速率限制、并发任务上限或额度规则（需产品与计费确认），也未接真实 Provider。迁移尚未应用到 `painttrack_dev`/`painttrack_test`。

## 阶段 5.3：Worker 执行、心跳、重试与崩溃恢复（2026-11-09）

设计与状态映射见 `PHASE5_STEP3_WORKER_EXECUTION.md`。本步骤只接 mock Provider：不调用真实供应商、不写真实凭据、不创建云资源、不扣额度。

**执行器**：新增 `lib/server/worker/taskExecutor.js`。领取后用 `taskId` 找回未终结的 `provider_calls` 记录：能接管就继续该提交轮次（`submitting`/`unknown` 重提，`accepted` 轮询），不能接管但记录仍在途则退避重试，只有完全没有在途记录时才按 `attempt_no = attempts` 新建提交。

**任务状态权威**：任务侧 `attempts` 是领取次数，调用侧 `attempt_no` 是供应商提交轮次。恢复复用同一轮次，因此两者可以不等；这是为了避免同一次提交被重复发起。

**成功原子性**：调用记录 `succeeded` 与任务 `succeeded + result` 在同一事务内提交，任一步失败整体回滚。同步完成的提交先补登 `provider_job_id`（accepted）再结算；没有任务号的"完成"按 `RESULT_INVALID` 拒绝。

**失败语义**：`taskQueue.failTask` 新增 `terminal` 选项——供应商拒绝类错误即使还有重试次数也直接 `failed` 并写 `completed_at`，不再空转重试预算。查询类可重试失败与轮询超限只释放调用租约并退避，调用记录保留 `accepted` 与 `provider_job_id`。

**结果描述符**：迁移 `0014_generation_task_result.sql` 为 `generation_tasks` 增加 `result jsonb`，并新增两条 CHECK：`(status='succeeded') = (result IS NOT NULL)` 与 `result IS NULL OR jsonb_typeof(result)='object'`。结果只保存 `kind`/`mediaType`/`sizeBytes`/`resultUrl`/`archive`/`provider` 摘要，**不含生成内容**；`archive` 恒为 `not_configured`，表示文件尚未归档。该迁移要求已存在的 `succeeded` 行都必须有结果，当前开发库为空表，可直接应用。

**Provider 选择**：`PAINTTRACK_WORKER_PROVIDER` 未设置时 Worker 拒绝启动（`PROVIDER_NOT_CONFIGURED`），任务留在队列；`mock` 在 `NODE_ENV=production` 下同样拒绝启动。宁可不起进程，也不先领取再把用户任务烧成失败。

**验收**：全量 `npm test` 267 项 / 265 通过 / 0 失败 / 2 跳过（新增 `tests/taskExecutor.test.js` 9 项、`tests/providerRegistry.test.js` 5 项、`tests/worker.test.js` 3 项）；`npm run lint` 0 error / 11 warning；`drizzle-kit check` 通过。真实 PostgreSQL 隔离验收报告 `.workbuddy/database-acceptance-mw8oy85s_2ec1e9.json`（`passed`，79 项检查 / 75 passed / 0 failed），新增 6 个执行器场景（同步成功、异步受理、未知提交恢复、可重试失败、终态失败、租约丢失回滚）与 `result` 约束正负例（CHECK 负例 14 → 15 项）。

**边界**：任务查询/详情/取消接口属 5.4；真实 Provider、结果下载与对象存储归档、SSRF 动态验证、成本对账仍未实现，`archive` 不得被读成"已落盘"。迁移尚未应用到 `painttrack_dev`/`painttrack_test`。

## 阶段 5.4：任务列表、详情与取消（2026-11-09）

设计与状态映射见 `PHASE5_STEP4_TASK_QUERY_CANCEL.md`。

**接口**：`GET /api/tasks`（keyset 分页，`limit` 默认 20/上限 50，排序 `created_at DESC, id DESC`）、`GET /api/tasks/:taskId`、`POST /api/tasks/:taskId/cancel`。列表与详情都只按会话中的 `owner_id` 过滤；不存在、非法 UUID、他人任务统一 `404 TASK_NOT_FOUND`，不能用错误差异枚举他人任务。

**取消语义**：`queued` 直接写 `cancelled`（并记录 `cancel_requested_at`/`completed_at`）；`running` 只登记 `cancel_requested_at`（202），由持有租约的 Worker 在提交前与每次轮询前观察后写 `cancelled`。`succeeded`/`failed` 返回 `409 TASK_NOT_CANCELLABLE`；重复取消返回 200 且不覆盖首次取消时间。

**竞态**：成功结算在事务内先 `SELECT ... FOR UPDATE` 锁任务行。取消先提交则任务写 `cancelled`、`result` 保持 NULL，调用记录仍记 `succeeded`（供应商成本已发生，留给阶段 6 对账）；成功先提交则取消 API 返回 409。没有这层锁会存在「用户已取消却被写成成功」的时间窗。

**迁移**：`0015_task_cancel_request.sql` 增加 `cancel_requested_at timestamptz` 与 `generation_tasks_cancel_request_check`（非空时状态必须是 `queued`/`running`/`cancelled`）。允许 `queued` 是为了避免「可重试失败回队列」与「取消请求」并发时触发约束错误。租约过期恢复改为取消优先：`cancel_requested_at` 非空 → `cancelled`，否则维持原有重试/失败规则。

**权限**：Web 运行角色只增加列级 `UPDATE(status, cancel_requested_at, completed_at, updated_at)`；租约、`worker_id`、`attempts`、`result` 不可写，执行状态仍只由 Worker 推进。

**验收**：全量 `npm test` 296 项 / 294 通过 / 0 失败 / 2 跳过；lint 0 error / 11 warning；`drizzle-kit check` 通过。真实 PostgreSQL 隔离验收 `.workbuddy/database-acceptance-mw8pnd8v_58228d.json`（`passed`，88 项 / 84 passed / 0 failed，4 项过程标记），新增 9 项检查：queued 立即取消、重复取消幂等、owner 隔离、running 仅登记意图、协作取消租约 fencing、过期恢复按取消终结、终态拒绝与 CHECK 负例、执行器提交前尊重取消、Web 角色列级权限正负例（写 `worker_id` 返回 `42501`，`SELECT ... FOR UPDATE` 可用）。

**边界**：前端轮询/任务页面、真实 Provider 取消协议、结果归档与额度扣减未实现；迁移 `0015` 尚未应用到 `painttrack_dev`/`painttrack_test`。



## 阶段 5.5：图片结果归档与 owner 授权读取（2026-11-13）

设计与边界说明见 `PHASE4_4.3.1_RESULT_FETCH_SSRF.md`（结果抓取侧）与下文。本步骤把"任务成功"从"只有结果描述符"推进到"私有对象已落盘、owner 可受控读取"，但仍不是阶段 7 的对象存储生产化。

**归档流程（`lib/server/assetArchive.js`）**：Worker 在自身结算事务内执行三段，顺序不可交换——①按最小列集 `INSERT INTO assets (owner_id, media_type, mime_type, size_bytes, metadata, status) VALUES (..., 'pending') RETURNING id`，UUID 走数据库默认；②把二进制写入私有对象存储；③`UPDATE assets SET status='ready', storage_key=$1, checksum_sha256=$2, updated_at=now() WHERE id=$3 AND owner_id=$4 AND status='pending'`。

**权限（`lib/server/db/runtimePermissions.js`）**：Worker 只获得列级授权——`INSERT(owner_id, media_type, mime_type, size_bytes, metadata, status)`、`SELECT(id, owner_id, status)`、`UPDATE(status, storage_key, thumbnail_storage_key, checksum_sha256, updated_at, deleted_at)`；**没有 `assets` 的表级 `INSERT`/`SELECT`/`UPDATE`/`DELETE`**。Web 资产读仍只有表级 `SELECT`，无写入。此拆分是"Worker 能归档、Web 不能伪造资产"的数据库层保证，不是应用层约定。

**对象存储（`lib/server/storage/fileObjectStore.js`）**：要求 `PAINTTRACK_ASSET_STORAGE_ROOT` 为绝对路径；对象键做路径穿越校验；先写临时文件再原子 rename；单对象有大小上限；只接受私有 ACL。另保留测试用 `MemoryObjectStore`。**Web 与 Worker 必须指向同一存储根**，否则归档成功但内容读取 404；本地启动器已默认准备 `.local-assets/` 并同时注入两侧。

**授权读取（`GET /api/assets/:id/content`）**：`requireOwnedAssetContent` 依次校验合法 UUID、`user`/`admin` 身份、`owner_id` 匹配、未删除、`status='ready'`、存在 `storage_key`，任一失败统一 `NOT_FOUND`（不区分"不存在"与"不是你的"）。管理员**不能**跨 owner 读取。响应带 `Content-Type`、`Content-Length`、`X-Content-Type-Options: nosniff`、`Cache-Control: private, no-store`，**不返回 storage key**。未配置私有存储时返回受控 `ASSET_STORAGE_UNAVAILABLE` 503。

**补偿删除**：对象写入无法与数据库事务原子提交，因此结算事务回滚时由 `assetArchive.discard({ storageKey })` 删除已写对象，避免孤儿文件。归档内部失败时先删已写对象再上抛。

**结果描述符**：归档成功后任务 `result` 的 `resultUrl` 一律改写为 `/api/assets/:id/content`，不再保留外部供应商地址或存储键；`archive` 字段此时为 `ready`（未配置存储时仍为 `not_configured`，不得读成"已落盘"）。

**验收**：真实隔离 PostgreSQL 报告 `.workbuddy/database-acceptance-mweebpub_346a46.json`（`passed`，113 条记录 108 passed / 1 skipped / 4 running 开始事件 / 0 failed），含两项本步骤新增检查——「Worker 列级授权归档二进制结果并提交任务可预览描述符」「真实 assets 本人 200 / 第二用户 404 / admin 跨用户 404 / 不存在 404 / 响应无存储键 metadata」。离线回归：`tests/assetArchive.test.js`、`tests/authorization.test.js`、`tests/taskExecutor.test.js`、`tests/studioTaskClient.test.js` 等定向 49/49；整仓 489 项 487 passed / 0 failed / 2 skipped。

**边界**：本步骤只完成"归档 + 授权读取"；用户主动删除在阶段 5.6 才出现，且同样只做软删除。任务删除/失败/过期不触发任何清理，`.local-assets/` 在用户不主动删除时只增不减；未接入生产对象存储（S3/OSS 等）；缩略图列存在但未使用；上传通道未实现。阶段 7 整体仍为「部分完成」，不得据此宣告对象存储生产化或长期保存承诺。

## 阶段 5.6：用户发起的资产软删除（2026-11-13）

本步骤把已归档资产从"只能读"推进到"所有者可以主动标记删除"。范围刻意收窄：只做**软删除与授权**，不做物理对象清理，也不引入任务删除 API。物理删除无法与数据库事务原子提交，塞进请求路径会制造两种悬空状态（对象已删/记录还在，或记录已删/对象还在），必须由独立、可重试、可观测的清理流程承担，见本节末尾的未完成项。

**接口**：`DELETE /api/assets/:id`，由 `createAuthorizationHandler('asset.delete')` 承担。同源策略要求 `Origin` 精确匹配 `APP_BASE_URL`；方法固定 `DELETE`，`GET` 及其它动词一律 `405`，避免预取或链接预览误触发删除。

**状态转换**：仅 `ready → deleted`，实现为单条条件更新而非"先查后改"：

```sql
UPDATE assets
SET status='deleted', deleted_at=now(), updated_at=now()
WHERE id=$1 AND owner_id=$2 AND status='ready' AND deleted_at IS NULL
RETURNING id, status, deleted_at
```

- `owner_id` 在 `WHERE` 里，归属判断与写入是同一条语句，不存在检查与使用分离的窗口。
- 并发重复删除时，后到的语句在行锁释放后重新求值 `WHERE`，命中 0 行，因此不会双写。
- 命中 0 行才探测一次：不属于自己（含不存在）→ `404`；已删除 → 幂等 `200`（`alreadyDeleted: true`）；`pending/uploading/failed` → `409 ASSET_NOT_DELETABLE`。重复 `DELETE` 返回成功而非冲突，符合 HTTP 删除的幂等语义。
- 删除保留 `storage_key`、`size_bytes`、`mime_type`：约束要求 `deleted` 状态仍持有存储键，且后续清理流程需要它定位对象。

**授权语义**：路径不因角色放宽。管理员删除他人资产同样返回 `404`，与"不存在"不可区分；非规范 UUID 在触库前拒绝。

**数据库权限**：Web 运行角色新增且仅新增列级写权限 `GRANT UPDATE(status,updated_at,deleted_at) ON assets`。表级 `UPDATE/DELETE` 仍为 `false`；`mime_type`、`size_bytes`、`storage_key`、`checksum_sha256`、`owner_id` 的写入仍返回 `42501`，删除失败不会回落到表级权限。验收脚本对这三列做精确比对，防止将来误扩大授权。

**读取即时失效**：`requireOwnedAsset` 与 `requireOwnedAssetContent` 都带 `deleted_at IS NULL`，软删除提交后元数据读取与内容读取立刻 `404`，不依赖缓存过期。

**未完成项（不得读成已完成）**：
1. 物理对象未删除：`deleted` 记录与存储中的文件同时存在，磁盘继续增长。
2. 没有清理 worker、没有重试队列、没有孤儿对象扫描（例如归档中途崩溃留下的 `pending` 行及其对象）。
3. 没有保留期限或自动过期策略，也没有任务删除、账号注销、配额相关的级联清理。
4. `lib/server/assetService.js` 的 `transitionAsset` 同样允许 `ready → deleted`，但生产请求路径不经过它；两处状态机需在后续收口时合并，避免语义漂移。
5. Studio 界面尚未提供删除入口，本步骤只交付服务端契约。

## 阶段 5.7：资产对象清理与独立清理角色（2026-11-13）

5.6 的软删除只把资产标记成 `deleted`，对象仍留在存储里。本节补上真正删除二进制的那一半：**可重试、可观测、权限独立**的清理流程。

**为什么需要新列**：数据库约束要求 `deleted` 状态必须持有 `storage_key`（`assets_status_storage_consistency_check`），所以不能用"清空键"表示已清理。迁移 `0022_asset_purge` 新增三列表达进度：

| 列 | 含义 |
|---|---|
| `purged_at` | 对象已删除的时间；为空表示可能仍在 |
| `purge_attempts` | 已认领次数，防止无限重试，并让长期失败的记录浮出水面 |
| `last_purge_error` | 最后一次失败的阶段与错误码，例如 `delete:EACCES` |

配套约束：`purge_attempts >= 0`；`purged_at IS NULL OR (status='deleted' AND purged_at >= deleted_at)`——已清理的资产不能被直接改回 `ready`（复活必须显式清空 `purged_at`）。部分索引 `assets_purge_pending_idx ON (deleted_at) WHERE status='deleted' AND purged_at IS NULL` 让认领只扫描待处理行。

**认领与标记分离**（`lib/server/assetPurge.js`）：

```sql
WITH claimed AS (
    SELECT id, owner_id, storage_key, thumbnail_storage_key
      FROM assets
     WHERE status='deleted' AND purged_at IS NULL
       AND deleted_at <= $1          -- 保留期截止
       AND purge_attempts < $2       -- 尝试次数上限
     ORDER BY deleted_at LIMIT $3
     FOR UPDATE SKIP LOCKED
)
UPDATE assets a SET purge_attempts = a.purge_attempts + 1, updated_at = now()
  FROM claimed WHERE a.id = claimed.id
RETURNING a.id, a.owner_id, a.storage_key, a.thumbnail_storage_key, a.purge_attempts
```

- **认领即计数**：计数在删除之前自增，进程中途崩溃也不会无限重试；超过上限的行不再被认领，计入 `exhausted` 交给运维处理。
- **删除对象在事务外**：不在持有行锁时等存储 IO。删除本身幂等（对象不存在视为成功），因此"删了对象但没来得及标记"可安全重跑。
- **失败只存错误码**：本地存储的错误消息含绝对路径，`last_purge_error` 只写 `阶段:码`，不落 message。
- **owner 前缀校验**：键必须落在 `users/<owner_id>/{assets,thumbnails}/` 下，否则拒绝删除并记 `verify:key_owner_mismatch`。数据库行被写坏时，也不能借清理删掉别人的对象。
- **已知取舍**：认领提交后到删除完成之间没有租约，理论上两个清理进程可能重复删除同一对象；因删除幂等、代价有界（最多多一次 unlink/DELETE），暂不引入租约列。

**权限边界**（`grantCleanupRuntimePermissions`）：新增独立 `cleanup` 角色，与 Web/Worker 分离。

| 能力 | cleanup 角色 |
|---|---|
| `SELECT (id,owner_id,status,storage_key,thumbnail_storage_key,deleted_at,purged_at,purge_attempts)` | 允许 |
| `UPDATE (purged_at,purge_attempts,last_purge_error,updated_at)` | 允许 |
| 表级 `SELECT/INSERT/UPDATE/DELETE` on `assets` | 全为 false |
| 读 `users` / `generation_tasks` | `42501` |
| 改 `status` / `storage_key` / `mime_type` | `42501` |

角色名白名单同步扩展为 `pt_local_cleanup_<12位十六进制>` / `pt_cleanup_<slug>_<6位十六进制>`。

**入口**：

- CLI：`scripts/asset-cleanup.js`，读 `PAINTTRACK_CLEANUP_DATABASE_URL` 与 `PAINTTRACK_ASSET_STORAGE_ROOT`；支持 `--dry-run`、`--retention-hours`、`--batch-size`、`--max-attempts`、`--interval`。退出码 `0` 无失败 / `1` 有失败条目 / `2` 配置错误；输出 JSON 事件，不含连接串与存储键。
- 本地常驻：`PAINTTRACK_LOCAL_ASSET_CLEANUP=1 node scripts/local-registration.js` 会以 cleanup 角色拉起子进程（默认保留期 0 小时、间隔 60 秒），日志出现 `LOCAL_ASSET_CLEANUP_ENABLED`。默认关闭，避免在用户没预期时删掉本地对象。

**缩略图的键布局约束**：文件存储适配器无法把对象嵌在另一个对象键之下（主对象本身是文件，`mkdir` 会 `EEXIST`）。缩略图必须与主对象**同级并列**，例如 `users/<owner>/thumbnails/<assetId>`，不能写成 `users/<owner>/assets/<assetId>/thumb`。`assetPurge` 的键族白名单已按此设计。

**验收证据**：`.workbuddy/database-acceptance-mwekxqi6_bdac7f.json` = **passed**（121 项检查：116 passed / 1 skipped（MFA 需显式开关）/ 4 条 running 开始事件 / 0 failed）。新增专项：

- `cleanup独立角色仅可读定位键、写清理进度四列；不能改status/storage_key或读用户与任务`
- `真实PG cleanup角色无表级权限，越权读写返回42501`
- `真实PG清理：对象被删除/标记完成/重跑幂等/已清理不可复活`
- `非空0020→0022约束与清理列迁移仅追加两条记录并保留历史快照字段`

**仍未完成（不得读成已完成）**：
1. 孤儿对象扫描：归档中途崩溃留下的 `pending` 行及其对象不会被清理（这些行 `status<>'deleted'`，不在认领范围）。
2. 保留期限只是参数，没有产品决策：生产该保留多久、是否需要"回收站/撤销"未定。
3. 生产对象存储（S3/OSS）未接入；清理只对本地文件存储验证过，远端存储需要适配 `deleteObject` 与批量/限流。
4. 任务删除、账号注销、配额相关的级联清理未做。
5. 缩略图仍未生成，`thumbnail_storage_key` 目前恒为空，相关分支只被单测覆盖。
6. Studio 无删除入口，清理只能在服务端/运维侧触发（**已由 5.8 补上，见下节**）。

## 阶段 5.8：Studio 资产删除入口（2026-11-13）

**目标**：让用户在现有 Studio 画廊里删掉自己生成的图片，复用的是已有的删除按钮，不新增平行页面或独立资产管理页。

**接线方式**：画廊条目在任务服务路径下本来就有删除按钮，但历史实现只删 localStorage 里的条目，服务端资产仍可访问。现在删除前先做一次归属判断：

- 条目带 `assetId`（任务结果的 `result.assetId`），或 `url` 匹配 `/api/assets/<uuid>/content`（兼容旧版本写入 localStorage 的条目）时，先 `DELETE /api/assets/:id`；
- 服务端成功（含 404，等价于"已经没有这个资产"）后才从列表移除；
- 服务端失败（`409 ASSET_NOT_DELETABLE`、网络错误）时**保留条目**，用户可以重试；
- 外部供应商 CDN 地址（非本服务归档）不发起删除请求，行为与以前一致，只做本地移除。

**改动的文件**：

- `packages/studio/src/taskClient.js`：新增 `deleteAsset(assetId)` 与 `assetIdFromResultUrl(url)`；`deleteAsset` 校验 UUID，只发一发 `DELETE`，`404` 归一化为 `alreadyDeleted: true`，其它错误保留 `code`/`status`。
- `packages/studio/src/components/ImageStudio.jsx`：`handleDeleteEntry` 增加资产删除步骤；生成结果落地时把 `assetId` 写进历史条目（随 localStorage 持久化）；上传入口/移动端菜单共用同一逻辑。
- `packages/studio/src/messages/{zh,en}/imageStudio.json`：删除确认文案改为"删除后无法恢复"，新增 `deleteNotReady`（图片仍在处理中）。
- `tests/studioTaskClient.test.js`：新增 4 项用例，覆盖 URL 解析白名单、单发 `DELETE`、404 幂等、`409` 与非法参数不伪装成功。

**语义边界**：这一步只做"用户主动删除 + 前端接线"。删除仍为软删除，物理对象由 5.7 的清理流程异步删除；因此界面上"已删除"不等于磁盘已释放，也不代表可以撤销。

**验收证据**：`node --test tests/studioTaskClient.test.js` = 9/9 通过（其中 4 项为本次新增）。前端组件没有单元测试基建（仓库无 jsdom / testing-library），因此 JSX 侧只做语法解析门禁与人工本地验证，不能在 CI 里声称"UI 已自动化覆盖"。

## 阶段 5.9：删除确认改为应用内弹窗（2026-11-13）

**这一节不涉及数据库变更。** 记录的是 5.8 删除入口在浏览器里的确认交互被替换，避免后续把"删除确认"重新写回 `window.confirm()`。

**问题**：5.8 用的是原生 `confirm()`，实机显示为「127.0.0.1:3000 显示 / Delete this image? This cannot be undone. / 确定 取消」——标题由浏览器注入（生产会变成实际域名）、按钮跟随浏览器语言与应用语言混排、系统灰白样式与深色 UI 断裂、且阻塞主线程，请求期间无法禁用按钮或展示失败原因。仓库内 9 个组件都这样写，属于既有遗留而非本轮引入。

**做法**：

- 新增 `packages/studio/src/components/ui/ConfirmDialog.jsx`（公共基元，并从 `packages/studio/src/index.js` 导出）：`createPortal` 到 `document.body`，`role="alertdialog"` + `aria-modal` + `aria-labelledby`/`aria-describedby`；Esc 与遮罩点击取消；Tab 焦点陷阱；**打开时焦点落在「取消」**，关闭后还原到触发元素；打开期间锁 `body` 滚动并补偿滚动条宽度；`busy` 时禁 Esc、禁遮罩、禁重复提交；`error` 内联渲染（失败不再丢上下文）。动效：遮罩 200ms 入 / 150ms 出，面板 260ms 入（ease-out-expo）/ 180ms 出，标题与按钮行 40ms/90ms 阶梯上浮；**入场用双 `requestAnimationFrame`**，单 rAF 可能和挂载同一次 paint，导致没有起始值可插值、弹窗"啪一下"出现（这是最初生硬的根因）；`prefers-reduced-motion: reduce` 时全部时序归零。
- `ImageStudio.jsx`：`pendingDelete`/`deleteBusy`/`deleteError` 三个状态 + `requestDelete`/`cancelDelete`/`confirmDelete`；桌面悬浮按钮和移动端 actions 菜单都改为先开弹窗，确认后才执行 5.8 的删除链路。
- `messages/{zh,en}/imageStudio.json`：`gallery` 新增 `deleteTitle`/`deleteDescription`/`deleteAction`/`deleteCancel`/`deleteBusy`；旧 `deleteConfirm` 保留但不再读取。

**验收证据**：`@babel/parser` 解析 `ConfirmDialog.jsx`、`ImageStudio.jsx` 通过；`esbuild --bundle` 退出 0（1.37 MB）；整仓 `node --test "tests/*.test.js"` = 516 项 / 514 passed / 0 failed / 2 skipped（与 5.8 一致）；dev server `GET /studio/image` 返回 200，客户端 chunk 内含 `alertdialog` 与 `deleteTitle`。

**边界**：只有 ImageStudio 迁移，`Cinema/Video/Marketing/Recast/LipSync/VibeMotion/MotionControl/Workflow/DrawModal` 仍是原生 `confirm()`；弹窗交互（焦点陷阱、Esc、busy 锁定）只有代码审阅和人工验证，没有自动化 UI 测试。**（本节边界已由 5.10 解除：其余入口已全部迁移。）**

## 阶段 5.10：ConfirmDialog 全站推广 + 回归门禁（2026-11-13）

**这一节同样不涉及数据库变更、迁移或角色权限。** 记录的是 5.9 的公共弹窗被推广到 Studio 包内所有危险操作入口，并用源码级门禁防止回退。

**迁移范围（9 个文件 / 10 个入口）**

| 文件 | 删除链路 | 接线方式 |
|---|---|---|
| `VibeMotionStudio.jsx` | 同步 `setHistory` | `pendingDeleteIdx` |
| `LipSyncStudio.jsx` | 同步 `setInternalHistory` | `pendingDeleteIdx` |
| `CinemaStudio.jsx` | 同步 `setInternalHistory` | `pendingDeleteIdx` |
| `RecastStudio.jsx` | 同步 `setInternalHistory` | `pendingDeleteIdx`；移动端原为硬编码英文，已统一 |
| `MarketingStudio.jsx` | 同步，仅 `!historyItems` 生效 | `pendingDelete{id}`；**保留原有 `!historyItems` 语义**，未擅自扩展 |
| `MotionControlStudio.jsx` | 同步 `saveHistory` | `pendingDeleteIdx` |
| `VideoStudio.jsx` | 异步 `onDeleteHistoryItem` | `pendingDelete{entry,idx}` + `deleteBusy` + `deleteError` |
| `WorkflowStudio.jsx` | 异步 `deleteWorkflow` | `pendingDeleteWorkflow{id,name}`；顺带移除 `alert("Failed to delete workflow")` |
| `DrawModal.jsx` | 清空画布（非删除） | 弹窗 `z-[1000]` 叠在 DrawModal 的 `z-[100]` 模态之上 |

**共享文案**：`packages/studio/src/messages/{en,zh}/confirmDialog.json`（`deleteTitle`/`deleteDescription`/`deleteAction`/`deleteCancel`/`deleteBusy`/`failed`）+ `packages/studio/src/confirmCopy.js` 的 `getConfirmCopy(locale)`。英文为 source of truth；`zh` 与 `zh-*` 命中中文，未知 locale 回退英文而不是 `undefined`。集中一处的理由是同一句话要在 9 个屏 × 2 语言里各写一遍必然漂移。

**回归门禁 `tests/studioConfirmDialogMigration.test.js`（5 项，纯静态）**：文案键对齐且非空；resolver 回退契约；**components 下无原生 `confirm()`**（剥注释后判裸 `confirm(` 与 `window.confirm(`——后者因点号会漏判，而它正是宿主 `TaskCenter.js` 的写法）；10 个入口都 import **并渲染** `<ConfirmDialog>`；`ConfirmDialog` 的可访问性/焦点契约（portal、`alertdialog`、`aria-modal`、默认焦点落取消、`busy` 短路、reduced-motion 清零卸载定时器）。门禁正则用 6 条样例反向自测过判定力，避免"写完就绿"。

**验收证据**：9 个改动文件 + `confirmCopy.js` 逐个 `@babel/parser` 解析通过；逐组件与 `packages/studio/src/index.js` 打包退出 0（8.6 MB）；整仓 `node --test "tests/*.test.js"` = **521 项 / 519 passed / 0 failed / 2 skipped**（较 5.9 增加 5 项门禁，无回归）；`GET /studio/image` 返回 200。

**边界**：宿主 `components/TaskCenter.js:223`（取消任务）仍是 `window.confirm`，不在 studio 包内、门禁也扫不到；`WorkflowStudio` 的 `alert("Failed to rename workflow")` 未改；门禁是源码级约束，**不能**替代"点击 → 弹窗 → 删除 → 失败重试"的交互验证（仓库仍无 jsdom/testing-library）。

## 阶段 5.11：孤儿「未完成归档」对象回收（2026-11-13）

**这一节涉及数据库变更**：迁移 `0023_orphan_asset_reclaim`。这是 5.7 清理链路的补口——5.7 只处理 `status='deleted'`（用户显式删除），归档中途被强杀留下的行与对象无人回收。

**问题形态（为什么不能复用 5.7 的查询）**

`lib/server/assetArchive.js` 的顺序是：`INSERT ... status='pending'` → `putObject(users/<owner>/assets/<id>)` → `UPDATE ... status='ready', storage_key=...`。进程如果在 `putObject` 之后、`UPDATE` 之前被 SIGKILL/OOM 杀掉，`catch` 里的补偿删除根本没机会执行，于是留下：

- 一行 `status='pending'`（或 `uploading`），
- 一个**已经写到盘上**的对象，
- 而 `assets_status_storage_consistency_check` 强制 pending/uploading 的 `storage_key IS NULL` —— **行上没有键可读**。

因此回收只能按归档路径的唯一键约定推导：`users/<owner_id>/assets/<asset_id>`。这也是本模块与 `assetPurge` 不能合并的原因（后者读行上的 `storage_key`）。

**为什么新增 `abandoned_at` 而不是把行标成 `failed`**

标记 `failed` 需要 cleanup 角色具备 `UPDATE(status)`。该角色刻意没有 status 写权限，验收里还保留「cleanup 不能改 status」的负例；为了清理方便而扩大运行时权限面，代价高于收益。因此：

- 迁移 0023 新增 `abandoned_at`，由 cleanup 角色写入，作为「该行已被判定放弃且对象已删」的收敛信号；
- 行的 `status` 保持原状，语义由 `abandoned_at` 承担（NULL = 还没处理）。

**迁移与约束**

```sql
ALTER TABLE "assets" ADD COLUMN "abandoned_at" timestamptz;
CREATE INDEX "assets_orphan_pending_idx" ON "assets" ("created_at")
  WHERE status IN ('pending','uploading') AND abandoned_at IS NULL;
ALTER TABLE "assets" ADD CONSTRAINT "assets_abandoned_state_check"
  CHECK (abandoned_at IS NULL OR (status IN ('pending','uploading') AND abandoned_at >= created_at));
```

CHECK 的作用是防止同一行同时被两条清理流程认领（`ready`/`deleted` 行必须 `abandoned_at IS NULL`），并保证时间单调。部分索引让扫描只覆盖真正待处理的行，与 `assets_purge_pending_idx` 同构。

**cleanup 角色权限变化（列级，表级仍全 false）**

| | 5.7 | 5.11 |
|---|---|---|
| SELECT | `id,owner_id,status,storage_key,thumbnail_storage_key,deleted_at,purged_at,purge_attempts` | 追加 `created_at,abandoned_at` |
| UPDATE | `purged_at,purge_attempts,last_purge_error,updated_at` | 追加 `abandoned_at` |

仍然**不能**改 `status`/`storage_key`/`mime_type`/`size_bytes`/`checksum_sha256`/`owner_id`，也读不到 `users`/`generation_tasks`；`created_at` 只读、不能写。

**运行时语义**

- 认领：`status IN ('pending','uploading') AND abandoned_at IS NULL AND created_at <= now()-窗口 AND purge_attempts < max`，`FOR UPDATE SKIP LOCKED`，认领即 `purge_attempts+1`；**刻意不 bump `updated_at`**（那是真实生命周期写入的时间，不该被清理流程伪造成心跳）。
- 删除对象在事务外，幂等（对象不存在视为成功）；缩略图若存在且属于同一 owner 一并删除；跨 owner 的键一律拒绝并记 `orphan-verify:key_owner_mismatch`。
- 成功写 `abandoned_at` 并清空 `last_purge_error`；失败只写 `last_purge_error='orphan-delete:<CODE>'`，不写 `abandoned_at`，下一轮继续重试，直到 `maxAttempts` 后计入 `exhausted`。
- CLI 一轮跑两段：`asset_cleanup`（已软删除）与 `asset_orphan_reclaim`（孤儿），两段事件分开输出，互不重叠。

**超时语义与已知局限（必须保留）**

schema 里没有上传租约/心跳字段，「多久算超时」只能用 `created_at` 老化判断。当前**没有交互式上传通道**，`pending` 行全部由归档路径在数秒内创建并转 `ready`，所以默认 6 小时窗口不会误删正在写入的对象；本地注册器也刻意**不跟随** `--retention-hours 0`（保留期为 0 只影响用户显式删除的行，孤儿窗口为 0 会误删在途对象）。将来若引入分片/长时上传，必须补租约（heartbeat 或 `upload_expires_at`），**不能只调大这个窗口**。

**验收证据**

- 整仓 `node --test "tests/*.test.js"` = **535 项 / 533 passed / 0 failed / 2 skipped**（新增 `tests/orphanReclaim.test.js` 10 项、CLI 4 项）。
- `npm run db:migrate:check` 输出 `Everything's fine`。
- 隔离 PostgreSQL 真实验收报告 `.workbuddy/database-acceptance-mwena934_77f663.json` 为 **passed**（123 checks：118 passed / 1 skipped / 4 running / 0 failed），新增两项专项证据：「assets.abandoned_at可写在pending行上（0023约束正向证据）」「真实PG孤儿回收：pending行按推导键删对象、写abandoned_at、重跑收敛、窗口内不误删」，且 cleanup 列级权限期望清单已同步为 10 读 / 5 写。
- 0000/0001/0002 历史迁移哈希未变；`0021`、`0022` 记录未被改写。

**边界**：只在本地文件存储上验证过 `deleteObject`；S3/OSS 的批量/限流/版本化桶删除标记未验证。孤儿行回收后仍以 `pending` 状态留存，属刻意（见上）。

## 本地开发：MFA 加密密钥持久化与 `--prune`（2026-11-13，无 schema 变更）

本节记录两处**本地开发环境**行为。它们不改表结构、不改迁移、不改任何角色权限，但都直接作用于数据库，所以写在这里而不是只留在交接单里。

**1. MFA 加密密钥必须与数据库同寿**

本地启动器默认**复用**固定库 `pt_local_auth_000000000000`。而 `PAINTTRACK_MFA_ENCRYPTION_KEY` 过去是每次启动 `randomBytes(32)` 新生成的。`admin_mfa_factors.secret_ciphertext/secret_nonce/secret_tag` 是 AES-256-GCM 密文，`admin_recovery_codes.code_digest` 是 SHA-256 摘要，因此换密钥后：

- `decryptSecret` 在 `decipher.final()` 抛认证失败，MFA 验证直接失败；
- 原始 TOTP 无法还原（只存密文），恢复码无法还原（只存哈希）；
- 结果是管理员被锁在自己的本地环境外，**没有 UI 可恢复**。

现在密钥持久化在 `.local-state/mfa-encryption.key`（目录 0700、文件 0600、gitignore）。要点：

- 复用库时持久化；`--fresh` 走一次性库，配一次性密钥且不写盘。
- 写入用 `flag: 'wx'`：并发启动时落败方回读胜者密钥，不会各写一份。
- 文件内容不是 64 位十六进制 → 抛 `LOCAL_MFA_KEY_CORRUPT`，**不覆盖原文件**。静默重建会让库里所有密文永久孤立。
- `mailboxSecret` 刻意**不持久化**：邮件只存在内存里，重启后旧链接本就失效，签名密钥跟着换才一致。
- 生产环境仍由 `PAINTTRACK_MFA_ENCRYPTION_KEY` 注入；真实部署需要密钥托管与轮换计划，本节的本地文件方案不适用于生产。

**2. `--prune` 清理历史本地库与构建目录**

每次 `--fresh` 都会留下一个 `pt_local_auth_<suffix>` 库、四个 `pt_local_{migrate,runtime,worker,cleanup}_<suffix>` 角色，以及一个 `.next_local_<suffix>` 构建目录。清理入口：

```bash
node scripts/local-registration.js --prune          # dry-run，只列清单
node scripts/local-registration.js --prune --yes    # 真正删除
```

删除边界（按顺序生效，任一不满足即跳过并输出原因）：

1. 库名必须匹配 `^pt_local_auth_[a-z0-9_]{1,24}$`；
2. 默认库 `pt_local_auth_000000000000`（或 `PAINTTRACK_LOCAL_DATABASE` 指定的那个）永远保留；
3. 库 owner 必须能推导出 `pt_local_migrate_*`，否则不视为本启动器创建的库；
4. 有活动连接（`pg_stat_activity`）的库跳过，不终止他人会话；
5. 只有 `DROP DATABASE` 成功后才删该库的四个角色；角色仍被引用（`2BP01`）则保留并记录。

`DROP DATABASE` / `DROP ROLE` 不能参数化，所以每个名字拼进 SQL 前**再次用 pattern 校验**并双引号引用。`.next/`、`.local-assets/`、`.local-state/` 都不在前缀匹配范围内——删掉 `.local-state/` 会重新触发上面第 1 条故障。

**证据与状态**

- `tests/local-secrets.test.js` 8 项（含「重启前加密的 TOTP 密文在重启后仍能解开，换任何其它密钥都解不开」端到端）；`tests/pruneLocal.test.js` 13 项；整仓 558 项 / 556 passed / 0 failed / 2 skipped。
- **已于 2026-11-13 执行真实清理**（使用者确认后）：`PRUNE_DATABASE_FOUND 23` → 23 个历史库全部 `DROP`，回收 **196.2 MB**，对应的 92 个 `pt_local_*` 角色随之删除，仓库角色总数从 57 降回 4（即固定库的 migrate/runtime/worker/cleanup 四角色）。删除前逐个核对：无任何活动连接、owner 均为对应的 `pt_local_migrate_<suffix>`。
- 删除后复核：`pg_database` 只剩固定库 `pt_local_auth_000000000000`（9.4 MB / 18 张表 / 22 条迁移记录 / users=1、assets=4、generation_tasks=4），固定库数据一行未动。
- **构建目录删除会被"运行中的 dev server"阻断**：`next dev` 与启动器进程持有 `.next_local_<suffix>`，Windows 下 `unlink`/`rename` 均返回 EPERM，删除守卫也整体 fail-closed。此时 `--prune --yes` 输出 `PRUNE_DIST_FAILED` + `PRUNE_DIST_HINT`（提示先停服务）并以 exit 1 退出——**这是预期行为，不是 fs 缺陷**。停掉本地开发环境后再跑一次即可清掉。

## 阶段 3.1：用户、注册与邮箱验证（本地受控实现）

本节保留阶段 3.1 交付时的范围和证据，后续登录/会话、KDF 资源控制及 Origin 策略以本文阶段 3.2 节为准。3.1 当时仅包含用户实体、规范邮箱唯一性、注册及邮箱验证，不包含登录、Cookie/会话、管理员初始化或授权中间件。不设置 role 字段，API 严格拒绝 role、verified、emailVerifiedAt、userId 等额外字段。现有业务端点没有因此获得认证或授权保护，不得面向真实用户开放。

### 数据与安全设计

- `schema.js` 为表定义来源，`schema.cjs` 复用同一来源。增量 `0004_registration.sql` 新建 `users`、`email_verification_tokens`、`auth_rate_limits`，不改写 0000–0003、不修改已有业务数据；journal 与 0004 snapshot 同步。保留旧 `__painttrack_schema_version` 占位表，迁移权威仍为 Drizzle journal。
- 邮箱仅支持 ASCII，trim + lowercase，不删除点或加号标签；local-part 最长 64、域标签最长 63、总长最多 254 字节。数据库 CHECK 强制小写/无首尾空格及基础格式，唯一索引是并发最终裁决；数据库不会自动替调用方转换非法大写邮箱，直接写入会被 CHECK 拒绝。
- 本小步注册时收密码：12 字符起、UTF-8 最多 128 字节，拒绝控制字符；不 trim 密码。不引入依赖，使用 Node 标准 `crypto.scrypt`，N=32768/r=8/p=3、maxmem=64 MiB、16 字节随机盐、64 字节派生值；持久格式携带参数，数据库校验格式。合法重复注册也执行 KDF，不替换原密码或发送第二封邮件。尚无登录/密码比较接口。
- 验证 token 为 32 字节密码学随机数，43 字符规范 base64url；仅 SHA-256 hash 落库，15 分钟有效。验证使用数据库时钟和 `UPDATE ... WHERE consumed_at IS NULL AND expires_at > clock_timestamp() RETURNING`，用户标记与消费在同一事务；并发只能消费一次，失败回滚。不得将 token 放 URL 查询串、响应或日志。
- 注册（新/重复邮箱）与验证（有效/不存在/过期/已用的规范 token）统一 HTTP 202、`{"status":"accepted"}`，不返回用户/邮箱/验证结果。格式错误 400、超过 2048 字节请求体 413、限流 429（Retry-After: 60）、邮件未配置或内部错误 503。所有响应 no-store/请求关联 ID，无 Cookie。防枚举是稳定状态/正文及相同 KDF 成本，不是严格恒定时间保证；未来真实投递可能形成时序侧信道，需专项复核。
- 限流使用 PostgreSQL UPSERT 原子窗口，register/verify-email 各全局最多 60 次/60 秒，先限额再 KDF，失败/重复也消耗额度，不在业务事务回滚中撤销额度。多实例共享同一数据库，不依赖进程内计数，也不信任客户端 X-Forwarded-For。表只有两个 bucket，不存邮箱/IP。该保守全局限额会影响可用性，不等于生产完整抗滥用：入口请求/慢请求限流、可信代理配置、分来源配额和 KDF 并发资源保护尚待上线前设计；非法请求当前由字节/格式校验拦截，不计数据库额度。
- 复用现有错误格式、日志及审计白名单；仅审计固定 action/outcome/requestId，不记录邮箱、密码、token、SQL参数或底层错误。审计为既有日志接口，不是数据库内持久原子审计账本。

### API 与邮件边界

- `POST /api/auth/register` JSON `{email,password}`；`POST /api/auth/verify-email` JSON `{token}`。不使用 `/api/v1`，避免现有供应商 rewrite。
- 默认 Route **不装配邮件发送器**，合法注册明确返回 `503 MAIL_UNAVAILABLE`，且不建用户、不连接数据库。仅下面的专用本机开发入口显式启用内存收件器；production 即使误设开发开关也拒绝启用。
- `createRegistrationHandler` / `createRegistrationService` 在测试注入 `tests/fixtures/registration-outbox.cjs`，专用开发入口注入 `developmentMailbox.js`；生产拒绝测试注入。token 只进入进程内 outbox，退出即丢失，绝不写盘；未接 Agent Mail/SMTP/Provider/云服务。
- 当前投递仅服务受控测试，投递拒绝导致数据库事务回滚。但内存消息不具备跨系统原子性：发送成功后数据库提交失败可能留下无效消息。不可直接把替身替换成真实网络发送器；后续真实邮件必须单独设计持久投递/重试协议与秘密保护，并获授权。未实现过期 token 重发、未验证用户清理或自助恢复；重复注册不会修复过期令牌，本步结束后暂停，不扩展这些流程。

### 迁移、权限与恢复

1. 对有价值数据先备份并记录迁移 journal；在授权目标上以独立迁移身份运行 `npm run db:migrate`。本轮仅在随机新建验收库应用，未迁移既有开发/测试/生产库。
2. 新运行角色只需新增三表的 SELECT/INSERT/UPDATE/DELETE（本地验收入口只在本次新库授予）。对既有目标的授权必须另行审批；本轮未修改任何既有认证规则或角色权限。运行身份不得拥有 DDL、迁移 journal 或身份升级权限。当前本机 trust 只验证授权隔离，不证明密码认证强度。
3. 迁移异常先检查 journal；Drizzle 事务失败不应保留半套表，修复采用新迁移，不改历史 SQL。已成功应用后回退应用代码可保留这三张附加表，旧 Worker/资产路径不依赖它们；应先停止注册/验证流量，不删除 journal 行，也不要手工 drop 表“回滚”。
4. 如确需恢复结构，先导出新增用户及令牌 hash/验证状态、停写并验证备份，在另一个恢复目标恢复迁移前备份、验证旧应用与权限再切换；这会丢失备份后的注册，需业务确认。破坏性删除三表只能在后续单独审查的迁移/授权中进行。本步不执行 drop/reset/资源清理。

### 2026-11-06 验收证据

- 定向：`node --test tests/registration.test.js tests/databaseInfrastructure.test.js tests/databaseLifecycle.test.js`，28/28 passed，0 skipped；包括 scrypt 重算、输入边界、客户端字段注入、生产替身拒绝、无邮件503、流式大小限制、错误/日志脱敏及两个 schema 与 snapshot 一致。日志 `.workbuddy/phase31-targeted.log`。
- 全量：`npm test`，154 项，152 passed、2 skipped、0 failed；跳过为缺少 TEST_DATABASE_URL 的旧数据库集成入口以及既有进程树停止测试。日志 `.workbuddy/phase31-full.log`。真实数据库证据来自下面独立新库验收，不能把离线跳过或替身当真实证据。
- `npm run lint`：0 errors / 11 条既有 warnings，日志 `.workbuddy/phase31-lint.log`；`npm run db:migrate:check`：Everything's fine，日志 `.workbuddy/phase31-migrate-check.log`；`git diff --check` 通过。
- 真实 PG16 loopback:5433：使用用户授权的无密码 postgres 管理员入口，新建 `pt_acceptance_mw4lqtvf_0c8f85`、配对 `pt_migrate_mw4lqtvf_0c8f85` / `pt_runtime_mw4lqtvf_0c8f85`，凭据只存进程内；报告 `.workbuddy/database-acceptance-mw4lqtvf_0c8f85.json` 最终 passed，日志 `.workbuddy/phase31-postgres.log`。资源保留，未复用历史库。
- 报告包含 6 表从空库迁移/重复 journal/hash/snapshot、运行角色授权负例；10 组新增注册验收：成功注册验证、大小写重复及4并发注册、数据库直接23505冲突、非法字段不落库、错/过期/重复 token、4并发验证、邮件故障真实回滚、消费后注入异常真实回滚且原 token 可重试、65并发限流恰好60通过5拒绝、数据库/HTTP/实际审计日志无明文秘密。邮件本身仅内存替身，故障注入包装保留真实 Drizzle 事务，未替换数据库/连接池。
- 最终复验再次使用全新库 `pt_acceptance_mw4lyqh7_d8f1d9`（配对角色 `pt_migrate_mw4lyqh7_d8f1d9` / `pt_runtime_mw4lyqh7_d8f1d9`），报告 `.workbuddy/database-acceptance-mw4lyqh7_d8f1d9.json` 最终 passed，`server_version_num=160015`（PG16.15）。日志 `.workbuddy/phase31-postgres-final.log`；额外核对索引 isUnique、重复注册 HTTP 202/不覆盖原用户、无通道503不落库。首轮与最终轮两个库及四个角色全部保留，不清理。最终全量/静态检查分别为 `.workbuddy/phase31-full-final.log`（154项，152通过，2跳过，0失败）及 `.workbuddy/phase31-lint-final.log`（0 errors/11 warnings）；均后台执行并 Read 核实。
- 同轮保留阶段2入口并重跑真实3 Worker/12任务/4轮/3独立后端、SIGKILL自然过期重领、旧token fencing、心跳、停止恢复及最终15任务成功，无遗留连接/事务。旧三表及8项权限硬编码断言已改为最新 snapshot 与5张业务表 DML；历史约束负例仍保留。
- 此轮后端结论：阶段3.1本地受控范围通过；当时未验证真实邮件、Next服务器网络端到端/浏览器UI、生产部署和压力容量。后续本地页面补验见下节。保留全部既有改动，不提交、不清理、不重置、不改依赖，不进入3.2。

### 本地注册页面与测试收件器

在项目目录执行 `npm run dev`，浏览器只访问 `http://127.0.0.1:3000/register`（也可直接执行 `node scripts/local-registration.js`）。可通过 `PORT` 更改公开端口；Next dev 仍使用公开端口加一作为loopback内部端口，因此本方案是一个公开入口加一个受门禁保护的内部监听，并非进程级单端口。此入口仅用于本机受控验收：使用已核实的本地5433 postgres身份（当前trust），每次新建 `pt_local_auth_<随机后缀>` 数据库及独立迁移/运行角色；新资源名称打印但密码不打印/落盘，失败时也不自动删除，不迁移原业务库。若数据库认证已加固，此入口会安全失败，不能通过修改trust或重置密码强行运行。

公开入口和Next内部服务均仅绑定 `127.0.0.1`。启动器检查真实socket地址、精确Host、Origin和Fetch-Site后才注入随机进程能力头；剥离客户端能力头和转发身份头。Next内部端口通过 `PAINTTRACK_LOCAL_INTERNAL_GUARD` 中间件校验同一进程能力值，绕过入口直接访问会返回403。HTTP与HMR WebSocket均由公开入口转发；不要将任一端口代理/隧道到外部，不要把能力头或开发环境变量泄漏。Next缓存使用独立随机distDir，管理员和迁移连接不传给应用子进程。Ctrl+C停止启动器和Next；关闭后内存邮件消失但隔离数据库保留。

页面流程：`/register` 使用虚构邮箱和12字符以上测试密码 → `/dev/mailbox` 点击刷新 → 打开邮件中的 `/verify-email#<token>` → 主动点击确认。fragment不会发给HTTP服务器，页面读取后立即移除；不自动消费令牌、不写localStorage。202只表示请求受理，不代表登录或必然验证成功。无邮件重发，过期后用新虚构邮箱重试。收件器最多100封、15分钟过期、无外部投递，清空仅影响内存邮件。所有开发响应no-store/no-referrer；production收件器页面/API为404，普通开发服务器即使复制开关也无启动器能力头，不能读取收件器。

既有阶段3.1 HTTP验收fixture针对历史3211专用服务。单入口开发服务另行验收：默认仅公开端口3000可供浏览器使用，默认内部端口3001直接访问返回403；注册、内存邮件验证、登录、带Cookie任务列表、Studio和HMR均经3000通过；错误Host、跨站请求和客户端伪造能力头被拒绝。新增 `tests/localRegistrationLauncher.test.js` 覆盖入口边界。以上仅证明本机loopback开发流程，不代表生产认证或外网部署验收；真实浏览器点击/截图与邮件投递容量仍未测试。

## 阶段 3.3：角色与服务端授权

本阶段在服务端引入 `user` / `admin` 角色及授权门禁。身份和角色均通过数据库中的有效、未撤销、未过期且邮箱已验证的会话实时解析；客户端传入的 role、user ID 或转发身份头不构成身份。管理员汇总端点要求 admin；资产读取始终要求资源所有者匹配，管理员也不能跨用户读取。资产响应仅返回白名单字段，不返回存储键、URL 或 metadata。未实现的供应商/API 代理统一 fail-closed：匿名请求拒绝，已认证请求仍返回 NOT_IMPLEMENTED，不调用 Provider。

迁移 `0006` 为现有 `users` 表添加受 CHECK 约束的 role；运行角色仅能在 `users` 上插入允许的非角色列、更新邮箱验证时间，不能插入/修改 role。角色变更只允许受信任的迁移/管理身份。不要把测试专用的管理员创建方式当作正式管理员初始化流程；正式初始化仅可通过独立受控的 CLI 和单独 bootstrap 数据库身份完成，不能经 HTTP/网页或应用运行身份执行。

### 2026-11-07 阶段 3.5 最终验收

- 正式入口 `npm run admin:init` 通过独立 bootstrap 身份在受控 TTY 中初始化首个管理员；事务级 advisory lock 保证并发请求仅一例成功，只允许数据库原本没有 admin 且邮箱未占用时插入新账户。输入校验、scrypt哈希、邮箱冲突拒绝、事务回滚、重复初始化拒绝和秘密不回显已验证。
- 最终真实 PostgreSQL 隔离报告 `.workbuddy/database-acceptance-mw5z8fxe_528a61.json` 状态为 `passed`，PostgreSQL 16.15。真实验收覆盖空库迁移、bootstrap最小权限、8路并发首设恰一成功、runtime身份无法 INSERT/UPDATE `users.role`、CLI初始化、拒绝重放及数据库连接释放；同一报告中的注册、session、密码重置、授权、Worker并发/恢复/fencing与停止验收也均通过。随机验收库及角色按策略保留。
- 阶段 3.5 离线全量测试 `.workbuddy/phase35-full.log`：180项，178 passed、2 skipped、0 failed；lint `.workbuddy/phase35-lint.log`：0 errors、11条既有 warnings；Drizzle migration check `.workbuddy/phase35-migrate-check.log`：`Everything's fine`。新增定向测试 `tests/adminBootstrap.test.js`：6/6 passed。已清理部分重复临时日志；保留最终测试/lint/迁移日志、最终真实PG报告和项目记忆。
- 未实施HTTP/网页升权、未连接真实邮件或云资源、未修改PostgreSQL认证设置、未提交Git。阶段 3.6 尚无已批准范围，本阶段结束后暂停等待用户确认下一目标。

### 2026-11-06 验收证据

- 隔离真实 PostgreSQL 最终报告 `.workbuddy/database-acceptance-mw4qxbnb_17fbac.json` 为 passed。新建数据库 `pt_acceptance_mw4qxbnb_17fbac` 与配对迁移/运行角色全部保留；迁移空库重放、journal/hash/snapshot、运行角色列级权限、DML/DDL/约束负例、事务/连接池，以及真实注册、session、角色与资产所有权检查均通过；原真实 Worker 并发/恢复检查也在同一隔离验收入口执行通过。此前两份失败报告反映当时的中途断言失败，未删除或覆盖，最新报告才是修正后的完整证据。
- 实际 HTTP 权限报告 `.workbuddy/phase33-http-report.json` 为 passed，11 组检查覆盖匿名401、伪造role无效、普通用户访问管理员端点403、管理员200、本人资产200、其他用户及管理员跨用户资产404、代理端点关闭、数据库权限故障503及日志秘密检查。
- 离线全量测试 `.workbuddy/phase33-recovery-full.log`：168 项，166 passed、2 skipped、0 failed；两个跳过项为既有可选数据库集成入口（未配置 TEST_DATABASE_URL）和进程树测试。真实 PG 证据另由隔离库报告提供。lint `.workbuddy/phase33-recovery-lint.log`：0 errors、11 条既有 warnings；迁移元数据检查 `.workbuddy/phase33-recovery-migrate-check.log` 输出 `Everything's fine`。
- 边界：HTTP 报告来自受控本机启动器及真实本机数据库，不是生产部署或外网渗透测试。当前本机 PostgreSQL 使用 trust，真实 PG 验收证明运行角色授权隔离，不证明密码认证安全。密码重置与正式管理员初始化属于后续独立阶段，分别见阶段 3.4 与阶段 3.5；Provider 授权/额度或生产对象存储仍未接入。未修改既有业务库、认证规则或依赖，未清理任何验收资源。

## 阶段 3.2：登录、登出与服务端会话

本步只增加认证会话与登录页面，不增加 role、管理员初始化、资源归属授权或阶段 3.3 中间件。**现有业务 API 仍没有因此获得认证/授权保护**；本机受控验收通过不等于可公开部署。3.1 的开发内存收件器继续默认关闭、production 禁用，不接外部邮件 Provider。

### API、密码与过载控制

- `/login` 展示登录表单、服务端查询的当前用户 ID 与登出按钮；注册/验证页增加登录链接。浏览器通过同源 Cookie 请求，不读写 localStorage，不持久化密码或 token。
- `POST /api/auth/login` 仅接受 JSON `{email,password}`，沿用注册的邮箱规范化/密码 12 字符至 128 UTF-8 字节/禁止额外字段规则及 2048 字节流式请求体上限。成功为 200 `{user:{id}}`；未知邮箱、密码错误、邮箱未验证均为 401 `INVALID_CREDENTIALS`，仅 requestId 不同，不签 Cookie、不返回邮箱/hash/token。非法输入 400、请求体过大 413、共享限流 429、KDF 队列满 503 `KDF_BUSY`、内部故障 503 `AUTH_UNAVAILABLE`。
- `GET /api/auth/me` 查询数据库会话和已验证用户，返回 `{user:{id}}` 或 `{user:null}`，不信任客户端 userId、不延长会话、不重签 Cookie。`POST /api/auth/logout` 提交撤销事务后返回 204 并清 Cookie；重复/无效会话登出幂等。数据库故障返回 503，不假报成功或先清 Cookie。
- `passwords.js` 保持已存 `scrypt:32768:8:3:<salt>:<hash>` 的原格式与计算方式，比较使用 timingSafeEqual。未知用户或损坏 hash 仍执行同参数 dummy KDF；未验证用户同样执行密码验证。稳定响应与相近 KDF 工作量不是完整请求恒定时间保证，未做时序侧信道统计认证。
- 注册/登录共用每进程全局 KDF 执行器：最多 2 个运行、8 个等待，超额明确拒绝；不在等待期间持有业务事务。PostgreSQL UPSERT 共享 login bucket 全局 30 次/60 秒，合法失败/超载也消耗额度，先扣限额再 KDF；register/verify-email 各 60 次/60 秒不变。429/KDF_BUSY 带 Retry-After: 60。数据库限流跨服务实例共享，KDF 并发上限仅每进程，不能宣称分布式 KDF 信号量。

### 会话、Cookie 与请求源策略

- 会话 token 为 32 字节 CSPRNG（256 位、43 字符规范 base64url），仅 SHA-256 hash 存入 auth_sessions；用户 ID、数据库到期时间、创建/撤销时间独立记录。固定有效 **8 小时**；无滑动续期、记住我或自动刷新，到期重新登录。
- 每次成功登录都签发新 token；真实事务内再锁定/核对用户凭据和验证状态，撤销请求携带的规范旧 token，再插入新会话。事务失败则旧撤销和新插入一起回滚。其他设备会话保留，失败登录不撤销旧会话。并发成功登录可各签有效新 token，登出只撤销携带的 token，不代表全设备登出；本步真实 PG 已验证两次并发登录与旧 token 登出竞争。并发 GET 可能在撤销提交前读到有效状态，撤销提交后旧 Cookie 重放无效。
- Cookie `painttrack_session`：host-only（无 Domain）、Path=/、HttpOnly、SameSite=Strict、Max-Age=28800、数据库到期对应 Expires；生产 HTTPS 强制 Secure。清除保持同名/同路径/同 Secure 属性并 Max-Age=0。重复同名、超长或非规范 Cookie 不作为身份。
- `APP_BASE_URL` 是唯一服务端可信 Origin：精确匹配 scheme/host/port，不接受路径（根路径除外）、查询、fragment 或嵌入凭据，不从 X-Forwarded-* 选择源。所有认证敏感 POST（含原注册/验证）必须带精确 Origin；缺失、null、跨源、同站不同源及跨站 Fetch-Site 拒绝，且在读取 body/创建数据库前检查。GET 不要求 Origin，但若提供必须匹配，也拒绝跨站 Fetch-Site。
- HTTP 非 Secure 仅限 NODE_ENV=development、loopback 和显式 `AUTH_ALLOW_LOCAL_HTTP=1`。为兼容已运行的旧专用 launcher，也认可其完整显式开发配置（收件器启用、精确 origin、64 hex 进程能力 secret），仍必须 development/loopback，production 不接受。不要手工复制能力 secret。专用 launcher 的 Host/socket/Origin 守卫保持不变；本地注册缺失 Origin 由能力守卫返回 404，其他敏感 POST 返回 403，并非绕过。
- 认证 API 与页面 no-store/no-referrer；会话响应 Vary: Cookie，Next 页面可附加 must-revalidate。错误和审计仅固定 action/outcome/requestId/errorCode，不写邮箱、密码、会话/验证 token、Cookie、SQL或底层错误。HttpOnly/SameSite/Origin 不等于 XSS 防护。

### 迁移、权限与恢复

1. 新增 `drizzle/0005_sessions.sql`、`meta/0005_snapshot.json` 与 journal 条目；仅新建 auth_sessions，并把 auth_rate_limits 的 CHECK 扩为 register/verify-email/login。token hash 唯一、SHA-256 格式 CHECK、expiry>created CHECK、用户外键 ON DELETE CASCADE、用户与到期索引。0000–0004 历史 SQL 不改写。
2. 本轮只在全新随机隔离开发/验收库应用迁移。新开发运行角色仅四张认证表 DML；完整验收运行角色六张业务表 DML，不能 DDL/TRUNCATE/改迁移记录/提升身份。未迁移旧3211库 `pt_local_auth_fd43c6e2186a`，未修改旧角色、PG认证规则或密码。当前 trust 只证明角色授权隔离，不证明密码认证安全。
3. 有价值目标须先备份并另行获得变更授权，使用独立迁移身份执行 `npm run db:migrate`，再单独审查新表 DML 授权；应用启动不自动迁移。失败先检查 Drizzle journal 与事务状态，使用新版本纠正，不删 journal、不改已应用 SQL、不 drop 表充当回滚。
4. 回退应用前停止登录/登出流量，保留附加会话表与扩展 bucket CHECK；旧注册/Worker 不依赖会话表。需要恢复结构时，停写、验证备份，在另一恢复目标恢复迁移前备份并核对用户/权限后切换；会使备份后的会话失效，须业务确认。本轮不执行破坏性恢复或资源清理。

### 本机入口与 2026-11-06 最终证据

- 新服务后台任务 **g1XFvd**，`http://127.0.0.1:3212/login`；注册 `/register`、测试收件器 `/dev/mailbox`、验证 `/verify-email`。启动命令：为进程设置 `LOCAL_REGISTRATION_PORT=3212` 后执行 `node scripts/local-registration.js`。不要直接重启复用：每次执行会新建随机库，且端口已占用时必须安全退出，不停止现有服务。日志 `.workbuddy/phase32-server.log`。
- 新开发库 `pt_local_auth_e3bf266e5168`，角色 `pt_local_migrate_e3bf266e5168` / `pt_local_runtime_e3bf266e5168`，独立 distDir `.next_local_auth_e3bf266e5168`；随机凭据不打印、不落盘，应用不继承管理员。旧任务 xYQJaS / 3211 保留，最终 HTTP fixture 仅 GET 旧注册页面确认 200；共享源码不是冻结副本，旧实例未迁移0005，不能用它验收新会话功能。
- 定向后台任务 n7nNKJ：`node --test tests/session.test.js tests/registration.test.js tests/databaseInfrastructure.test.js tests/databaseLifecycle.test.js`，**36/36 passed，0 skipped/failed**，日志 `.workbuddy/phase32-targeted-final.log`。
- 全量后台任务 Yqe1Ip：`npm test`，**163 项，161 passed、2 skipped、0 failed**，日志 `.workbuddy/phase32-full-final.log`。两跳过为缺少 TEST_DATABASE_URL 的旧集成入口及既有进程树停止测试；真实 PG 证据另列，不能用替身或跳过推定通过。
- lint 后台任务 e4Zmn6：**0 errors / 11 条既有 warnings**，`.workbuddy/phase32-lint-final.log`；迁移离线检查任务 kbea5P：Everything's fine，`.workbuddy/phase32-migrate-check-final.log`。这些日志均已 Read 核实。`git diff --check` 与本步29个文件全内容空白检查通过，日志 `.workbuddy/phase32-diff-check-final-verified.log`；首次全文件检查误将既有 CRLF 识别为尾部空白（保留日志 phase32-diff-check-final.log），已用 cr-at-eol 正确识别 Windows 换行，仍检查行尾空格/文件尾空行/tab前空格，未为此改写既有文件。
- 真实 PG 最终任务 99Bcjd：全新库 `pt_acceptance_mw4p1g5f_18b6c4` 及配对 `pt_migrate_mw4p1g5f_18b6c4` / `pt_runtime_mw4p1g5f_18b6c4`；PG16.15（160015），报告 `.workbuddy/database-acceptance-mw4p1g5f_18b6c4.json` 最终 **passed**，日志 `.workbuddy/phase32-postgres-final.log`。9 组会话验收含固定到期/hash、轮换、提交前异常真实回滚、6并发幂等撤销、两登录/旧登出竞争、稳定401/生产HTTPS handler Secure、3服务实例35并发30通过5限流、数据库约束、实际序列化日志无秘密。保留全部10组注册与真实3 Worker/12任务/4轮/3后端、SIGKILL自然恢复/fencing/停止恢复、最终15任务成功及无遗留连接；报告中的 running 项是历史开始事件，最终状态及对应完成事件均通过。此前本步新库 `pt_acceptance_mw4oiwvq_d97fdb` 同样保留，不复用凭据。
- 真实 HTTP 最终任务 GsHt9f：`node tests/fixtures/session-ui-http.cjs`，10 组全部 passed，报告 `.workbuddy/phase32-http-report.json`、日志 `.workbuddy/phase32-http-final.log`。实际 Next/pg 注册→内存邮件验证→登录/Cookie→me→轮换→登出→旧Cookie重放、未验证/错密码/未知邮箱、过期/伪造、非法字段、缺失Origin/跨站/转发头、6并发登出及数据库/日志秘密检查通过。35并发结果401=10、429=5、503=20（KDF_BUSY资源拒绝），不把503算登录成功。测试只连接3212日志指定的新库，旧库明确排除。

### 精确落点与未验证边界

- 实现：`lib/server/passwords.js`、`authPolicy.js`、`session.js`、`sessionHttp.js`；复用/调整 `registration.js`、`registrationHttp.js`、`db/schema.js`（schema.cjs 继续复用）。API：`app/api/auth/{login,logout,me}/route.js`；UI：`app/login/page.js`、既有 register/verify-email 页；middleware 仅添加登录页缓存策略，**没有授权保护**。
- 迁移与入口：`drizzle/0005_sessions.sql`、`drizzle/meta/0005_snapshot.json`、`drizzle/meta/_journal.json`、`scripts/local-registration.js`、`scripts/accept-database-local.js`；测试：`tests/session.test.js`、`tests/fixtures/session-postgres.cjs`、`tests/fixtures/session-ui-http.cjs` 以及适配现有 registration/databaseLifecycle 测试；配置说明只更新既有 `.env.example` / 本文件，无依赖变更。
- 未执行本步生产 build、真实浏览器点击/截图或生产 HTTPS 网络部署；Secure 证据来自 production 配置的真实 handler+PG，不等于 TLS/代理链验收。未接真实邮件、无记住我/密码重置/全部设备登出/过期会话自动清理；过期或撤销 hash 记录目前保留。
- 全局额度可被攻击占满，尚无入口慢请求/分来源限流、可信生产代理设计、跨进程 KDF 总资源限额或生产容量压测；开发服务器不应外网暴露。本步不证明本机 trust 的密码安全、生产认证加固、真实邮件原子投递或现有业务 API 安全。未提交、清理、回滚、修改依赖或迁移旧库；完成后暂停，等待验收，不进入 3.3。
