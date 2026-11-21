# 新会话开场提示词（复制粘贴用）

> 用法：在新会话里把下面 `---` 之间的内容整段粘贴给它，作为第一条消息。
> 维护：不要在这里复制项目细节。细节只写在 `PAINTTRACK_ONBOARDING.md` 和总体实施计划里，这里只保留「怎么接手」的动作指令，避免两处口径漂移。

---

你接手一个正在进行中的项目，工作目录是 `F:\111\QAQ\me\AI Agent\Hub\PaintTrack\PaintTrack`。

不要先写代码，也不要凭常识猜项目状态。严格按下面四步做。

## 第一步：按序读入口文件

1. `AGENTS.md`（硬约束）
2. `docs/ImplementationPlan/PAINTTRACK_ONBOARDING.md`（项目现状、文档地图、环境、常见坑）
3. `docs/ImplementationPlan/PAINTTRACK_DEVELOPMENT_PROCESS.md` —— **按 §10.0 执行控制协议读取 §10.4 最新当前执行卡**；阶段状态速查仅作摘要，不得据此另定下一步
4. `docs/records/HANDOFF_2026-11-17.md`（当前交接；更早交接仅作历史追溯）
5. 如果接下来的工作是阶段 6，加读 `docs/records/PHASE6_ACCOUNT_CENTER_PRODUCT_DESIGN.md`；如果涉及数据库，加读 `docs/records/DB_SETUP.md`

## 第二步：核验真实状态（不要只信文档）

依次执行并记录结果：

```bash
git branch -vv
git log --oneline -3
git status --short
npm run patch:submodules:check
npm test
```

文档可能与实际不一致。**以命令输出为准**；发现不一致要主动指出来，并说明该以哪份为准。

判断标准：`npm test` 要求 `0 failed`；`patch:submodules:check` 要求退出码 0；`git status` 只应出现三个子模块的 `m`，其它改动都要解释来源。

## 第三步：先汇报，不要开工

按这个结构输出：

1. **项目是什么**（一句话）
2. **现在在哪**：当前阶段编号与名称，哪些已完成的、哪些明确未实现
3. **最近一次提交做了什么**
4. **下一步该做什么**，并注明依据来自哪份文档的哪一节
5. **环境核验结果**：测试通过数与失败数、工作区状态、补丁状态
6. **你发现的疑点或不一致**（没有就写「无」）

汇报完停下，等用户确认再动手。

## 第四步：开工后遵守的节奏

- 一次只推进一个可独立验证的小步骤，做完停下等确认，不要连续跨阶段施工。
- 每步完成后同步四处：总体实施计划、对应阶段设计稿、`docs/records/HANDOFF_*.md`、`.workbuddy/memory/YYYY-MM-DD.md`。历史结论保留并标注「已被取代」，不得改写历史。
- 区分证据等级：`npm test` 是离线测试；真实数据库结论只能看 `.workbuddy/database-acceptance-*.json` 里的 `status`。两者不能互相替代。
- 不得声称某阶段「已完成」，如果只有离线或内存替身证据。

## 硬约束（违反即返工）

- **不要创建根目录 `.env`**。启动器见到 `.env`、`.env.local`、`.env.development`、`.env.development.local` 会直接拒绝启动。需要配置就用命令行内联环境变量。
- **三个子模块 dirty 是正常状态**。`packages/Open-AI-Design-Agent`、`Open-Poe-AI`、`Vibe-Workflow` 的改动来自 `patches/0001~0003` 补丁机制，`npm run setup` 会自动重放。它们指向上游作者仓库（无写权限）且处于 detached HEAD，**不要试图提交或推送**；要改就改补丁文件再跑 `npm run patch:submodules`。
- **不要为了验收变绿而放宽权限**。Web / Worker / cleanup 的表级与列级授权边界不可扩大。
- **未获批准不得引入**：真实 Provider 凭据与预算、云服务、生产部署平台或地域、支付渠道、重型新依赖。
- **写 API 与计费 UI 保持关闭**。Provider 配置写 API、真实余额/扣费/充值入口，在对应门禁通过前不得开放。
- **`drizzle/*.sql` 必须是 LF 行尾**。仓库已用 `.gitattributes` 钉死；若测试报迁移哈希不一致，是行尾问题，不要改测试断言或哈希常量。

## 当前任务定位

本提示词不复制阶段状态、任务号或下一步，避免成为第二个权威来源。新会话完成前述工作树和环境核验后，只引用 `docs/ImplementationPlan/PAINTTRACK_DEVELOPMENT_PROCESS.md` §10.4 最新当前执行卡；授权和冲突处理遵循该文件 §10.0。任务列表、handoff、阶段设计稿、Onboarding、memory 中的旧“当前/下一步”均须与当前执行卡核对，不能单独作为开工授权。

如当前执行卡缺失、信息不全或与用户最近指令/代码实际状态冲突：先报告冲突与证据，标记待澄清/阻断并暂停，不猜测任务定义、不发起外部调用。

---

## 极简版（不想跑测试时用）

如果你只想快速对齐、不做核验，用这段：

```
工作目录 F:\111\QAQ\me\AI Agent\Hub\PaintTrack\PaintTrack。
按顺序读 AGENTS.md、docs/ImplementationPlan/PAINTTRACK_ONBOARDING.md、
总体实施计划的 §10.4 与阶段状态速查表、docs/records/HANDOFF_2026-11-17.md。
然后用 6 行以内告诉我：项目是什么、现在在哪一步、下一步做什么、依据是哪份文档的哪一节。
先不要改任何文件，等我确认。
```

极简版省掉了状态核验，适合只想聊方向的时候；真要动手前，还是补跑一次 `npm test`。
