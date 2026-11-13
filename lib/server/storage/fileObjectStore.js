'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { assertObjectKey } = require('./memoryObjectStore');

function toBuffer(value) {
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) return Buffer.from(value);
    throw new TypeError('body must be a Buffer or Uint8Array');
}

function createFileObjectStore({ rootDirectory, maxObjectBytes = 50 * 1024 * 1024 } = {}) {
    if (typeof rootDirectory !== 'string' || !path.isAbsolute(rootDirectory)) {
        throw new TypeError('rootDirectory must be an absolute path');
    }
    if (!Number.isSafeInteger(maxObjectBytes) || maxObjectBytes <= 0) {
        throw new TypeError('maxObjectBytes must be a positive safe integer');
    }
    const root = path.resolve(rootDirectory);

    function objectPath(key) {
        assertObjectKey(key);
        const target = path.resolve(root, key);
        if (!target.startsWith(`${root}${path.sep}`)) throw new TypeError('key escapes object root');
        return target;
    }

    return Object.freeze({
        async putObject({ key, body, metadata = {}, acl } = {}) {
            if (acl !== undefined && acl !== 'private') throw new TypeError('only private ACL is supported');
            const bytes = toBuffer(body);
            if (bytes.byteLength > maxObjectBytes) throw new RangeError('object exceeds configured size limit');
            const target = objectPath(key);
            const directory = path.dirname(target);
            await fs.mkdir(directory, { recursive: true, mode: 0o700 });
            const temporary = path.join(directory, `.painttrack-${randomUUID()}.tmp`);
            try {
                await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
                await fs.rename(temporary, target);
            } catch (error) {
                await fs.unlink(temporary).catch(() => {});
                throw error;
            }
            return { key, sizeBytes: bytes.byteLength, metadata: { ...metadata } };
        },
        async getObject({ key } = {}) {
            const target = objectPath(key);
            try {
                const body = await fs.readFile(target);
                return { key, body, sizeBytes: body.byteLength, metadata: {} };
            } catch (error) {
                if (error.code === 'ENOENT') return null;
                throw error;
            }
        },
        async deleteObject({ key } = {}) {
            const target = objectPath(key);
            try {
                await fs.unlink(target);
                return true;
            } catch (error) {
                if (error.code === 'ENOENT') return false;
                throw error;
            }
        },
    });
}

module.exports = { createFileObjectStore };
