function createTestOutbox() {
    if (process.env.NODE_ENV === 'production') throw new Error('生产禁止测试 outbox');
    const messages = [];
    return {
        kind: 'test-memory-outbox',
        messages,
        async sendVerification(message) { messages.push({ ...message, type: 'verification' }); },
        async sendPasswordReset(message) { messages.push({ ...message, type: 'password-reset' }); },
    };
}
module.exports = { createTestOutbox };
