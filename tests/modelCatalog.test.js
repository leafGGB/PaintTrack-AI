const test = require('node:test');
const assert = require('node:assert/strict');
const { createModelCatalogService, parseMediaFilter } = require('../lib/server/modelCatalog');

function row(overrides = {}) {
    return {
        logical_model_id: 'painttrack-image',
        display_name: 'PaintTrack Image',
        provider_display_name: 'Example Provider',
        media_type: 'image',
        supported_operations: ['image.generate', 'image.edit'],
        capability_template_key: 'generic-image',
        capability_template_version: 1,
        parameter_schema_version: 2,
        description: 'Synthetic catalog fixture',
        icon_key: 'image',
        sort_order: 10,
        catalog_version: 3,
        ...overrides,
    };
}

function poolWith(rows) {
    const calls = [];
    return {
        calls,
        async query(text, values) {
            calls.push({ text, values });
            return { rows };
        },
    };
}

test('media filter distinguishes absent, valid, invalid, and duplicate values', () => {
    assert.equal(parseMediaFilter(new URLSearchParams()), null);
    assert.equal(parseMediaFilter(new URLSearchParams('media=image')), 'image');
    assert.equal(parseMediaFilter(new URLSearchParams('media=video')), 'video');
    assert.equal(parseMediaFilter(new URLSearchParams('media=audio')), undefined);
    assert.equal(parseMediaFilter(new URLSearchParams('media=image&media=video')), undefined);
});

test('catalog reads only the constrained public database view and returns all safe fields', async () => {
    const pool = poolWith([row()]);
    const catalog = await createModelCatalogService({ pool }).list({ mediaType: 'image' });

    assert.deepEqual(pool.calls[0].values, ['image']);
    assert.match(pool.calls[0].text, /FROM model_catalog_public/);
    assert.doesNotMatch(pool.calls[0].text, /provider_instances|provider_models|model_provider_bindings|base_url|credential_ref|upstream_model_name|parameter_mapping/i);
    assert.deepEqual(catalog.models, [{
        logicalModelId: 'painttrack-image',
        displayName: 'PaintTrack Image',
        providerDisplayName: 'Example Provider',
        mediaType: 'image',
        operations: ['image.generate', 'image.edit'],
        studioModeIds: ['t2i', 'i2i'],
        capabilityTemplate: { key: 'generic-image', version: 1 },
        parameterSchemaVersion: 2,
        catalogVersion: 3,
        availability: 'available',
        description: 'Synthetic catalog fixture',
        iconKey: 'image',
        sortOrder: 10,
    }]);
    assert.match(catalog.etag, /^"[0-9a-f]{64}"$/);
    assert.equal(catalog.catalogVersion, catalog.etag.slice(1, -1));
});

test('catalog maps all known operations to Studio modes and leaves unknown operations unmapped', async () => {
    const pool = poolWith([
        row({ logical_model_id: 'image', supported_operations: ['image.generate', 'image.edit'] }),
        row({ logical_model_id: 'video', media_type: 'video', supported_operations: ['video.generate', 'video.generate_from_image', 'video.edit'] }),
        row({ logical_model_id: 'custom', supported_operations: ['future.operation'] }),
    ]);
    const { models } = await createModelCatalogService({ pool }).list();

    assert.deepEqual(models.map((model) => model.studioModeIds), [
        ['t2i', 'i2i'], ['t2v', 'i2v', 'v2v'], [],
    ]);
    assert.deepEqual(pool.calls[0].values, [null]);
});

test('catalog rejects unsupported service-side media filters', async () => {
    const service = createModelCatalogService({ pool: poolWith([]) });
    await assert.rejects(service.list({ mediaType: 'audio' }), TypeError);
});

test('catalog ETag is stable for identical projection and changes when directory state changes', async () => {
    const first = await createModelCatalogService({ pool: poolWith([row()]) }).list();
    const same = await createModelCatalogService({ pool: poolWith([row()]) }).list();
    const changedDisplay = await createModelCatalogService({ pool: poolWith([row({ display_name: 'Renamed' })]) }).list();
    const changedVersion = await createModelCatalogService({ pool: poolWith([row({ catalog_version: 4 })]) }).list();

    assert.equal(first.etag, same.etag);
    assert.notEqual(first.etag, changedDisplay.etag);
    assert.notEqual(first.etag, changedVersion.etag);
});

test('catalog validates pool dependency', () => {
    assert.throws(() => createModelCatalogService({ pool: null }), TypeError);
    assert.throws(() => createModelCatalogService({ pool: {} }), TypeError);
});
