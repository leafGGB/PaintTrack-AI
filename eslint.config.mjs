import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { FlatCompat } from '@eslint/eslintrc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// eslint-config-next 15.x 仍以 eslintrc 格式发布，需要用 FlatCompat 桥接。
const compat = new FlatCompat({ baseDirectory: __dirname });

const config = [
  {
    // 构建产物、依赖、临时备份和子模块编译输出不参与检查。
    // .next_bak_* 是沙箱环境下重命名而来的历史构建缓存，不能当作源码。
    ignores: [
      '**/node_modules/**',
      '**/node_modules.bak_*/**',
      '**/.next/**',
      '.next_*/**',
      // 子模块的编译产物分散在多级目录下（如 packages/*/packages/*/dist），
      // 统一按目录名忽略，否则会把打包后的代码当源码检查。
      '**/dist/**',
      '**/release/**',
      'patches/**',
      '.workbuddy/**',
    ],
  },
  ...compat.extends('next/core-web-vitals'),
];

export default config;
