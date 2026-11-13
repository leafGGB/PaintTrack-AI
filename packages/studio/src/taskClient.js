const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const TASKS_PATH = "/api/tasks";
const ASSETS_PATH = "/api/assets";
const IMAGE_CATALOG_PATH = "/api/catalog/models?media=image";
const ASSET_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// 只有本服务归档出来的内容地址才可删除；外部供应商 CDN 地址不在本服务管辖范围内。
const ASSET_CONTENT_PATH = /^\/api\/assets\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/content\/?$/i;
const SIZE_BY_ASPECT_RATIO = Object.freeze({
  auto: "1024x1024",
  "1:1": "1024x1024",
  "16:9": "1536x864",
  "9:16": "864x1536",
  "4:3": "1365x1024",
  "3:4": "1024x1365",
});

function createIdempotencyKey() {
  if (globalThis.crypto?.randomUUID) return `studio_${globalThis.crypto.randomUUID()}`;
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `studio_${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function getErrorCode(body, fallback) {
  return body?.error?.code || body?.code || fallback;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function requestJson(fetchImpl, url, options, fallbackCode) {
  const response = await fetchImpl(url, options);
  const body = await readJson(response);
  if (!response.ok) {
    const error = new Error(getErrorCode(body, fallbackCode));
    error.code = getErrorCode(body, fallbackCode);
    error.status = response.status;
    throw error;
  }
  return body;
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("The operation was aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("The operation was aborted", "AbortError"));
    }, { once: true });
  });
}

export async function getImageTaskModel({ fetchImpl = globalThis.fetch, signal } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetch is required");
  const body = await requestJson(fetchImpl, IMAGE_CATALOG_PATH, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    signal,
    headers: { Accept: "application/json" },
  }, "CATALOG_QUERY_FAILED");
  const model = Array.isArray(body?.models)
    ? body.models.find((entry) => entry?.mediaType === "image"
      && Array.isArray(entry.operations)
      && entry.operations.includes("image.generate")
      && typeof entry.logicalModelId === "string"
      && entry.logicalModelId.length > 0)
    : null;
  return model || null;
}

function isTaskResultImage(task) {
  const result = task?.result;
  return task?.status === "succeeded"
    && result?.mediaType === "image"
    && typeof result.resultUrl === "string"
    && result.resultUrl.length > 0;
}

export async function createImageTask({
  logicalModelId,
  prompt,
  aspectRatio = "1:1",
  fetchImpl = globalThis.fetch,
  idempotencyKey = createIdempotencyKey(),
  signal,
} = {}) {
  if (typeof logicalModelId !== "string" || !logicalModelId.trim()) {
    throw new TypeError("logicalModelId is required");
  }
  if (typeof prompt !== "string" || !prompt.trim()) throw new TypeError("prompt is required");
  if (!Object.hasOwn(SIZE_BY_ASPECT_RATIO, aspectRatio)) throw new TypeError("aspectRatio is unsupported");
  if (typeof fetchImpl !== "function") throw new TypeError("fetch is required");

  const body = await requestJson(fetchImpl, TASKS_PATH, {
    method: "POST",
    credentials: "same-origin",
    signal,
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      taskType: "image.generate",
      payload: {
        logicalModelId,
        prompt: prompt.trim(),
        aspectRatio,
        size: SIZE_BY_ASPECT_RATIO[aspectRatio],
      },
    }),
  }, "TASK_SUBMISSION_FAILED");

  if (!body?.task || typeof body.task.id !== "string") {
    throw new Error("INVALID_TASK_RESPONSE");
  }
  return body.task;
}

export async function waitForImageTask(taskId, {
  fetchImpl = globalThis.fetch,
  signal,
  pollIntervalMs = 1000,
  timeoutMs = 120000,
  now = () => Date.now(),
  sleep = delay,
} = {}) {
  if (typeof taskId !== "string" || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(taskId)) {
    throw new TypeError("taskId must be a UUID");
  }
  if (typeof fetchImpl !== "function") throw new TypeError("fetch is required");
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 100) {
    throw new TypeError("pollIntervalMs must be at least 100ms");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be positive");

  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const body = await requestJson(fetchImpl, `${TASKS_PATH}/${encodeURIComponent(taskId)}`, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      signal,
      headers: { Accept: "application/json" },
    }, "TASK_QUERY_FAILED");
    const task = body?.task;
    if (!task || task.id !== taskId) throw new Error("INVALID_TASK_RESPONSE");
    if (TERMINAL_STATUSES.has(task.status)) {
      if (task.status !== "succeeded") {
        const error = new Error(task.errorCode || `TASK_${task.status.toUpperCase()}`);
        error.code = task.errorCode || `TASK_${task.status.toUpperCase()}`;
        error.task = task;
        throw error;
      }
      if (!isTaskResultImage(task)) {
        const error = new Error("IMAGE_RESULT_NOT_AVAILABLE");
        error.code = "IMAGE_RESULT_NOT_AVAILABLE";
        error.task = task;
        throw error;
      }
      return task;
    }
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - now())), signal);
  }
  const error = new Error("TASK_POLL_TIMEOUT");
  error.code = "TASK_POLL_TIMEOUT";
  error.taskId = taskId;
  throw error;
}

// 历史条目可能来自 localStorage 或旧版本（只有 url），因此删除前统一从内容地址反推资产 ID。
function assetIdFromResultUrl(url) {
  if (typeof url !== "string") return null;
  const match = ASSET_CONTENT_PATH.exec(url.trim());
  if (!match) return null;
  const assetId = match[1];
  return ASSET_ID_PATTERN.test(assetId) ? assetId : null;
}

// 调用 DELETE /api/assets/:id。删除是幂等的：资产已不存在或不属于当前用户时，
// 服务端统一返回 404（不区分两种情况），对 UI 而言都等价于「已经没有这个资产」。
export async function deleteAsset(assetId, { fetchImpl = globalThis.fetch, signal } = {}) {
  if (typeof assetId !== "string" || !ASSET_ID_PATTERN.test(assetId)) {
    throw new TypeError("assetId must be a UUID");
  }
  if (typeof fetchImpl !== "function") throw new TypeError("fetch is required");
  const response = await fetchImpl(`${ASSETS_PATH}/${encodeURIComponent(assetId)}`, {
    method: "DELETE",
    credentials: "same-origin",
    cache: "no-store",
    signal,
    headers: { Accept: "application/json" },
  });
  const body = await readJson(response);
  if (response.ok) {
    const asset = body?.asset;
    return {
      id: assetId,
      status: asset?.status || "deleted",
      deletedAt: asset?.deletedAt ?? null,
      alreadyDeleted: asset?.alreadyDeleted === true,
    };
  }
  if (response.status === 404) {
    return { id: assetId, status: "deleted", alreadyDeleted: true };
  }
  const code = getErrorCode(body, "ASSET_DELETE_FAILED");
  const error = new Error(code);
  error.code = code;
  error.status = response.status;
  throw error;
}

export { createIdempotencyKey, isTaskResultImage, assetIdFromResultUrl };
