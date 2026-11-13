const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// 阶段 4.5.1 客户端凭据边界棘轮，阶段 4.5.3 完成清零。
// 目的：把「供应商密钥只能存在于服务端」从口头约定变成会让 CI 变红的断言。
// 允许清单基线写在 tests/fixtures/client-credential-allowlist.json，
// 规则只有一条：只许减少。清理一个文件就删一条，留下过期条目同样会失败。
// 阶段 4.5.3 后基线已清空 ⇒ 实际语义是零容忍，任何新增命中都会失败。
const ROOT = path.resolve(__dirname, '..');
// packages/studio/src 是 /studio、/workflow 页面真正使用的共享 SDK，
// 阶段 4.5.1 遗漏了它，导致门禁存在盲区；4.5.3 起纳入扫描。
const SCAN_ROOTS = ['app', 'components', 'src', 'packages/studio/src'];
const SCAN_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
const SKIP_DIRECTORIES = new Set(['node_modules', '.next', 'dist', 'build', 'out', 'coverage', '.git', '.workbuddy']);
const PATTERN_SOURCES = {
    muapi_key: /muapi_key/g,
    'x-api-key': /x-api-key/gi,
    'api.muapi.ai': /api\.muapi\.ai/gi,
    '__MUAPI_KEY__': /__MUAPI_KEY__/g,
};
const ALLOWLIST_PATH = path.join(ROOT, 'tests/fixtures/client-credential-allowlist.json');
// 扫描文件数的下界：防止 glob/目录改名后变成「扫到 0 个文件 ⇒ 全部通过」的假绿。
const MINIMUM_SCANNED_FILES = 60;

function collectSourceFiles(relativeRoot) {
    const absoluteRoot = path.join(ROOT, relativeRoot);
    const collector = [];
    const walk = (current) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                if (SKIP_DIRECTORIES.has(entry.name)) continue;
                walk(path.join(current, entry.name));
                continue;
            }
            if (!SCAN_EXTENSIONS.has(path.extname(entry.name))) continue;
            collector.push(path.relative(ROOT, path.join(current, entry.name)).split(path.sep).join('/'));
        }
    };
    if (!fs.existsSync(absoluteRoot)) return collector;
    walk(absoluteRoot);
    return collector;
}

function scan(file) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const found = new Set();
    for (const [name, pattern] of Object.entries(PATTERN_SOURCES)) {
        // 每次新建 RegExp 的 global 状态，避免 lastIndex 跨调用污染。
        if (new RegExp(pattern.source, pattern.flags).test(source)) found.add(name);
    }
    return found;
}

function inventory() {
    const files = SCAN_ROOTS.flatMap(collectSourceFiles).sort();
    const hits = new Map();
    for (const file of files) {
        const found = scan(file);
        if (found.size > 0) hits.set(file, found);
    }
    return { files, hits };
}

const allowlist = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'));

test('客户端代码不得新增供应商密钥引用（只许减少）', () => {
    const { hits } = inventory();
    const unexpected = [];
    for (const [file, patterns] of hits) {
        if (!allowlist.entries[file]) {
            unexpected.push(`${file} → ${[...patterns].join(', ')}`);
            continue;
        }
        const allowed = new Set(allowlist.entries[file].patterns);
        const added = [...patterns].filter((pattern) => !allowed.has(pattern));
        if (added.length > 0) unexpected.push(`${file} 新增引用 → ${added.join(', ')}`);
    }
    assert.deepEqual(
        unexpected,
        [],
        `检测到未登记的客户端供应商密钥引用：\n${unexpected.join('\n')}\n`
        + '供应商密钥只能由服务端读取；不要把新文件加进 allowlist，请改走服务端或删除客户端直连。',
    );
});

test('允许清单只许减少：已清理的文件必须同步删条目，否则会掩盖残留', () => {
    const stale = [];
    for (const [file, entry] of Object.entries(allowlist.entries)) {
        if (!fs.existsSync(path.join(ROOT, file))) {
            stale.push(`${file}：文件已不存在，删除该条目`);
            continue;
        }
        const found = scan(file);
        for (const pattern of entry.patterns) {
            if (!found.has(pattern)) stale.push(`${file}：已不再出现 ${pattern}，从条目中移除`);
        }
        if (found.size === 0) stale.push(`${file}：已完全清理，删除整条条目`);
    }
    assert.deepEqual(stale, [], `允许清单存在过期条目：\n${stale.join('\n')}`);
});

test('扫描基线覆盖足够文件，避免空扫描或目录改名造成假绿', () => {
    const { files } = inventory();
    assert.ok(files.length >= MINIMUM_SCANNED_FILES, `仅扫描到 ${files.length} 个文件，低于下界 ${MINIMUM_SCANNED_FILES}`);
    for (const root of SCAN_ROOTS) {
        assert.ok(files.some((file) => file.startsWith(`${root}/`)), `扫描根目录 ${root} 未产出任何文件`);
    }
});

test('第一方客户端代码必须零命中：浏览器不得持有或转发供应商凭据', () => {
    const { hits } = inventory();
    const offenders = [...hits].map(([file, patterns]) => `${file} → ${[...patterns].join(', ')}`);
    assert.deepEqual(
        offenders,
        [],
        `客户端代码重新出现供应商凭据引用：\n${offenders.join('\n')}\n`
        + '浏览器侧不应存在密钥输入、存储或转发；生成能力必须走服务端 Provider。',
    );
});

test('共享 studio SDK 不得直连外部供应商域名', () => {
    const sdkPath = 'packages/studio/src/muapi.js';
    const source = fs.readFileSync(path.join(ROOT, sdkPath), 'utf8');
    const baseUrlDeclaration = source.match(/const BASE_URL = [^;]+;/);
    assert.ok(baseUrlDeclaration, `${sdkPath} 缺少 BASE_URL 声明，检查是否被改写成内联地址`);
    assert.ok(
        baseUrlDeclaration[0].includes("'/api'"),
        `BASE_URL 必须固定为同源 /api，实际为：${baseUrlDeclaration[0]}`,
    );
    assert.ok(
        !/https?:\/\//.test(baseUrlDeclaration[0]),
        `BASE_URL 不得包含外部 http(s) 地址：${baseUrlDeclaration[0]}`,
    );
});

test('允许清单不得被当成新增泄露的通道', () => {
    const knownPatterns = new Set(Object.keys(PATTERN_SOURCES));
    for (const [file, entry] of Object.entries(allowlist.entries)) {
        assert.ok(typeof entry.reason === 'string' && entry.reason.trim().length >= 8, `${file} 缺少可审查的清理原因`);
        assert.ok(Array.isArray(entry.patterns) && entry.patterns.length > 0, `${file} 未声明具体引用类型`);
        for (const pattern of entry.patterns) {
            assert.ok(knownPatterns.has(pattern), `${file} 声明了未受门禁管理的引用类型：${pattern}`);
        }
    }
    assert.deepEqual(
        [...allowlist.patterns].sort(),
        [...knownPatterns].sort(),
        'allowlist.patterns 必须与测试内的受管模式完全一致，否则新增模式会绕过门禁',
    );
});

test('服务端凭据边界模块本身不得被客户端引用', () => {
    const { files } = inventory();
    const configModule = 'lib/server/providers/providerConfig';
    // 只拦「真的 import/require 进来」的情况。注释里提到该路径是说明性文字，
    // 不会把服务端模块打进客户端 bundle；用正则匹配模块说明符而非裸字符串。
    const importPattern = /(?:require\s*\(\s*|from\s+|import\s*\(\s*)['"][^'"]*lib\/server\/providers\/providerConfig[^'"]*['"]/;
    const offenders = files.filter((file) => importPattern.test(fs.readFileSync(path.join(ROOT, file), 'utf8')));
    assert.deepEqual(offenders, [], `服务端凭据模块被客户端代码导入：${offenders.join(', ')}`);
});
