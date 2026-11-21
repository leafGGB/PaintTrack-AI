'use strict';

const { catalog, logicalModelId, descriptor, controlledImageOwner, createSyntheticImageAdapter } = require('../lib/server/tasks/controlledImageDevelopment');
const { createFileObjectStore } = require('../lib/server/storage/fileObjectStore');
const { bootstrapWorker } = require('../lib/server/worker');

async function run() {
    if (typeof process.send !== 'function' || !process.connected) throw new Error('CONTROLLED_IMAGE_IPC_REQUIRED');
    const environment = process.env;
    const databaseUrl = environment.PAINTTRACK_WORKER_DATABASE_URL;
    const ownerId = controlledImageOwner(environment, databaseUrl, 'worker');
    const objectStore = createFileObjectStore({ rootDirectory: environment.PAINTTRACK_ASSET_STORAGE_ROOT });
    let lifecycle;
    let stopping = false;
    const stop = () => { stopping = true; lifecycle?.revoke(); };
    const onMessage = (message) => { if (message === 'controlled-image-stop') stop(); };
    process.on('message', onMessage);
    process.once('disconnect', stop);
    try {
        await bootstrapWorker({ databaseUrl, descriptor, approvedBindings: [descriptor], secretResolver: async () => 'synthetic-fixture-only',
            objectStore, trustedCatalog: catalog, logicalModelId, approvedOwnerId: ownerId, checkStartupDatabase: true,
            onHostLifecycle(control) {
                lifecycle = control;
                if (stopping || !process.connected) stop();
                else process.send('controlled-image-ready', error => { if (error) stop(); });
            },
        }, { adapterFactory: createSyntheticImageAdapter });
    } finally {
        process.removeListener('message', onMessage);
        process.removeListener('disconnect', stop);
        if (process.connected) process.disconnect();
    }
}

run().catch(() => {
    process.stderr.write('CONTROLLED_IMAGE_WORKER_FAILED\n');
    process.exitCode = 1;
    if (process.connected) process.disconnect();
});
