const KEY_PATTERN = /^[^\\/:?#\x00-\x1f\x7f]+(?:\/[^\\/:?#\x00-\x1f\x7f]+)*$/;

function assertObjectKey(key) {
    if (typeof key !== 'string' || key !== key.trim() || !KEY_PATTERN.test(key) || key === '.' || key === '..'
        || key.split('/').some((part) => part === '.' || part === '..')) {
        throw new TypeError('key must be a relative object key');
    }
}

function toBuffer(value) {
    if (Buffer.isBuffer(value)) return Buffer.from(value);
    if (value instanceof Uint8Array) return Buffer.from(value);
    throw new TypeError('body must be a Buffer or Uint8Array');
}

function cloneMetadata(metadata) {
    if (metadata === undefined) return {};
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(metadata))) {
        throw new TypeError('metadata must be a plain object of string values');
    }
    const copy = { ...metadata };
    if (Reflect.ownKeys(copy).some((key) => typeof key !== 'string' || typeof copy[key] !== 'string')) {
        throw new TypeError('metadata must be a plain object of string values');
    }
    return copy;
}

/**
 * Injectable object-store test double. Each instance is private and ephemeral;
 * it provides no persistence, URLs, authentication, or ownership checks.
 * 私有仅指进程内实例隔离；无 URL 不证明生产 bucket 的 ACL 或访问策略安全。
 * 不支持公开 ACL；省略 ACL 或显式 private 均不创建外部访问授权。
 * Contract: putObject({ key, body, metadata?, acl? }) -> { key, sizeBytes, metadata };
 * getObject({ key }) -> that record plus a copied Buffer body, or null;
 * deleteObject({ key }) -> whether an object existed. Puts overwrite the key.
 * Metadata is a string map (separate from asset JSON metadata). Helpers
 * hasObject/clear are for tests only, not required of future adapters.
 */
class MemoryObjectStore {
    #objects = new Map();

    async putObject({ key, body, metadata, acl } = {}) {
        if (acl !== undefined && acl !== 'private') {
            throw new TypeError('memory object store only supports private ACL');
        }
        assertObjectKey(key);
        const bytes = toBuffer(body);
        const record = { body: bytes, metadata: cloneMetadata(metadata), sizeBytes: bytes.length };
        this.#objects.set(key, record);
        return { key, sizeBytes: record.sizeBytes, metadata: { ...record.metadata } };
    }

    async getObject({ key } = {}) {
        assertObjectKey(key);
        const record = this.#objects.get(key);
        if (!record) return null;
        return {
            key,
            body: Buffer.from(record.body),
            metadata: { ...record.metadata },
            sizeBytes: record.sizeBytes,
        };
    }

    async deleteObject({ key } = {}) {
        assertObjectKey(key);
        return this.#objects.delete(key);
    }

    async hasObject({ key } = {}) {
        assertObjectKey(key);
        return this.#objects.has(key);
    }

    clear() {
        this.#objects.clear();
    }
}

module.exports = { MemoryObjectStore, assertObjectKey };
