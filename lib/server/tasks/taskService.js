const { createTask } = require('../worker/taskQueue');
const { TaskApiError, requestFingerprint } = require('./taskSubmission');
const { toPublicTask } = require('./taskView');

function createTaskSubmissionService({ pool, routeResolver } = {}) {
    if (!pool || typeof pool.connect !== 'function') throw new TypeError('pool is required');
    if (routeResolver != null && typeof routeResolver.resolve !== 'function') {
        throw new TypeError('trusted routeResolver must provide resolve');
    }

    return Object.freeze({
        async submit({ ownerId, idempotencyKey, taskType, payload } = {}) {
            const fingerprint = requestFingerprint({ taskType, payload });
            const { task, inserted } = await createTask(pool, {
                ownerId,
                idempotencyKey,
                requestFingerprint: fingerprint,
                taskType,
                payload,
                routeResolver: routeResolver ?? undefined,
            });
            if (!inserted && task.request_fingerprint !== fingerprint) {
                // 同键不同请求必须拒绝，不能把旧任务伪装成这次提交的结果。
                throw new TaskApiError('IDEMPOTENCY_KEY_REUSED', 409);
            }
            return Object.freeze({ task: toPublicTask(task), replayed: !inserted });
        },
    });
}

module.exports = { createTaskSubmissionService, toPublicTask };
