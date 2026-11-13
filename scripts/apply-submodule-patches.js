#!/usr/bin/env node
/**
 * 应用子模块补丁：把 Git submodule 内的依赖版本修正重新打上。
 *
 * 背景：本项目对 React / react-konva 的版本有强制约束（见 docs/ImplementationPlan/PAINTTRACK_DEVELOPMENT_PROCESS.md 5.1）。
 * 这些修正落在三个 Git 子模块内部，不会随主仓库提交，且 `git submodule update --recursive`
 * 会把子模块重置到固定 commit，导致修正丢失、启动报错复现。
 *
 * 用法：
 *   node scripts/apply-submodule-patches.js          应用补丁（幂等）
 *   node scripts/apply-submodule-patches.js --check  只检查不写入
 *
 * 退出码：0 = 全部就绪；1 = 存在需要人工处理的问题。
 */
'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const CHECK_ONLY = process.argv.includes('--check');

const PATCHES = [
  {
    submodule: 'packages/Vibe-Workflow',
    patch: 'patches/0001-vibe-workflow-client-react-19.2.4.patch',
  },
  {
    submodule: 'packages/Open-Poe-AI',
    patch: 'patches/0002-open-poe-ai-client-react-19.2.4.patch',
  },
  {
    submodule: 'packages/Open-AI-Design-Agent',
    patch: 'patches/0003-open-ai-design-agent-react-konva-19.2.7.patch',
  },
];

/** 执行 git，失败时抛错并带回 stderr。 */
function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** 执行 git，只关心成功与否。 */
function tryGit(args, cwd) {
  try {
    git(args, cwd);
    return true;
  } catch {
    return false;
  }
}

let problems = 0;

for (const { submodule, patch } of PATCHES) {
  const subPath = path.join(ROOT, submodule);
  const patchPath = path.join(ROOT, patch);
  const label = `[${submodule}]`;

  if (!fs.existsSync(patchPath)) {
    console.error(`${label} ✗ 补丁文件不存在: ${patch}`);
    problems += 1;
    continue;
  }

  // 子模块未初始化时目录为空或缺少 .git，直接提示并跳过。
  if (!fs.existsSync(subPath) || !fs.existsSync(path.join(subPath, '.git'))) {
    console.error(`${label} ✗ 子模块未初始化，请先执行: git submodule update --init --recursive`);
    problems += 1;
    continue;
  }

  // 已应用判定：补丁能反向应用，说明当前内容与补丁结果一致。
  if (tryGit(['apply', '--reverse', '--check', patchPath], subPath)) {
    console.log(`${label} = 已是最新，跳过`);
    continue;
  }

  // 未应用且可正向应用 → 需要打补丁。
  if (tryGit(['apply', '--check', patchPath], subPath)) {
    if (CHECK_ONLY) {
      console.log(`${label} → 待应用（--check 模式，未写入）`);
      problems += 1;
      continue;
    }
    try {
      git(['apply', patchPath], subPath);
      console.log(`${label} ✓ 补丁已应用`);
    } catch (error) {
      const detail = (error.stderr || error.message || '').toString().trim();
      console.error(`${label} ✗ 应用补丁失败: ${detail}`);
      problems += 1;
    }
    continue;
  }

  // 既不能正向也不能反向 → 上游内容已变，需人工核对。
  console.error(
    `${label} ✗ 补丁冲突：既不能应用也不能反查已应用。\n` +
      `         上游子模块内容可能已变更，请人工核对 ${patch} 后再更新补丁。`
  );
  problems += 1;
}

if (problems > 0) {
  console.error(`\n共 ${problems} 项需要处理。子模块补丁未全部就绪，依赖版本可能不正确。`);
  process.exit(1);
}

console.log('\n全部子模块补丁已就绪。');
process.exit(0);
