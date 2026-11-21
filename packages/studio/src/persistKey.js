// Scope local studio state to a stable authenticated account identity. The
// account id is preferred because session tokens can rotate while the account
// remains the same, and an empty identity must never fall back to a shared key.
export function scopedPersistKey(baseKey, identity) {
  if (!identity) return `${baseKey}:unscoped`;
  let hash = 0;
  for (let i = 0; i < identity.length; i++) {
    hash = (hash * 31 + identity.charCodeAt(i)) | 0;
  }
  return `${baseKey}:${(hash >>> 0).toString(36)}`;
}

// Compatibility helper for the other Studio modules that still use the
// historical migration path. ImageStudio deliberately does not call this
// helper because its legacy key has no trustworthy account ownership.
export function migrateLegacyPersistKey(baseKey, scopedKey) {
  if (scopedKey === baseKey) return;
  try {
    if (localStorage.getItem(scopedKey)) return;
    const legacy = localStorage.getItem(baseKey);
    if (legacy) {
      localStorage.setItem(scopedKey, legacy);
      localStorage.removeItem(baseKey);
    }
  } catch {
    // localStorage unavailable (SSR/private mode) — nothing to migrate
  }
}
