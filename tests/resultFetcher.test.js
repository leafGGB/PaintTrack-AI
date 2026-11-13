'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const {
    ProviderResultFetchError,
    createResultFetcher,
    isBlockedAddress,
    normalizeTargetUrl,
} = require('../lib/server/providers/resultFetcher');

const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
    'base64',
);

async function withServer(handler, run) {
    const server = createServer(handler);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    try {
        await run(`http://127.0.0.1:${port}`, port);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

// 测试专用：允许回环地址与明文 HTTP。生产构造时该开关会被强制关闭。
function loopbackFetcher(options = {}) {
    return createResultFetcher({
        allowInsecureLoopback: true,
        nodeEnv: 'test',
        timeoutMs: 2000,
        ...options,
    });
}

function assertFetchCode(error, code) {
    assert.ok(error instanceof ProviderResultFetchError, `expected ProviderResultFetchError, got ${error}`);
    assert.equal(error.code, code);
    return true;
}

test('回环请求可下载图片并保留服务端声明的 MIME', async () => {
    await withServer((request, response) => {
        assert.equal(request.method, 'GET');
        assert.equal(request.url, '/result.png');
        assert.equal(request.headers['accept-encoding'], 'identity');
        response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(PNG.length) });
        response.end(PNG);
    }, async (origin) => {
        const fetcher = loopbackFetcher();
        const result = await fetcher.fetchResult({ url: `${origin}/result.png`, mediaType: 'image' });
        assert.equal(result.mimeType, 'image/png');
        assert.equal(result.sizeBytes, PNG.length);
        assert.equal(result.bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
        assert.equal(result.finalUrl, `${origin}/result.png`);
    });
});

test('私网与环回地址在抓取时被拒绝，生产环境强制关闭回环放行开关', async () => {
    const strict = createResultFetcher({ nodeEnv: 'test' });
    // 非回环测试模式下，明文 HTTP 先被协议策略拦下。
    await assert.rejects(
        strict.fetchResult({ url: 'http://127.0.0.1:8080/a.png', mediaType: 'image' }),
        (error) => assertFetchCode(error, 'RESULT_FETCH_INVALID_URL'),
    );
    // 其余地址在解析校验处失败：字面量 IP 同样走地址策略，不因为"已经是 IP"而跳过。
    for (const url of [
        'https://127.0.0.1/a.png',
        'https://10.0.0.5/a.png',
        'https://192.168.1.7/a.png',
        'https://172.20.1.1/a.png',
        'https://169.254.169.254/latest/meta-data',
        'https://[::1]/a.png',
        'https://[fd00::1]/a.png',
    ]) {
        await assert.rejects(
            strict.fetchResult({ url, mediaType: 'image' }),
            (error) => assertFetchCode(error, 'RESULT_FETCH_BLOCKED_HOST'),
        );
    }

    // 即使调用方显式开启，生产环境也必须拒绝明文回环。
    const production = createResultFetcher({ allowInsecureLoopback: true, nodeEnv: 'production' });
    await assert.rejects(
        production.fetchResult({ url: 'http://127.0.0.1:1/a.png', mediaType: 'image' }),
        (error) => assertFetchCode(error, 'RESULT_FETCH_INVALID_URL'),
    );
});

test('URL 形状约束：凭据、非 http(s)、非常规端口一律拒绝', () => {
    for (const url of [
        'file:///etc/passwd',
        'ftp://example.test/a.png',
        'https://user:pass@example.test/a.png',
        'https://example.test:8443/a.png',
        'not-a-url',
        '',
    ]) {
        assert.throws(() => normalizeTargetUrl(url, { allowLoopback: false }), Error, `应拒绝 ${url}`);
    }
    assert.equal(normalizeTargetUrl('https://example.test/a.png#frag', { allowLoopback: false }).hash, '');
});

test('DNS 解析到私网时拒绝，且不会向目标发起连接', async () => {
    let hits = 0;
    await withServer((request, response) => {
        hits += 1;
        response.writeHead(200, { 'Content-Type': 'image/png' });
        response.end(PNG);
    }, async (origin, port) => {
        const fetcher = loopbackFetcher({
            // 攻击者控制的域名指向内网地址：解析结果必须被拦下。
            resolveHost: async () => [{ address: '10.1.2.3', family: 4 }],
        });
        await assert.rejects(
            fetcher.fetchResult({ url: `http://rebind.test:${port}/a.png`, mediaType: 'image' }),
            (error) => assertFetchCode(error, 'RESULT_FETCH_BLOCKED_HOST'),
        );
        assert.equal(hits, 0);
    });
});

test('混合 DNS 记录只取合规地址，并把它钉在连接上', async () => {
    let hits = 0;
    await withServer((request, response) => {
        hits += 1;
        response.writeHead(200, { 'Content-Type': 'image/png' });
        response.end(PNG);
    }, async (origin, port) => {
        const fetcher = loopbackFetcher({
            // 顺序上私网在前：必须跳过它，而不是把它当作连接目标。
            resolveHost: async () => [{ address: '10.9.9.9', family: 4 }, { address: '127.0.0.1', family: 4 }],
        });
        const result = await fetcher.fetchResult({ url: `http://mixed.test:${port}/a.png`, mediaType: 'image' });
        assert.equal(result.sizeBytes, PNG.length);
        assert.equal(hits, 1);
    });
});

test('重定向逐跳重新校验，落到私网即拒绝', async () => {
    await withServer((request, response) => {
        response.writeHead(302, { Location: 'http://10.0.0.9/internal.png' });
        response.end();
    }, async (origin) => {
        const fetcher = loopbackFetcher();
        await assert.rejects(
            fetcher.fetchResult({ url: `${origin}/go`, mediaType: 'image' }),
            (error) => assertFetchCode(error, 'RESULT_FETCH_BLOCKED_HOST'),
        );
    });
});

test('重定向上限与缺失 location 都被拒绝', async () => {
    await withServer((request, response) => {
        response.writeHead(302, { Location: '/loop' });
        response.end();
    }, async (origin) => {
        await assert.rejects(
            loopbackFetcher({ maxRedirects: 2 }).fetchResult({ url: `${origin}/loop`, mediaType: 'image' }),
            (error) => assertFetchCode(error, 'RESULT_FETCH_REDIRECT_LIMIT'),
        );
    });
    await withServer((request, response) => {
        response.writeHead(302);
        response.end();
    }, async (origin) => {
        await assert.rejects(
            loopbackFetcher().fetchResult({ url: `${origin}/noloc`, mediaType: 'image' }),
            (error) => assertFetchCode(error, 'RESULT_FETCH_REDIRECT_INVALID'),
        );
    });
});

test('重定向成功后返回最终地址，且跟随同源相对跳转', async () => {
    await withServer((request, response) => {
        if (request.url === '/start') {
            response.writeHead(302, { Location: '/final.png' });
            response.end();
            return;
        }
        response.writeHead(200, { 'Content-Type': 'image/png' });
        response.end(PNG);
    }, async (origin) => {
        const result = await loopbackFetcher().fetchResult({ url: `${origin}/start`, mediaType: 'image' });
        assert.equal(result.finalUrl, `${origin}/final.png`);
        assert.equal(result.sizeBytes, PNG.length);
    });
});

test('Content-Type 必须与声明的媒体类型一致，缺失也不放行', async () => {
    const cases = [
        [{ 'Content-Type': 'text/html' }, 'RESULT_FETCH_CONTENT_TYPE_MISMATCH'],
        [{ 'Content-Type': 'application/json' }, 'RESULT_FETCH_CONTENT_TYPE_MISMATCH'],
        [{}, 'RESULT_FETCH_CONTENT_TYPE_MISSING'],
    ];
    for (const [headers, code] of cases) {
        await withServer((request, response) => {
            response.writeHead(200, headers);
            response.end('<html>not an image</html>');
        }, async (origin) => {
            await assert.rejects(
                loopbackFetcher().fetchResult({ url: `${origin}/x`, mediaType: 'image' }),
                (error) => assertFetchCode(error, code),
            );
        });
    }
});

test('声明长度与实际流量两个维度都拦截超限结果', async () => {
    await withServer((request, response) => {
        response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': '4096' });
        response.end(PNG);
    }, async (origin) => {
        await assert.rejects(
            loopbackFetcher({ maxBytes: 128 }).fetchResult({ url: `${origin}/big`, mediaType: 'image' }),
            (error) => assertFetchCode(error, 'RESULT_FETCH_TOO_LARGE'),
        );
    });
    // 不声明长度：靠流式累计在超限处中断。
    await withServer((request, response) => {
        response.writeHead(200, { 'Content-Type': 'image/png' });
        const chunk = Buffer.alloc(64, 1);
        for (let index = 0; index < 64; index += 1) response.write(chunk);
        response.end();
    }, async (origin) => {
        await assert.rejects(
            loopbackFetcher({ maxBytes: 256 }).fetchResult({ url: `${origin}/stream`, mediaType: 'image' }),
            (error) => assertFetchCode(error, 'RESULT_FETCH_TOO_LARGE'),
        );
    });
});

test('非 2xx 状态、超时与中止都映射成固定错误码', async () => {
    await withServer((request, response) => {
        response.writeHead(404, { 'Content-Type': 'text/plain' });
        response.end('missing');
    }, async (origin) => {
        await assert.rejects(
            loopbackFetcher().fetchResult({ url: `${origin}/missing`, mediaType: 'image' }),
            (error) => assertFetchCode(error, 'RESULT_FETCH_HTTP_STATUS'),
        );
    });

    await withServer(() => {
        // 永不响应：触发请求级超时。
    }, async (origin) => {
        await assert.rejects(
            loopbackFetcher({ timeoutMs: 50 }).fetchResult({ url: `${origin}/hang`, mediaType: 'image' }),
            (error) => assertFetchCode(error, 'RESULT_FETCH_TIMEOUT'),
        );
    });

    const controller = new AbortController();
    controller.abort();
    await withServer((request, response) => {
        response.writeHead(200, { 'Content-Type': 'image/png' });
        response.end(PNG);
    }, async (origin) => {
        await assert.rejects(
            loopbackFetcher().fetchResult({ url: `${origin}/a.png`, mediaType: 'image', signal: controller.signal }),
            (error) => assertFetchCode(error, 'RESULT_FETCH_ABORTED'),
        );
    });
});

test('不支持的媒体类型与非法参数在构造/调用处就被拒绝', async () => {
    const fetcher = loopbackFetcher();
    await assert.rejects(
        fetcher.fetchResult({ url: 'https://example.test/a.bin', mediaType: 'archive' }),
        (error) => assertFetchCode(error, 'RESULT_FETCH_UNSUPPORTED_MEDIA'),
    );
    assert.throws(() => createResultFetcher({ maxBytes: 0 }), TypeError);
    assert.throws(() => createResultFetcher({ timeoutMs: -1 }), TypeError);
    assert.throws(() => createResultFetcher({ maxRedirects: -1 }), TypeError);
    assert.throws(() => createResultFetcher({ resolveHost: 'nope' }), TypeError);
});

test('地址分类覆盖私网、保留段与 IPv4 映射的 IPv6', () => {
    for (const address of [
        '0.0.0.0', '10.1.1.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.0.1',
        '100.64.0.1', '198.18.0.1', '224.0.0.1', '::1', 'fd00::1', 'fe80::1', 'ff02::1',
        '::ffff:10.0.0.1', '::ffff:7f00:1',
    ]) {
        assert.equal(isBlockedAddress(address), true, `${address} 应被判定为不可抓取`);
    }
    for (const address of ['1.1.1.1', '8.8.8.8', '104.16.0.1', '2606:4700::1111']) {
        assert.equal(isBlockedAddress(address), false, `${address} 应被判定为公网`);
    }
});
