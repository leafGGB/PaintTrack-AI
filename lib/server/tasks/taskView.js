'use strict';

const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

// 对外只暴露用户需要轮询的字段：不返回 owner_id、payload、租约、worker 或供应商内部字段。
// last_error 可能来自通用处理器的原始异常文本（例如 ECONNREFUSED、SQL 片段），
// 只有固定错误码才原样暴露，其余折叠成 TASK_FAILED，避免把内部信息带到浏览器。
function publicErrorCode(value) {
    if (typeof value !== 'string' || value === '') return null;
    return ERROR_CODE_PATTERN.test(value) ? value : 'TASK_FAILED';
}

function toPublicTask(row) {
    return Object.freeze({
        id: row.id,
        taskType: row.task_type,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        completedAt: row.completed_at ?? null,
        cancelRequestedAt: row.cancel_requested_at ?? null,
        result: row.result ?? null,
        errorCode: publicErrorCode(row.last_error),
    });
}

module.exports = { publicErrorCode, toPublicTask };
