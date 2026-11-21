# MyVigna 对接文档

> MYVIGNA API · 更新于 2026-11-06

使用本站密钥，将文本、图片与视频模型接入你的应用。从获取模型列表开始，按对应分组与模型协议调用；第 10、11 章按档位列出图片与视频模型的参数口径和注意事项。

---

## 1. 接入前准备
1. 登录本站，在[控制台 → API 密钥](/keys)创建令牌，选择需要使用的分组，并确认余额、额度、过期时间和模型限制。
2. 将密钥保存为环境变量 `MYVIGNA_API_KEY`。示例中的密钥均为占位符，需替换为你自己的密钥。
3. 先查询当前 Key 的模型列表，再复制完整模型名调用；中文、括号、线路和“原生”等后缀均是模型名的一部分。

| 配置项 | 填写内容 |
|---|---|
| 服务地址（Origin） | `https://www.myvigna.top` |
| OpenAI 兼容 Base URL | `https://www.myvigna.top/v1` |
| 鉴权 | `Authorization: Bearer YOUR_API_KEY` |
| JSON 请求头 | `Content-Type: application/json` |
| 模型与价格 | 以[模型广场](/pricing)、当前分组和实际账单为准 |

SDK 的 Base URL 填到 `/v1`；直接用 HTTP 时使用下文的完整路径。不要重复拼成 `/v1/v1`。API Key 使用控制台颁发的令牌，不是登录密码或浏览器 Cookie。

> 下方 curl 使用 Bash 语法。Windows PowerShell 请用 curl.exe，将 JSON 保存为 UTF-8 request.json 后用 --data-binary @request.json；换行符与环境变量语法需要按所用终端调整。

---

## 2. 查询可用模型与分组

```
curl --fail-with-body "https://www.myvigna.top/v1/models" \
  -H "Authorization: Bearer $MYVIGNA_API_KEY"
```

```
{"object":"list","data":[{"id":"YOUR_MODEL_ID","object":"model"}]}
```

`data[].id` 就是请求的 `model`。列表随令牌权限、分组和渠道状态变化；有模型权限不代表支持所有接口和参数。

不同分组有独立倍率、模型与质量规则。切换分组请使用绑定该分组的 Key；不要随意给请求添加 group 字段来切组。按 token、按次、按秒的模型计费方式不同，以模型详情和使用日志为准。

---

## 3. 分组与代表模型速查

每个分组是一套独立的模型池和计价规则。下面的分组名就是你后台令牌里看到的「分组」；调用时不需要在请求体里传分组，**用哪个分组的 Key，就走哪个分组**。

| 分组 | 类型 | 代表模型 | 主要接口 |
|---|---|---|---|
| `default` / `gpt渠道1~5` / `不降智商渠道1` | GPT 文本 | `gpt-6-astra`、`gpt-6.1-sol`、`gpt-5.6-sol`、`gpt-5.6-terra` | `/v1/chat/completions`、`/v1/responses` |
| `Gemini渠道2` | Gemini 文本 | `gemini-4-argon`、`gemini-4-argon-high/medium/low`、`gemini-3.8-flash` | `/v1/chat/completions` |
| `国模分组` | 国产文本 | `deepseek-v4-pro`、`deepseek-v4-flash`、`deepseek-v4.1-flash` | `/v1/chat/completions` |
| `CC满血` / `Kiro企业` / `kiro低价渠道` | Claude 文本 | `claude-opus-4-8`、`claude-fable-5`、`claude-haiku-4-5` | `/v1/chat/completions` |
| `grok特惠` | Grok 文本 | `grok-4.5`、`grok-4.6`、`grok-4.7` | `/v1/chat/completions` |
| `free-model` | 免费/工具模型 | `nemotron-3-ultra-550b-a55b`、`nv-embed-v1`、`nemotron-3.5-content-safety`、`step-5-preview` | `/v1/chat/completions`、`/v1/embeddings` |
| `生图分组分组` | 图片 | `gpt-image-2`、`gpt-image-2.5-flare/sunburst`、`seedream-5.0-pro`、`gemini-nano-banana-2.1`、`midjourney-v8.2-full` | `/v1/images/generations`、`/v1/images/edits`、`/v1/images/tasks` |
| `视频分组` | 视频 | `sd2.5-多尺寸301010-线路1`、`sd2.0-fast-933-线路1`、`seedance-2.5-m1`、`minimax-h3-f`、`sd-2.0` | `/v1/videos` |
| `音乐模型` | 音乐 | `suno-v6`、`suno-v5.5`、`suno-v6-mini`、`Lyria-3pro音频音乐` | 按模型说明提交，通常返回任务号后轮询 |

### 视频分组要点

视频模型的参数彼此不同，先 `GET /v1/models` 拿到准确模型名，再按模型说明传参。通用规律：

| 模型族 | 分辨率写法 | 备注 |
|---|---|---|
| `minimax-h3-f` / `全参MinimaxH3` / `官方h3-*` | `480p` / `720p` / `768p` / `1080p` / `2k`（枚举） | 不能写 `1920x1080`，否则报 `plugin usage enum is not an allowed value`；时长 4–15 秒整数 |
| `sd-*` / `seedance-*` | 按模型说明，常见 `720p` | 部分按秒计费 |
| `rh-h3-video` / `sd-rh-h3` | 用 `usage.size` 传比例（`16:9`、`9:16` 等） | 支持参考视频：`video_url` 或 `reference_videos`；参考图：`image_url` 或 `images`（最多 9 张） |

### 图片分组要点

按模型分三种入参：普通 GPT 图片走 multipart；原生 GPT / Seedream / Gemini 走 JSON 的 `images[].image_url`；Midjourney 使用专用模型名（带参考图请用 `-ref` 别名，会自动按带参考图计费）。

### 音乐分组要点

音乐模型（Suno、Lyria）使用音乐分组的 Key。提交后一般返回任务编号，按模型说明轮询取结果；不要把视频或图片接口的参数套用到音乐模型。

> 分组会随渠道调整而变化，模型清单以 `GET /v1/models` 和「模型广场」的实时结果为准。

---

## 4. 文本对话 · Chat Completions

```
curl --fail-with-body "https://www.myvigna.top/v1/chat/completions" \
  -H "Authorization: Bearer $MYVIGNA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"YOUR_CHAT_MODEL_ID","messages":[{"role":"user","content":"你好，请简短介绍自己。"}],"stream":false}'
```

非流式正文通常位于 `choices[0].message.content`。模型名用上一节返回的真实 ID 替换；图片、视频模型不能直接当作聊天模型调用。

### 流式输出

将 `stream` 改为 `true`，curl 添加 `-N`；客户端逐块读取 SSE 的 `data:`，拼接 `choices[].delta.content`，并正确处理结束标志、错误和工具调用。不要先等整个响应读完再展示。支持情况依模型和渠道而定。

```
curl -N "https://www.myvigna.top/v1/chat/completions"   -H "Authorization: Bearer $MYVIGNA_API_KEY"   -H "Content-Type: application/json"   -d '{"model":"YOUR_CHAT_MODEL_ID","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

> HTTP 200、心跳或思考事件不等于完整回答。工具调用参数可能分片，需拼接后执行；连接中断时不要直接重放已执行工具的请求。

---

## 5. Responses 兼容接口

```
curl --fail-with-body "https://www.myvigna.top/v1/responses" \
  -H "Authorization: Bearer $MYVIGNA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"YOUR_RESPONSES_MODEL_ID","input":"请用一句话介绍你自己。","stream":false}'
```

用于支持 Responses 的模型/分组。正文从 `output[]` 中 message 的 `content[]` / `output_text` 项读取，不能套用 Chat 的 choices 字段。流式使用 Responses 事件格式，不能复用 Chat SSE 解析器。客户端选用 OpenAI 兼容提供方，Base URL 同样填本站 `/v1`。

Claude / Gemini 等模型若通过 OpenAI 兼容协议接入，使用其实际模型名与支持的兼容接口；不能仅凭模型厂商就假定原生 Messages、generateContent 或某个工具协议可用。

---

## 6. Python 与 Node.js SDK

Python：`pip install openai`。环境变量设置自己的密钥与可用文本模型 `MYVIGNA_MODEL`。

```
import os
from openai import OpenAI
client = OpenAI(
    api_key=os.environ["MYVIGNA_API_KEY"],
    base_url="https://www.myvigna.top/v1",
    timeout=180.0,
    max_retries=0,
)
reply = client.chat.completions.create(
    model=os.environ["MYVIGNA_MODEL"],
    messages=[{"role": "user", "content": "你好"}],
)
print(reply.choices[0].message.content)
```

Node.js：`npm install openai`，保存为 `example.mjs`。

```
import OpenAI from "openai";
const client = new OpenAI({
  apiKey: process.env.MYVIGNA_API_KEY,
  baseURL: "https://www.myvigna.top/v1",
  timeout: 180000,
  maxRetries: 0,
});
const reply = await client.chat.completions.create({
  model: process.env.MYVIGNA_MODEL,
  messages: [{ role: "user", content: "你好" }],
});
console.log(reply.choices[0].message.content);
```

客户端若只要求“API 地址”，请留意它是否自动添加 /v1。密钥应由你自己的后端或本地客户端持有，公开前端不要嵌入服务端密钥。

---

## 7. 同步图片生成与参考图

文生图：`POST /v1/images/generations`；参考图：`POST /v1/images/edits`。模型质量档和尺寸必须匹配对应分组；以下仅展示普通 GPT 图片接口的请求结构。

```
curl --fail-with-body "https://www.myvigna.top/v1/images/generations" \
  -H "Authorization: Bearer $MYVIGNA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"YOUR_IMAGE_MODEL_ID","prompt":"一只橘猫坐在窗边，柔和自然光","n":1,"size":"1024x1024","response_format":"url"}'
```

普通 GPT 参考图使用 multipart；让客户端自动设置带 boundary 的 Content-Type。

```
curl --fail-with-body "https://www.myvigna.top/v1/images/edits"   -H "Authorization: Bearer $MYVIGNA_API_KEY"   -F "model=YOUR_ORDINARY_GPT_IMAGE_MODEL_ID"   -F "prompt=将图片中的杯子改为蓝色"   -F "image=@reference.png" -F "n=1"
```

原生 GPT 参考图使用 JSON，示例中的模型 ID 必须来自原生分组：

```
curl --fail-with-body "https://www.myvigna.top/v1/images/edits" \
  -H "Authorization: Bearer $MYVIGNA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"YOUR_NATIVE_IMAGE_MODEL_ID","prompt":"将图1的杯子改为蓝色","n":1,"size":"1024x1024","quality":"high","images":[{"image_url":"data:image/png;base64,REPLACE_WITH_IMAGE_BASE64"}]}'
```

| 模型类型 | 格式/参数要点 |
|---|---|
| 普通 GPT 图片 | 参考图 multipart；质量按模型说明使用，不套用原生 high/medium |
| 原生 GPT 图片 | 参考图 JSON：images[].image_url；quality 按对应模型/分组说明 |
| Seedream | 参考图 JSON：images[].image_url；不传 GPT quality；size / resolution 按模型说明选用 |
| Midjourney / Niji | 使用精确版本模型名及专用素材、参数规则；不要套用 GPT quality |

结果可能包含 `data[].url` 或 `data[].b64_json`。url 需及时下载，外部 CDN 下载不附加本站 Key；b64_json 需 Base64 解码成图片字节。结果 JSON 不能直接改名为 PNG。请保存所有 data 项。

---

## 8. 推荐：异步生图 · 可恢复原任务

提交一次 → 保存 task_id → 查询状态 → 成功后取图。长耗时生成推荐使用本站异步接口；每次新生成使用一个新的幂等键，同次网络恢复保持原幂等键和完全相同的请求。

```
curl --fail-with-body "https://www.myvigna.top/v1/images/tasks" \
  -H "Authorization: Bearer $MYVIGNA_API_KEY" \
  -H "Idempotency-Key: image-unique-request-001" \
  -H "Content-Type: application/json" \
  -d '{"model":"YOUR_IMAGE_MODEL_ID","prompt":"一只橘猫坐在窗边","n":1,"size":"1024x1024","response_format":"url"}'
```

```
HTTP 202
{"object":"image.task","task_id":"imgtask_…","status":"queued",
 "poll_url":"/v1/images/tasks/imgtask_…",
 "result_url":"/v1/images/tasks/imgtask_…/result","poll_after_ms":2000}
```

```
curl --fail-with-body "https://www.myvigna.top/v1/images/tasks/TASK_ID" \
  -H "Authorization: Bearer $MYVIGNA_API_KEY"
```

| 状态 | 处理 |
|---|---|
| queued / running | 继续查询原任务，遵守 poll_after_ms / Retry-After |
| success | GET /v1/images/tasks/TASK_ID/result 读取图片 JSON |
| failed / uncertain | 保存任务号、读取 error；停止自动重建，核对使用日志或联系支持 |

结果接口返回 202 表示仍在处理；HTTP 200 才读取 data。所有查询均使用提交时同一把 Key。参考图使用 `POST /v1/images/tasks/edits`，沿用上一节对应模型格式。近期任务：`GET /v1/images/tasks?limit=20`。

请求体当前上限 20 MB；任务结果通常保留约 24 小时，实际以回执 expires_at 为准，图片链接可能更早失效。不要使用 /tasks/generations，也不要因超时更换幂等键重新生图。下载失败只重试原结果下载。

[查看异步生图补充说明 →](/async-api.html)

---

## 9. 视频生成与取回

视频使用**视频分组**的 Key。若 Key 是 `auto` 或生图分组，调用视频会返回 `503 No available channel for model  under group `，需要换成视频分组的 Key。

视频是**异步任务**：提交拿 `id` → 轮询状态 → 完成后取文件。单条通常 30 秒到 10 分钟，提交请求不要设太短超时。

### 提交任务

```
curl --fail-with-body "https://www.myvigna.top/v1/videos" \
  -H "Authorization: Bearer $MYVIGNA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"YOUR_VIDEO_MODEL_ID","prompt":"阳光穿过森林，镜头缓慢推进","seconds":5,"size":"720p","aspect_ratio":"16:9"}'
```

响应里保存 `id`：

```
{"id":"task_xxx","object":"video","model":"...","status":"queued","progress":0,"created_at":1793976113}
```

### 轮询任务

```
curl --fail-with-body "https://www.myvigna.top/v1/videos/TASK_ID" \
  -H "Authorization: Bearer $MYVIGNA_API_KEY"
```

状态值：`queued` 排队中、`in_progress` 生成中、`succeeded` 成功、`failed` 失败。前 2 分钟每 5 秒查一次，之后放宽到 15 秒；总超时建议给足 15 分钟。不要用 1 秒级高频轮询。

### 取回文件

```
curl --fail-with-body "https://www.myvigna.top/v1/videos/TASK_ID/content" \
  -H "Authorization: Bearer $MYVIGNA_API_KEY" \
  --output video.mp4
```

若查询响应里直接给了 `url`，那是上游临时地址，**请及时转存**到你自己的存储，过期后无法再取。

### 参数要点
- `size` 与 `resolution` 大部分模型都认，但 `wan3-480p-20s` / `wan3-720p-20s` **必须用 size**，传 resolution 会报 `plugin_usage_invalid`。保险起见统一用 `size`。
- 分辨率必须在该模型支持范围内，否则报 `invalid_resolution`。例如 `minimax-h3-f` 支持 480p / 768p / 1080p，**不支持 720p**。
- 参考图必须是**公网 HTTP(S) 直链**，不支持本地上传（会报 `Video references require public HTTP(S) URLs`）。私有存储请生成有效期 ≥30 分钟的签名链接。
- 提交时按最坏情况**预扣额度**，完成后按实际结算，失败会退还。余额建议留 20% 余量，否则会出现「明明够钱却报余额不足」。
- 失败不要原样重试：多半是提示词或素材触发上游审核，重试大概率继续失败，还会重复扣费。
- 超时不等于任务停止。已拿到 `task_id` 就查原任务，**不要重新 POST**（会二次计费）。
- 同一 Key 大量并发提交会被上游排队，表现为长时间停在 `queued`；单 Key 并发建议不超过 3~5 个。

---

## 10. 图片模型各档位参数与注意事项

下表把当前生图分组里的档位、分辨率口径、quality 与参考图能力对齐。模型名里的括号、线路和「原生 / 满血 / 稳定 / 4k」后缀都是模型名的一部分，必须整串传入。

| 档位（完整模型名） | 分辨率 / 尺寸 | quality | 参考图 | 说明 |
|---|---|---|---|---|
| `gpt-image-2` | 仅 1K（1024×1024 等，按 size 给像素） | 固定 high | 支持 · JSON | 基础档，无超分 |
| `gpt-image-2（4k）` | 1K 超分；支持 1/2/4K | 上游未明确 | 支持 · JSON | 用 size 传 2048/3840 级像素 |
| `gpt-image-2（稳定）` | 2K 超分；支持 1/2/4K | 上游未明确 | 支持 · JSON | 画质稳定优先 |
| `gpt-image-2（原生高质量）` | 原始分辨率；支持 1/2/4K | high | 支持 · JSON | 原生成像，质量档 high |
| `gpt-image-2（原生中质量）` | 原始分辨率；支持 1/2/4K | medium | 支持 · JSON | 原生成像，质量档 medium |
| `gpt-image-2（原生）` | 原生通道分辨率 | 按档位 | 支持 · JSON | 生图分组（原生）专档 |
| `gpt-image-2.5 / -flare / -sunburst` | 仅 1K | 固定 high | 支持 · JSON | 无超分 |
| `gpt-image-2.5（4k）/ -flare（4k）/ -sunburst（4k）` | 1K 超分；支持 1/2/4K | 上游未明确 | 支持 · JSON | 按 size 指定 2K/4K |
| `…（稳定）` | 2K 超分；支持 1/2/4K | 上游未明确 | 支持 · JSON | 同上命名族 |
| `…（满血）` | 原始分辨率；支持 1/2/4K | 全质量可选 | 支持 · JSON | 最高画质档 |
| `…（原生中质量）` | 原始分辨率；支持 1/2/4K | medium | 支持 · JSON | 原生成像 |
| `…（原生）` | 原生通道分辨率 | 按档位 | 支持 · JSON | 生图分组（原生） |
| `grok-imagine-image-2.0` | size=宽x高；不传则为默认 | 无 quality 字段 | 不支持 | 仅文生图；带参考图会被直接拒绝且不扣费 |
| `seedream-5.0-lite` | 按 size 比例出图 | 无 | 支持，仅 1 张 | 真正图生图档 |
| `seedream-5.0-pro` | 固定 2048×2048 方图 | 无 | 只读参考图（≤8 张） | 不按图生图；需在提示词里描述参考图内容 |
| `midjourney-v7 / v8 / v8.1 / v8.2-full` | 由上游决定 | 无 | 带参考图请用 -ref 别名 | -ref 别名会自动按带参考图计费 |
| `midjourney-v8.2` | 由上游决定 | 无 | 不支持 | 标准档 |
| `midjourney-v8.2-特价` | 由上游决定 | 无 | 不支持 | 只有文生图 |
| `niji-v7-full / -ref` | 由上游决定 | 无 | 带参考图请用 -ref 别名 | 同上 -ref 约定 |
| `gemini-3-pro-image-preview / gemini-3.1-flash-image-preview / gemini-nano-banana-2.1` | imageSize 1K/2K/4K + aspectRatio 1:1、4:3、3:4、16:9、9:16 | 无 | 支持 · JSON | 分辨率与比例写在 extra_fields.gemini_image_config |

### 通用规则

| 项目 | 写法与限制 |
|---|---|
| 文生图 | `POST /v1/images/generations`，JSON |
| 参考图 | `POST /v1/images/edits`，JSON 的 `images[].image_url`（公网直链或 image data URL） |
| 不支持的参考图字段 | `imageurls`、`urls`、`file_id` 都不是该 JSON 编辑接口的字段 |
| multipart | 仅普通 GPT 图片档使用，`image` 字段可重复；原生档与 Grok、Gemini 请用 JSON |
| 尺寸 | `size` 传 `宽x高` 的整数像素；分辨率由 size 决定，不要靠模型名后缀猜 |
| 张数 | `n` 为 1–6 的整数，实际可用数量以分组为准 |
| 幂等 | 带 `Idempotency-Key`，重复提交同一键不会重复扣费 |
| 响应 | 同步返回 200 带 `data[]`；异步返回 202 带 `task_id`，按 `poll_after_ms` 轮询 |

### 注意事项
1. 提示词为空白字符串会被拒（400）；`size` 与 `resolution` 不要同时传。
2. 参考图建议单张 ≤1.4 MB、单边 ≤2048；过大的图先压缩，否则容易 400 或超时。
3. 任务已失败或结果未确认时不要自动重发：凭 `task_id` 查原任务；失败任务不计费。
4. `grok-imagine-image-2.0` 暂不支持图片编辑（只能文生图）：带参考图会被拒绝，且不产生任务、不扣费。
5. `seedream-5.0-pro` 只读参考图、不按图生图，出图固定方图；要真正图生图请用 `seedream-5.0-lite`。
6. Midjourney / niji 带参考图请用 `-ref` 别名，它会自动按带参考图计费；基础别名只做文生图。
7. Gemini 图片模型的分辨率与比例写在 `extra_fields.gemini_image_config` 的 `imageSize` 与 `aspectRatio` 里，不支持任意像素尺寸。

---

## 11. 视频模型各档位参数与注意事项

下表是当前**视频分组**实际可用的 21 个模型，参数与价格取自各模型的当前配置。未列出的模型名调用会返回 400。

### 11.1 按秒计费（费用 = 单价 × 实际时长）

| 模型 | 480P | 720P | 768P | 1080P | 4K | 时长范围 | 参考素材上限 |
|---|---|---|---|---|---|---|---|
| `seedance-2.0-mini-m1` | 0.138 | 0.276 | — | — | — | 4–15 秒 | 9 图 / 3 视频 / 3 音频 |
| `seedance-2.0-fast-m1` | 0.207 | 0.437 | — | — | — | 4–15 秒 | 9 图 / 3 视频 / 3 音频 |
| `seedance-2.0-m1` | 0.2645 | 0.5474 | — | — | — | 4–15 秒 | 9 图 / 3 视频 / 3 音频 |
| `seedance-2.5-m1` | 0.3335 | 0.7475 | — | — | — | 4–30 秒 | 30 图 / 10 视频 / 10 音频 |
| `sd-mini` | 0.2645 | 0.5175 | — | — | — | 4–15 秒 | — |
| `sd-fast` | 0.69（不分档） | — | — | — | — | 4–15 秒 | — |
| `sd2.5-pro` | 0.6555（不分档） | — | — | — | — | 4–30 秒 | — |
| `sd-2.5-720p` | — | 1.38 | — | — | — | 4–30 秒 | — |
| `sd-2.0` | 0.575 | 0.92 | — | 2.07 | 4.6 | 4–15 秒 | — |
| `minimax-h3-f` | 0.0575 | — | 0.069 | 0.1725 | — | 4–15 秒 | — |

> 单位：元/秒。**seedance 系列特别注意**：带参考视频时，计费时长 = 生成时长 + 参考视频实际总时长。例如生成 4 秒、参考视频 6 秒，按 10 秒计费。

### 11.2 按条计费（固定价格，与时长无关）

| 模型 | 单价（元/次） | 清晰度 | 时长 | 画面比例 | 参考素材 |
|---|---|---|---|---|---|
| `video-sd20-10s` | 0.92 | 按提交参数 | 固定 10 秒 | 按提交参数 | — |
| `sd2.0-mini竖屏933-线路1` | 2.16 | 固定 720P | 4–15 秒整数 | 仅 9:16 竖屏 | 9 图 / 3 视频 / 3 音频，合计 ≤15 |
| `wan3-480p-20s` | 2.76 | 固定 480P | 固定 20 秒 | 按提交参数 | — |
| `wan3-720p-20s` | 3.45 | 固定 720P | 固定 20 秒 | 按提交参数 | — |
| `sd2.0-fast-933-线路1` | 3.6 | 固定 720P | 4–15 秒 | 1:1 / 16:9 / 9:16 | 9 图 / 3 视频 / 3 音频 |
| `sd2.0-竖屏933-线路1` | 3.6 | 固定 720P | 4–15 秒 | 仅 9:16 竖屏 | 9 图 / 3 视频 / 3 音频（合计 15） |
| `sd2.0-fast-933-线路3` | 4.2 | 固定 720P | 4–15 秒 | 全比例 | 9 图 / 3 视频 / 3 音频 |
| `sd2.0-满血-903-线路3` | 5.16 | 固定 720P | 10 或 15 秒 | 16:9 / 9:16 / 4:3 / 3:4 / 1:1 / 21:9 | 9 图 / 3 音频（不支持参考视频） |
| `sd2.5-满血301010-线路1` | 6.6 | 固定 720P | 固定 30 秒 | adaptive / 21:9 / 16:9 等 | 30 图 / 10 视频 / 10 音频，合计 ≤50 |
| `sd2.5max900` | 6.9 | 按提交参数 | 4–30 秒 | 按提交参数 | — |
| `sd2.5-多尺寸301010-线路1` | 7.8 | 480P / 720P / 1080P 同价 | 4–30 秒 | 16:9 / 9:16 / 1:1 / 4:3 / 3:4 / 21:9 | 30 图 / 10 视频 / 10 音频 |

> 按条计费的模型，提交时传的 `seconds` 只在允许范围内校验，**不影响价格**。标「固定」的分辨率或时长，传其它值无效。

### 11.3 参数注意事项
1. **分辨率超出范围会被拒**：报 `invalid_resolution`。典型例子是 `minimax-h3-f` 支持 480p / 768p / 1080p，**不支持 720p**。
2. **wan3 系列必须用 size**：`wan3-480p-20s` / `wan3-720p-20s` 传 `resolution` 会报 `plugin_usage_invalid: plugin usage enum is not an allowed value`。
3. **时长超出范围会被拒**：报 `invalid_duration`。固定时长的模型（如 wan3 固定 20 秒、`sd2.5-满血301010-线路1` 固定 30 秒）传别的值无意义。
4. **参考素材必须是公网直链**：图片 / 视频 / 音频都要公网 HTTP(S) 地址，本地文件先上传拿 URL 再提交。
5. **参考素材有数量上限**：见上表最后一列。`sd2.0-满血-903-线路3` 不支持参考视频，只支持图片和音频。
6. **预扣机制**：提交时按最大时长和最高分辨率预扣，完成后按实际结算。余额不足会报 `insufficient_user_quota`。
7. **计费配置异常**：若报 `model_price_error: fixed pricing is not supported for task usage expressions`，说明该模型的计费表达式配置有问题，请联系管理员。

### 11.4 选型建议

| 需求 | 推荐模型 |
|---|---|
| 最便宜试水 | `seedance-2.0-mini-m1`（480P ¥0.138/秒） |
| 性价比 + 画质 | `seedance-2.0-m1`（480P ¥0.2645/秒） |
| 长视频（30 秒） | `seedance-2.5-m1` 或 `sd2.5-多尺寸301010-线路1` |
| 4K 输出 | `sd-2.0`（4K ¥4.6/秒） |
| 竖屏短视频 | `sd2.0-mini竖屏933-线路1`（按条 ¥2.16） |
| 多参考素材（30 图） | `sd2.5-多尺寸301010-线路1` 或 `seedance-2.5-m1` |
| 成本可预估 | 任意按条计费模型 |

---

## 12. 常见错误与排查

| 状态/现象 | 检查方法 |
|---|---|
| 400 | 检查精确模型名、字段格式、尺寸、quality、时长与素材限制 |
| 401 | Key 无效、过期、被删除或 Authorization 缺失 |
| 403 | 检查分组/模型权限、IP 限制及跨域；浏览器跨站调用可能不开放 |
| 404 | 检查接口路径；任务查询还需检查同一 Key、编号和过期时间 |
| 409 / 410 | 异步任务非成功、幂等冲突或过期；读响应中的具体错误 |
| 413 | 请求体过大，Base64 会增加体积 |
| 429 | 限流、队列繁忙或并发限制；遵守 Retry-After 并退避 |
| 5xx / 超时 | 保存请求号；媒体请求先查原任务和使用日志，避免重复提交 |
| 看不到模型 / 模型无渠道 | 检查当前 Key 分组、模型限制和渠道可用性 |
| 图片只显示一部分 / 链接失效 | 检查 CDN 下载链路和链接有效期，只重试取图，不重新生成 |

排查时提供：请求时间、模型完整名称、接口路径、HTTP 状态、任务号/请求号和错误内容。不要提供完整密钥。调用是否扣费及金额以本站[使用日志](/usage-logs)与账单为准。

---
