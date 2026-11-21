# PaintTrack 项目接续指南（新电脑 / 新 AI 会话入口）

> 最后更新：2026-11-21（审计后流程导航收敛；当前任务、授权和顺序只以总体计划 §10.4 当前执行卡为准，本文其余“当前/下一步”均为历史摘要）。
> 用途：任何新机器、新会话、新协作者从这份文档开始。本文**只做导航和现状摘要**，规则与验收细节一律以它指向的原文为准——不在这里复制细则，避免两处口径漂移。

---

## 0. 三十秒定位

> **当前入口：**当前任务与可执行下一步只看总体计划 §10.4 最新当前执行卡；本页其余任务状态、下一步文字均为按日期保留的历史快照，不构成授权。

> **2026-11-21 #169：**新增显式本机入口 `npm run dev:controlled-image`。在已配置 `LOCAL_DATABASE_ADMIN_URL` 的终端，另提供 `PAINTTRACK_CONTROLLED_IMAGE_PASSWORD`（自选至少 12 字符的临时测试密码）；等待 `CONTROLLED_IMAGE_READY`，在日志给出的地址用 `controlled-image@example.test` 登录并测试 **Controlled Synthetic Image**。每次启动新建隔离库，不复用日常 Mock 数据；正式 Next.js 与浏览器实机流程仍待验收，见总体计划 §10.4。

> **2026-11-21 #168 验收更新：**`.workbuddy/database-acceptance-mwq2uyp7_e551f8.json` 顶层与受控单图 HTTP 专项均 `passed`，取代下方待实跑状态。覆盖本机回环 HTTP、真实隔离 PostgreSQL、实际 Worker 单轮、合成 PNG 文件归档及授权读取；不含正式 Next.js、Studio 浏览器或真实供应商，见总体计划 §10.4。

> **2026-11-21 #168：**隔离回环 HTTP 合成单图夹具已接入 `npm run test:db:local`，涵盖登录、提交、Worker 单轮执行、文件归档与授权读取。164 项定向通过，真实隔离库待实跑，见总体计划 §10.4。

> **2026-11-21 #167 验收更新：**隔离 PostgreSQL 报告 `database-acceptance-mwq2h3zo_d08a98.json` 顶层和可信队列专项均 `passed`；快照相同、账号不同仍不能领取。下方 `blocked` 为历史，受控宿主的实际挂载及真实上游仍未验收，见总体计划 §10.4。

> **2026-11-21 #167：**受控单图宿主已接上同一固定目录、单账号提交/领取与私有归档配置，150 项离线通过；账号范围 SQL 待隔离 PostgreSQL 复跑，未挂载正式路由或调用上游。见总体计划 §10.4。

> **2026-11-21 #166 验收更新：**隔离 PostgreSQL 报告 `database-acceptance-mwq1z9qa_2ad4c7.json` 顶层和可信队列领取/租约恢复专项均 `passed`，下方 `blocked` 为历史。真实单图宿主和上游尚未接通，见总体计划 §10.4。

> **2026-11-21 #166：**可信单图 Worker 已接批准快照领取及显式历史版本恢复，149 项离线通过。隔离 PostgreSQL 因当前终端缺管理员连接而 `blocked`，须在已配置终端运行 `npm run test:db:local`，详见总体计划 §10.4。

> **2026-11-21 #165：**合成单图已离线贯通路由 HTTP 处理器、Worker 执行与私有归档；147 项定向通过。未接正式 Next 路由、真实 PostgreSQL 或上游。共享队列按批准路由领取和历史快照恢复仍是下一步，详见总体计划 §10.4。

> **历史快照（2026-11-21 #163，已由后续合成单图验收与总体计划 §10.4 当前执行卡取代）：**当时计划先补合成提交、执行与归档。本条只留历史，不表示 #163 仍是当前任务或授权。

> **2026-11-21 当前停点 #153：**Studio 顶层唯一“资产”入口与默认“全部资产 / 图片 / 视频”筛选已接线；全部资产由服务端统一排序分页，保留本人访问边界。58/58 离线定向、Studio 76 文件构建通过；真实 PG 与登录浏览器待验收。

> **2026-11-21 本人资产集合代码接线：**已新增GET /api/assets、assetsHttp/assetsQuery、assetsClient/useAssets/AssetsStudio及Studio assets入口；本人ready未删除图片/视频分页、预览、复用软删除及账号作用域失效通知连接Studio历史。组合54/54离线通过、Studio76文件构建通过（后续最终检查另记）；无新迁移/授权，不接上传/TaskCenter/真实Provider。尚未取得真实PG专项与用户浏览器验收，Hook/新页面完整交互矩阵仍待补，不标整体完成。

> **2026-11-21 当前施工：**用户明确授权本人资产集合，开发中：新增只读集合GET、Studio唯一资产tab及图片/视频分页预览删除同步。已有单项授权/内容/删除复用，不新建存储或平行任务入口，不接上传/真实Provider/收费。此前“候选未授权/未自动开工”已被本授权取代；未完成测试/浏览器验收前不得标通过。

> **2026-11-21 最新用户验收：**按dev:mock重启后用户反馈“测试完了，没问题”，本地Mock模型列表问题正向复验通过，视频参数视觉此前也已确认；下方“待重启验证/目录仍未闭环”仅历史。非真实Provider/生产证据。下一建议为本人资产集合列表，复用既有图片/视频预览、分页与删除，不新增平行入口；当前仅建议，未自动开工。

> **2026-11-21 模型列表修复入口：**用户已确认参数视觉恢复。当前图片/视频显示空目录，代码核对发现普通dev默认不启用Mock，Mock占位模型在数据库公共目录中刻意禁用；重启遗漏Mock开关会回到无正式模型的空目录。补充显式 `npm run dev:mock`（启动器 `--mock --worker`）以统一Mock准备、Next与Worker，不改变默认关闭、不自动fallback。当前进程实际开关未获确认，根因组合仍待用户重启正向验证；不假定接口已恢复，不开新库/清历史，不输出凭据。

> **2026-11-21 用户样式要求：**视频参数须恢复图片Studio同风格的底部紧凑按钮与弹出面板，撤回常驻四列表单。已移除常驻四列表单并恢复紧凑参数按钮/弹出面板，组件45项与目录联合61/61通过、Studio72文件构建通过；未做浏览器视觉验收。此项仅展示层纠偏，不改变公共参数提交、Mock固定限制或历史隔离，也不证明空目录已恢复。

> **2026-11-21 最新用户反例优先于下方离线修复结论：**用户再次报告图片/视频目录均空、生成按钮不可用，并指出视频参数消失；截图确认“No video models”且输入区缺少诊断。视频参数和输入区目录诊断已补回代码，图片对应输入区诊断和重试已补齐；客户端41/41回归通过，仍非浏览器验收。此前测试通过不证明现场生成已恢复。必须取得同一登录浏览器的 `/api/catalog/models?media=image` 与 `media=video` 响应，区分空目录、认证/权限拒绝与服务失败；不得自动补Mock或放宽认证。历史隔离的用户正向结论保留，生成专项仍未闭环。

> **2026-11-21 当前优先停点 #147：**用户 Chrome/Edge A/B 实测推翻了此前隔离验收的覆盖范围：同账号跨浏览器图片不恢复，切换账号仍显示前账号视频卡片。现已完成服务端 `studio-history` 窄投影及图片/视频统一账号历史 Hook；历史仅取当前会话本人成功且未删除的匹配归档，前端核对 accountId、取消旧请求/拒绝迟到响应，不回退浏览器旧历史；生成/删除后刷新，支持分页与失败重试。已修复并行合并产生的重复声明/DTO形状冲突，定向测试64/64、Studio72文件构建及diff检查通过。**用户随后确认历史隔离/恢复复验“没问题了”；真实 PostgreSQL 专项未补跑**。新增阻断为图片模型列表空及图片/视频生成按钮不可用，生成入口回归已完成前端修复及78/78定向回归、Studio72文件构建、lint零错误/13既有警告：图片清除保留公共logicalModelId；视频模型菜单和提交统一公共目录，旧工作流不再控制公共任务按钮；目录取消迟到保护和失败/空目录重试补齐。仍待用户刷新页面复验生成；未取得用户图片空目录当时的HTTP响应，不断言全部现场成因已确认。不把历史专项通过等同于整个Studio可用。下一步按原反例：Chrome登录B应恢复Edge生成的B两张图且无A视频；切回A恢复A两图一视频。无需清空缓存或迁移不明归属旧记录。真实Provider、收费、生产写和发布仍关闭。

> **当前入口（2026-11-20）：**此前管理员模型目录读取曾失败；完整重启本地启动器并重放准备后，用户确认“可以了，接下来该做什么了”，随后明确“开始下一步”，模型读取已恢复。**#141 Studio 三项运行问题修复已完成并通过真实本地浏览器验收**：公共目录 Mock 模型可见并可生成，账号 A/B 的图片与提示词互不可见；代码定向测试16/16通过，Studio包71文件构建通过。#142 Video Studio 文生视频模型身份统一已完成代码与离线验收：视频目录 Mock 可见，正式文生视频提交使用公共 logicalModelId、durationMs 和 fps；#143 已补齐视频任务轮询和结果 URL 校验，只有可播放结果才进入历史；#144 已让受保护 Mock Provider 使用仓库内 demo.mp4 经资产归档返回授权播放地址；I2V/V2V仍未接入公共任务 API。#122 的代码接线与离线证据保留但不升级：定向86/86；全量939项937通过、2项环境跳过、0失败；lint 0错误/13警告；双前缀模型页HTTP 200、匿名模型API 401。模型筛选、分页等未逐项验收，不把已登录模型HTTP/browser验证或后台验收完成写成已完成。内部目录 API 不依赖外部 Provider；价格读取、所有真实后台写操作、生产收费和发布保持关闭。
>
> **纠正提前完成记录：**上一轮曾写“#122 本切片已完成、已接入真实 transport 和页面只读展示”，但当时代码未接线、5 个测试被 skip；该完成结论已撤回，仅作被取代的历史记录，不能据此宣称实现或验收完成。

> **2026-11-19 历史记录：模型目录窄投影尝试因缺少管理员连接而停止，未交付。**当时环境未提供 `LOCAL_DATABASE_ADMIN_URL`、`DATABASE_URL`、`MIGRATION_DATABASE_URL`；按“缺管理员连接/权限停止”门禁，既有验收入口仅执行缺连接分支，报告 `.workbuddy/database-acceptance-mwn8pbu3_8aa5da.json` 顶层 `status=blocked`、`created=[]`、退出码2，未建立数据库连接、未执行PG夹具。曾新增但未接线的投影owner helper已仅撤回本轮部分，原账本owner/全部既有修改保留；无本轮SQL迁移、角色授权、投影函数或夹具交付，未接真实API/gateway/HTTP transport/UI来源，真实写操作仍关闭。
>
> 本轮仅既有三组离线定向回归：58项、57通过、1失败、0跳过（`.workbuddy/admin-models-projection-block-tests.log`）；失败为 `tests/creditFoundation.test.js:79` 的旧账务全禁断言与既有账户页列级只读授权冲突，本轮未改该权限或放宽测试。七相关文件ESLint通过且零输出（`.workbuddy/admin-models-projection-block-lint.log`）。未跑全量、未启动Next/浏览器，不构成投影/ACL/真实API验收。上一轮“仅设计、未获实现授权”仅授权时点被本条接续，历史证据保留；下一步需在显式安全连接具备后恢复SQL/角色/隔离夹具小步，投影真实PG通过前不接API，不猜密码、不借owner/Worker、不暂存不提交。

PaintTrack 是一个 AI 生成内容平台（图片/视频），fork 自开源项目 `Anil-matcha/Open-Generative-AI`，在其上重建了服务端：多人账户体系、任务队列与 Worker 执行、Provider 适配与调用账本、资产归档与生命周期清理、管理员权限与 MFA。

| 项 | 值 |
|---|---|
| 主仓库 | `github.com/leafGGB/PaintTrack-AI`（你的 fork，默认分支 `main`） |
| 上游作者仓库 | `github.com/Anil-matcha/Open-Generative-AI`（只读） |
| 技术栈 | Next.js 15 + React 19.2.4 + PostgreSQL + Drizzle ORM，Node 22 |
| 工作区包 | `studio` / `workflow-builder` / `ai-agent` / `design-agent`（另有 Electron 打包配置） |
| 本地开发库 | 固定库 `pt_local_auth_000000000000`，端口 **5433** |
| 历史最近全量回归 | **723 项**（721 passed / 0 failed / 2 skipped；2026-11-18）；保留历史结论，不覆盖本轮管理员用户只读切片 |
| 最近后台 UI 定向回归 | **五组68/68 通过**（0 failed / 0 skipped）；主代理最终独立复核日志 `.workbuddy/admin-pages-review.log`，含实际login源码深层admin目的地/MFA保留测试；仓库cwd核心四文件lint通过零输出；原四组60项 `.workbuddy/admin-module-pages-tests-final.log` 及12文件lint作为子集证据保留，不是浏览器/PG/新全量验收；历史31项`.workbuddy/admin-ui-refresh.log`保留 |
| 历史用户只读切片定向 | **39/39 通过**；`.workbuddy/admin-users-final.log`，含另两组账户测试，与 31 项范围不同；当前用户只读真实 PG/浏览器验收仍未完成 |

---

## 1. 现在做到哪里了

阶段 0–3 已完成。阶段 6.2 的账本、HTTP 收费提交链和独立本地结算宿主均已通过真实隔离 PostgreSQL 验收；账户中心已展示当前用户自己的真实余额与账单流水。阶段 8 已有 `/admin` 壳、汇总接口和用户列表/详情只读代码切片，均要求服务端 admin+MFA；本轮用户列表/详情尚未做真实 PG 验收。封禁/解封、会话撤销、风险事件/审计及其他写操作仍未开放。收费开关默认关闭，生产可信目录未接入，阶段整体仍不能宣称可生产收费。

| 阶段 | 状态 |
|---|---|
| 0 基线与项目身份 | 已完成 |
| 1 架构与基础设施决策 | 已完成 |
| 2 数据库与服务端基础 | 已完成 |
| 3.1–3.5 认证与管理员初始化 | 已完成（真实隔离 PG 验收通过） |
| 3.6 账户安全收尾 | 基础小步骤完成；真实邮件服务按决定延期 |
| 4 Provider 适配 | 4.7.1–4.7.5、4.3.1 SSRF 门禁已完成；**Secret boundary 未闭环，整体未完成** |
| 5 任务与状态恢复 | 5.1–5.12 全部完成（含资产归档、软删除、对象清理、孤儿回收、全站确认弹窗） |
| 6 账户中心与额度账本 | 6.1 身份 UI 完成；6.2 账本、结算扫描、定价/发放 CLI、HTTP 收费提交、0031 金额复算及独立本地结算宿主均已通过真实隔离 PG 验收；账户中心余额/账单读取已接入；收费默认关闭，支付充值与赠送仍未接线 |
| 7 上传与结果归档 | 部分完成：归档/清理/回收已做；交互式上传通道、生产对象存储、保留政策未做 |
| 8 管理后台 | 8.1及既有真实总览/用户只读、十模块中文浅色路由保留；analytics/models/providers/pricing的隔离Mock历史与其余四模块骨架保留。模型读取在完整重启本地启动器并重放准备后恢复；当前执行已授权的#134 Studio身份统一，实现中、尚未验收。#122代码/离线86/86及全量939/937/2证据保留，不升级为模型筛选、分页、已登录HTTP/browser或后台验收完成；内部目录API不依赖外部Provider。价格读取、所有真实后台写和生产收费/发布关闭，4.7.4/4.7.5原范围验收保留。
| 9–12 产品流程 / 工作流 / 合规 / 发布 | 尚未开始 |

### 阶段 6.2 已确认的规则（不要在实现中暗中改值）

- **最小单位 `0.1 credit`**，账本以整数十分之一 credit 原子单位记账，禁止浮点余额。
- **价格全部由后台管理员动态配置并版本化发布**，代码里不写死任何金额；任务创建时固定不可变报价快照，改价只影响新任务。
- 计价模板：图片 = 「分辨率分档 + 输出数量」；视频 = 「视频时长 + 帧率」。模板只定义结构，档位与系数归管理员。
- 报价计算：定点整数运算，正向费用向上取整到 `0.1 credit`，非零最低 `0.1 credit`，参数异常 `fail closed`（不回退低价）。
- 人民币可充值兑换积分，**积分不可兑换或提现为人民币**；兑换比例暂定，比例未定前充值/换算功能保持关闭。
- 注册赠送**默认关闭**，管理员控制开关与额度，只影响新用户；发放前必须防脚本批量注册与一次性邮箱滥用，且幂等最多发一次。
- 额度语义：确定未 dispatch 的系统失败全额释放；上游明确成功则结算；上游明确失败则释放未结算的冻结；**结果未知持续冻结**，直到可验证结果或受审计对账，不按等待时间自动退款。

### 下一步

> **后台既有只读证据：**用户已确认双前缀下 admin+MFA 的总览及用户列表/详情浏览器正向路径，匿名三个 API 返回脱敏 401；先前综合隔离 PG 不覆盖这三个接口专项及故障路径。
>
> **当前施工顺序：**唯一以总体计划 §10.4 为准：先推进正在实现的 #134 Studio 身份统一，再按该切片的独立验收门禁收口。管理员模型目录读取已在完整重启本地启动器并重放准备后恢复；模型筛选、分页等仍未逐项验收。#122 既有代码/离线86/86及全量939/937/2证据保留，但不升级为已登录模型HTTP/browser或后台验收完成；内部目录 API 不依赖外部 Provider。价格读取、所有真实后台写、生产收费和发布保持关闭。
>
> **已被取代的历史快照：**此前“0032 代码与夹具已就绪、定向 66 项通过、因终端缺管理员连接未实跑；唯一下一步是新隔离库验 0032，通过前不接 API”属于专项报告出具前的记录。现由 `.workbuddy/database-acceptance-mwoc1hrq_6402d0.json` 的投影专项 passed 与上方 #134 执行状态取代；历史离线数字不作为本轮 API/gateway/UI 通过证据。

#### 历史进展（下方各条的“当前”和“下一步”均为当时状态）

> **推荐供独立审查：**基本目录沿用logical_models现有安全列；绑定用新专用最小只读NOLOGIN owner的窄SECURITY DEFINER函数，Web只获指定签名EXECUTE，仍不能读内部Provider/绑定表，不借Worker/ledger owner/发布CLI或收费专用函数。安全视图/专用服务为备选，不改用户公共视图。价格首版明确NOT_AUTHORIZED/null，不是未配置/免费；未来独立摘要仅版本ID/标识/template/effective/status及非敏感档位结构，绝不复制账务owner。新owner/GRANT/迁移/实现须独立审查和另行批准，**本设计不代表现有Web权限已覆盖，也不是扩权授权**。
>
> **候选API/停止门禁：**GET /api/admin/models每请求admin+MFA/no-store、严格查询/DTO/来源能力、默认20最多50 keyset、有限批量与只读一致快照；真实写false，绑定权限不足/42501/超时整请求503脱敏并停止，不动态降级/混源/fallback。未来须验逐列ACL、owner/函数安全、历史不变、审计留存策略、池复原及性能/PG；现有审计sink不等于持久审计。尚无新route/SQL服务/createAdminModelsGateway/HTTP transport，旧Mock接口不能直接当新DTO。Mock仍可醒目隔离展示，真实summary/users和拒绝不fallback保留。
>
> **本轮证据：**只有四正式文档、外层memory及`.workbuddy/admin-models-projection-design-review.log`；只运行git diff --check/必要文档核验，未跑测试/全量/lint、不连PG、不接真实API、不启动Next/浏览器，无源码/SQL/权限/依赖改动，不暂存不提交、保留全部已有修改。下方81/81与lint零输出是历史证据；上一轮“本轮不设计”范围被本设计授权接续，但权限不足停止不变。下一步仅独立审查推荐与门禁，再另行确定实现，本单步后暂停。

> **2026-11-19 最新核查：模型真实只读 API 因现有 Web 读权限不足停止，未交付实现。**用户授权以“不扩权、权限不足停止”为硬门禁。已核对0016/0017/0025/0030迁移、schema、runtimePermissions及catalog服务/route：Web仅可读logical_models安全列和model_catalog_public；视图只含当前启用且主绑定/上游模型/实例可用的目录，不投影绑定身份/版本/优先级或价格状态，也不是全量管理员目录。Web无内部Provider/绑定表及pricing_versions通用读权；pricing_versions_for_submission仅收费提交显式开关授权，不能挪作后台目录读取。不能把缺权限当未绑定/未配置，不能按当前目录过滤或补写历史绑定。
>
> **本轮实际交付/证据：**仅同步四份文档与外层memory，未新增/api/admin/models、SQL服务、createAdminModelsGateway或API transport；当前adminModelsData仍是read/source适配及Mock内存操作，页面继续醒目Mock本地演示，失败不fallback，真实写未开放。现有七组定向81/81通过（models14/providers18/pricing20/modelCatalog6/catalogHttp10/summary5/users8），日志`.workbuddy/admin-models-permission-block-tests.log`；15相关源码/测试ESLint零输出，`.workbuddy/admin-models-permission-block-lint.log`。这些仅为既有功能离线回归，不是新route/gateway验收。未跑全量、未连PG、未启动Next/浏览器，真实ACL/PG/浏览器未验收；保留全部已有修改、不提交。后续须先另行审查批准安全只读投影/能力及迁移权限门禁，本轮不设计或放宽授权。下方历史Mock交付证据继续保留。

> **2026-11-19 最新：定价版本隔离 Mock 已交付。**`/admin/pricing`、`/zh/admin/pricing`复用`components/AdminPricing.js`；独立`lib/adminPricingMock.js`与`lib/adminPricingData.js`提供每实例内存transport及`createAdminPricingGateway({transport})`。读取/commands均异步、纯DTO、统一`{ok,data,error,meta}`及稳定脱敏码、source/mock/writesAvailable/contractVersion能力，支持AbortSignal、UI序号/卸载迟到保护；UI不直接导入Mock/改数组，真实HTTP transport可注入而无需重写UI，但本步未实现网络接线。无自动fallback，Mock命令不能用作source=api；用户偏好“数据与操作接口独立可替换，UI不绑定mock实现”已写外层长期MEMORY。
>
> **范围：**醒目“演示数据 / Mock，非真实定价”、中文浅色；模型筛选、版本列表/时间轴、当前头/状态/时点/影响范围、图片视频档位单位详情。新增草稿/发布/未生效取消/已生效撤销先预览确认可取消；改价追加、撤销最新头不回退旧版、失败不变更，仅本页内存/刷新恢复、不改历史报价、不收费。固定演示时钟`2026-11-19T08:00:00Z` UTC永不推进/非实时，未来整秒据此校验、不自行计算Unix时间戳。金额tenths字符串/BigInt、表单最多1位小数、无商业默认价；只投影图片per_unit单张和视频per_second，新增仅固定档位统一单价，非所有模板编辑器。
>
> **证据/边界：**十二组 **277/277通过、0失败/0跳过**（新增pricing20、routes69及既有后台/定价契约），`.workbuddy/admin-pricing-tests.log`；八相关文件ESLint零输出，`.workbuddy/admin-pricing-lint.log`。真实summary admin+MFA门禁和原模块不动；无真实API/fetch/写入/持久化/owner凭据/迁移/ACL/依赖改动，远端幂等/审计/step-up仅保留未来安全门禁，未实现。未跑全量、未连PG、未启动Next/浏览器；离线JSX/transport替身不是浏览器/真实ACL或生产验收。四文档、外层当日日志/长期MEMORY同步，全部已有修改保留、不提交，本步后暂停。下方pricing占位/余五模块骨架仅pricing被取代，现四模块隔离Mock、余四模块骨架，历史证据保留。

> **2026-11-19 最新：Provider 与路由隔离 Mock 单步已交付，非真实Provider状态。**`/admin/providers`、`/zh/admin/providers`复用`components/AdminProviders.js`，独立`lib/adminProvidersMock.js`虚构实例/模型/路由及`lib/adminProvidersData.js`可替换read/source读取/安全投影/纯内存操作，目录不硬编码JSX、不依赖models/analytics数据源。中文浅色醒目Mock，实例稳定ID/名称、启停、关联模型、主备路由、优先级、固定健康/验证和最近检查齐备，明确非实时健康。支持搜索/状态/模型组合筛选、详情；启停、1–100整数优先级、主备互换均先预览确认可取消，只改页面内存、刷新恢复；不自动故障转移、不改固定检查状态。
>
> **边界/证据：**真实summary admin+MFA成功才挂载，拒绝/故障不fallback；summary/users和analytics/models原真实或Mock边界不动。无真实API/Provider/网络健康检查/持久化，不读展示Secret/API key/连接信息，不改模型目录/任务/账务/价格、不做定价，无迁移/ACL/权限/依赖变更。八组 **170/170通过、0失败/0跳过**，`.workbuddy/admin-providers-tests.log`；八文件ESLint通过零输出，`.workbuddy/admin-providers-lint.log`。实际JSX离线事件和重新挂载模拟刷新，非浏览器或真实持久化证据；未跑全量、未连PG、未启动Next/浏览器、未接真实Provider，真实ACL/生产未验收。四正式文档和外层日志同步，全部既有修改及历史证据保留、不提交，完成单步后暂停。下方providers占位/余六模块骨架仅providers状态被取代，现analytics/models/providers隔离演示、余五模块仍骨架，真实写API仍关闭。

> **2026-11-19 最新：模型目录隔离 Mock 演示已交付，非真实运营能力。**`/admin/models`、`/zh/admin/models` 复用 `components/AdminModels.js`；独立 `lib/adminModelsMock.js` 虚构目录与 `lib/adminModelsData.js` 读取/投影/校验/内存操作，页面不硬编码列表。中文浅色展示模型名称/稳定ID、image/video能力、启停、档位、Provider绑定和价格配置状态；名称/ID搜索、类型/启停筛选、详情与空态齐备。添加校验稳定ID（2–128位）、名称（1–80字符）、类型及至少一项匹配能力，重复ID拒绝；新增默认禁用且无档位/绑定/价格。添加、启停必须明确仅演示的预览/确认，可取消；只修改本页内存，刷新恢复，不冒充服务器写成功。
>
> **隔离与证据：**AdminShell真实summary admin+MFA成功才挂载，拒绝/DB错误/网络故障仍失败关闭，不fallback。真实summary/users及analytics既有Mock边界不替换；无真实模型API、秘密/路由/价格编辑，不影响任务/账务/定价历史，无迁移/权限/依赖改动。七组 **142/142通过，0失败/0跳过**（adminModels14/adminRoutes49/adminAnalyticsUi9/adminAnalyticsRead39/adminCenter18/summary5/users8），`.workbuddy/admin-models-tests.log`；七文件ESLint通过零输出，`.workbuddy/admin-models-lint.log`。覆盖真实JSX离线事件与重新挂载模拟刷新，不是浏览器或真实持久化验收；未跑全量、未连PG、未启动Next/浏览器，未提交。下方“models占位/其余七模块骨架”仅models状态被取代，analytics/models均为隔离演示，其余六模块仍骨架；真实后台写操作未开放、原历史证据保留。同步四文档与外层日志后暂停，不自动扩展真实接线。

> **2026-11-19 最新：使用分析隔离 Mock UI 已交付。**`/admin/analytics` 和 `/zh/admin/analytics` 不再是未开放占位，展示中文浅色模型任务数横条/当前成功、按 taskCount 排序的用户任务数/实际结算积分、窗口全量与三类未归类。顶部醒目“演示数据 / Mock，非真实运营结果”，各排名/未归类卡与总计标 Mock；固定31天 UTC“演示窗口”与固定 asOf，没有筛选或实时伪数据。独立 `lib/adminAnalyticsMock.js` 沿用服务完整返回结构，`lib/adminAnalyticsData.js` 隔离读取/适配，BigInt 精确除10；含零消费及仅结算用户，不包含真实邮箱/资料，attempt不可用false/null，无实际Provider调用数或收入成本利润。
>
> **用户新约定：**允许明确标识且隔离 mock 支持 UI 开发、后期真实 API 替换；旧“禁止假数据”指不得冒充真实，不禁止显式演示。已接真实 summary/users 等模块不替换；共享 AdminShell 仍要求真实 summary admin+MFA 成功才挂载，DB故障/拒绝继续失败关闭，绝不 fallback 到 mock。单人约定不变，mock 不构成 PG/生产验收。下方“分析 UI 未接/八模块占位/不得用假数据”仅 analytics 与显式 mock 政策被本条取代，历史证据保留；其余七模块仍占位。
>
> **本轮证据：**六组离线定向 **118/118通过，0失败/0跳过**，`.workbuddy/admin-analytics-ui-tests.log`；七个本轮源码/测试文件 ESLint 零输出通过，`.workbuddy/admin-analytics-ui-lint.log`。含组件真实JSX渲染、服务投影/元数据契约对齐、汇总/精度及双前缀展示门禁，非真实SQL执行或浏览器验收。未连库、未跑全量、未启动Next/浏览器；未接真实分析API、未改聚合SQL/权限/迁移/依赖，保留全部既有修改、未提交。本步停止；PG结果/ACL/池复原/性能、真实API及浏览器需后续独立授权验收。

> **2026-11-19 最新：后台只读排名聚合服务已实现，API/UI仍未接。**新增 `lib/server/adminAnalyticsRead.js` 与39项定向测试；工厂注入database/clock/environment，仅 `.read(URLSearchParams)`，不新增鉴权。READ ONLY REPEATABLE READ事务内有限5秒超时、一次DB微秒时钟、单语句CTE分别聚合任务/settle后组合；模型按原PK+快照业务ID结构归类，未归类独立；用户按owner、缺users资料仍保留，返回Top10及全量总计、精确字符串。只读现有Web投影，不读provider_calls/当前目录，不算attempt/收入成本/P95。**用户本轮确认默认连续31天、最大31天，取代旧7天默认值**；UTC `[from,to)`，非法参数在数据库工厂前零SQL，未来to仅时钟/事务语句、不执行排名SQL。阶段6 §4.3.27新增实现记录为准。
>
> **证据与边界：**新增39项+summary 5项+users 8项共 **52/52通过、0失败/0跳过**，`.workbuddy/admin-analytics-read-tests.log`；两新增文件仓库cwd原生ESLint通过零输出（先前外层cwd/ESLint API启动问题不记作代码失败）。SQL编译形状断言与独立关系oracle仍仅离线，未执行SQL引擎；未接API/UI，未连PG、未跑全量、未启动Next/浏览器，无迁移/权限/依赖改动，未提交，保留全部既有修改。真实PG结果/ACL/池复原/性能及未来GET admin+MFA接线仍需独立授权验收。下方“服务未实现/默认7天/下一候选先实现服务”已由本条取代，历史原证据保留，完成后暂停。

> **2026-11-19 当前追加：模型/用户排名实现前源码核查与契约已完成，功能未实现。**见阶段6 §4.3.27独立追加A–F。Web不能读provider_calls，调用写入尚未填模型审计身份列；task领取次数不是attempt，updated_at不是上游耗时。候选首版仅现有Web权限内的模型任务量/本批次当前成功、用户任务量/成功/settle消耗；UTC半开窗口默认连续7天、显式最大31天，任务按创建时间、消费按settle事件时间，历史未归类单列，预聚合防重。attempt能力未开放不能报0；不做收入成本利润。下一建议先独立授权聚合服务＋离线测试，不接API/UI、不迁移/授权；本步仅文档、不连库/启动/重复预检、不要求DB凭据。既有37/37路由预检与68/68复核仅离线，PG/浏览器/Next运行仍待验收。下方旧下一候选由本条接续，历史实现/证据保留。
>
> **2026-11-19 当前摘要：十模块独立页面骨架已实现。**`/admin`、`/zh/admin` 根为总览，`users` 独立列表/详情；八个白名单模块 `models/providers/pricing/analytics/tasks/billing/audit/settings` 经 `[module]` 路由分发，未知模块404。共享 `AdminShell` 提供默认中文浅色布局、真实链接、唯一active及加载/拒绝/错误主状态；汇总成功才挂载子页面，受保护数据仍由每个服务端API的admin+MFA门禁约束。`AdminCenter`仅保留用户只读及原并发分页保护，八模块明确未开放，不加API/迁移/权限/排名/假数据。
>
> **本轮最终证据：**主代理独立复核 `adminRoutes/adminCenter/adminSummaryHttp/adminUsersHttp/loginRedirect` 五组68/68，0失败/0跳过，`.workbuddy/admin-pages-review.log`；仅额外修改 `tests/loginRedirect.test.js`，新增实际执行login源码重定向函数的深层admin目的地/MFA保留测试。仓库cwd下 `AdminShell/AdminCenter/adminRoutes/loginRedirect` lint通过零输出，先前错误cwd尝试不记为代码失败；主代理已读AdminShell及路由，未发现阻断。原四组60/60（新增路由/布局29项）日志 `.workbuddy/admin-module-pages-tests-final.log` 作为子集保留；12文件lint 0 errors/0 warnings，`.workbuddy/admin-module-pages-lint-passed.log` 保留。未跑全量、未连接数据库，真实PG/浏览器/Next运行验收未完成；历史31/39项范围与证据保留。下一步候选为当前只读与独立页面的授权验收，之后另行确定分析/配置只读切片，完成本步后暂停。下方“页面未拆/主状态未统一”和“本轮仅文档”均为已被本条取代的历史快照。
>
> **2026-11-19 历史摘要（已由上方独立页面状态接续）：独立中文运营控制台。**所有管理员调整集中 `/admin`，不放进 Studio 或用户 `/account`；`/admin` 与 `/zh/admin` 默认中文，主控制台采用参考图的浅色左导航、顶部工具区、白色卡片和右侧运营栏。导航包含总览、用户、模型目录、Provider 与路由、定价、使用分析、任务运营、额度与账务、风险与审计、系统设置。当前仅总览真实快照与用户只读接入，其余为规划/空态；页面级路由拆分、真实排名/趋势、日期筛选、健康与审计 API、模型/定价等写操作未实现。不得用假数据补齐界面，也不宣称全部错误/拒绝页已统一浅色。
>
> **实施路线：**统一页面骨架及当前只读 PG/浏览器验收 → 真实 Dashboard、模型调用排名与用户使用量排名 → 模型/Provider/路由/定价只读 → 安全写边界及持久审计先行，再逐项开放模型添加/启停与版本化配置 → 用户/任务/账务处置 → 风险查询与报表。任务数与 attempt 分开，消费取 settle，不把积分视作收入或真实成本；分析读取须核验字段、索引、权限投影。完整决策见总体计划 §10.4、阶段稿 §4.3.27 和当前交接。最近 31 项与历史 39 项范围不同，均不证明当前用户只读真实 PG/浏览器验收；本轮仅补文档，不开工后续模块。
>
> **历史摘要（UI 与路线已由上方 2026-11-19 当前摘要接续；原证据保留）：admin+MFA 用户列表/详情只读 API/UI 及请求保护已实现，39 项定向测试通过。**新增 `lib/server/adminUsersHttp.js` 和 `app/api/admin/users/route.js`、`app/api/admin/users/[id]/route.js`；列表支持精确邮箱搜索、默认 20 条/最大 50 条游标分页，详情返回身份、有效会话数量、BigInt 精确余额及最近 5 条账单。`components/AdminCenter.js` 提供中英界面，接入 `/admin`、`/zh/admin`；请求序号 + `AbortController` 防旧响应覆盖，分页使用已提交筛选并防重复点击，追加失败保留列表和游标。
>
> **证据与未完成边界：**`adminUsersHttp` / `adminCenter` / `adminSummaryHttp` / `accountCredits` / `accountCreditsHttp` 合计 39 项通过（0 失败、0 跳过），日志 `.workbuddy/admin-users-final.log`。UI 仅源码回归，非浏览器运行验收；本轮无显式 PG 连接，真实 PG 未验收。本人 API 隔离不变，未修改 runtime 权限或迁移。封禁/解封、会话撤销、账号状态模型及审计写操作未做；不宣称全量或生产完成。后续候选为显式授权连接后的隔离 PG 验收及浏览器运行验收，细节见总体计划 §10.4、阶段稿 §4.3.27 和当前交接。
>
> **历史入口（日志及 UI 状态已被上方当前摘要取代）：管理员用户列表/详情只读代码切片已实现，定向离线测试通过，真实 PostgreSQL 验收待执行。**新增独立 `GET /api/admin/users` 与 `GET /api/admin/users/:id`，均逐请求执行 admin+MFA 服务端门禁；列表精确邮箱匹配、最多 50 条稳定游标分页，详情复用本人额度账单服务读取投影。runtime 既有 users/session 表读取及 credit 列级 SELECT 已覆盖本切片，未新增授权或迁移；普通 `/api/account/credits` 仍只按当前会话用户读取。测试日志见 `.workbuddy/admin-users-readonly-tests.log`。本轮未提供 `LOCAL_DATABASE_ADMIN_URL`，不宣称真实 PG 验收通过。后台只读之外的封禁/解封、会话撤销、风险事件/审计查询及任何后台写操作仍未开放。收费开关 `PAINTTRACK_CHARGED_SUBMISSION` 仍默认关闭；退出前最终扫描、多实例并发门禁、生产可信目录、支付/充值/自动赠送、部分结算与人工退款仍未完成。
>
> **历史：额度发放CLI已通过真实隔离PG验收（2026-11-17，§4.3.24 / HANDOFF §30）。**新增`scripts/grant-credit.js`（npm脚本`credit:grant`）与`lib/server/tasks/creditGrantCli.js`，提供`grant`/`balance`两个动作；迁移0029让`credit_ledger_events.task_id`可空、把`shape_check`拆成任务族与`grant`族，并新增owner专属`credit_grant(p_user_id,p_credit_tenths,p_source_type,p_source_id)`：发放即开户、单语句加额防溢出、幂等键`grant:<来源>:<来由>`、同来由换金额或换用户报`CREDIT_GRANT_CONFLICT`；未知用户由`credit_accounts`外键裁决（owner不持有`users`读权限）。账本任务归属触发器改用新函数`credit_check_ledger_task_owner`并加`WHEN (NEW.task_id IS NOT NULL)`（迁移身份INHERIT FALSE，既不能替换owner所有也不能授权原函数）。运维身份用`LEDGER_DATABASE_URL`（保留`PUBLISH_DATABASE_URL`兼容），金额上限在连库前拒绝。报告`.workbuddy/database-acceptance-mwk5isye_451074.json`顶层`passed`（149项，仅`admin-mfa-postgres`skipped）。边界：未接HTTP收费入口（已被上一条取代）；注册赠送仍默认关闭，额度只能由运维命令显式发放；无余额/账单UI、免费报价仍拒绝、无支付与退款。
>
> **历史：价格版本发布CLI已通过真实隔离PG验收（2026-11-17，§4.3.23 / HANDOFF §29）。**新增`scripts/publish-pricing.js`与`lib/server/tasks/pricingPublishCli.js`，提供`publish`/`cancel`/`revoke`/`timeline`四个动作；`publish`支持`--dry-run`（只做本地校验，不建立连接），配置走JSON文件，生效时间只接受整秒（ISO 8601或`@秒`）。权限模型沿用`migrateDatabase`既有范式：使用独立管理员身份`PUBLISH_DATABASE_URL`（必须与`DATABASE_URL`同库、本机回环、且与运行/迁移/Worker/cleanup身份不同），连接只在显式事务内`SET LOCAL ROLE`到`pt_ledger_owner_<hash>`，事务结束自动失效；**不GRANT任何角色、不新增长期owner连接、不新增HTTP入口**。事务外语句按`PRICING_SESSION_UNBOUND`拒绝，切角色失败回滚并`42501`。报告`.workbuddy/database-acceptance-mwk4mnjp_dd5288.json`顶层`passed`（140项，仅`admin-mfa-postgres`按开关skipped），夹具验证发布、同参重放、同名异内容`VERSION_CONFLICT`、同秒`23505`、已过时间`EFFECTIVE_TIME_INVALID`、未知模型`NO_ACTIVE_VERSION`、模板不匹配`TEMPLATE_MISMATCH`、未生效取消幂等、取消后禁止撤销、生效后撤销、只读时间轴，以及Worker身份尝试`SET ROLE`被`42501`拒绝、发布结束后管理员会话身份复原、运行/Worker/cleanup仍对定价表零读写。全量698项696通过0失败2跳过；lint零错误11条既有警告。边界：**未接HTTP收费入口、未接结算触发点、无余额/账单UI、无赠送/支付、免费报价仍拒绝**；本入口是运维命令，项目当前仍无`/admin`页面。
>
> **历史：终态结算扫描已通过真实隔离PG验收（2026-11-17，§4.3.22 / HANDOFF §28）。**`0028_credit_settlement_sweep.sql`新增只读函数`credit_pending_settlements(p_limit)`（仅专用`NOLOGIN` ledger owner可执行），列出已终态、已冻结、未裁决的任务，结局由任务状态决定；JS侧`pending()`/`sweep()`逐笔独立事务收敛，重复扫描为空。无新表、无schema变更；冻结表仅补列级只读授权。报告`.workbuddy/database-acceptance-mwk41xpd_af2e80.json`顶层`passed`（132项，仅`admin-mfa-postgres` skipped）；夹具用真实Worker函数产生成功/失败/取消三种终态并自动收敛为一结算两释放。全量690项688通过0失败2跳过，lint零错误11条既有警告。仍未接HTTP与常驻定时器，Worker无账务写权，无部分结算/赠送/支付/收费UI，免费报价仍拒绝；下列0027及更早状态为历史。
>
> **历史：冻结额度终态裁决（settle/release）已通过真实隔离PG验收（2026-11-17，§4.3.21 / HANDOFF §27）。**`0027_credit_settle_release.sql`新增`credit_settlements`与仅限专用`NOLOGIN` ledger owner的`credit_finalize_task(user_id,task_id,outcome)`：成功任务全额结算、失败/取消任务全额释放，其余终态一律拒绝；`credit_reservations`保持不可变，终态只追加，advisory lock + 主键保证一个任务只有一个终态。账本`kind`扩为`reserve|settle|release`，唯一索引改为`(task_id,kind)`。报告`.workbuddy/database-acceptance-mwk3g2tx_90b67a.json`顶层`passed`（131项，仅`admin-mfa-postgres` skipped）；全量684项682通过0失败2跳过，lint零错误11条既有警告。仍未接HTTP/Worker入口，无赠送、支付或收费UI，免费报价仍拒绝；下列0026及更早状态为历史。
>
> **历史：原子任务已强制绑定可信路由快照（2026-11-17，§4.3.20 / HANDOFF §26）。**`createAtomicTaskPricingStore` 构造期必须提供 `routeResolver`，`submit` 不再接受外部 `route`；路由需带 UUID 模型主键、版本号与自洽哈希，并与请求模型/操作一致，事务内再核对锁定模型 id 与 `catalog_version`。任一不满足在事务外拒绝，不写 task/quote/reserve。最新报告`.workbuddy/database-acceptance-mwk3440i_951e83.json`顶层`passed`（130项，仅`admin-mfa-postgres` skipped）；全量677项675通过0失败2跳过，lint零错误11条既有警告。无新迁移、无权限变化；仍未接HTTP、无settle/release/赠送/支付/收费UI。下列0026及更早状态为历史。
>
> **历史：0026 task+quote+reserve 原子链真实隔离PG验收已通过（§4.3.19 / HANDOFF §25）。**最新报告`.workbuddy/database-acceptance-mwk24fug_a38ca5.json`顶层`passed`（130项检查，仅`admin-mfa-postgres`按开关`skipped`）。0020→0026六条追加迁移、0026表列/索引/snapshot、原子冻结夹具（同事务提交、同键重放与异请求冲突、余额不足整体回滚、并发不超额冻结、账本/报价/任务三表一致）均通过；Web/Worker/cleanup/migration仍无法调用账务写路径。真实修复：`credit_reserve_task()`去掉`FOR SHARE`，改用`UPDATE ... WHERE available_tenths>=p RETURNING *`原子扣减；账本事件`RETURNING id`补`SELECT(id)`只读授权。该报告不证明既有业务库升级，也不覆盖HTTP入口、settle/release、赠送、支付或收费链；免费报价（`credit_tenths=0`）当前拒绝，任务暂不强制可信路由快照。下列0025及更早状态为历史。
>
> **历史：0025报价持久化真实隔离PG验收已通过（§4.3.18 / HANDOFF §24）。**最新报告`.workbuddy/database-acceptance-mwj1zu0t_80be75.json`顶层`passed`；0020→0025非空迁移追加、历史快照、0025权限边界，以及报价锁/数据库时钟/并发重放/不可变快照/撤销不回退夹具均通过。`admin-mfa-postgres`本轮`skipped`，因未显式开启。首次失败报告及其新建隔离库/角色保留为修复历史，不复用或自动清理。该报告不证明既有业务库升级，也不覆盖完整task+quote+reserve、settle/release或收费链；Web/Worker/cleanup无新增授权，专用owner与可信JS宿主共同受信。下方待新PG/blocked为历史。

> **当前：可信报价计算与内存快照已实现（§4.3.15、HANDOFF §21）。**新增纯服务端pricingQuote.js及43项测试；全量647项645通过0失败2跳过，lint零错误、11条既有警告。显式配置，无默认金额；BigInt精确运算、最终ceil、生命周期不回退及深冻结/hash已覆盖。尚无价格/quote数据库持久化、锁后实时采样或task+quote+reserve原子事务，不是新PG验收。下一候选为价格版本和quote持久化及事务接线的独立小步，本步交付后暂停。下方“报价待实现”局部被本条取代，历史保留。

> **最新：共用owner准备接线的真实PG隔离复验已通过。**报告database-acceptance-mwitu7md_e8013e.json顶层passed，0024/撤权/账务权限与约束检查通过；admin-mfa-postgres本次skipped。下方待PG状态为历史。未证明现有业务库升级或完整收费可用，下一候选可信报价快照最小代码，之后原子reserve；本次只确认结果。

> **当前：本地启动/迁移owner准备代码接线完成，见§4.3.14。**原0024报告database-acceptance-mwirzzwn_9872fa.json顶层passed；本次共用角色准备与finally撤权尚待新隔离库复验，未操作既有业务库。全量604项602通过0失败2跳过；普通db:migrate现在也需显式LOCAL_DATABASE_ADMIN_URL。下方“普通启动未接线/PG blocked”是历史，不引用旧报告证明新路径通过。下一步仅新隔离库真实验收，账务业务不扩展。

> **当前：§4.3.13基础账本代码已落地、真实PG验收blocked。**本轮已授权并新增0024/schema及未开放内部函数，但无reserve冻结写入口，未应用既有库。普通启动未接专用owner准备，禁止直接用启动器升级业务库；下一步以显式LOCAL_DATABASE_ADMIN_URL做全新隔离PG验收。报告database-acceptance-mwiqwlb1_6f32ed.json顶层blocked、created=[]，不能引用旧报告证明新0024通过。当前全量577项575通过0失败2跳过，下方572/558为历史。账本整体、赠送/支付/收费仍不可用；下方“0024未实现/未授权”已局部被本轮取代。

> **当前入口：参数契约代码切片已获用户明确授权并完成**，见阶段设计稿§4.3.12；模型ID/图片outputCount/视频durationMs与fps显式校验、Studio单图接线和纯视频提交客户端已落地。图片仅支持1张，视频仅mock可信档位，无视频UI/真实Provider。全量572项570通过/0失败/2跳过，非真实PG验收。下方“参数不存在/未授权”为历史；下一候选是账务执行边界选型与逐动作契约，不含0024/账本/支付/收费或权限变更。

> **当前入口（门禁审查后）：**实施/启用门禁与最小能力矩阵已记录在阶段设计稿 §4.3.11。仍未完成账务执行载体、DDL与事务细案，不宣称整体评审通过。下一小步只设计账务执行边界选型及逐动作调用契约；本地mock实现与生产启用门禁分开，不要求先买服务/设真实价格。单人流程及默认关闭赠送不变，参数代码、0024、账本/支付/收费入口仍未授权。下方一致性复核入口作为历史保留。

> **当前入口（2026-11-16 文档一致性复核，取代下方历史待定数量）：**本轮报价、赠送触发/有效期、反滥用、邮箱准入及单人 unknown 参数已确认，规则分别见阶段设计稿 §4.3.4 J/§4.3.6、§4.3.7 G.1、§4.3.8 E.1、§4.3.10。开发运营仅本人，unknown 超过30分钟仅管理员列表高亮，证据不足持续冻结；不建工单/替补/多人审批。具体价格及赠送金额不预设，赠送默认关闭；申诉2/5工作日仍为已确认目标，由本人处理，不引入独立岗位。下一候选为实施前门禁与最小权限方案审查；未完成整体评审、任务计价参数契约扩展或账本/0024实现，均需独立授权。以下旧“三项参数 + 五项取值待定”仅为历史快照，不得据此重复索要已确认决策。

> 2026-11-16 10:04 当前更新（取代下面旧状态）：阶段6设计稿 §4.3.7 已形成风控/申诉草案，参数见G，仍待用户确认、隐私及权限评审；之后独立做上游unknown人工SLA。未实现风控/赠送/账本、未授权0024或开放写入口。

> 2026-11-16 09:51 更新：下段“三项待确认”的历史状态已被本条取代。用户已确认赠送触发、永久有效及无默认金额三项，报价阻断修订见阶段6设计稿 §4.3.6（未实现/验收）。下一候选为反滥用阈值/申诉，之后 unknown 人工 SLA；不据此宣称6.2整体评审通过或授权账本实施。

阶段 6.2 剩余三项参数收口：赠送额度/有效期、反滥用阈值与申诉、上游长期未知的人工处置 SLA。（计价模板落地细节见 `PHASE6_ACCOUNT_CENTER_PRODUCT_DESIGN.md` §4.3.3，2026-11-16；价格生效/紧急停价/报价有效期见 §4.3.4，同日；该两节均标明**仍需你拍板的商业取值**，尤其 §4.3.4 §J 的 5 项。§4.3.3 另记录一条硬结论：图片输出数量、视频时长/帧率参数**当前不存在**，账本启用前须先扩参数契约，属独立授权步骤。）收口并通过评审后，**才**另外申请迁移与账本实现授权。

---

## 2. 文档地图

| 想知道什么 | 去哪看 |
|---|---|
| **总体执行顺序、阶段门禁、当前下一步** | `docs/ImplementationPlan/PAINTTRACK_DEVELOPMENT_PROCESS.md`（权威入口，查看 §10.4 与阶段状态速查） |
| 当前进度摘要（就是本文） | `docs/ImplementationPlan/PAINTTRACK_ONBOARDING.md` |
| 当前交接：改了什么、证据在哪、下一步候选 | `docs/records/HANDOFF_2026-11-17.md`（0031 收费金额复算与真实 PG 验收；`HANDOFF_2026-11-16.md` 为历史记录，阶段 5.x / 本地环境仍看 `HANDOFF_2026-11-13.md`） |
| 数据库架构、迁移、角色权限、DB 验收细节 | `docs/records/DB_SETUP.md` |
| 阶段 6 账户中心与账本契约 | `docs/records/PHASE6_ACCOUNT_CENTER_PRODUCT_DESIGN.md` |
| 认证/威胁模型/Provider 契约/路由/状态机等阶段设计稿 | `docs/records/PHASE*.md` |
| 阶段 1–4 验收索引 | `docs/records/PHASE1-4_ACCEPTANCE_INDEX.md` |
| Git 分支、提交、子模块工作流 | `GIT_WORKFLOW.md` |
| 每天做了什么、当时的决策 | `.workbuddy/memory/YYYY-MM-DD.md`（只追加） |
| 真实数据库验收的机器报告 | `.workbuddy/database-acceptance-*.json` |
| 子模块版本修正补丁 | `patches/0001~0003`，由 `npm run patch:submodules` 重放 |
| 测试 | `tests/`，`npm test` |

**读法建议**：不要从头读总体计划。先看它的 `10.4 当前状态与下一步` 和文末 `阶段状态速查` 表，再按需回跳对应阶段章节。

---

## 3. 新 AI 会话的启动阅读顺序

按这个顺序读，不要一开始就翻代码：

1. 根目录 `AGENTS.md`（硬约束）
2. 本文档（现状 + 地图）
3. `docs/ImplementationPlan/PAINTTRACK_DEVELOPMENT_PROCESS.md` 的 §10.4 与阶段状态速查表
4. `docs/records/HANDOFF_2026-11-17.md`（当前交接；阶段 5.x 与本地环境细节回看 `HANDOFF_2026-11-13.md`）
5. 当前要动的那个阶段的 `docs/records/PHASE*.md`
6. 涉及数据库时加读 `docs/records/DB_SETUP.md`

---

## 4. 工作方式约束（必须遵守）

- **单步推进**：一次只做一个可独立验证的小步骤，做完停下等用户确认，不要连着改多个阶段。
- **文档同步**：每步完成后同步更新——总体实施计划、对应阶段设计稿、`HANDOFF_*.md`、`.workbuddy/memory/YYYY-MM-DD.md`。历史状态要保留并标注“已被取代”，不能直接删改历史结论。
- **不夸大完成度**：离线 `node --test` 通过 ≠ 真实 PostgreSQL 验收通过；内存替身 ≠ 真实持久化。真实 DB 结论只能引用 `.workbuddy/database-acceptance-*.json` 的 `status`。
- **不擅自扩大权限**：不得为了“让验收通过”而放宽 Web/Worker/cleanup 的表级或列级授权。
- **不引入未批准的东西**：真实 Provider 凭据、预算、云服务、生产部署平台/地域、支付渠道，都必须先取得用户明确批准。
- **不创建根目录 `.env`**：启动器见到 `.env`、`.env.local`、`.env.development`、`.env.development.local` 会直接拒绝启动（见第 6 节）。
- **写 API 仍关闭**：Provider 配置写 API、真实余额/计费 UI 在对应门禁通过前不得开放。

---

## 5. 新电脑环境搭建

### 5.1 前置

- **Node 22**（本机验证版本 v22.22.2）
- **PostgreSQL**，监听 `127.0.0.1:5433`，需有一个具备 `CREATEDB`/`CREATEROLE` 的 `postgres` 管理连接
- Git

### 5.2 拉代码与安装

```bash
git clone https://github.com/leafGGB/PaintTrack-AI.git
cd PaintTrack-AI
npm run setup
```

`npm run setup` 等价于：拉取并初始化子模块 → 重放子模块补丁 → `npm install` → 构建 4 个工作区包。**用这一条命令，不要手工只跑 `npm install`**，否则子模块版本修正不会应用，启动会报依赖错误。

### 5.3 启动开发环境

```bash
LOCAL_DATABASE_ADMIN_URL="postgresql://postgres:你的密码@127.0.0.1:5433/postgres" npm run dev
```

启动器会：校验管理连接必须是 loopback:5433 且库名为 `postgres` → 建固定库与四个角色 → 跑迁移 → 以独立环境启动 Next、Worker 等进程。

- 密码含特殊字符要百分号编码（`@` → `%40`）。
- 缺少该变量会在探测环境文件和加载 pg 之前就失败（`LOCAL_DATABASE_ADMIN_URL_REQUIRED`），这是 fail-closed 设计，不是 bug。
- 本地合成图片/视频测试：在原启动 CMD 保留已有 `LOCAL_DATABASE_ADMIN_URL` 及历史库设置，停止原服务后执行 `npm run dev:mock`；该命令显式传 `--mock --worker`，统一准备Mock目录与执行Worker。普通 `npm run dev` 仍默认不启用Mock。启动状态应显示 `LOCAL_MODEL_SOURCE=mock` 和 `LOCAL_WORKER=enabled`，缺任一项先核对启动命令；不要用 `--fresh`，不要清历史或把凭据贴到聊天。
- 可选开关（按需加）：`PAINTTRACK_LOCAL_WORKER=1` 起 Worker、`PAINTTRACK_LOCAL_MOCK_ROUTING=1` 用本地 mock 模型路由（保留兼容）、`PAINTTRACK_LOCAL_ASSET_CLEANUP=1` 起资产清理进程、`PAINTTRACK_LOCAL_DATABASE=<库名>` 复用历史库。

### 5.4 不在 Git 里、必须单独带走的东西

| 东西 | 位置 | 不带走的后果 |
|---|---|---|
| 本地数据库内容 | 库 `pt_local_auth_000000000000` | 账号、会话、任务、资产元数据全丢 |
| 四个数据库角色 | `pt_local_{migrate,runtime,worker,cleanup}_000000000000` | 库在但连不上 |
| MFA 加密密钥 | `.local-state/mfa-encryption.key` | 启用过 MFA 就会解不开 TOTP，管理员被锁死 |
| 本地资产文件 | `.local-assets/` | 已归档的图片/视频对象丢失 |
| `node_modules` | 各目录 | 重新 `npm install` 即可，无需带走 |

要迁移旧数据：

```bash
# 旧机器
pg_dump -h 127.0.0.1 -p 5433 -U postgres -Fc pt_local_auth_000000000000 > painttrack_local.dump
# 新机器（先按 5.3 让启动器建好库与角色，再恢复数据）
pg_restore -h 127.0.0.1 -p 5433 -U postgres -d pt_local_auth_000000000000 --no-owner painttrack_local.dump
```

只想继续写代码、不需要旧数据的话，**不用迁移**，直接在新机器注册新账号即可。

---

## 6. 常见坑

1. **不要新建根目录 `.env`**
   启动器主动拒绝 `.env`、`.env.local`、`.env.development`、`.env.development.local` 四类文件。需要配置就用命令行内联环境变量（见 5.3）。仓库里的 `.env.example` 只是字段说明，**不是**让你复制成 `.env`。

2. **子模块显示 dirty 是正常的**
   `packages/Open-AI-Design-Agent`、`Open-Poe-AI`、`Vibe-Workflow` 的 `package.json` 改动来自 `patches/` 补丁，是设计预期。这三个子模块指向**上游作者仓库**（你没有写权限），且处于 detached HEAD，不要试图把它们提交推送回去。正确做法是改补丁文件，再跑 `npm run patch:submodules`。

3. **推送报代理错误不一定是凭据失效**
   仓库级配置把 GitHub 指向了 `127.0.0.1:7890`。该代理没启动时 `git push` 会报连接失败，先确认代理是否在跑。

4. **`.local-state/` 不能删**
   删掉等于重新生成 MFA 密钥，库里已加密的 TOTP 密文将永久无法解密（恢复码只存哈希，没有 UI 可以恢复）。`--prune` 也刻意不匹配这个目录。

5. **测试证据要分层看**
   `npm test` 是离线单元/门禁测试；真实数据库结论看 `.workbuddy/database-acceptance-*.json` 里的 `status` 字段。两者不能互相替代。

6. **本地历史库堆积**
   `node scripts/local-registration.js --prune` 默认 dry-run，只列不删；加 `--yes` 才真正删除。固定默认库永远保留。

7. **Windows 换行符会让测试挂 1 项**
   这台机器的 PortableGit 在系统级设置了 `core.autocrlf=true`。`git checkout` / `git clone` 会把 `drizzle/*.sql` 从 LF 转成 CRLF，而 `tests/databaseLifecycle.test.js` 对 `0000_initial.sql`、`0001_generation_tasks.sql`、`0002_assets.sql` 做**原始字节** sha256 校验，于是报「最新 snapshot 与两个 schema 完整一致，历史迁移未被改写」失败，症状是一串 64 位十六进制哈希对不上。
   仓库已用 `.gitattributes`（`*.sql text eol=lf`）钉死 LF 来防复发；若仍然遇到，直接转回 LF：

   ```bash
   for f in drizzle/*.sql; do tr -d '\r' < "$f" > "$f.lftmp" && mv "$f.lftmp" "$f"; done
   ```

   这是环境问题，**不是迁移文件被改坏**，不要去修改哈希常量或测试断言。

---

## 7. 快速自检

接手时跑这几条，确认环境与代码状态：

```bash
git status --short                    # 应只有三个子模块的 M
npm run patch:submodules:check        # 期望「全部子模块补丁已就绪」，exit 0
npm test                              # 当前回归基线 723 项 / 0 failed（资源受限时串行）
npm run db:migrate:check              # Drizzle 迁移一致性
node scripts/local-registration.js --prune   # dry-run 列出历史本地库
```

---

## 8. 一句话交接

服务端骨架与账本链（0024–0031）已通过真实隔离库验收，HTTP 收费提交的金额由数据库复算；独立本地结算宿主和用户账户余额/账单读取已完成对应验证。**当前不能宣称可对外收费或完整 SaaS 可运营**：`PAINTTRACK_CHARGED_SUBMISSION` 默认关闭，生产可信目录未接入，支付/充值/赠送未完成。阶段 8 已实现独立 `/admin` 壳、MFA 门禁和用户列表/详情只读代码切片；用户列表/详情本轮尚无真实 PG 证据。后台写操作仍关闭，后续风险事件/审计及运营写操作依赖单独门禁。全量回归既有基线为 723 项，不能当成本轮回归结果；退出前最终扫描和多实例并发门禁仍是结算宿主后续运行边界。
