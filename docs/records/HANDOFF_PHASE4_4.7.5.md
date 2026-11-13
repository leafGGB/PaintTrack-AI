# 交接单：阶段 4.7.5 Web/Worker/Migration 数据库身份拆分

> **已被 `HANDOFF_2026-11-13.md` 取代（2026-11-13）。** 本文件此后仅作历史追溯：4.7.5 及其后各切片的时点记录保留原文，但其中的"下一步"已过时。当前状态、启动命令、未完成项与硬约束一律以新交接单及开发流程 3.0.4 / 10.4 为准。
>
> 本文件供新会话冷启动使用。读完即可继续，不需要历史对话。
> 最后更新：2026-11-12
>
> **最新（2026-11-13）第三次真跑 `passed`：本地 mock 路由快照 fixture 已在真实 PG 隔离库通过**。报告 `.workbuddy/database-acceptance-mweb6dgr_e1f6d4.json`，库 `pt_acceptance_mweb6dgr_e1f6d4` + 四个 `pt_*_mweb6dgr_e1f6d4` 角色（脚本自建、按策略保留）；112 条检查 107 passed / 1 skipped（`admin-mfa-postgres` 需 `RUN_ADMIN_MFA_PG_ACCEPTANCE=1`）/ 4 条 `running` 开始事件 / **0 failed**，退出 0。覆盖：三身份事实校验、四列临时授权、快照落库与重放零 resolver、同键并发单任务、image/video 执行、Web/Worker 快照 UPDATE 均 42501、落库篡改重算 hash 仍拒发、未知提交恢复保留调用 ID/轮次/幂等键、历史 provider_name 冲突零调用、migration 精确清理并撤销授权。之前两次失败都是 fixture 自身判定写法问题（8 条件一刀切无诊断 → 回环白名单过严），未改被测代码路径。
>
> **遗留资源清理**：新增 `scripts/cleanup-acceptance-databases.js`，只接受严格匹配 `pt_acceptance_<后缀>` 的库名、角色名由后缀推导，故无法指向 `painttrack_dev`/`painttrack_test`/生产库；有活动连接时跳过、库不存在时只探测、先删库再按 bootstrap/worker/runtime/migrate 删角色、2BP01 记为受阻不伪装成功、无事务包裹、缺管理变量在建连前退出且不读 `.env`。`tests/acceptanceCleanup.test.js` 6 项离线测试通过，全量 `npm test` 459 项 457 pass/0 fail/2 skipped、退出 0（`.workbuddy/full-test-after-cleanup-script.log`）。真实删除由用户持显式管理连接执行，本轮未连库。下一步：接 Studio 主流程（共享 ImageStudio/VideoStudio 走 `/api/tasks`，不新建平行生成页）；任务管理入口/页面仍暂缓、Provider 配置写 API 保持关闭、生产部署与秘密 ACL 后置。
>
> **2026-11-13 第二次真跑拿到字段名：`identity[0] fields: address`，已按“回环等价写法”修正**：报告 `.workbuddy/database-acceptance-mweb19lu_3c31d4.json` 为 failed，唯一失败子项仍是 `local-mock-route-postgres`，`line` 32，`hint` = `<redacted> identity[0] fields: address`。含义：`owner`（migration 连接）的 `database/role/session_role/database_owner/port/privileged/has_membership` 七项全部匹配，只有服务器端地址一项不符 ⇒ 角色、库名、库主、端口、无高权限、无成员关系都是对的，错在判定写法。根因：`accept-database-local.js` 的 `withClient` 对同一端点用 `::1 || startsWith('127.')`（一直通过），而 fixture 只认 `'127.0.0.1'`/`'::1'` 两个精确字符串，于是 127/8 内其它地址、IPv4 映射回环 `::ffff:127.x`、带 `/32` 掩码的 inet 文本都被误判。修正为 `isLoopbackAddress`：接受 `::1`、`::ffff:127.x.x.x`、整个 `127.0.0.0/8`，容忍 `/32`、`/128`；非回环（`172.17.x`/`192.0.2.x`/域名/空串/null）仍拒绝；仅 `address` 项回显实际 IP，其余字段仍只报字段名。证据：fixture 单测 6/6，全量 `npm test` 453 项 451 pass/0 fail/2 skipped、退出0（`.workbuddy/full-test-after-loopback-fix.log`）。仍为离线证据，不得写真实PG通过。下一步再跑一次 `node scripts/accept-database-local.js`（npm 受执行策略限制，用 node 直接调脚本）争取 passed。
>
> **2026-11-13 首次真跑失败已定位到身份断言并补字段级诊断**：报告 `.workbuddy/database-acceptance-mwea3nkn_60b7d6.json` 为 failed，唯一失败子项 `local-mock-route-postgres`，只留 `LOCAL_CHECK_FAILED` + `tests/fixtures/local-mock-route-postgres.cjs:25`，且缺少 `本地mock快照准备` 前置记录 ⇒ 失败发生在四个路由列的授权与任何写入之前，卡在 `assertAcceptanceIdentities`。其余 89 项（管理员只读探测、四角色与空库、迁移链、Web/Worker 列级权限正反例、执行器、撤销/授权）全部 passed，MFA 开关未开 skipped，环境本身正常。已把 8 个条件的一刀切报错改成逐字段 AssertionError，消息形如 `identity[1] fields: database_owner`，只含序号与字段名、不含任何身份值，且未放宽校验强度；新增一项离线断言校验该消息不泄露身份值。证据：三文件 29/29、全量 `npm test` 452 项 450 pass/0 fail/2 skipped、退出0（`.workbuddy/full-test-after-identity-diag.log`）。仍是离线证据，不得写真实PG通过。下一步：用显式 `LOCAL_DATABASE_ADMIN_URL` 重跑一次 `npm run test:db:local`，按报告 hint 指出的字段修真正原因后再复跑至 passed。
>
> **最新PG验收准备**：local-mock-route-postgres.cjs接入accept-database-local随机新库fixture流程，实际三身份校验后临时授予四列INSERT，覆盖快照落库/重放/并发、图片视频执行、UPDATE42501、篡改拒发、未知同键恢复与历史Provider冲突，migration精确清理并撤销授权。入口去掉隐式.env加载，仅接收显式LOCAL_DATABASE_ADMIN_URL。4项新守卫+9文件离线72/72、3文件语法通过，日志local-mock-route-offline-20261112.log及local-mock-route-syntax-20261112.log已读回。变量缺失，未运行真实PG，不得写DB通过。下一步管理连接可用后运行test:db:local；fixture不是HTTP/独立Worker进程闭环，mock内存恢复不跨进程，调用账本完整路由审计尚未覆盖。无既有业务库或真实Provider访问。
>
> **最新Worker本地快照选路（16.18）**：可信selector启动时固化image/video批准快照，executor在SQL前校验模型FK/业务ID/operation/版本/hash/完整快照，拒绝缺selector或篡改快照，旧全NULL任务兼容。CLI在Pool前建立selector，启动器仅显式选项传Worker guard。恢复核对provider_name，冲突不派发、不改写unknown或幂等键，调用租约自然到期；生产精确实例/版本账本绑定尚待实施。七文件93/93回归、六文件语法通过（worker-local-route-test.log、worker-local-route-syntax.log），无真实PG/Next/Studio/Provider验收。下一步真实新隔离库任务快照/权限/恢复验证，再接Studio；显式管理URL当前缺失，不猜凭据。任务入口暂缓、写API关闭，生产ACL未完成。下方“Worker未按快照选路”仅指此前状态或生产多Provider能力。
>
> **最新本地mock接线**：localMockCatalog提供固定image/video合成路由；app/api/tasks POST仅在development+内部guard+显式PAINTTRACK_LOCAL_MOCK_ROUTING=1下装配可信catalog，非法环境503，未开关保留兼容路径。local-registration新库写入禁用合成模型FK身份，仅向新建本地Web角色补四列快照INSERT，未授予快照UPDATE/配置写权限，未改通用runtimePermissions。源模型对象冻结。6文件57/57定向回归通过（`.workbuddy/local-mock-routing-final-test.log`），四文件语法通过；SQL替身不是实际PG权限证据。当前管理连接存在性false（`.workbuddy/local-mock-routing-db-precheck.log`），未运行DB或重启服务。下一步Worker按快照校验/选择mock Provider，后续补真实隔离DB及Studio接线；任务入口/页面暂缓，生产部署后置、Provider写API关闭。下方无快照/app未装配等描述为历史。
>
> **启动器管理入口已修正**：local-registration仅接受显式LOCAL_DATABASE_ADMIN_URL并校验loopback:5433/postgres，拒绝host/port等覆盖参数，派生连接复用批准端点。3项新测试加环境回归26/26通过（`.workbuddy/local-admin-url-test.log`），两文件语法通过；真实CLI缺失/非法URL在探测文件/端口/加载pg前退出且不回显凭据。未连接数据库或启动服务；仍需提供显式URL并确定.env处理，不能自动读取/移动该文件。下方硬编码入口描述为修复前历史。
>
> **最新本地优先路线**：用户确定生产部署后置，先本机单实例内部验证。预检日志 `.workbuddy/local-preview-preflight.log`：Node v22.22.2、Next/pg已安装，3000/3001空闲、5433有TCP监听；LOCAL_DATABASE_ADMIN_URL缺失且根.env存在（未读内容）。启动器拒绝.env，provision还写死无密码postgres连接；本轮未启动服务、未认证数据库、未创建资源。下一步修启动器为仅用显式loopback:5433/postgres管理URL并补离线测试；不读取/移动.env或猜默认身份。Studio任务快照/动态路由及生成表单接线仍未完成，写API关闭，生产秘密边界仍未验收。
>
> **最新生命周期收口（16.16）**：实际runWorkerProcess已接onHostLifecycle，rotate为gate.drain→worker.stop，revoke为gate.revoke→worker.stop；支持轮换升级撤销及幂等，finally关闭Pool/gate/秘密。新增4项组合测试与回归82/82通过，日志 `.workbuddy/worker-host-lifecycle-final.log`，两文件语法通过。使用内存队列/账本替身，无真实PG、Provider或OS信号验收；Worker宽限可能比排空期限更早结束，不自动创建新版本Worker。下一步确认生产平台/地域、秘密后端、Worker身份和撤销时限后接线；整体边界未完成、写API关闭。
>
> **当前续接入口（优先于下方数据库阶段历史）**：4.7.5数据库身份拆分已完成；后续Secret boundary已实现本地秘密IPC、显式resolver、Worker bootstrap、Next环境隔离和旧env凭据入口退役。调用闸门及六项竞态修复见设计稿16.15：本次定向复跑78/78通过，日志 `.workbuddy/provider-invocation-gate-verified.log`；旧修复日志最终83/83，首轮失败仍保留。历史unknown/submitting拒发后保留未知和原幂等键。组合测试使用内存SQL替身，本轮未做真实PG验收。下一步可信宿主撤销/轮换编排收口，生产秘密后端/身份/ACL仍待确认；整体Secret boundary未完成，写API关闭。下方“仍从环境变量读取”的描述仅为4.7.5完成时历史，已被16.12退役实现取代。
>
> **最终状态：4.7.5本地实现和真实隔离验收完成。** 报告 `.workbuddy/database-acceptance-mwcyonlg_45f52d.json` passed，108 passed/0 failed/0 skipped（4条running为开始事件），含MFA；日志 `.workbuddy/phase4-4.7.5-final-with-mfa.log`，退出0。53定向单测和6文件语法/限定diff检查通过。五fixture身份、完整Worker清理和fencing探测身份已修正，未扩大授权。原四项待验证已闭环，完整Worker并发/恢复/停止/连接释放通过。下一步Secret boundary，Provider写API仍关闭，凭据仍环境变量，owner/migration仍可改审计。以下各时点记录仅为历史，不能作为当前失败/待办。
>
> 10:51 最新实测：补齐清单后test:db:local退出1，报告 `.workbuddy/database-acceptance-mwcybt19_7ad662.json` failed，75 passed/1 skipped/7 failed记录（5fixture+汇总+终止）。Worker列级权限及该段42501越权负例通过，Web权限回归通过；完整Worker并发恢复未执行到。5个fixture权限错误见设计稿15.2最新条目；MFA可选验收跳过。下一步只定位fixture身份和准备SQL冲突；本轮未改代码或再次重跑。4.7.5仍未完成。
>
> 10:47 最新代码状态：仅补齐验收脚本Worker显式expected的30项漏项（155→185），授权代码和越权负例不变。语法/脚本diff检查退出0，独立离线日志 `.workbuddy/phase4-4.7.5-worker-expectation-offline.log` 为185/185、missing/extra为空、退出0。未跑程序单测或数据库验收，最新真实报告仍failed，下一步待确认后运行一次真实隔离验收。
>
> 10:12 只诊断补充：实时探针因管理变量缺失blocked；离线捕获授权SQL并按0021 snapshot展开，对照expected得到185对155，missing=[]、extra30（邮件9、逻辑模型2、调用INSERT19）。属于当前表级授权与手写窄列期望不一致，完整离线日志 `.workbuddy/phase4-4.7.5-worker-permission-diagnosis.log`；未改代码、未重跑。下一小步修显式期望清单以符合15.1现有边界，不扩大授权。
>
> 10:09 最新实测（优先于下文）：修正后重跑一次 test:db:local，日志 `.workbuddy/phase4-4.7.5-db-recheck.log`，退出码1；报告 `.workbuddy/database-acceptance-mwcwtoqq_754590.json` 为 failed，34项passed，Web权限/审计正反例、migration结构约束、Worker独立结果写正例和Drizzle事务均通过。当前停止于脚本889行Worker列级权限比对（missing=[]、extra非空，hint截断），后续Worker越权与完整并发恢复未验证。下一小步定位清单差异，本轮未改代码或再次重跑。隔离库及四角色按策略保留。
>
> 后续修正补充：验收脚本已拆开 Web 权限正反例、migration 结构约束与清理、Worker 独立连接结果写正例；Drizzle 提交夹具不再用 Web DELETE。node --check 与限定脚本 git diff --check 退出码均 0，日志 `.workbuddy/phase4-4.7.5-identity-fix-check.log`。未重跑数据库，最新实测仍 failed；下一步待单步确认后重跑一次 test:db:local，不扩大运行权限。
>
> 10:00 执行补充（优先于下文执行前快照）：管理连接已可用，已在嵌套根运行一次 `npm run test:db:local`，退出码 1；报告 `.workbuddy/database-acceptance-mwcwiaua_78f510.json` 为 `failed`，20 项 passed，终止于 `scripts/accept-database-local.js:405` 的 Web assets INSERT，错误码 `42501`。Worker 权限及后续检查未执行到；4.7.5 仍为实现中、验收失败待修正。下一步先定位此失败，不得直接宣称通过。隔离库及报告列出的四角色按脚本策略保留。本轮未修改代码、未重跑。

## 0. 上位文档（先确认层级，别只看这一份）

本项目有两层文档，职责不同，**都不能漏**：

| 文档 | 位置 | 职责 |
| --- | --- | --- |
| **开发流程与验收规范（总纲）** | `F:/111/QAQ/me/AI Agent/Hub/PaintTrack/PaintTrack/docs/ImplementationPlan/PAINTTRACK_DEVELOPMENT_PROCESS.md` | 阶段划分、执行协议、门禁、当前执行快照（3.0.3）、下一步（10.4）、阶段速查表。**它决定"能不能做、做到哪算完"** |
| 本交接单 | `PaintTrack/docs/records/HANDOFF_PHASE4_4.7.5.md` | 只看当前小步骤：改了什么、验了什么、下一条命令。**它决定"这一步具体怎么接着做"** |
| 小步骤设计稿 | `PaintTrack/docs/records/PHASE4_STEP2_MODEL_CATALOG_ROUTING_DATA_DESIGN.md` 第 15 节 | 本轮权限边界的详细设计与实测状态（14.2 节是旧结论，仅作历史） |

注意总纲在**仓库之外**（外层 `Hub/PaintTrack/doc/`），不随仓库 Git 提交。改阶段状态时**必须同步更新总纲第 10.4 节与阶段速查表**，不能只改仓库内的设计稿——这是本项目的固定规矩（见总纲「记录与证据归档规则」）。

## 0. 现状一句话

Web/Worker/Migration三身份拆分已完成本地实现和真实PostgreSQL隔离验收，最终报告mwcyonlg_45f52d为passed（108项、无失败/跳过），定向单测53/53。下一步为Provider Secret boundary，不开放Provider写API，不宣称生产部署已完成。

## 1. 环境坑（先看这条，否则会浪费半小时）

项目根目录是**嵌套**的：

```
F:/111/QAQ/me/AI Agent/Hub/PaintTrack/PaintTrack     <- 真正的仓库根
F:/111/QAQ/me/AI Agent/Hub/PaintTrack                <- 外层，不是仓库
```

- 在**外层**目录跑 `node --check scripts/xxx.js` 会报 `MODULE_NOT_FOUND`；输出重定向还会把日志写到外层 `.workbuddy`，然后你读到空文件，极易误判成“检查没通过”或“被沙箱拦了”。
- 所有命令先 `cd "F:/111/QAQ/me/AI Agent/Hub/PaintTrack/PaintTrack"`。
- 本环境 `git status` 显示大量 modified/untracked 是既有工作区状态，**不要清理、不要回滚**。

## 2. 已完成的代码改动

| 文件 | 改了什么 |
| --- | --- |
| `lib/server/worker/index.js` | Worker 连接改 fail-closed：只接受显式入参或 `PAINTTRACK_WORKER_DATABASE_URL`，删除 `getEnvironment().databaseUrl` 回退，缺失时抛错不建连接 |
| `lib/server/db/runtimePermissions.js` | 拆为 `grantWebRuntimePermissions` / `grantWorkerRuntimePermissions`；旧入口 `grantRuntimePermissions(..., { worker: true })` 保留签名但抛错 |
| `lib/server/env.js` | 解析并校验 `PAINTTRACK_WORKER_DATABASE_URL`，返回 `workerDatabaseUrl` |
| `lib/server/db/testIsolation.js` | 导出 `assertDistinctRuntimeIdentity`：同目标、用户名必须不同 |
| `scripts/local-registration.js` | 建 migration/runtime/worker 三角色；Worker 连接串不进 Next 子进程环境，改由 `createWorkerEnvironment()` 单独构造；Worker 进程仅 `PAINTTRACK_LOCAL_WORKER=1` 时启动 |
| `scripts/accept-database-local.js` | 建 `pt_worker_<suffix>` 角色与 URL；新增 `checkWorkerRolePrivileges`；Web 侧加审计 append-only 正反例；`checkPostgresWorkers` 改用 Worker URL 且 `main()` 已补传 `workerUrl`；`pg_stat_activity.usename` 期望改为 Worker role |
| `tests/fixtures/worker-postgres.cjs` | 用 `PAINTTRACK_WORKER_DATABASE_URL`；起 pool 前独立连接执行 `SELECT current_user` 经 IPC 上报 `identity` 事件 |
| `tests/localRegistrationLauncher.test.js` | 新增 Worker 环境隔离用例（含 Worker URL、不含 Web/Migration URL 与 Provider 凭据、保留 PATH、缺 URL 抛错） |

权限边界实际内容：

- **Web**：`provider_config_audit_events` 仅 `INSERT`；`generation_tasks` 仅取消四列 `UPDATE`（`status`/`cancel_requested_at`/`completed_at`/`updated_at`）+ 建任务列 `INSERT`；`email_outbox` 仅 `INSERT`；`provider_calls` 无权限；目录只能读安全投影 `model_catalog_public`。
- **Worker**：`generation_tasks` 执行列 `UPDATE`；`provider_calls` `SELECT`+`INSERT`+执行列 `UPDATE`，**无 `DELETE`**；`email_outbox` `SELECT`+`UPDATE`；保留目录/路由读权限；**无**审计表任何权限。

## 3. 已验证 / 未验证

已验证（可复述为通过）：

- 四个文件 `node --check` 通过：`scripts/accept-database-local.js`、`scripts/local-registration.js`、`tests/fixtures/worker-postgres.cjs`、`lib/server/worker/index.js`。
- 定向单测通过：`node --test tests/localRegistrationLauncher.test.js tests/databaseLifecycle.test.js tests/serverEnvironment.test.js tests/worker.test.js` → 53 pass / 0 fail。

**未验证（不得说成通过）**：

1. 真实 PostgreSQL 隔离库验收本轮未重跑。
2. `checkWorkerRolePrivileges` 里手写的列级期望清单与 `information_schema.column_privileges` 实际展开是否逐条一致，未实证。
3. Web 权限清单（`checkDatabase` 中 `fullDmlTables` 那套）仍按旧的合并身份书写，需按拆分后身份回归。
4. Worker 越权负例的报错码是否稳定为 `42501`（而非先撞上其它约束）未实证。

## 4. 下一步（按这个顺序做）

```bash
cd "F:/111/QAQ/me/AI Agent/Hub/PaintTrack/PaintTrack"

# 1) 先确认本地隔离 postgres 管理员连接可用（loopback:5433，库名 postgres）
#    需显式提供，脚本不会去猜 DATABASE_URL / TEST_DATABASE_URL
export LOCAL_DATABASE_ADMIN_URL='postgres://<admin>@127.0.0.1:5433/postgres'

# 2) 跑真实隔离验收（只新建随机隔离库，不碰既有业务库）
npm run test:db:local
```

3. 按报告 `.workbuddy/database-acceptance-<suffix>.json` 的失败项修权限清单——大概率要改的是 `checkWorkerRolePrivileges` 的 `expected` 数组（列级展开方式）和 `checkDatabase` 的 Web 表级清单。
4. 修完重跑，直到 `status: passed`。
5. 回填文档第 15 节：把「未验证」三条改成实测结论或注明差异原因。

相关文档：`docs/records/PHASE4_STEP2_MODEL_CATALOG_ROUTING_DATA_DESIGN.md` 第 15 节（第 14.2 节是旧结论，仅作历史）。

## 5. 硬约束（不能违反）

- 不开放 Provider 配置写 API，它仍是后续步骤。
- 不连接真实 Provider、不访问公网。
- 不访问或修改既有业务数据库（`painttrack_dev` / `painttrack_test` / 生产）；真实验收只在脚本自建的 loopback 隔离库内。
- 不覆盖工作区其它既有改动。
- **Provider Secret boundary 未完成**：凭据仍从 `PAINTTRACK_PROVIDER_CREDENTIAL` 等进程环境变量读。数据库角色拆分不能证明 secret 读取隔离，任何表述都不得说成 Secret Store 隔离已完成。
- 审计 append-only 只约束 Web/Worker；表 owner 与 migration 身份仍可修改，不得声称任何人都无法篡改。
