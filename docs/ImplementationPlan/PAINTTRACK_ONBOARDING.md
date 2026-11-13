# PaintTrack 项目接续指南（新电脑 / 新 AI 会话入口）

> 最后更新：2026-11-13
> 用途：任何新机器、新会话、新协作者从这份文档开始。本文**只做导航和现状摘要**，规则与验收细节一律以它指向的原文为准——不在这里复制细则，避免两处口径漂移。

---

## 0. 三十秒定位

PaintTrack 是一个 AI 生成内容平台（图片/视频），fork 自开源项目 `Anil-matcha/Open-Generative-AI`，在其上重建了服务端：多人账户体系、任务队列与 Worker 执行、Provider 适配与调用账本、资产归档与生命周期清理、管理员权限与 MFA。

| 项 | 值 |
|---|---|
| 主仓库 | `github.com/leafGGB/PaintTrack-AI`（你的 fork，默认分支 `main`） |
| 上游作者仓库 | `github.com/Anil-matcha/Open-Generative-AI`（只读） |
| 技术栈 | Next.js 15 + React 19.2.4 + PostgreSQL + Drizzle ORM，Node 22 |
| 工作区包 | `studio` / `workflow-builder` / `ai-agent` / `design-agent`（另有 Electron 打包配置） |
| 本地开发库 | 固定库 `pt_local_auth_000000000000`，端口 **5433** |
| 测试基线 | 整仓 **558 项**（556 passed / 0 failed / 2 skipped） |

---

## 1. 现在做到哪里了

阶段 0–3 已完成。当前处在**阶段 6.2 的设计收口期**，账本代码和数据库迁移**尚未实现、也未获授权**。

| 阶段 | 状态 |
|---|---|
| 0 基线与项目身份 | 已完成 |
| 1 架构与基础设施决策 | 已完成 |
| 2 数据库与服务端基础 | 已完成 |
| 3.1–3.5 认证与管理员初始化 | 已完成（真实隔离 PG 验收通过） |
| 3.6 账户安全收尾 | 基础小步骤完成；真实邮件服务按决定延期 |
| 4 Provider 适配 | 4.7.1–4.7.5、4.3.1 SSRF 门禁已完成；**Secret boundary 未闭环，整体未完成** |
| 5 任务与状态恢复 | 5.1–5.12 全部完成（含资产归档、软删除、对象清理、孤儿回收、全站确认弹窗） |
| 6 账户中心与额度账本 | 6.1 身份 UI 完成；**6.2 规则与技术契约已定，待参数收口；账本/迁移/计费未实现** |
| 7 上传与结果归档 | 部分完成：归档/清理/回收已做；交互式上传通道、生产对象存储、保留政策未做 |
| 8 管理后台 | 8.1 完成；4.7.4 准入设计与 4.7.5 数据库身份拆分已验收 |
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

阶段 6.2 剩余参数收口：管理员计价模板的落地细节、价格生效与报价有效期、赠送额度/有效期、反滥用阈值与申诉、上游长期未知的人工处置 SLA。收口并通过评审后，**才**另外申请迁移与账本实现授权。

---

## 2. 文档地图

| 想知道什么 | 去哪看 |
|---|---|
| **总体执行顺序、阶段门禁、当前下一步** | `docs/ImplementationPlan/PAINTTRACK_DEVELOPMENT_PROCESS.md`（权威入口，约 1170 行） |
| 当前进度摘要（就是本文） | `docs/ImplementationPlan/PAINTTRACK_ONBOARDING.md` |
| 最近一次交接：改了什么、证据在哪、下一步候选 | `docs/records/HANDOFF_2026-11-13.md` |
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
4. `docs/records/HANDOFF_2026-11-13.md`
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
- 可选开关（按需加）：`PAINTTRACK_LOCAL_WORKER=1` 起 Worker、`PAINTTRACK_LOCAL_MOCK_ROUTING=1` 用本地 mock 模型路由、`PAINTTRACK_LOCAL_ASSET_CLEANUP=1` 起资产清理进程、`PAINTTRACK_LOCAL_DATABASE=<库名>` 复用历史库。

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
npm test                              # 期望 558 项 / 0 failed
npm run db:migrate:check              # Drizzle 迁移一致性
node scripts/local-registration.js --prune   # dry-run 列出历史本地库
```

---

## 8. 一句话交接

服务端骨架（账户、任务、Provider、资产、权限）已经立起来并通过真实隔离库验收；**它现在还不能对外收费、也不能承诺完整 SaaS 可运营**。下一步是把阶段 6.2 的计价与账本参数收口，然后才谈迁移与计费实现。
