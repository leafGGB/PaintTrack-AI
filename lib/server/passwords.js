const { randomBytes, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const derive = promisify(scrypt);
const KEY = Symbol.for('painttrack.passwordKdf.v1');
const FORMAT = /^scrypt:32768:8:3:([0-9a-f]{32}):([0-9a-f]{128})$/;
const dummy = `scrypt:32768:8:3:${randomBytes(16).toString('hex')}:${'0'.repeat(128)}`;
class KdfBusyError extends Error {
    constructor() { super('KDF_BUSY'); this.code = 'KDF_BUSY'; this.status = 503; }
}
async function boundedDerive(password, salt) {
    const state = globalThis[KEY] ||= { active: 0, waiting: [] };
    if (state.active >= 2) {
        if (state.waiting.length >= 8) throw new KdfBusyError();
        await new Promise((resolve) => state.waiting.push(resolve));
    } else state.active++;
    try {
        return await derive(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
    } finally {
        const next = state.waiting.shift();
        if (next) next();
        else state.active--;
    }
}
async function hashPassword(password) {
    const salt = randomBytes(16).toString('hex');
    const hash = await boundedDerive(password, salt);
    return `scrypt:32768:8:3:${salt}:${hash.toString('hex')}`;
}
async function verifyPassword(password, stored) {
    const valid = typeof stored === 'string' && FORMAT.test(stored);
    const [, salt, expected] = (valid ? stored : dummy).match(FORMAT);
    const actual = await boundedDerive(password, salt);
    const matches = timingSafeEqual(actual, Buffer.from(expected, 'hex'));
    return Boolean(valid && matches);
}
module.exports = { hashPassword, verifyPassword, KdfBusyError };
