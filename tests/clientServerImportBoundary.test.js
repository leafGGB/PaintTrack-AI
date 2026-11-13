const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const parser = require('next/dist/compiled/babel/parser');

const ROOT = path.resolve(__dirname, '..');
const posix = path.posix;
const EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'];
const SCAN_ROOTS = ['app', 'components', 'src', 'lib'];
const SKIP = new Set(['dist', 'build', 'out', 'coverage', 'tests', '__tests__']);
const normalize = (file) => posix.normalize(file.replace(/\\/g, '/')).replace(/^\.\//, '');
const forbidden = (file) => file === 'lib/server' || file.startsWith('lib/server/');
const sourceFile = (file) => EXTENSIONS.includes(posix.extname(file));
const excluded = (file) => file.split('/').some((part) => part.startsWith('.') || part.startsWith('node_modules') || SKIP.has(part));
const inRepository = (file) => file !== '..' && !file.startsWith('../') && !posix.isAbsolute(file);

// 只读源码，不执行应用或 Next 配置，不加载应用依赖、环境文件或数据库。
function diskHost(root) {
    function canonical(file) {
        file = normalize(file);
        if (!inRepository(file) || excluded(file)) return null;
        try {
            const absolute = fs.realpathSync(path.join(root, file));
            const relative = normalize(path.relative(root, absolute));
            assert.ok(inRepository(relative), `本地导入越出仓库：${file}`);
            assert.ok(!excluded(relative), `本地导入指向依赖或生成目录：${file} → ${relative}`);
            return fs.statSync(absolute).isFile() ? relative : null;
        } catch (error) {
            if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
            throw error;
        }
    }
    return {
        canonical,
        read(file) {
            assert.ok(sourceFile(file) || posix.basename(file) === 'package.json', `拒绝读取非源码文件：${file}`);
            return fs.readFileSync(path.join(root, file), 'utf8');
        },
        list(directory) {
            const files = [];
            const walk = (current) => {
                if (!fs.existsSync(path.join(root, current))) return;
                for (const entry of fs.readdirSync(path.join(root, current), { withFileTypes: true })) {
                    const file = posix.join(current, entry.name);
                    if (excluded(file)) continue;
                    if (entry.isDirectory()) walk(file);
                    else if (sourceFile(file) && (entry.isFile() || entry.isSymbolicLink())) files.push(file);
                }
            };
            walk(directory);
            return files.sort();
        },
    };
}

function parseSource(source, file) {
    const ast = parser.parse(source, {
        sourceType: 'unambiguous',
        allowReturnOutsideFunction: true,
        plugins: ['jsx', ...(/\.tsx?$/.test(file) ? ['typescript'] : [])],
    });
    const imports = [];
    const literal = (node) => {
        if (node?.type === 'StringLiteral') return node.value;
        if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
        return null;
    };
    const add = (node, kind) => {
        const specifier = literal(node);
        if (specifier !== null) imports.push({ specifier, kind, line: node.loc.start.line });
    };
    const walk = (node) => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'ImportDeclaration') {
            if (node.importKind !== 'type' && !(node.specifiers.length && node.specifiers.every((item) => item.importKind === 'type'))) {
                add(node.source, 'import');
            }
        } else if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') {
            if (node.source && node.exportKind !== 'type'
                && !(node.specifiers?.length && node.specifiers.every((item) => item.exportKind === 'type'))) add(node.source, 'export');
        } else if (node.type === 'ImportExpression') {
            add(node.source, 'import');
        } else if (node.type === 'CallExpression') {
            if (node.callee.type === 'Import') add(node.arguments[0], 'import');
            if (node.callee.type === 'Identifier' && node.callee.name === 'require' && node.arguments.length === 1) {
                add(node.arguments[0], 'require');
            }
        } else if (node.type === 'TSImportEqualsDeclaration' && node.importKind !== 'type'
            && node.moduleReference.type === 'TSExternalModuleReference') {
            add(node.moduleReference.expression, 'require');
        }
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) value.forEach(walk);
            else if (value && typeof value === 'object' && typeof value.type === 'string') walk(value);
        }
    };
    walk(ast.program);
    return { client: ast.program.directives.some((item) => item.value.value === 'use client'), imports };
}

function createGate(host, config, workspaceDirectories) {
    const baseUrl = normalize(config.compilerOptions?.baseUrl || '.');
    const aliases = Object.entries(config.compilerOptions?.paths || {}).sort(([a], [b]) => {
        return Number(a.includes('*')) - Number(b.includes('*')) || b.indexOf('*') - a.indexOf('*') || b.length - a.length;
    });
    const packages = new Map();
    const metadata = new Map();
    const graph = new Map();
    const assets = new Set();
    const external = new Set();
    const json = (file) => JSON.parse(host.read(file));
    for (const directory of workspaceDirectories) {
        assert.ok(!directory.includes('*'), `请为新增 workspace 通配配置补充目录展开：${directory}`);
        const manifest = json(`${directory}/package.json`);
        assert.ok(manifest.name && !packages.has(manifest.name), `workspace 名称缺失或重复：${directory}`);
        packages.set(manifest.name, { directory, manifest });
    }
    function info(file) {
        if (!metadata.has(file)) {
            try {
                metadata.set(file, parseSource(host.read(file), file));
            } catch (error) {
                throw new Error(`源码解析失败 ${file}：${error.message}`, { cause: error });
            }
        }
        return metadata.get(file);
    }
    function local(candidate, seen = new Set()) {
        candidate = normalize(candidate);
        assert.ok(inRepository(candidate), `本地路径越出仓库：${candidate}`);
        if (forbidden(candidate)) return candidate;
        if (excluded(candidate)) return null;
        const extension = posix.extname(candidate);
        if (extension && !sourceFile(candidate)) {
            assets.add(candidate);
            return false;
        }
        const probes = [candidate, ...(!extension ? EXTENSIONS.map((ext) => candidate + ext) : [])];
        for (const probe of probes) {
            if (!sourceFile(probe)) continue;
            const found = host.canonical(probe);
            if (found) return found;
        }
        if (extension || seen.has(candidate)) return null;
        seen.add(candidate);
        const manifestFile = host.canonical(`${candidate}/package.json`);
        if (manifestFile) {
            const manifest = json(manifestFile);
            for (const entry of [manifest.module, manifest.main].filter((item) => typeof item === 'string')) {
                const found = local(posix.join(candidate, entry), seen);
                if (found !== null) return found;
            }
        }
        for (const ext of EXTENSIONS) {
            const found = host.canonical(`${candidate}/index${ext}`);
            if (found) return found;
        }
        return null;
    }
    function match(pattern, specifier) {
        const star = pattern.indexOf('*');
        if (star < 0) return pattern === specifier ? '' : null;
        const prefix = pattern.slice(0, star);
        const suffix = pattern.slice(star + 1);
        return specifier.startsWith(prefix) && specifier.endsWith(suffix) && specifier.length >= prefix.length + suffix.length
            ? specifier.slice(prefix.length, specifier.length - suffix.length || undefined) : null;
    }
    function exportTargets(value, kind) {
        if (typeof value === 'string') return [value];
        if (Array.isArray(value)) return value.flatMap((item) => exportTargets(item, kind));
        if (value && typeof value === 'object') {
            for (const condition of ['browser', kind === 'require' ? 'require' : 'import', 'default']) {
                if (Object.hasOwn(value, condition)) return exportTargets(value[condition], kind);
            }
        }
        return [];
    }
    function resolve(file, { specifier, kind, line }) {
        const fail = () => { throw new Error(`无法解析本仓库源码导入：${file}:${line} → ${specifier}`); };
        const tryTargets = (targets) => {
            for (const target of targets) {
                const found = local(target);
                if (found !== null) return found;
            }
            return fail();
        };
        if (specifier.startsWith('.')) return tryTargets([posix.join(posix.dirname(file), specifier)]);
        for (const [pattern, targets] of aliases) {
            const capture = match(pattern, specifier);
            if (capture !== null) return tryTargets(targets.map((target) => posix.join(baseUrl, target.replace('*', capture))));
        }
        const packageName = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
        if (packages.has(packageName)) {
            const { directory, manifest } = packages.get(packageName);
            const subpath = specifier.slice(packageName.length + 1);
            let targets;
            if (manifest.exports !== undefined) {
                const key = subpath ? `./${subpath}` : '.';
                const exports = manifest.exports;
                if (exports && typeof exports === 'object' && !Array.isArray(exports) && Object.keys(exports).some((item) => item.startsWith('.'))) {
                    const pattern = Object.keys(exports).sort((a, b) => b.length - a.length).find((item) => match(item, key) !== null);
                    targets = pattern ? exportTargets(exports[pattern], kind).map((item) => item.replace('*', match(pattern, key))) : [];
                } else targets = key === '.' ? exportTargets(exports, kind) : [];
            } else targets = subpath ? [subpath] : [manifest.module, manifest.main, 'src/index', 'index'].filter(Boolean);
            // 构建产物不能替代源码门禁：dist 入口回溯到同名 src 文件。
            return tryTargets(targets.map((target) => posix.join(directory, target.replace(/^(\.\/)?dist\//, 'src/'))));
        }
        const fromBase = local(posix.join(baseUrl, specifier));
        if (fromBase !== null) return fromBase;
        external.add(specifier);
        return false;
    }
    function edges(file) {
        if (!graph.has(file)) {
            graph.set(file, info(file).imports.map((edge) => ({ ...edge, target: resolve(file, edge) })).filter((edge) => edge.target));
        }
        return graph.get(file);
    }
    function scan(directories) {
        const files = [...new Set(directories.flatMap((directory) => host.list(directory)).map((file) => host.canonical(file)))].filter(Boolean).sort();
        const entries = files.filter((file) => info(file).client);
        const violations = [];
        for (const entry of entries) {
            const visited = new Set([entry]);
            const queue = [{ file: entry, chain: entry }];
            for (let index = 0; index < queue.length; index++) {
                const current = queue[index];
                if (forbidden(current.file)) {
                    violations.push(current.chain);
                    continue;
                }
                for (const edge of edges(current.file)) {
                    if (visited.has(edge.target)) continue;
                    visited.add(edge.target);
                    queue.push({ file: edge.target, chain: `${current.chain}\n  -- ${edge.kind} ${JSON.stringify(edge.specifier)} (${current.file}:${edge.line}) --> ${edge.target}` });
                }
            }
        }
        return { files, entries, violations, parsed: metadata.size, reached: graph.size, external: external.size, assets: assets.size };
    }
    return { scan };
}

// 合成仓库完全在内存中；不落 fixture，不执行 fixture 中的任何代码。
function fixture(files, config = { compilerOptions: { baseUrl: '.', paths: { '@/*': ['./*'] } } }, workspaces = []) {
    const contents = new Map(Object.entries(files));
    const host = {
        canonical: (file) => contents.has(normalize(file)) ? normalize(file) : null,
        read: (file) => { assert.ok(contents.has(file), `fixture 缺少文件：${file}`); return contents.get(file); },
        list: (directory) => [...contents.keys()].filter((file) => sourceFile(file) && (directory === '.' || file.startsWith(`${directory}/`)) && !excluded(file)),
    };
    return createGate(host, config, workspaces).scan(['.']);
}
const secret = { 'lib/server/secret.js': 'export const secret = 1;' };
const chainOf = (files, config, workspaces) => {
    const result = fixture({ ...secret, ...files }, config, workspaces);
    assert.equal(result.violations.length, 1, JSON.stringify(result));
    return result.violations[0];
};

test('AST：直接静态 import 与副作用导入触达根 lib/server 时失败', () => {
    for (const statement of ["import { secret } from '../lib/server/secret';", "import '../lib/server/secret.js';"]) {
        assert.match(chainOf({ 'app/client.js': `'use client';\n${statement}` }), /app\/client\.js:2.*lib\/server\/secret/);
    }
});

test('传递依赖：无 use client 的辅助模块、循环和目录 index 仍被追踪', () => {
    const chain = chainOf({
        'app/client.jsx': "'use strict'; /* 指令前可有注释 */ 'use client'; import '../shared'; export default () => <div />;",
        'shared/index.ts': "import './cycle'; export { value } from './bridge';",
        'shared/cycle.ts': "import './index';",
        'shared/bridge.ts': "export { secret as value } from '../lib/server/secret';",
    });
    for (const file of ['shared/index.ts', 'shared/bridge.ts', 'lib/server/secret']) assert.ok(chain.includes(file), chain);
});

test('别名：@/*、精确匹配、通配符后缀及多个候选目标', () => {
    const config = { compilerOptions: { baseUrl: '.', paths: {
        '@/*': ['./*'], bridge: ['./missing', './shared/bridge'], '@bridge/*.js': ['./shared/*.ts'],
    } } };
    for (const specifier of ['@/lib/server/secret', 'bridge', '@bridge/bridge.js']) {
        assert.match(chainOf({
            'app/client.js': `'use client'; import '${specifier}';`,
            'shared/bridge.ts': "export * from '@/lib/server/secret';",
        }, config), /lib\/server\/secret/);
    }
});

test('baseUrl：无需 paths 的本地绝对项目导入也被追踪', () => {
    assert.match(chainOf({ 'app/client.js': "'use client'; import 'lib/server/secret';" }), /lib\/server\/secret/);
});

test('reexport：export-from、export-all、命名空间导出均保留依赖边', () => {
    for (const statement of ["export { secret } from '../lib/server/secret';", "export * from '../lib/server/secret';", "export * as secrets from '../lib/server/secret';"]) {
        assert.match(chainOf({
            'app/client.js': "'use client'; import '../shared/bridge';",
            'shared/bridge.js': statement,
        }), /-- export .*lib\/server\/secret/);
    }
});

test('require 与 import 字面量：嵌套函数、注释及无插值模板字符串', () => {
    for (const statement of [
        "function load() { return require(/* 注释 */ '../lib/server/secret'); }",
        "const load = () => import(/* 分块注释 */ '../lib/server/secret');",
        'const load = () => import(`../lib/server/secret`);',
    ]) assert.match(chainOf({ 'app/client.js': `'use client'; ${statement}` }), /lib\/server\/secret/);
});

test('workspace：main/module 指向 dist 时遍历 src，绝不使用旧构建产物', () => {
    for (const field of ['main', 'module']) {
        const chain = chainOf({
            'app/client.js': "'use client'; import '@local/sdk';",
            'packages/sdk/package.json': JSON.stringify({ name: '@local/sdk', [field]: 'dist/index.js' }),
            'packages/sdk/src/index.js': "export * from './bridge';",
            'packages/sdk/src/bridge.js': "export * from '../../../lib/server/secret';",
            'packages/sdk/dist/index.js': 'export const safeButStale = true;',
        }, undefined, ['packages/sdk']);
        assert.ok(chain.includes('packages/sdk/src/bridge.js'), chain);
        assert.ok(!chain.includes('dist/'), chain);
    }
});

test('workspace：exports 根入口、子路径、通配符以及 import/require 条件', () => {
    for (const [specifier, statement, target] of [
        ['@local/sdk', 'import', 'index'], ['@local/sdk/bridge', 'import', 'bridge'],
        ['@local/sdk/features/secret', 'import', 'secret'], ['@local/sdk/conditional', 'require', 'bridge'],
    ]) {
        const chain = chainOf({
            'app/client.js': `'use client'; ${statement === 'require' ? `require('${specifier}')` : `import '${specifier}'`};`,
            'packages/sdk/package.json': JSON.stringify({ name: '@local/sdk', exports: {
                '.': './src/index.js', './bridge': './src/bridge.js', './features/*': './src/*.js',
                './conditional': { import: './src/safe.js', require: './src/bridge.js' },
            } }),
            ...Object.fromEntries(['index', 'bridge', 'secret'].map((name) => [`packages/sdk/src/${name}.js`, "export * from '../../../lib/server/secret';"])),
            'packages/sdk/src/safe.js': 'export const safe = true;',
        }, undefined, ['packages/sdk']);
        assert.ok(chain.includes(`packages/sdk/src/${target}.js`), chain);
    }
});

test('真实项目的三个包名别名必须覆盖其 workspace 源码，而非 dist', () => {
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'jsconfig.json'), 'utf8'));
    for (const name of ['ai-agent', 'workflow-builder', 'design-agent']) {
        const entry = normalize(config.compilerOptions.paths[name][0]);
        const relativeSecret = posix.relative(posix.dirname(entry), 'lib/server/secret');
        const chain = chainOf({
            'app/client.js': `'use client'; import '${name}';`,
            [entry]: `export * from '${relativeSecret}';`,
        }, config);
        assert.ok(chain.includes(entry), chain);
    }
});

test('合法服务端入口：API、服务端页面、use server 及服务端到客户端反向边不会误报', () => {
    const result = fixture({
        ...secret,
        'app/api/example/route.js': "import { secret } from '@/lib/server/secret'; export function GET() {}",
        'app/page.jsx': "import { secret } from '@/lib/server/secret'; import './client'; export default () => <div />;",
        'app/actions.js': "'use server'; export { secret } from '@/lib/server/secret';",
        'app/client.js': "'use client'; import '../shared/safe';",
        'shared/safe.js': 'export const safe = true;',
    });
    assert.deepEqual(result.entries, ['app/client.js']);
    assert.deepEqual(result.violations, []);
});

test('合法客户端：注释、普通字符串、嵌套假指令、资源和第三方依赖不会产生导入边', () => {
    const result = fixture({
        ...secret,
        'app/client.tsx': `// import '@/lib/server/secret';
'use client';
import React from 'react';
import '../styles.css';
import data from '../data.json';
import '../lib/server-public/safe';
const description = "require('@/lib/server/secret')";
export default () => <div>{description}</div>;`,
        'app/server.js': "const text = 'use client'; function nested() { 'use client'; } import '../lib/server/secret';",
        'lib/server-public/safe.js': 'export const safe = true;',
        'node_modules/react/index.js': "throw new Error('不得扫描第三方依赖');",
    });
    assert.deepEqual(result.violations, []);
    assert.deepEqual(result.entries, ['app/client.tsx']);
    assert.equal(result.external, 1);
    assert.equal(result.assets, 2);
});

test('TypeScript：已擦除的类型边不进入客户端运行时依赖图', () => {
    const result = fixture({
        ...secret,
        'app/client.ts': `'use client';
import type { Secret } from '../lib/server/types';
import { type Secret as Other } from '../lib/server/types';
export type { Secret } from '../lib/server/types';
export { type Secret as Again } from '../lib/server/types';
const safe: number = 1;`,
    });
    assert.deepEqual(result.violations, []);
});

test('合法 workspace 及包子路径：只沿客户端出边遍历安全源码', () => {
    const result = fixture({
        ...secret,
        'app/client.js': "'use client'; import 'sdk'; import 'sdk/src/helper';",
        'packages/sdk/package.json': '{"name":"sdk","module":"dist/index.js"}',
        'packages/sdk/src/index.js': "export { safe } from './helper';",
        'packages/sdk/src/helper.js': 'export const safe = true;',
        'packages/sdk/src/server.js': "export * from '../../../lib/server/secret';",
        '.next/cache/broken.js': '无法解析的生成文件 <<<',
        'node_modules.bak_old/sdk/broken.js': '无法解析的依赖备份 <<<',
        'packages/sdk/dist/index.js': '无法解析的生成文件 <<<',
    }, undefined, ['packages/sdk']);
    assert.deepEqual(result.violations, []);
    assert.equal(result.reached, 3);
});

test('TypeScript：混合类型与运行时导入仍必须拦截', () => {
    for (const statement of [
        "import { type Secret, secret } from '../lib/server/secret';",
        "export { type Secret, secret } from '../lib/server/secret';",
        "import secret = require('../lib/server/secret');",
    ]) assert.match(chainOf({ 'app/client.ts': `'use client'; ${statement}` }), /lib\/server\/secret/);
});

test('静态分析限制：不计算变量导入，对同名 require 保守处理', () => {
    const result = fixture({
        ...secret,
        'app/client.js': "'use client'; const target = '../lib/server/secret'; import(target); require(target);",
    });
    assert.deepEqual(result.violations, []);
    assert.match(chainOf({
        'app/client.js': "'use client'; function call(require) { require('../lib/server/secret'); }",
    }), /lib\/server\/secret/);
});

test('失败关闭：本地导入、别名和 workspace 源码丢失或语法错误不能变成假绿', () => {
    for (const specifier of ['./missing', '@/shared/missing']) {
        assert.throws(() => fixture({ 'app/client.js': `'use client'; import '${specifier}';` }), /无法解析本仓库源码导入/);
    }
    assert.throws(() => fixture({
        'app/client.js': "'use client'; import 'sdk';",
        'packages/sdk/package.json': '{"name":"sdk","main":"dist/index.js"}',
        'packages/sdk/dist/index.js': 'export const safe = true;',
    }, undefined, ['packages/sdk']), /无法解析本仓库源码导入/);
    assert.throws(() => fixture({ 'app/client.jsx': "'use client'; const broken = <" }), /源码解析失败 app\/client.jsx/);
});

test('根 lib/server 门禁：从所有生产 use client 入口检查传递源码依赖', (t) => {
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'jsconfig.json'), 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const workspaces = manifest.workspaces;
    assert.ok(Array.isArray(workspaces) && workspaces.length >= 4, 'workspace 扫描配置缺失');
    const directories = [...SCAN_ROOTS, ...workspaces.map((directory) => `${directory}/src`)];
    const result = createGate(diskHost(ROOT), config, workspaces).scan(directories);
    assert.ok(result.files.length >= 60, `只扫描到 ${result.files.length} 个源码文件`);
    assert.ok(result.entries.length > 0, '没有找到真正的 use client 指令入口');
    for (const directory of directories) {
        assert.ok(result.files.some((file) => file.startsWith(`${directory}/`)), `扫描目录未产出源码：${directory}`);
    }
    t.diagnostic(`扫描 ${result.files.length} 个源码，${result.entries.length} 个客户端入口，遍历 ${result.reached} 个依赖节点；跳过 ${result.external} 个外部说明符与 ${result.assets} 个资源路径。`);
    assert.deepEqual(result.violations, [], `客户端静态依赖触达根 lib/server：\n${result.violations.join('\n\n')}`);
});
