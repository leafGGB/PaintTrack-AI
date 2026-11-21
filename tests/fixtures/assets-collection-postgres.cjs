'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { createAssetsQueryService } = require('../../lib/server/assetsQuery');

async function checkAssetsCollection(admin, runtimeUrl, names, record) {
    assert.match(names.database, /^pt_acceptance_[a-z0-9]+_[a-f0-9]{6}$/);
    assert.equal(names.runtimeRole, names.database.replace(/^pt_acceptance_/, 'pt_runtime_'));
    assert.equal((await admin.query('SELECT current_database() AS name')).rows[0].name, names.database);
    const runtime = new Pool({ connectionString: runtimeUrl, max: 1, connectionTimeoutMillis: 3000 });
    try {
        assert.deepEqual((await runtime.query('SELECT current_database() AS db, current_user AS role')).rows[0], { db: names.database, role: names.runtimeRole });
        const a = randomUUID();
        const b = randomUUID();
        await admin.query(`INSERT INTO users (id, email, password_hash, email_verified_at, role)
            VALUES ($1,$3,$5,now(),'user'),($2,$4,$5,now(),'user')`, [a, b, `assets-${a}@example.com`, `assets-${b}@example.com`, `scrypt:32768:8:3:${'a'.repeat(32)}:${'b'.repeat(128)}`]);
        const ids = Array.from({ length: 8 }, () => randomUUID()).sort();
        // Reverse the IDs of the time boundaries so UUID order cannot hide a loss of precision.
        const [newest, tieLow, tieHigh, oldest, other, pending, deleted, audio] = ids;
        const labels = new Map([[newest, 'newest'], [tieLow, 'tie-low'], [tieHigh, 'tie-high'], [oldest, 'oldest'], [other, 'other-account'], [pending, 'pending'], [deleted, 'deleted'], [audio, 'audio']]);
        // Keep all boundaries in the same millisecond, in actual chronological order.
        const atMicrosecond = (offset) => `2026-11-21T01:00:00.${382917 + offset}Z`;
        const [oldestTime, tiedTime, newestTime] = [0, 1, 2].map(atMicrosecond);
        assert.ok(oldestTime < tiedTime && tiedTime < newestTime, 'fixture timestamps must be ordered at microsecond precision');
        for (const [id, owner, media, mime, status, time] of [
            [tieLow, a, 'image', 'image/png', 'ready', tiedTime],
            [tieHigh, a, 'video', 'video/mp4', 'ready', tiedTime],
            [newest, a, 'image', 'image/png', 'ready', newestTime],
            [oldest, a, 'video', 'video/mp4', 'ready', oldestTime],
            [other, b, 'video', 'video/mp4', 'ready', newestTime],
            [pending, a, 'image', 'image/png', 'pending', newestTime],
            [deleted, a, 'video', 'video/mp4', 'deleted', newestTime],
            [audio, a, 'audio', 'audio/mpeg', 'ready', newestTime],
        ]) {
            await admin.query(`INSERT INTO assets
                (id, owner_id, media_type, mime_type, size_bytes, storage_key, status, created_at, deleted_at)
                VALUES ($1,$2,$3,$4,42,$5,$6,$7::timestamptz, CASE WHEN $6 = 'deleted' THEN clock_timestamp() ELSE NULL END)`,
            [id, owner, media, mime, status === 'pending' ? null : `fixture-assets/${id}`, status, time]);
        }
        const service = createAssetsQueryService({ pool: runtime });
        const list = (ownerId, media, params = {}) => service.list({ ownerId, media, ...params });
        const itemLabels = (page) => page.items.map(({ id }) => labels.get(id) || 'unexpected-id');
        const first = await list(a, 'all', { limit: '2' });
        assert.deepEqual(itemLabels(first), ['newest', 'tie-high']);
        assert.ok(first.nextCursor);
        assert.deepEqual(first.items[1], { id: tieHigh, mediaType: 'video', mimeType: 'video/mp4', sizeBytes: 42, createdAt: tiedTime, resultUrl: `/api/assets/${tieHigh}/content` });
        const second = await list(a, 'all', { limit: '2', cursor: first.nextCursor });
        assert.deepEqual(itemLabels(second), ['tie-low', 'oldest']);
        assert.equal(second.nextCursor, null);
        record('资产集合：跨媒体微秒排序与同时间键集分页', 'passed');
        assert.deepEqual(itemLabels(await list(a, 'image')), ['newest', 'tie-low']);
        assert.deepEqual(itemLabels(await list(a, 'video')), ['tie-high', 'oldest']);
        assert.deepEqual(itemLabels(await list(b, 'all')), ['other-account']);
        assert.deepEqual(itemLabels(await list(b, 'image')), []);
        record('资产集合：Web角色下账号归属、媒体与归档状态过滤', 'passed');
    } finally {
        await runtime.end();
    }
}

module.exports = { checkAssetsCollection };
