# 阶段 5.2：任务创建 API（认证、归属、幂等）

日期：2026-11-09

## 1. 本步骤范围

本步骤实现 PaintTrack 自己的任务入口，替代“浏览器直接持有供应商 request ID 作为权威状态”的旧路径：

- `POST /api/tasks`：已认证用户创建任务；
- 任务归属只来自会话中的 `user.id`，客户端不能指定；
- 必填 `Idempotency-Key`，在同一个 owner 内唯一；
- 请求体、任务类型和 payload 有明确边界；
- 只写 `generation_tasks`，不调用任何 Provider、不扣额度、不创建云资源。

不在本步骤范围：

- 任务列表/详情/取消接口（5.4）；
- Worker 领取、调用 mock Provider、轮询与结果归档（5.3）；
- 真实 Provider 适配（按用户决定后置）；
- 额度预扣、计费与并发配额（阶段 6，配额上限需产品确认）；
- 前端轮询/SSE（5.4 之后）。

## 2. API 契约

```http
POST /api/tasks
Content-Type: application/json
Idempotency-Key: request-key-0001
Cookie: painttrack_session=...
Origin: https://<app-origin>

{
  "taskType": "image.generate",
  "payload": { "prompt": "a cat", "width": 1024 }
}
```

成功：

- 新任务：`201`，响应头 `Idempotency-Replayed: false`
- 同键同请求重放：`200`，响应头 `Idempotency-Replayed: true`

```json
{
  "task": {
    "id": "uuid",
    "taskType": "image.generate",
    "status": "queued",
    "createdAt": "2026-11-09T02:00:00.000Z",
    "updatedAt": "2026-11-09T02:00:00.000Z"
  }
}
```

响应不含 `owner_id`、`payload`、租约、`worker_id`、请求指纹或供应商内部字段。

### 2.1 错误

| 状态 | 错误码 | 触发条件 |
| --- | --- | --- |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | 缺少 `Idempotency-Key` |
| 400 | `INVALID_IDEMPOTENCY_KEY` | 不是 8–128 位 `[A-Za-z0-9._:-]` |
| 400 | `INVALID_TASK_REQUEST` | 非 JSON 对象、字段缺失或多余、JSON 非法 |
| 400 | `UNSUPPORTED_TASK_TYPE` | 不在 `image.generate` / `video.generate` 白名单 |
| 400 | `INVALID_TASK_PAYLOAD` | payload 非对象、为空、含禁用键、超深度/节点/字符串限制 |
| 401 | `UNAUTHENTICATED` | 无有效会话 |
| 403 | `ORIGIN_REJECTED` | 跨站或缺失 Origin 的变更请求 |
| 405 | `METHOD_NOT_ALLOWED` | 非 POST |
| 409 | `IDEMPOTENCY_KEY_REUSED` | 同键但 taskType/payload 不同 |
| 413 | `BODY_TOO_LARGE` / `TASK_PAYLOAD_TOO_LARGE` | 请求体 > 64 KiB，payload > 32 KiB |
| 415 | `INVALID_CONTENT_TYPE` | 非 `application/json` |
| 503 | `TASK_SUBMISSION_UNAVAILABLE` | 数据库或未知内部故障，不泄露堆栈 |

## 3. 幂等语义

- 指纹 = `sha256(stableStringify({ taskType, payload }))`，对象键排序，数组顺序保留。
- 唯一约束 `(owner_id, idempotency_key)`：
  - 同 owner、同键、同指纹 → 返回原任务，`replayed=true`；
  - 同 owner、同键、不同指纹 → `409`，不覆盖、不复用旧任务；
  - 不同 owner 可以使用相同键，互不影响。
- 并发提交由唯一索引决胜：`INSERT ... ON CONFLICT DO NOTHING`，同一事务内读回原行，避免“插入失败但读不到”的空窗。
- 创建事务不推进任务状态；任务一律以 `queued` 初始状态落库。

## 4. 输入边界

| 项目 | 限制 |
| --- | --- |
| 请求体 | 64 KiB，`application/json`，UTF-8 严格解码 |
| payload | 32 KiB、非空对象、最大深度 8、最多 1000 个节点、字符串 ≤ 4096 |
| 禁用键 | `__proto__`、`constructor`、`prototype`（任意层级） |
| 任务类型 | `image.generate`、`video.generate` |
| 幂等键 | 8–128 位 `[A-Za-z0-9._:-]` |
| 重试次数 | 服务端固定 `max_attempts=3`，客户端不可设置 |

payload 的具体业务 schema 将在 5.3 Worker 侧按任务类型校验；本步骤只保证结构安全与有界。

## 5. 数据模型与迁移

`drizzle/0013_generation_task_ownership.sql`：

- `owner_id uuid NOT NULL`
- `idempotency_key text NOT NULL`
- `request_fingerprint text NOT NULL`
- 唯一索引 `generation_tasks_owner_idempotency_unique (owner_id, idempotency_key)`
- 查询索引 `generation_tasks_owner_created_idx (owner_id, created_at)`
- `CHECK`：幂等键格式、指纹为 64 位小写十六进制

迁移前置条件：`generation_tasks` 必须为空。旧任务没有可归属的用户，迁移会明确报错而不是伪造归属或删除历史数据。当前开发库尚无该表数据；如未来存在历史任务，须先导出并决定处置策略。

## 6. 权限边界

- Web 运行角色新增 `SELECT, INSERT ON generation_tasks`，仅够创建与幂等读回。
- 任务领取、状态更新、删除仍只授予 Worker 角色（`runtimePermissions.js` 的 `worker: true` 分支）。
- 客户端不能提交 `owner_id`、`status`、`attempts`、`max_attempts`、租约或供应商字段；多余字段直接 400。

## 7. 与 Provider 的边界

- 本步骤不加载 `providerConfig`、不读取供应商凭据、不调用 `mockProvider`。
- 5.3 的 Worker 将以 `mockProvider` 作为执行目标，把 `payload` 映射为 Provider `input`，并通过 `provider_calls` 账本记录调用意图。
- 未配置真实 Provider 时，任务可以创建并停留在 `queued`；这是方案 A 的既定代价，不会回退到浏览器直连。

## 8. 验证

| 项目 | 结果 |
| --- | --- |
| 定向测试 | `tests/taskSubmission.test.js`、`tests/taskApi.test.js`、`tests/taskQueue.test.js` 共 24 项全部通过 |
| 全量测试 | `npm test` 248 项 / 246 通过 / 0 失败 / 2 跳过 |
| `npm run lint` | 0 error / 11 warning（与基线一致） |
| `drizzle-kit check` | `Everything's fine` |
| 真实 PostgreSQL 隔离验收 | `.workbuddy/database-acceptance-mw8of0uy_52b6b8.json`，`passed`，72 项检查 / 68 passed / 0 failed |

隔离验收覆盖：

- 0013 迁移应用、列/主键/CHECK/索引与最新 snapshot 逐项比对；
- 14 项 CHECK 与 NOT NULL/主键负例（含幂等键与指纹格式）；
- 同一 owner 并发同键提交收敛为一个任务，且不同 owner 使用同一键互不影响；
- 既有 Worker 租约、崩溃恢复、fencing、权限与事务回滚回归。

## 9. 明确未做

- 未提供任务查询/取消接口；
- 未实现 Worker 执行与 mock Provider 调用；
- 未引入速率限制、并发任务上限或额度扣减（需产品与计费规则确认）；
- 未接真实 Provider、未写真实凭据、未创建云资源。
