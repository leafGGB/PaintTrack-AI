const listeners = new Map();

export function subscribeAssetInvalidations(accountId, listener) {
  if (!accountId) return () => {};
  if (!listeners.has(accountId)) listeners.set(accountId, new Set());
  const scoped = listeners.get(accountId);
  scoped.add(listener);
  return () => {
    scoped.delete(listener);
    if (scoped.size === 0) listeners.delete(accountId);
  };
}

export function invalidateAssets(accountId, change = {}) {
  if (!accountId) return;
  for (const listener of [...(listeners.get(accountId) || [])]) listener(change);
}
