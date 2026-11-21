import { useCallback, useEffect, useRef, useState } from 'react';
import { getAssets } from './assetsClient.js';
import { subscribeAssetInvalidations } from './assetInvalidations.js';

const empty = { items: [], nextCursor: null, loading: false, error: null, failedPage: null };

export default function useAssets(accountId, media, active) {
  const [state, setState] = useState(empty);
  const scope = useRef(null);
  if (scope.current?.accountId !== accountId || scope.current?.media !== media || scope.current?.active !== active) {
    scope.current = { accountId, media, active };
  }
  const identity = scope.current;
  const request = useRef(null);
  const visited = useRef(new Set());
  const current = state.identity === identity ? state : empty;

  const load = useCallback(async ({ cursor = null, append = false } = {}) => {
    if (!accountId || !active || scope.current !== identity) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    if (!append) visited.current = new Set();
    const isCurrent = () => !controller.signal.aborted && scope.current === identity && request.current === controller;
    setState((previous) => ({ ...(append && previous.identity === identity ? previous : empty), identity, loading: true, error: null, failedPage: null }));
    try {
      const page = await getAssets({ accountId, media, cursor, limit: 20, signal: controller.signal });
      if (!isCurrent()) return;
      if (page.nextCursor !== null && visited.current.has(page.nextCursor)) throw new Error('INVALID_ASSETS_PAGINATION');
      if (cursor !== null) visited.current.add(cursor);
      setState((previous) => {
        const items = append && previous.identity === identity ? [...previous.items] : [];
        const ids = new Set(items.map((item) => item.id));
        for (const item of page.items) {
          if (!ids.has(item.id)) { items.push(item); ids.add(item.id); }
        }
        return { identity, items, nextCursor: page.nextCursor, loading: false, error: null, failedPage: null };
      });
    } catch (error) {
      if (isCurrent()) setState((previous) => ({ ...previous, loading: false, error, failedPage: { cursor, append } }));
    }
  }, [accountId, media, active, identity]);

  useEffect(() => {
    void load();
    const unsubscribe = active ? subscribeAssetInvalidations(accountId, () => { void load(); }) : () => {};
    return () => { unsubscribe(); request.current?.abort(); };
  }, [accountId, active, load]);

  const loadMore = useCallback(() => {
    if (!current.nextCursor || current.loading || current.error || request.current && !request.current.signal.aborted && current.identity !== identity) return;
    return load({ cursor: current.nextCursor, append: true });
  }, [current, identity, load]);
  const retry = useCallback(() => load(current.failedPage || undefined), [current.failedPage, load]);
  return { ...current, refresh: load, loadMore, retry };
}
