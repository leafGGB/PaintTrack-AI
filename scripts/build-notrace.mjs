/**
 * 带 trace 写入规避的生产构建（可选，非默认入口）
 *
 * 用途见 scripts/trace-write-shim.cjs 顶部说明。
 * 通过 NODE_OPTIONS 注入 shim，确保 next build 派生的 worker 子进程同样生效
 * —— 只给主进程传 --require 是不够的，worker 也会写同一份 trace。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const shim = path.join(here, 'trace-write-shim.cjs');

const prev = process.env.NODE_OPTIONS || '';
process.env.NODE_OPTIONS = `${prev} --require ${JSON.stringify(shim)}`.trim();

const result = spawnSync('npx', ['next', 'build'], {
  stdio: 'inherit',
  shell: true,
  env: process.env,
  cwd: path.resolve(here, '..'),
});

if (result.error) {
  console.error('[build:notrace] 启动失败:', result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
