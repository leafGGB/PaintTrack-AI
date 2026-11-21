const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const TASKS_PATH = "/api/tasks";
const ASSETS_PATH = "/api/assets";
const IMAGE_CATALOG_PATH = "/api/catalog/models?media=image";
const VIDEO_CATALOG_PATH = "/api/catalog/models?media=video";
export const IMAGE_TASK_ASPECT_RATIOS = Object.freeze(["auto", "1:1", "16:9", "9:16", "4:3", "3:4"]);
const LOGICAL_MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,127}$/;
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

function studioHistoryError(code) {
  return Object.assign(new Error(code), { code });
}

export async function getStudioHistory({
  accountId, media, limit = 20, cursor = null, fetchImpl = globalThis.fetch, signal,
} = {}) {
  if (typeof accountId !== "string" || !accountId.trim()) {
    throw studioHistoryError("STUDIO_HISTORY_ACCOUNT_REQUIRED");
  }
  if (media !== "image" && media !== "video") throw new TypeError("INVALID_STUDIO_HISTORY_MEDIA");
  const query = new URLSearchParams({ view: "studio-history", media, limit: String(limit) });
  if (cursor !== null) query.set("cursor", cursor);

  signal?.throwIfAborted();
  const body = await requestJson(fetchImpl, `${TASKS_PATH}?${query}`, {
    method: "GET", credentials: "same-origin", cache: "no-store", signal,
  }, "STUDIO_HISTORY_QUERY_FAILED");
  signal?.throwIfAborted();
  if (body?.accountId !== accountId) throw studioHistoryError("STUDIO_HISTORY_ACCOUNT_MISMATCH");
  if (!Array.isArray(body.items)
    || (body.nextCursor !== null && (typeof body.nextCursor !== "string" || !body.nextCursor || body.nextCursor === cursor))) {
    throw studioHistoryError("INVALID_STUDIO_HISTORY_RESPONSE");
  }
  const items = body.items.map((item) => {
    if (typeof item?.id !== "string" || !item.id
      || typeof item.assetId !== "string" || assetIdFromResultUrl(item.resultUrl) !== item.assetId
      || (item.logicalModelId !== null && typeof item.logicalModelId !== "string")
      || (item.prompt !== null && typeof item.prompt !== "string")
      || typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt))) {
      throw studioHistoryError("INVALID_STUDIO_HISTORY_RESPONSE");
    }
    const { id, assetId, resultUrl, logicalModelId, prompt, createdAt } = item;
    return { id, assetId, resultUrl, logicalModelId, prompt, createdAt };
  });
  return { accountId, items, nextCursor: body.nextCursor };
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

function invalidCatalogError(message = "INVALID_IMAGE_CATALOG") {
  const error = new Error(message);
  error.code = message;
  return error;
}

function normalizeVideoCatalog(body) {
  if (!body || !Array.isArray(body.models)) {
    throw invalidCatalogError("INVALID_VIDEO_CATALOG");
  }
  const models = [];
  const seenIds = new Set();
  for (const entry of body.models) {
    if (!entry || typeof entry !== "object") throw invalidCatalogError("INVALID_VIDEO_CATALOG");
    if (entry.mediaType !== "video") continue;
    if (Array.isArray(entry.operations) && entry.operations.includes("video.edit")
      && !entry.operations.includes("video.generate")) continue;
    if (typeof entry.logicalModelId !== "string"
      || !LOGICAL_MODEL_ID_PATTERN.test(entry.logicalModelId)
      || typeof entry.displayName !== "string" || !entry.displayName.trim()
      || !Array.isArray(entry.operations)
      || !entry.operations.includes("video.generate")) {
      throw invalidCatalogError("INVALID_VIDEO_CATALOG");
    }
    if (seenIds.has(entry.logicalModelId)) {
      throw invalidCatalogError("DUPLICATE_VIDEO_MODEL_ID");
    }
    seenIds.add(entry.logicalModelId);
    const rawDisplayName = entry.displayName.trim();
    const displayName = entry.logicalModelId.startsWith("local-mock-")
      && !/\\bmock\\b/i.test(rawDisplayName)
      ? `${rawDisplayName} (Mock)`
      : rawDisplayName;
    models.push(Object.freeze({
      logicalModelId: entry.logicalModelId,
      displayName,
      mediaType: "video",
      operations: ["video.generate"],
      studioModeIds: ["t2v"],
    }));
  }
  return Object.freeze(models);
}

function normalizeImageCatalog(body) {
  if (!body || !Array.isArray(body.models)) throw invalidCatalogError();
  const models = [];
  const seenIds = new Set();
  for (const entry of body.models) {
    if (!entry || typeof entry !== "object") throw invalidCatalogError();
    if (entry.mediaType === "image" && Array.isArray(entry.operations)
      && entry.operations.includes("image.edit")
      && !entry.operations.includes("image.generate")) {
      continue;
    }
    if (typeof entry.logicalModelId !== "string"
      || !LOGICAL_MODEL_ID_PATTERN.test(entry.logicalModelId)
      || typeof entry.displayName !== "string" || !entry.displayName.trim()
      || entry.mediaType !== "image"
      || !Array.isArray(entry.operations)
      || !entry.operations.includes("image.generate")) {
      throw invalidCatalogError();
    }
    if (seenIds.has(entry.logicalModelId)) throw invalidCatalogError("DUPLICATE_IMAGE_MODEL_ID");
    seenIds.add(entry.logicalModelId);
    const rawDisplayName = entry.displayName.trim();
    const displayName = entry.logicalModelId.startsWith("local-mock-")
      && !/\\bmock\\b/i.test(rawDisplayName)
      ? `${rawDisplayName} (Mock)`
      : rawDisplayName;
    models.push(Object.freeze({
      logicalModelId: entry.logicalModelId,
      displayName,
      mediaType: "image",
      operations: ["image.generate"],
      studioModeIds: ["t2i"],
    }));
  }
  return Object.freeze(models);
}

async function getTaskCatalog(path, normalize, fetchImpl, signal) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetch is required");
  const body = await requestJson(fetchImpl, path, {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    signal,
    headers: { Accept: "application/json" },
  }, "CATALOG_QUERY_FAILED");
  return normalize(body);
}

export async function getImageTaskCatalog({ fetchImpl = globalThis.fetch, signal } = {}) {
  return getTaskCatalog(IMAGE_CATALOG_PATH, normalizeImageCatalog, fetchImpl, signal);
}

export async function getVideoTaskCatalog({ fetchImpl = globalThis.fetch, signal } = {}) {
  return getTaskCatalog(VIDEO_CATALOG_PATH, normalizeVideoCatalog, fetchImpl, signal);
}

export async function getImageTaskModel({ fetchImpl = globalThis.fetch, signal, logicalModelId } = {}) {
  const models = await getImageTaskCatalog({ fetchImpl, signal });
  if (logicalModelId !== undefined && logicalModelId !== null) {
    return models.find((model) => model.logicalModelId === logicalModelId) || null;
  }
  return models[0] || null;
}

function isTaskResultImage(task) {
  const result = task?.result;
  return task?.status === "succeeded"
    && result?.mediaType === "image"
    && typeof result.resultUrl === "string"
    && result.resultUrl.length > 0;
}

function isTaskResultVideo(task) {
  const result = task?.result;
  return task?.status === "succeeded"
    && result?.mediaType === "video"
    && typeof result.resultUrl === "string"
    && result.resultUrl.length > 0;
}

export async function createImageTask({
  logicalModelId,
  prompt,
  aspectRatio = "1:1",
  outputCount,
  fetchImpl = globalThis.fetch,
  idempotencyKey = createIdempotencyKey(),
  signal,
} = {}) {
  if (typeof logicalModelId !== "string" || !LOGICAL_MODEL_ID_PATTERN.test(logicalModelId)) {
    throw new TypeError("logicalModelId is required");
  }
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 4096) throw new TypeError("prompt is required and must not exceed 4096 characters");
  if (!Object.hasOwn(SIZE_BY_ASPECT_RATIO, aspectRatio) || !IMAGE_TASK_ASPECT_RATIOS.includes(aspectRatio)) throw new TypeError("aspectRatio is unsupported");
  if (!Number.isSafeInteger(outputCount) || outputCount <= 0) throw new TypeError("outputCount must be a positive safe integer");
  if (outputCount !== 1) throw new TypeError("outputCount is unsupported");
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
        outputCount,
      },
    }),
  }, "TASK_SUBMISSION_FAILED");

  if (!body?.task || typeof body.task.id !== "string") {
    throw new Error("INVALID_TASK_RESPONSE");
  }
  return body.task;
}

// 只提交任务；不代表存在视频生成 UI 或可播放结果。
export async function createVideoTask({
  logicalModelId, prompt, durationMs, fps,
  fetchImpl = globalThis.fetch, idempotencyKey = createIdempotencyKey(), signal,
} = {}) {
  if (typeof logicalModelId !== "string" || !LOGICAL_MODEL_ID_PATTERN.test(logicalModelId)) {
    throw new TypeError("logicalModelId is required");
  }
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 4096) throw new TypeError("prompt is required and must not exceed 4096 characters");
  for (const [name, value] of [["durationMs", durationMs], ["fps", fps]]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
  }
  if (typeof fetchImpl !== "function") throw new TypeError("fetch is required");
  const body = await requestJson(fetchImpl, TASKS_PATH, {
    method: "POST", credentials: "same-origin", signal,
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ taskType: "video.generate", payload: { logicalModelId, prompt: prompt.trim(), durationMs, fps } }),
  }, "TASK_SUBMISSION_FAILED");
  if (!body?.task || typeof body.task.id !== "string") throw new Error("INVALID_TASK_RESPONSE");
  return body.task;
}

async function waitForMediaTask(taskId, {
  fetchImpl = globalThis.fetch,
  signal,
  pollIntervalMs = 1000,
  timeoutMs = 120000,
  now = () => Date.now(),
  sleep = delay,
  mediaType,
  resultPredicate,
  missingResultCode,
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
      if (!resultPredicate(task)) {
        const error = new Error(missingResultCode);
        error.code = missingResultCode;
        error.mediaType = mediaType;
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
  error.mediaType = mediaType;
  throw error;
}

export async function waitForImageTask(taskId, options = {}) {
  return waitForMediaTask(taskId, {
    ...options,
    mediaType: "image",
    resultPredicate: isTaskResultImage,
    missingResultCode: "IMAGE_RESULT_NOT_AVAILABLE",
  });
}

export async function waitForVideoTask(taskId, options = {}) {
  return waitForMediaTask(taskId, {
    ...options,
    mediaType: "video",
    resultPredicate: isTaskResultVideo,
    missingResultCode: "VIDEO_RESULT_NOT_AVAILABLE",
  });
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
