/**
 * 构建期 trace 写入规避 shim（可选工具，非默认启用）
 *
 * 背景：在某些受限环境（如带文件写入策略的托管沙箱、部分杀毒软件实时防护）
 * 中，`next build` 打开 `.next/trace` 会抛：
 *     uncaughtException [Error: EPERM: operation not permitted, open '...\.next\trace']
 * 一旦抛出，构建直接以退出码 1 终止 —— 但此时源码编译并未真正失败，
 * 只是 Next 的 trace 上报流（to-json.js 里未监听 error 事件）把进程打崩了。
 *
 * `.next/trace` 仅用于 Next 内部的构建性能诊断与遥测，不参与产物生成，
 * 因此拦截它不影响构建结果的正确性。
 *
 * 用法：
 *     NODE_OPTIONS="--require ./scripts/trace-write-shim.cjs" npm run build
 * 或直接：
 *     npm run build:notrace
 *
 * 注意：这是环境适配手段，不是项目缺陷的修复。若本机 `npm run build` 正常，
 * 请不要使用本脚本。
 */
const fs = require('node:fs');
const path = require('node:path');
const { Writable } = require('node:stream');

const origCreateWriteStream = fs.createWriteStream;
let reported = false;

fs.createWriteStream = function (file) {
  try {
    const p = String(file);
    if (path.basename(p) === 'trace' && p.includes(`${path.sep}.next`)) {
      if (!reported) {
        reported = true;
        process.stderr.write(`[trace-write-shim] 已跳过 Next trace 写入: ${p}\n`);
      }
      // 吞掉所有写入，不触碰磁盘
      return new Writable({
        write(_chunk, _enc, cb) {
          cb();
        },
      });
    }
  } catch {
    // 判定过程出错时回退到原始实现
  }
  return origCreateWriteStream.apply(fs, arguments);
};
