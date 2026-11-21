'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createTrustedQuoteService, preparePricingVersion, PricingError } = require('../lib/server/tasks/pricingQuote');
const { stableStringify, validateCreateTaskRequest } = require('../lib/server/tasks/taskSubmission');

// 全部金额和档位均为显式合成夹具，不是产品默认价。
const sample = (epochMicroseconds = '2000000') => ({ source: 'postgresql.clock_timestamp', epochMicroseconds });
function imageConfig() {
    return { modelId: 'image-test', modelVersion: 1, pricingVersion: 'test-v1', enabled: true,
        templateType: 'image_resolution_quantity', currencyUnit: 'credit_tenths', roundingMode: 'ceil_to_atom',
        precisionVersion: 'integer_rational_ms_v1', roundingModeVersion: 'ceil_to_atom_v1',
        quantityMode: 'per_unit', maxOutputCount: 4,
        resolutions: [{ resolutionKey: '1024x1024', enabled: true, unitPriceTenths: '7' }] };
}
function videoConfig() {
    return { modelId: 'video-test', modelVersion: 1, pricingVersion: 'test-v1', enabled: true,
        templateType: 'video_duration_fps', currencyUnit: 'credit_tenths', roundingMode: 'ceil_to_atom',
        precisionVersion: 'integer_rational_ms_v1', roundingModeVersion: 'ceil_to_atom_v1',
        durationMode: 'per_second', minDurationMs: 1, maxDurationMs: 6000,
        durationBands: [{ start: 1, end: 3000, enabled: true, unitPriceTenths: '3' },
            { start: 3000, end: 6001, enabled: true, unitPriceTenths: '9' }],
        fpsRates: [{ fps: 24, enabled: true, numerator: '1', denominator: '2' },
            { fps: 30, enabled: true, numerator: '3', denominator: '2' }] };
}
function version(config = imageConfig(), changes = {}) {
    return { config, publishedAtUs: '0', effectiveFromUs: '1000000', revokedAtUs: null, cancelledAtUs: null, ...changes };
}
function imageRequest(changes = {}) {
    return { taskType: 'image.generate', payload: { logicalModelId: 'image-test', prompt: '合成测试',
        aspectRatio: '1:1', size: '1024x1024', outputCount: 1, ...changes } };
}
function videoRequest(changes = {}) {
    return { taskType: 'video.generate', payload: { logicalModelId: 'video-test', prompt: '合成测试',
        durationMs: 1001, fps: 24, ...changes } };
}
function quote(config = imageConfig(), request = imageRequest(), databaseTime = sample()) {
    return createTrustedQuoteService({ versions: [version(config)] }).quote({ request, databaseTime });
}
function rejects(fn, reason) {
    assert.throws(fn, error => error instanceof PricingError && error.code === 'PRICING_UNAVAILABLE'
        && (!reason || error.reason === reason));
}
function assertDeepFrozen(value) {
    if (value && typeof value === 'object') {
        assert.ok(Object.isFrozen(value));
        Object.values(value).forEach(assertDeepFrozen);
    }
}

test('图片按显式单价生成可复算快照，金额为JSON字符串且包含完整单位、版本及时钟信息', () => {
    const result = quote();
    assert.equal(result.credit_tenths, '7');
    assert.deepEqual(result.normalizedInput, { resolutionKey: '1024x1024', outputCount: 1,
        outputCountSource: 'server_task_type_image_generate_single_v1' });
    assert.equal(result.createdAtUs, '2000000');
    assert.equal(result.expiresAtUs, '1802000000');
    assert.equal(result.quoteValidityMs, 1800000);
    assert.equal(result.databaseTime.source, 'postgresql.clock_timestamp');
    assert.equal(result.databaseTime.unit, 'unix_microseconds');
    assert.equal(result.databaseTime.requiredContext, 'after_model_lock_in_creation_transaction');
    assert.equal(result.expiryPolicy, 'before_first_dispatch_intent_only_no_auto_requote');
    assert.equal(result.currencyUnit, 'credit_tenths');
    assert.equal(result.precisionVersion, 'integer_rational_ms_v1');
    assert.equal(result.roundingModeVersion, 'ceil_to_atom_v1');
    assert.equal(result.modelVersion, 1);
    assert.equal(result.pricingVersion, 'test-v1');
    assert.equal(BigInt(result.exactResult.numerator) / BigInt(result.exactResult.denominator), 7n);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
    assertDeepFrozen(result);
    const { snapshotHash, ...body } = result;
    assert.equal(snapshotHash, createHash('sha256').update(stableStringify(body)).digest('hex'));
    assert.equal(result.configHash, createHash('sha256').update(stableStringify(result.pricingConfig)).digest('hex'));
});

test('图片base_plus_increment按首张基础价计算，显式零增量合法', () => {
    const config = imageConfig();
    config.quantityMode = 'base_plus_increment';
    config.resolutions = [{ resolutionKey: '1024x1024', enabled: true, basePriceTenths: '11', incrementPriceTenths: '0' }];
    assert.equal(quote(config).credit_tenths, '11');
    config.resolutions[0].incrementPriceTenths = '9007199254740991';
    assert.equal(quote(config).credit_tenths, '11');
    rejects(() => quote(config, imageRequest({ outputCount: 2 })));
});

test('图片tiered_total使用左闭右开数量档总价，当前单张命中第一档', () => {
    const config = imageConfig();
    config.quantityMode = 'tiered_total';
    config.resolutions = [{ resolutionKey: '1024x1024', enabled: true, quantityBands: [
        { start: 2, end: 5, totalPriceTenths: '13' }, { start: 1, end: 2, totalPriceTenths: '8' },
    ] }];
    assert.equal(quote(config).credit_tenths, '8');
    rejects(() => quote(config, imageRequest({ outputCount: 2 })));
});

test('图片精确覆盖任务契约所有尺寸，未登记或禁用档位拒绝', () => {
    const mappings = { auto: '1024x1024', '1:1': '1024x1024', '16:9': '1536x864',
        '9:16': '864x1536', '4:3': '1365x1024', '3:4': '1024x1365' };
    const config = imageConfig();
    config.resolutions = [...new Set(Object.values(mappings))].map(resolutionKey => ({ resolutionKey, enabled: true, unitPriceTenths: '2' }));
    for (const [aspectRatio, size] of Object.entries(mappings)) {
        const request = imageRequest({ aspectRatio, size });
        validateCreateTaskRequest(request);
        assert.equal(quote(config, request).normalizedInput.resolutionKey, size);
    }
    rejects(() => quote(imageConfig(), imageRequest({ aspectRatio: '16:9', size: '1536x864' })), 'RESOLUTION_UNMAPPED');
    config.resolutions[0].enabled = false;
    rejects(() => quote(config), 'RESOLUTION_UNMAPPED');
    rejects(() => quote(config, imageRequest({ size: '1025x1024' })), 'INPUT_INVALID');
});

test('视频per_second毫秒和帧率比例合并后仅最终ceil，不逐因子取整', () => {
    const result = quote(videoConfig(), videoRequest());
    assert.equal(result.exactResult.numerator, '3003');
    assert.equal(result.exactResult.denominator, '2000');
    assert.equal(result.credit_tenths, '2');
    assert.deepEqual(result.normalizedInput, { durationMs: 1001, fps: 24 });
    // 精确0.5*1.5=0.75，最终ceil为1；先ceil(0.5)再乘1.5会错报2。
    const config = videoConfig();
    config.durationBands[0].unitPriceTenths = '1';
    assert.equal(quote(config, videoRequest({ durationMs: 500, fps: 30 })).credit_tenths, '1');
    assert.equal(quote(config, videoRequest({ durationMs: 1 })).credit_tenths, '1');
});

test('视频band_total取命中区间总价再乘帧率比例，边界不吸附', () => {
    const config = videoConfig();
    config.durationMode = 'band_total';
    assert.equal(quote(config, videoRequest({ durationMs: 2999 })).credit_tenths, '2');
    assert.equal(quote(config, videoRequest({ durationMs: 3000 })).credit_tenths, '5');
    assert.equal(quote(config, videoRequest({ durationMs: 6000 })).credit_tenths, '5');
    rejects(() => quote(config, videoRequest({ durationMs: 6001 })), 'DURATION_INVALID');
    rejects(() => quote(config, videoRequest({ fps: 25 })), 'FPS_UNMAPPED');
    config.durationBands[0].enabled = false;
    rejects(() => quote(config, videoRequest()), 'DURATION_UNMAPPED');
    config.durationBands[0].enabled = true;
    config.fpsRates[0].enabled = false;
    rejects(() => quote(config, videoRequest()), 'FPS_UNMAPPED');
});

test('视频per_frame只支持显式require_exact，拒绝余数而非偷偷取整', () => {
    const config = videoConfig();
    config.durationMode = 'per_frame';
    config.frameRemainderMode = 'require_exact';
    assert.equal(quote(config, videoRequest({ durationMs: 1000 })).credit_tenths, '36');
    rejects(() => quote(config, videoRequest({ durationMs: 1001 })), 'DURATION_INVALID');
    for (const mode of [undefined, 'ceil', 'floor', 'fractional']) {
        config.frameRemainderMode = mode;
        rejects(() => quote(config, videoRequest()));
    }
});

test('显式免费档和零比例结果为0，任意严格正费用至少1原子单位', () => {
    const image = imageConfig();
    image.resolutions[0].unitPriceTenths = '0';
    assert.equal(quote(image).credit_tenths, '0');
    const video = videoConfig();
    video.fpsRates[0].numerator = '0';
    assert.equal(quote(video, videoRequest()).credit_tenths, '0');
    video.fpsRates[0].numerator = '1';
    video.fpsRates[0].denominator = '9007199254740991';
    assert.equal(quote(video, videoRequest({ durationMs: 1 })).credit_tenths, '1');
});

test('超过Number精确范围的中间乘积用BigInt精确抵消，最终MAX_SAFE_INTEGER可接受', () => {
    const config = videoConfig();
    config.durationMode = 'band_total';
    config.durationBands[0].unitPriceTenths = '9007199254740991';
    config.fpsRates[0].numerator = '9007199254740991';
    config.fpsRates[0].denominator = '9007199254740991';
    const result = quote(config, videoRequest());
    assert.equal(result.credit_tenths, '9007199254740991');
    assert.equal(result.exactResult.numerator, (9007199254740991n ** 2n).toString());
    config.fpsRates[0].denominator = '9007199254740990';
    rejects(() => quote(config, videoRequest()), 'RESULT_OVERFLOW');
});

test('大整数三因子和微小余数精确计算，不以浮点或显示值扣费', () => {
    const config = videoConfig();
    config.durationBands[0].unitPriceTenths = '9007199254740991';
    config.fpsRates[0].numerator = '9007199254740990';
    config.fpsRates[0].denominator = '9007199254740991';
    assert.equal(quote(config, videoRequest({ durationMs: 1 })).credit_tenths, '9007199254741');
    config.fpsRates[0].numerator = '9007199254740991';
    rejects(() => quote(config, videoRequest({ durationMs: 1001 })), 'RESULT_OVERFLOW');
});

for (const [label, value] of Object.entries({ 缺失: undefined, 负数: '-1', 小数: '0.1', 指数: '1e3', 正号: '+1',
    前导零: '01', 空白: ' 1', 空串: '', 数字类型: 1, bigint类型: 1n, 超限: '9007199254740992', 超长: '9'.repeat(20000) })) {
    test(`价格${label}拒绝且不存在默认金额`, () => {
        const config = imageConfig();
        config.resolutions[0].unitPriceTenths = value;
        rejects(() => quote(config));
    });
}

for (const [label, value] of Object.entries({ 缺失: undefined, 零: '0', 负数: '-1', 小数: '1.5', 指数: '1e2',
    超限: '9007199254740992', 数字类型: 2 })) {
    test(`比例分母${label}拒绝`, () => {
        const config = videoConfig();
        config.fpsRates[0].denominator = value;
        rejects(() => quote(config, videoRequest()));
    });
}

test('负比例分子和负基础价增量均不能藏在零数量乘积后', () => {
    const video = videoConfig();
    video.fpsRates[0].numerator = '-1';
    rejects(() => quote(video, videoRequest()));
    const image = imageConfig();
    image.quantityMode = 'base_plus_increment';
    image.resolutions = [{ resolutionKey: '1024x1024', enabled: true, basePriceTenths: '1', incrementPriceTenths: '-1' }];
    rejects(() => quote(image));
    image.resolutions[0].incrementPriceTenths = '0';
    image.resolutions[0].basePriceTenths = '-1';
    rejects(() => quote(image));
});

test('提交参数缺失、字符串、零、负数、小数、非安全整数和NaN均与任务契约一致地拒绝', () => {
    for (const value of [undefined, '1', '1e3', '1.0', 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        const request = imageRequest({ outputCount: value });
        assert.throws(() => validateCreateTaskRequest(request));
        rejects(() => quote(imageConfig(), request));
        for (const field of ['durationMs', 'fps']) {
            const video = videoRequest({ [field]: value });
            assert.throws(() => validateCreateTaskRequest(video));
            rejects(() => quote(videoConfig(), video));
        }
    }
    rejects(() => quote(imageConfig(), imageRequest({ outputCount: 2 })));
    rejects(() => quote(videoConfig(), videoRequest({ durationMs: Number.MAX_SAFE_INTEGER })));
    rejects(() => quote(videoConfig(), videoRequest({ fps: Number.MAX_SAFE_INTEGER })));
    rejects(() => quote(imageConfig(), imageRequest({ logicalModelId: 'other-model' })), 'NO_ACTIVE_VERSION');
    rejects(() => quote(imageConfig(), videoRequest({ logicalModelId: 'image-test' })), 'TEMPLATE_MISMATCH');
});

test('客户端价格、版本、expiry或quote字段一律拒绝，服务方法没有价格覆写参数', () => {
    for (const field of ['unitPriceTenths', 'pricingVersion', 'credit_tenths', 'expiresAt', 'expiresAtUs', 'quote', 'quoteSnapshot', 'fpsNumerator']) {
        rejects(() => quote(imageConfig(), imageRequest({ [field]: '1' })));
    }
    const service = createTrustedQuoteService({ versions: [version()] });
    for (const field of ['versions', 'config', 'pricingVersion', 'quote']) {
        rejects(() => service.quote({ request: imageRequest(), databaseTime: sample(), [field]: '任意覆写' }));
    }
    assert.deepEqual(Object.keys(service), ['quote']);
});

test('时长区间必须覆盖声明范围、无空洞、不重叠且非负，重复fps拒绝', () => {
    const mutations = [
        c => { c.durationBands[0].start = -1; }, c => { c.durationBands[0].start = 2; },
        c => { c.durationBands[0].end = 2999; }, c => { c.durationBands[0].end = 3001; },
        c => { c.durationBands[1].end = 6000; }, c => { c.durationBands[0].end = 1; },
        c => { c.durationBands[0].end = '3000'; }, c => { c.fpsRates.push({ ...c.fpsRates[0] }); },
        c => { c.fpsRates[0].fps = 1.5; }, c => { c.minDurationMs = 0; }, c => { c.maxDurationMs = 0; },
    ];
    for (const mutate of mutations) { const config = videoConfig(); mutate(config); rejects(() => quote(config, videoRequest())); }
});

test('数量区间重复、空洞、覆盖不足和无效上限均拒绝，未知模式和版本拒绝', () => {
    const mutations = [
        c => { c.resolutions.push({ ...c.resolutions[0] }); }, c => { c.maxOutputCount = 0; },
        c => { c.maxOutputCount = '1'; }, c => { c.enabled = 'true'; }, c => { c.quantityMode = 'automatic'; },
        c => { c.precisionVersion = 'unknown'; }, c => { c.roundingModeVersion = 'unknown'; },
        c => { c.currencyUnit = 'credits'; }, c => { c.roundingMode = 'floor'; }, c => { c.extra = 1; },
        c => { delete c.resolutions[0].unitPriceTenths; },
    ];
    for (const mutate of mutations) { const config = imageConfig(); mutate(config); rejects(() => quote(config)); }
    for (const bands of [[{ start: 1, end: 4, totalPriceTenths: '2' }],
        [{ start: 1, end: 3, totalPriceTenths: '2' }, { start: 2, end: 5, totalPriceTenths: '3' }],
        [{ start: 1, end: 2, totalPriceTenths: '2' }, { start: 3, end: 5, totalPriceTenths: '3' }]]) {
        const config = imageConfig(); config.quantityMode = 'tiered_total';
        config.resolutions = [{ resolutionKey: '1024x1024', enabled: true, quantityBands: bands }];
        rejects(() => quote(config));
    }
});

test('hash与对象键和无语义集合顺序无关，修改任何价格或模型版本改变hash', () => {
    const config = videoConfig();
    const first = quote(config, videoRequest());
    const reversed = JSON.parse(JSON.stringify(config), (key, value) => {
        if (value && !Array.isArray(value) && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse());
        return value;
    });
    reversed.durationBands.reverse(); reversed.fpsRates.reverse();
    const second = quote(reversed, videoRequest());
    assert.equal(second.configHash, first.configHash);
    assert.equal(second.snapshotHash, first.snapshotHash);
    config.modelVersion++;
    assert.notEqual(quote(config, videoRequest()).configHash, first.configHash);
    config.modelVersion--;
    config.durationBands[0].unitPriceTenths = '4';
    assert.notEqual(quote(config, videoRequest()).configHash, first.configHash);
});

test('服务装配后源配置原地修改无效，请求与采样修改不影响既有深层冻结快照', () => {
    const records = [version(videoConfig())];
    const service = createTrustedQuoteService({ versions: records });
    const request = videoRequest(); const databaseTime = sample();
    const result = service.quote({ request, databaseTime });
    const before = JSON.stringify(result);
    records[0].config.fpsRates[0].numerator = '999';
    records[0].config.durationBands[0].unitPriceTenths = '999';
    records[0].revokedAtUs = '0'; records.push(version());
    request.payload.durationMs = 2000; databaseTime.epochMicroseconds = '3000000';
    assert.equal(JSON.stringify(result), before);
    assert.equal(service.quote({ request: videoRequest(), databaseTime: sample() }).snapshotHash, result.snapshotHash);
    assertDeepFrozen(result);
    assert.throws(() => { result.pricingConfig.fpsRates[0].numerator = '99'; }, TypeError);
    assert.throws(() => { result.normalizedInput.durationMs = 2000; }, TypeError);
    assert.throws(() => { result.credit_tenths = '0'; }, TypeError);
});

test('默认30分钟，模型覆盖含5分钟和24小时端点，其余值不兜底', () => {
    for (const validity of [300000, 86400000]) {
        const config = imageConfig(); config.quoteValidityMs = validity;
        const result = quote(config);
        assert.equal(BigInt(result.expiresAtUs) - BigInt(result.createdAtUs), BigInt(validity) * 1000n);
    }
    for (const validity of [0, -1, 299999, 86400001, 300000.5, '300000', null, undefined]) {
        const config = imageConfig(); config.quoteValidityMs = validity;
        rejects(() => quote(config));
    }
});

test('必须显式提供DB实时时钟采样，禁止应用时钟及事务now来源，保留微秒精度', () => {
    const service = createTrustedQuoteService({ versions: [version()] });
    for (const databaseTime of [undefined, null, {}, { epochMicroseconds: '2000000' },
        { source: 'Date.now', epochMicroseconds: '2000000' }, { source: 'postgresql.now', epochMicroseconds: '2000000' },
        sample(2000000), sample('2e6'), sample('-1'), sample('2000000.1')]) {
        rejects(() => service.quote({ request: imageRequest(), databaseTime }));
    }
    const result = service.quote({ request: imageRequest(), databaseTime: sample('2000001') });
    assert.equal(result.createdAtUs, '2000001');
    assert.equal(result.expiresAtUs, '1802000001');
    rejects(() => service.quote({ request: imageRequest(), databaseTime: sample('253402300799999999') }), 'RESULT_OVERFLOW');
});

test('预约到点自动成为头，撤销最新头不复活旧价，未来新头到点恢复', () => {
    const v1 = version();
    const v2 = version({ ...imageConfig(), pricingVersion: 'test-v2', resolutions: [
        { resolutionKey: '1024x1024', enabled: true, unitPriceTenths: '12' },
    ] }, { effectiveFromUs: '3000000', revokedAtUs: '4000000' });
    const v3 = version({ ...imageConfig(), pricingVersion: 'test-v3' }, { effectiveFromUs: '5000000' });
    const service = createTrustedQuoteService({ versions: [v3, v1, v2] });
    const at = us => service.quote({ request: imageRequest(), databaseTime: sample(us) });
    rejects(() => at('999999'), 'NO_ACTIVE_VERSION');
    assert.equal(at('1000000').pricingVersion, 'test-v1');
    assert.equal(at('2999999').pricingVersion, 'test-v1');
    assert.equal(at('3000000').credit_tenths, '12');
    const outstanding = at('3999999');
    rejects(() => at('4000000'), 'NO_ACTIVE_VERSION');
    rejects(() => at('4999999'), 'NO_ACTIVE_VERSION');
    assert.equal(at('5000000').pricingVersion, 'test-v3');
    assert.equal(outstanding.credit_tenths, '12');
});

test('合法取消预约永不成为头；草稿不可报价；取消到点或已生效版本拒绝', () => {
    const cancelled = version({ ...imageConfig(), pricingVersion: 'test-v2' },
        { effectiveFromUs: '3000000', cancelledAtUs: '2999999' });
    const draft = version({ ...imageConfig(), pricingVersion: 'test-v3' },
        { publishedAtUs: null, effectiveFromUs: '4000000' });
    const service = createTrustedQuoteService({ versions: [version(), cancelled, draft] });
    assert.equal(service.quote({ request: imageRequest(), databaseTime: sample('5000000') }).pricingVersion, 'test-v1');
    for (const cancelledAtUs of ['3000000', '4000000']) {
        rejects(() => createTrustedQuoteService({ versions: [version(), { ...cancelled, cancelledAtUs }] }));
    }
});

test('超过256个价格历史版本仍完整读入并选择最新头，不截断或回退', () => {
    const versions = Array.from({ length: 257 }, (_, index) => version({ ...imageConfig(), pricingVersion: `v${index + 1}` }, {
        effectiveFromUs: `${(index + 1) * 1000000}`,
    }));
    const result = createTrustedQuoteService({ versions }).quote({ request: imageRequest(), databaseTime: sample('257000000') });
    assert.equal(result.pricingVersion, 'v257');
});

test('历史独立容量为10000版本且JSON预算按版本计，超限整条拒绝不截断', () => {
    const versions = Array.from({ length: 10000 }, (_, index) => version({ ...imageConfig(), pricingVersion: `v${index}` }, {
        effectiveFromUs: `${(index + 1) * 1000000}`,
    }));
    const service = createTrustedQuoteService({ versions });
    assert.equal(service.quote({ request: imageRequest(), databaseTime: sample('10000000000') }).pricingVersion, 'v9999');
    versions.push(version());
    rejects(() => createTrustedQuoteService({ versions }), 'VERSION_HISTORY_LIMIT');
    const config = imageConfig();
    config.resolutions = Array.from({ length: 257 }, (_, index) => ({ resolutionKey: `${index + 1}x1`, enabled: true, unitPriceTenths: '1' }));
    rejects(() => quote(config));
});

test('版本集合拒绝访问器和稀疏项，不执行getter', () => {
    const versions = [version()];
    Object.defineProperty(versions, '0', { enumerable: true, get() { assert.fail('不可执行版本getter'); } });
    rejects(() => createTrustedQuoteService({ versions }));
    rejects(() => createTrustedQuoteService({ versions: new Array(2) }));
});

test('取消与撤销同时非空时服务装配和持久化版本准备均拒绝', () => {
    const invalid = version(imageConfig(), { cancelledAtUs: '500000', revokedAtUs: '2000000' });
    rejects(() => preparePricingVersion(invalid));
    rejects(() => createTrustedQuoteService({ versions: [invalid] }));
});

test('重复生效秒、重复版本、非秒时间轴和生命周期不自洽拒绝', () => {
    for (const records of [[version(), version({ ...imageConfig(), pricingVersion: 'v2' })],
        [version(), version(imageConfig(), { effectiveFromUs: '3000000' })],
        [version(imageConfig(), { effectiveFromUs: '1000001' })],
        [version(imageConfig(), { publishedAtUs: '1000001' })],
        [version(imageConfig(), { publishedAtUs: '100', revokedAtUs: '99' })],
        [version(imageConfig(), { publishedAtUs: null, cancelledAtUs: '1' })],
        [version(imageConfig(), { revokedAtUs: '2000000', cancelledAtUs: '500000' })]]) {
        rejects(() => createTrustedQuoteService({ versions: records }));
    }
    const disabled = imageConfig(); disabled.enabled = false;
    rejects(() => quote(disabled), 'NO_ACTIVE_VERSION');
});

test('缺失配置、循环、访问器、超深对象和非法对象fail closed且不执行getter', () => {
    for (const versions of [undefined, null, [], [{}], [version(null)]]) {
        rejects(() => createTrustedQuoteService({ versions }));
    }
    const cyclic = version(); cyclic.self = cyclic;
    rejects(() => createTrustedQuoteService({ versions: [cyclic] }));
    const getter = version();
    Object.defineProperty(getter.config.resolutions[0], 'unitPriceTenths', { enumerable: true, get() { assert.fail('不能执行访问器'); } });
    rejects(() => createTrustedQuoteService({ versions: [getter] }));
    const config = imageConfig(); let deep = config;
    for (let i = 0; i < 20; i++) { deep.nested = {}; deep = deep.nested; }
    rejects(() => quote(config));
    rejects(() => quote(new Date()));
});

test('内部失败只序列化粗码，消息和堆栈不泄漏价格配置', () => {
    let error;
    try { quote(imageConfig(), imageRequest({ size: '未知私有档位' })); } catch (caught) { error = caught; }
    assert.ok(error instanceof PricingError);
    assert.equal(JSON.stringify(error), '{"code":"PRICING_UNAVAILABLE"}');
    assert.equal(error.message, 'PRICING_UNAVAILABLE');
    assert.ok(!error.stack.includes('未知私有档位'));
    assert.ok(!Object.keys(error).includes('reason'));
});
