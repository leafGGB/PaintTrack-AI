const { RegistrationError } = require('./registration');
function authPolicy(source = process.env) {
    let url;
    try { url = new URL(source.APP_BASE_URL); } catch { throw new RegistrationError('AUTH_UNAVAILABLE', 503); }
    const explicitLocal = source.AUTH_ALLOW_LOCAL_HTTP === '1' || (source.PAINTTRACK_LOCAL_MAILBOX === '1'
        && source.PAINTTRACK_LOCAL_MAILBOX_ORIGIN === url.origin && /^[a-f0-9]{64}$/.test(source.PAINTTRACK_LOCAL_MAILBOX_SECRET || ''));
    const localHttp = source.NODE_ENV === 'development' && explicitLocal
        && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
        || (url.protocol !== 'https:' && !localHttp)) throw new RegistrationError('AUTH_UNAVAILABLE', 503);
    return { origin: url.origin, secure: !localHttp };
}
function checkOrigin(request, policy, mutation = true) {
    const supplied = request.headers.get('origin');
    const site = request.headers.get('sec-fetch-site');
    if ((mutation && supplied !== policy.origin) || (supplied !== null && supplied !== policy.origin)
        || (site && !['same-origin', 'none'].includes(site))) throw new RegistrationError('ORIGIN_REJECTED', 403);
}
module.exports = { authPolicy, checkOrigin };
