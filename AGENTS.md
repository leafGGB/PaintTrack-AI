# AGENTS.md — PaintTrack AI 会话入口

任何 AI 编码会话在本仓库动手之前，先读这三份，按序：

1. `docs/ImplementationPlan/PAINTTRACK_ONBOARDING.md` — 项目现状、文档地图、环境搭建、常见坑
2. `docs/ImplementationPlan/PAINTTRACK_DEVELOPMENT_PROCESS.md` — 总体执行顺序与门禁（先看 §10.4 和文末「阶段状态速查」）
3. `docs/records/HANDOFF_2026-11-17.md` — 当前阶段 6 交接（`HANDOFF_2026-11-16.md` 为历史记录；`HANDOFF_2026-11-13.md` 仍对阶段 5.x / 本地环境细节有效）

要动具体阶段，再加读 `docs/records/PHASE*.md`；涉及数据库加读 `docs/records/DB_SETUP.md`。

## 当前阶段

本节只给流程入口，不复制阶段/任务快照。当前任务及授权状态统一查看总体计划 §10.4 最新当前执行卡；历史内容均不构成下一步授权。

> **权威流程与当前任务：**以 `docs/ImplementationPlan/PAINTTRACK_DEVELOPMENT_PROCESS.md` §10.4 最新“当前执行卡”为唯一依据。此文件及下方历史段落不定义当前任务、授权或下一步；阶段速查仅作摘要。开工前必须按该文件 §10.0 执行状态/授权/依赖/证据核验，并检查 Git 工作树及目标文件 diff。
>
> **#134/#170状态：**旧文档所述“#134 当前执行中”已过期；#134 与 #170 范围不同，不构成两个并行当前入口。#170 的真实 Provider 调用状态及授权前置以总体计划 §10.4 当前执行卡为准；不得仅凭任务列表状态发起真实请求。

### 历史阶段快照（以下各条的“当前”和“下一步”均为当时状态）

> **历史入口：0031 收费金额数据库复算已通过真实隔离 PG 验收（阶段稿 §4.3.26 / HANDOFF_2026-11-17）。**报告 `.workbuddy/database-acceptance-mwkeg1wc_0f3ca9.json` 顶层 `status=passed`，验证 0020→0031 十一条追加迁移及账本、报价、冻结、结算、发放和收费提交 fixtures；仅可选 `admin-mfa-postgres` 检查 skipped。0031 复用既有价格计算函数，数据库首次报价按任务输入与价格版本复算金额，正价伪造零价被拒且不留报价/冻结；真实零价只落零报价、不开户、不冻结、不写账本；幂等重放返回原报价。运行角色只能执行 verified wrapper，不能执行旧收费函数，Worker 无账务执行权；授权步骤事务化并在失败时整体回滚。本地收费开关只由显式 launcher 选项传给 Next 子进程，默认关闭。全量测试 719 项（717 通过、2 跳过、0 失败），lint 0 errors、11 条既有 warnings。边界：生产可信目录未接入，结算触发点未接线，余额/账单 UI、自动赠送、支付/充值、部分结算与退款未完成；报告不证明既有业务库升级或生产收费可用。
>
> **历史入口：额度发放CLI已通过真实隔离PG验收（2026-11-17，§4.3.24 / HANDOFF §30）。**新增`scripts/grant-credit.js`（npm脚本`credit:grant`）与`lib/server/tasks/creditGrantCli.js`，提供`grant`/`balance`两个动作；迁移0029让`credit_ledger_events.task_id`可空、把`shape_check`拆成任务族与`grant`族，并新增owner专属`credit_grant(p_user_id,p_credit_tenths,p_source_type,p_source_id)`：发放即开户、单语句加额防溢出、幂等键`grant:<来源>:<来由>`、同来由换金额或换用户报`CREDIT_GRANT_CONFLICT`；未知用户由`credit_accounts`外键裁决（owner不持有`users`读权限）。账本任务归属触发器改用新函数`credit_check_ledger_task_owner`并加`WHEN (NEW.task_id IS NOT NULL)`（迁移身份INHERIT FALSE，既不能替换owner所有也不能授权原函数）。运维身份用`LEDGER_DATABASE_URL`（保留`PUBLISH_DATABASE_URL`兼容），金额上限在连库前拒绝。报告`.workbuddy/database-acceptance-mwk5isye_451074.json`顶层`passed`（149项，仅`admin-mfa-postgres`skipped）。边界：未接HTTP收费入口（本条已被上一条取代）；注册赠送仍默认关闭，额度只能由运维命令显式发放；无余额/账单UI、免费报价仍拒绝、无支付与退款。
>
> **历史入口：价格版本发布CLI已通过真实隔离PG验收（2026-11-17，§4.3.23 / HANDOFF §29）。**新增`scripts/publish-pricing.js`与`lib/server/tasks/pricingPublishCli.js`，提供`publish`/`cancel`/`revoke`/`timeline`四个动作；`publish`支持`--dry-run`（只做本地校验，不建立连接），配置走JSON文件，生效时间只接受整秒（ISO 8601或`@秒`）。权限模型沿用`migrateDatabase`既有范式：使用独立管理员身份`PUBLISH_DATABASE_URL`（必须与`DATABASE_URL`同库、本机回环、且与运行/迁移/Worker/cleanup身份不同），连接只在显式事务内`SET LOCAL ROLE`到`pt_ledger_owner_<hash>`，事务结束自动失效；**不GRANT任何角色、不新增长期owner连接、不新增HTTP入口**。事务外语句按`PRICING_SESSION_UNBOUND`拒绝，切角色失败回滚并`42501`。报告`.workbuddy/database-acceptance-mwk4mnjp_dd5288.json`顶层`passed`（140项，仅`admin-mfa-postgres`按开关skipped），夹具验证发布、同参重放、同名异内容`VERSION_CONFLICT`、同秒`23505`、已过时间`EFFECTIVE_TIME_INVALID`、未知模型`NO_ACTIVE_VERSION`、模板不匹配`TEMPLATE_MISMATCH`、未生效取消幂等、取消后禁止撤销、生效后撤销、只读时间轴，以及Worker身份尝试`SET ROLE`被`42501`拒绝、发布结束后管理员会话身份复原、运行/Worker/cleanup仍对定价表零读写。全量698项696通过0失败2跳过；lint零错误11条既有警告。边界：**未接HTTP收费入口、未接结算触发点、无余额/账单UI、无赠送/支付、免费报价仍拒绝**；本入口是运维命令，项目当前仍无`/admin`页面。
>
> **历史入口：终态结算扫描已通过真实隔离PG验收（2026-11-17，§4.3.22 / HANDOFF §28）。**新增迁移`0028_credit_settlement_sweep.sql`与只读函数`credit_pending_settlements(p_limit)`（`STABLE SECURITY DEFINER`、owner所有、仅owner可执行）：列出"任务已到终态、已冻结、尚未裁决"的候选，结局由任务状态唯一决定（`succeeded`→`settle`，`failed|cancelled`→`release`），批次限制1..500，越界按`CREDIT_SWEEP_LIMIT_INVALID`拒绝。JS侧`createCreditSettlementStore`新增`pending({limit})`与`sweep({limit})`：每笔裁决独立事务，已登记的业务拒绝记录后继续，未知错误上抛，重复扫描自然为空。不新建表、不改schema（0028快照与0027内容一致）；冻结表只补列级`SELECT(task_id,user_id,credit_tenths,reserve_event_id)`，仍不可改/删/清空。真实报告`.workbuddy/database-acceptance-mwk41xpd_af2e80.json`顶层`passed`（132项，仅`admin-mfa-postgres` skipped）；新夹具用**真实Worker函数**（`claimNextTask`+`completeTask`/`failTask`/`cancelClaimedTask`）把三个任务推到三种终态后，由账本宿主扫描收敛为一结算两释放，余额`0/21`→`14/0`，账本6条、裁决3行，重复扫描为0，Web/Worker/cleanup与迁移身份调用扫描或裁决均`42501`。全量690项688通过0失败2跳过，lint零错误11条既有警告。仍未接HTTP与常驻定时器（触发点仍是账本宿主显式调用）；Worker无任何账务写权；无部分结算、赠送、支付或收费UI；免费报价仍按`CREDIT_FREE_RESERVE_UNSUPPORTED`拒绝。
>
> **历史入口：冻结额度终态裁决（settle/release）已通过真实隔离PG验收（2026-11-17，§4.3.21 / HANDOFF §27）。**新增迁移`0027_credit_settle_release.sql`与函数`credit_finalize_task(user_id,task_id,outcome)`：只允许专用`NOLOGIN` ledger owner执行，按任务终态一次性全额结算或全额释放，并用 advisory lock + `credit_settlements`主键保证每个任务只有一个终态。`credit_reservations`仍完全不可变，终态只追加到`credit_settlements`；账本`kind`收紧为`reserve|settle|release`，`idempotency_key` 必须为`kind||':'||task_id`，唯一索引由`(task_id)`改为`(task_id,kind)`。只对成功任务结算、只对失败/取消任务释放，排队/执行中、反向裁决、不存在冻结一律拒绝且不写账本；不做部分结算，金额一律取自冻结记录而非调用方。真实报告`.workbuddy/database-acceptance-mwk3g2tx_90b67a.json`顶层`passed`（131项，仅`admin-mfa-postgres` skipped）；夹具验证结算/释放各一次、重放返回原事件且余额不变、反向与未终态拒绝、裁决历史不可改/删/清空、未知kind被CHECK拒绝、Web/Worker/cleanup与迁移身份均`42501`。全量684项682通过0失败2跳过，lint零错误11条既有警告。仍未接HTTP/Worker入口、未实现赠送、支付或收费UI；免费报价仍按`CREDIT_FREE_RESERVE_UNSUPPORTED`拒绝。
>
> **历史入口：原子任务已强制绑定可信路由快照（2026-11-17，§4.3.20 / HANDOFF §26）。**`createAtomicTaskPricingStore` 现在**构造期强制**要求 `routeResolver`，`submit` 不再接受调用方传入的 `route`；解析结果必须同时满足：`logicalModelPk` 为 UUID、`routeSnapshot` 为对象、`routeSnapshotVersion` 为正整数且等于 `snapshotVersion`、`routeSnapshotHash` 为64位十六进制且与 `sha256(stableStringify(snapshot))` 一致、快照 `logicalModelId`/`capabilitySnapshot.operation` 与请求一致，并在事务内二次校验 `logicalModelPk === 锁定模型id` 且 `logicalModelVersion === catalog_version`。任一项不满足即 `MODEL_ROUTE_REQUIRED`/`MODEL_ROUTE_INVALID`/`MODEL_ROUTE_HASH_MISMATCH`，**事务外拒绝**，不产生 task/quote/reserve。无新迁移、无权限变化。最新报告`.workbuddy/database-acceptance-mwk3440i_951e83.json`顶层`passed`（130项，仅`admin-mfa-postgres` skipped）；原子夹具同时断言任务路由四列非空、重放不重新解析且原快照不变。全量677项675通过0失败2跳过，lint零错误11条既有警告。仍未接HTTP、未实现settle/release、赠送、支付或收费UI；免费报价仍拒绝。
>
> **历史入口：0026 task+quote+reserve 原子链真实隔离PG验收已通过（2026-11-17，§4.3.19 / HANDOFF §25）。**最新报告`.workbuddy/database-acceptance-mwk24fug_a38ca5.json`顶层`passed`，130项检查中仅`admin-mfa-postgres`按显式开关`skipped`。新隔离库完成0020→0026六条追加迁移，原子冻结夹具验证：task/quote/reserve同事务提交、同键重放、同键异请求拒绝、余额不足整体回滚、并发冻结不超额，以及Web/Worker/cleanup/migration均无法调用账务写路径。本轮真实修复两处越权假设：`credit_reserve_task()`内报价查询去掉`FOR SHARE`（行锁子句要求超出最小权限的表级UPDATE），余额判定改为`UPDATE ... WHERE available_tenths>=p RETURNING *`单语句原子扣减；账本事件`RETURNING id`补`SELECT(id)`只读授权。全量675项673通过0失败2跳过，lint零错误11条既有警告。范围限制：**未接HTTP入口、未实现settle/release、赠送、支付或收费UI；免费报价`credit_tenths=0`当前按`CREDIT_FREE_RESERVE_UNSUPPORTED`拒绝；任务暂不强制可信路由快照**。证据仅覆盖本次新隔离库与报告所列检查，不证明既有业务库升级。
>
> **当前入口：0025报价持久化真实隔离PG验收已通过（2026-11-16，§4.3.18 / HANDOFF §24）。**最新报告`.workbuddy/database-acceptance-mwj1zu0t_80be75.json`顶层`passed`；新隔离库迁移追加/历史快照、0025报价权限、锁等待后数据库时钟采样、并发/幂等重放、不可变快照、撤销不回退及失败零任务/账务写入等检查均通过。`admin-mfa-postgres`本轮为`skipped`（未显式开启）。此前首次失败报告`database-acceptance-mwj16hbs_d03903.json`及保留的隔离资源仍是修复历史，不复用或自动清理。全量673项671通过0失败2跳过，lint零错误11条既有警告。此证据仅覆盖本次新隔离库与报告所列检查，不证明既有业务库升级或完整task+quote+reserve、settle/release、支付/收费链；Web/Worker/cleanup零新增授权，owner与可信JS宿主共同受信，DB不重算hash/金额。下一步由用户另行确定，不自动扩展功能。

> **当前入口（2026-11-16）：可信报价计算与内存快照切片已完成，见阶段稿§4.3.15、HANDOFF §21。**新增pricingQuote.js及43项测试；显式版本配置、BigInt有理数、最终ceil、最新头撤销不回退、有效期与深冻结/hash快照已实现。全量647项645通过0失败2跳过；lint零错误、11条既有警告。纯模块尚未接数据库模型锁/clock_timestamp采样、价格或quote持久化、task+quote+reserve原子写入，不能据此宣称真实PG报价验收或收费可用。此前owner共用路径PG报告passed仍仅证明其原范围。下一候选是价格版本及quote持久化与事务接线的小切片，需按单步节奏另行推进；下方“报价下一候选/尚无quote”已局部被本条取代，历史保留。

> **当前验收更新（2026-11-16）：**本地owner准备共用路径真实PG复验已通过，报告`.workbuddy/database-acceptance-mwitu7md_e8013e.json`顶层passed，0024升级、临时成员撤回、运行角色拒绝账务调用及账本约束均passed；admin-mfa-postgres本轮显式未开启而skipped。取代下方“新接线待PG”状态，不代表普通启动器现有库升级或收费链已验收。下一候选实现可信报价快照的最小代码切片，再接task+quote+reserve原子协调；本次仅记录验收，不开工新功能。

> **当前入口：本地owner准备代码接线完成（§4.3.14），待新一轮真实PG。**原0024报告database-acceptance-mwirzzwn_9872fa.json顶层passed；本次普通启动/迁移/隔离验收已共用严格owner准备、锁内临时SET与finally撤回，db:migrate也需显式LOCAL_DATABASE_ADMIN_URL，604项602通过0失败2跳过。未操作现有业务库，新接线不能沿用旧PG报告宣称通过；下一步新隔离库复验。下方“普通启动未接线/原0024 blocked”为历史。无reserve/支付/收费新增，无运行角色扩权。

> **当前入口：窄函数账本基础代码已实现，真实PG验收blocked（§4.3.13）。**用户已授权本轮0024/基础schema及内部函数，取代下方“账本/0024均未授权且不存在”。没有实现reserve写入口，仅零账户初始化和已有reservation重放核验，均未向Web/Worker/cleanup授调用权。全量577项575通过0失败2跳过；真实报告database-acceptance-mwiqwlb1_6f32ed.json顶层blocked、created=[]，缺显式管理员连接。0024需专用NOLOGIN owner准备，普通本地启动/直接迁移尚未接线，禁止默认应用既有库；下一步优先显式连接的全新隔离PG验收，不叠加功能。赠送/支付/收费入口仍关闭。

> **当前入口：首个参数代码切片已完成（2026-11-16，设计稿§4.3.12）。**用户明确授权并已实现logicalModelId/outputCount/durationMs/fps提交契约、Studio接线及测试；当前单图outputCount必须显式为1，视频仅可信声明匹配的mock，不含真实视频UI/多输出。572项测试570通过/0失败/2跳过，非真实PG证据。下方“参数代码未授权”已被本条局部取代；账本/0024/赠送/支付/收费及权限变更仍未授权。下一候选回到账务执行边界选型与逐动作契约，不把本次参数授权扩大到计费实现。

> **2026-11-16 门禁审查后的当前入口：**阶段设计稿 §4.3.11 已区分继续设计、实现授权和能力启用，并列出逐调用方最小能力与未来真实PG证据要求。生产Secret boundary、真实预算与金额等只阻断相应启用，不阻断另行授权的mock/本地开发；不能为此放宽Web/Worker/cleanup。下一候选只设计账务执行边界选型与逐动作调用契约，尚未选定数据库函数或独立身份；不新增微服务/岗位，不授权0024、参数代码、账本、支付或收费入口。以下入口为历史接续，既有单人规则不变。

> **2026-11-16 一致性复核后的当前入口（取代本节以下历史状态）：**阶段 6.2 已完成本轮设计参数确认及文档一致性修订，**不等于整体设计/权限评审通过，更不等于实现完成**。报价参数见阶段设计稿 §4.3.4 J/§4.3.6；赠送见 §4.3.6；反滥用与一次性邮箱拒绝注册见 §4.3.7 G.1、§4.3.8 E.1；单人 unknown 核对以 §4.3.10 为准。项目只有用户本人开发和运营：unknown 超过 30 分钟仅页面高亮，不引入工单、替补、多人审批或分级 SLA；证据不足继续冻结。具体价格/赠送金额不预设，赠送默认关闭。下一候选是独立审查实施前门禁与最小权限方案；参数契约扩展、账本、0024、支付及收费代码均未授权。以下时间条目和“三项待确认”摘要仅作历史追溯。

> 2026-11-16 10:04 当前更新（取代以下旧入口）：阶段6设计稿 §4.3.7 反滥用/申诉草案已形成，四组候选参数待用户确认，未实现/验收；下一步先确认再推进上游unknown人工SLA，不授权账本/0024。

> 2026-11-16 09:51 更新（以下旧摘要的待定数量已被本条取代）：赠送三项推荐已确认；报价四类阻断已形成修订，见阶段6设计稿 §4.3.6，尚未实现/验收。当前下一候选为反滥用阈值与申诉，之后 unknown 人工 SLA；审批复核仍留阶段8评审。

阶段 0–3 已完成，阶段 5.1–5.12 已完成，阶段 6.1 已完成；阶段 6.2 账本链（0024–0031）、HTTP 收费提交及数据库金额复算均已通过真实隔离 PG 验收。当前状态：**收费提交已实现但默认关闭（`PAINTTRACK_CHARGED_SUBMISSION`），生产可信目录未接入，结算触发点未接线，余额/账单 UI 未完成**。后续候选是先审查运行生命周期、启动恢复、重复触发及错误语义，再提出受限结算触发点实现切片；实现须另行确认。赠送仍默认关闭，支付/充值、部分结算与人工退款未完成。**不得因账本链验收通过而宣称生产可收费**。

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
