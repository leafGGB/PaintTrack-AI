const { sql } = require('drizzle-orm');
const { hashPassword } = require('./passwords');
const { validateInput, RegistrationError } = require('./registration');
const { emitAuditEvent } = require('./observability');

const BOOTSTRAP_LOCK_ID = 724196232;

class AdminBootstrapError extends Error {
    constructor(code, status = 409) {
        super(code);
        this.code = code;
        this.status = status;
    }
}

function createAdminBootstrapService({ database, hashPasswordImpl = hashPassword, auditSink = console }) {
    if (!database || typeof database.transaction !== 'function') throw new TypeError('需要数据库事务接口');
    if (typeof hashPasswordImpl !== 'function') throw new TypeError('需要密码哈希函数');

    return {
        async initialize(input) {
            try {
                let normalized;
                try {
                    normalized = validateInput('register', input);
                } catch (error) {
                    if (error instanceof RegistrationError) throw new AdminBootstrapError('INVALID_INPUT', 400);
                    throw error;
                }

                const passwordHash = await hashPasswordImpl(normalized.password);
                const userId = await database.transaction(async (tx) => {
                    await tx.execute(sql`SELECT pg_advisory_xact_lock(${BOOTSTRAP_LOCK_ID}::bigint)`);
                    const existingAdmins = await tx.execute(sql`SELECT count(*)::int AS count FROM users WHERE role = 'admin'`);
                    if (Number(existingAdmins.rows[0]?.count) !== 0) throw new AdminBootstrapError('ADMIN_ALREADY_INITIALIZED');

                    const inserted = await tx.execute(sql`INSERT INTO users(email, password_hash, email_verified_at, role)
                        VALUES (${normalized.email}, ${passwordHash}, clock_timestamp(), 'admin')
                        ON CONFLICT (email) DO NOTHING RETURNING id`);
                    if (!inserted.rows.length) throw new AdminBootstrapError('ADMIN_EMAIL_EXISTS');
                    return inserted.rows[0].id;
                });

                emitAuditEvent({ action: 'admin.bootstrap', outcome: 'accepted', resourceType: 'user', resourceId: userId }, auditSink);
                return { userId };
            } catch (error) {
                emitAuditEvent({ action: 'admin.bootstrap', outcome: 'rejected' }, auditSink);
                throw error;
            }
        },
    };
}

module.exports = { createAdminBootstrapService, AdminBootstrapError, BOOTSTRAP_LOCK_ID };
