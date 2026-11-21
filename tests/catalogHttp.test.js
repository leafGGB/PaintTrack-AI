const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { createCatalogHandler } = require('../lib/server/catalogHttp');

const ORIGIN = 'https://catalog.example';
const TOKEN = randomBytes(32).toString('base64url');
const USER_ID = '00000000-0000-4000-8000-0000000000b1';
const ETAG = '"' + 'a'.repeat(64) + '"';

function createSink() {
    return {
        records: [],
        info(value) { this.records.push(value); },
        warn(value) { this.records.push(value); },
        error(value) { this.records.push(value); },
    };
}

function fakeDatabase({ authenticated = true, role = 'user', authLevel = 'password', pool = {} } = {}) {
    return {
        $client: pool,
        async execute() {
            return { rows: authenticated ? [{
                id: USER_ID,
                email: 'user@example.test',
                created_at: new Date('2026-11-10T00:00:00.000Z'),
                email_verified_at: new Date('2026-11-09T00:00:00.000Z'),
                role,
                auth_level: authLevel,
                mfa_verified_at: authLevel === 'mfa' ? new Date('2026-11-10T00:00:00.000Z') : null,
                step_up_verified_at: null,
            }] : [] };
        },
    };
}

function makeRequest({
    method = 'GET', origin = ORIGIN, cookie = `painttrack_session=${TOKEN}`,
    media = '', ifNoneMatch, requestId = randomUUID(),
} = {}) {
    const headers = { 'x-request-id': requestId };
    if (origin !== null) headers.origin = origin;
    if (cookie) headers.cookie = cookie;
    if (ifNoneMatch) headers['if-none-match'] = ifNoneMatch;
    return new Request(`${ORIGIN}/api/catalog/models${media}`, {
        method,
        headers,
        ...(method === 'POST' ? { body: '{}' } : {}),
    });
}

function createHandler(options = {}) {
    const sink = options.sink || createSink();
    const handler = createCatalogHandler({
        database: options.database || fakeDatabase(),
        environment: { NODE_ENV: 'production', APP_BASE_URL: ORIGIN },
        sink,
        serviceFactory: options.serviceFactory || (() => ({
            async list({ mediaType }) {
                return { catalogVersion: 'version-1', etag: ETAG, models: [{
                    logicalModelId: 'example-image', mediaType: mediaType || 'image',
                }] };
            },
        })),
    });
    return { handler, sink };
}

test('受控目录只为就绪宿主的指定会话返回文生图，不回退到普通目录', async () => {
    const secret = 'a'.repeat(64);
    const environment = { NODE_ENV: 'development', APP_BASE_URL: ORIGIN, PAINTTRACK_LOCAL_INTERNAL_GUARD: '1',
        PAINTTRACK_LOCAL_CONTROLLED_IMAGE: '1', PAINTTRACK_CONTROLLED_IMAGE_OWNER: USER_ID,
        PAINTTRACK_LOCAL_MAILBOX_SECRET: secret,
        DATABASE_URL: 'postgres://pt_local_runtime_ci_aabb00112233:fixture@127.0.0.1:5433/pt_local_auth_ci_aabb00112233' };
    const makeHandler = (config, authenticated = true) => createCatalogHandler({ environment: config, sink: createSink(),
        database: fakeDatabase({ authenticated }), serviceFactory() { assert.fail('受控目录不可回退'); } });
    const request = (media, ready = true, cookie) => {
        const req = makeRequest({ media, cookie });
        req.headers.set('x-painttrack-local-capability', secret);
        if (ready) req.headers.set('x-painttrack-controlled-image-ready', secret);
        return req;
    };
    const handler = makeHandler(environment);
    const image = await handler(request('?media=image'));
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('cache-control'), 'no-store');
    assert.deepEqual((await image.json()).models.map(model => model.logicalModelId), ['local-controlled-image']);
    assert.deepEqual((await (await handler(request('?media=video'))).json()).models, []);
    assert.equal((await handler(request('?media=image', false))).status, 503);
    assert.equal((await makeHandler(environment, false)(request('?media=image', true, null))).status, 401);
    const otherOwner = makeHandler({ ...environment, PAINTTRACK_CONTROLLED_IMAGE_OWNER: randomUUID() });
    assert.deepEqual((await (await otherOwner(request('?media=image'))).json()).models, []);
    for (const overrides of [{ NODE_ENV: 'production' }, { PAINTTRACK_LOCAL_MOCK_ROUTING: '1' },
        { PAINTTRACK_CHARGED_SUBMISSION: '1' }, { PAINTTRACK_LOCAL_CONTROLLED_IMAGE: 'true' }]) {
        assert.equal((await makeHandler({ ...environment, ...overrides })(request('?media=image'))).status, 503);
    }
});

test('catalog requires an authenticated session', async () => {
    const { handler } = createHandler({ database: fakeDatabase({ authenticated: false }) });
    const response = await handler(makeRequest({ cookie: null }));
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'UNAUTHENTICATED');
});

test('password-level administrator cannot read the catalog before MFA elevation', async () => {
    const { handler } = createHandler({ database: fakeDatabase({ role: 'admin', authLevel: 'password' }) });
    const response = await handler(makeRequest());
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'MFA_REQUIRED');
});

test('MFA-level administrator can read the catalog', async () => {
    const { handler } = createHandler({ database: fakeDatabase({ role: 'admin', authLevel: 'mfa' }) });
    const response = await handler(makeRequest());
    assert.equal(response.status, 200);
});

test('catalog accepts only GET and rejects cross-origin requests', async () => {
    const { handler } = createHandler();
    const wrongMethod = await handler(makeRequest({ method: 'POST' }));
    assert.equal(wrongMethod.status, 405);
    assert.equal((await wrongMethod.json()).error.code, 'METHOD_NOT_ALLOWED');

    const crossOrigin = await handler(makeRequest({ origin: 'https://attacker.example' }));
    assert.equal(crossOrigin.status, 403);
    assert.equal((await crossOrigin.json()).error.code, 'ORIGIN_REJECTED');
});

test('catalog rejects unsupported and repeated media filters', async () => {
    const { handler } = createHandler();
    for (const media of ['?media=audio', '?media=image&media=video']) {
        const response = await handler(makeRequest({ media }));
        assert.equal(response.status, 400);
        assert.equal((await response.json()).error.code, 'INVALID_CATALOG_FILTER');
    }
});

test('catalog returns safe models with private revalidation headers', async () => {
    const { handler } = createHandler();
    const response = await handler(makeRequest({ media: '?media=video' }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, max-age=60, must-revalidate');
    assert.equal(response.headers.get('etag'), ETAG);
    assert.equal(response.headers.get('vary'), 'Cookie, Accept-Encoding');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.deepEqual(await response.json(), {
        catalogVersion: 'version-1',
        models: [{ logicalModelId: 'example-image', mediaType: 'video' }],
    });
});

test('matching ETag returns 304 without a response body', async () => {
    const { handler } = createHandler();
    const response = await handler(makeRequest({ ifNoneMatch: ETAG }));
    assert.equal(response.status, 304);
    assert.equal(await response.text(), '');
    assert.equal(response.headers.get('etag'), ETAG);
});

test('database failures return a fixed 503 and do not expose exception details', async () => {
    const secretDiagnostic = 'database-password-and-provider-url';
    const { handler, sink } = createHandler({
        serviceFactory: () => ({ async list() { throw new Error(secretDiagnostic); } }),
    });
    const response = await handler(makeRequest());
    const text = await response.text();
    assert.equal(response.status, 503);
    assert.match(text, /CATALOG_UNAVAILABLE/);
    assert.doesNotMatch(text, /database-password|provider-url/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(sink.records.join('\n'), /database-password|provider-url/);
});

test('local mock model is exposed only behind the guarded development route', async () => {
    const environment = {
        NODE_ENV: 'development',
        APP_BASE_URL: ORIGIN,
        PAINTTRACK_LOCAL_MOCK_ROUTING: '1',
        PAINTTRACK_LOCAL_INTERNAL_GUARD: '1',
    };
    const handler = createCatalogHandler({
        database: fakeDatabase({ pool: { async query() { throw new Error('database catalog should not be queried'); } } }),
        environment,
        sink: createSink(),
    });
    const response = await handler(makeRequest({ media: '?media=image' }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.models.length, 1);
    assert.equal(body.models[0].logicalModelId, 'local-mock-image');
    assert.deepEqual(body.models[0].operations, ['image.generate']);

    const videoResponse = await handler(makeRequest({ media: '?media=video' }));
    assert.equal(videoResponse.status, 200);
    const videoBody = await videoResponse.json();
    assert.equal(videoBody.models.length, 1);
    assert.equal(videoBody.models[0].logicalModelId, 'local-mock-video');
    assert.deepEqual(videoBody.models[0].operations, ['video.generate']);

    const forbiddenHandler = createCatalogHandler({
        database: fakeDatabase({ pool: { async query() { return { rows: [] }; } } }),
        environment: { ...environment, PAINTTRACK_LOCAL_INTERNAL_GUARD: '0' },
        sink: createSink(),
        serviceFactory: () => ({ async list() { return { catalogVersion: 'regular', etag: ETAG, models: [] }; } }),
    });
    const forbiddenResponse = await forbiddenHandler(makeRequest({ media: '?media=image' }));
    assert.equal(forbiddenResponse.status, 200);
    assert.deepEqual((await forbiddenResponse.json()).models, []);

    const productionHandler = createCatalogHandler({
        database: fakeDatabase({ pool: { async query() { return { rows: [] }; } } }),
        environment: { ...environment, NODE_ENV: 'production', APP_BASE_URL: ORIGIN },
        sink: createSink(),
        serviceFactory: () => ({ async list() { return { catalogVersion: 'regular', etag: ETAG, models: [] }; } }),
    });
    const productionResponse = await productionHandler(makeRequest({ media: '?media=image' }));
    assert.equal(productionResponse.status, 200);
    assert.deepEqual((await productionResponse.json()).models, []);
});

test('catalog sends only safe audit and log fields', async () => {
    const sink = createSink();
    const requestId = randomUUID();
    const { handler } = createHandler({ sink });
    const response = await handler(makeRequest({ requestId }));
    assert.equal(response.headers.get('x-request-id'), requestId);
    assert.ok(sink.records.some((record) => record.includes('catalog.models.read')));
    assert.doesNotMatch(sink.records.join('\n'), /painttrack_session|user@example|base_url|credential_ref|upstream_model_name/);
});
