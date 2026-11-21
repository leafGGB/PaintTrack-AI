import { useCallback, useEffect, useRef, useState } from "react";
import { getStudioHistory } from "./taskClient.js";
import { subscribeAssetInvalidations } from './assetInvalidations.js';

const PAGE_SIZE = 20;

export default function useStudioHistory(accountId, media) {
  const [state, setState] = useState({ accountId: null, media: null, items: [], nextCursor: null, loading: false, error: null });
  const controllerRef = useRef(null);
  const requestRef = useRef(0);
  const currentState = state.accountId === accountId && state.media === media
    ? state
    : { items: [], nextCursor: null, loading: Boolean(accountId), error: null };

  const loadPage = useCallback(async ({ cursor = null, append = false } = {}) => {
    if (!accountId) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const requestId = ++requestRef.current;
    setState((previous) => ({
      accountId,
      media,
      items: append && previous.accountId === accountId && previous.media === media ? previous.items : [],
      nextCursor: append && previous.accountId === accountId && previous.media === media ? previous.nextCursor : null,
      loading: true,
      error: null,
    }));

    try {
      const page = await getStudioHistory({ accountId, media, limit: PAGE_SIZE, cursor, signal: controller.signal });
      if (controller.signal.aborted || requestId !== requestRef.current) return;
      const items = page.items.map(({ resultUrl, logicalModelId, createdAt, ...item }) => ({
        ...item,
        url: resultUrl,
        model: logicalModelId,
        timestamp: createdAt,
      }));
      setState((previous) => ({
        accountId,
        media,
        items: append && previous.accountId === accountId && previous.media === media
          ? [...previous.items, ...items.filter((item) => !previous.items.some((existing) => existing.id === item.id))]
          : items,
        nextCursor: page.nextCursor,
        loading: false,
        error: null,
      }));
    } catch (error) {
      if (controller.signal.aborted || requestId !== requestRef.current) return;
      setState((previous) => ({ ...previous, loading: false, error, failedPage: { cursor, append } }));
    }
  }, [accountId, media]);

  useEffect(() => {
    if (accountId) void loadPage();
    else setState({ accountId: null, media, items: [], nextCursor: null, loading: false, error: null });
    return () => {
      requestRef.current += 1;
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, [accountId, media, loadPage]);

  useEffect(() => subscribeAssetInvalidations(accountId, () => { void loadPage(); }), [accountId, loadPage]);

  const refresh = useCallback(() => loadPage(), [loadPage]);
  const retry = useCallback(() => loadPage(currentState.failedPage), [currentState.failedPage, loadPage]);
  const loadMore = useCallback(() => {
    if (!currentState.nextCursor || currentState.loading) return;
    return loadPage({ cursor: currentState.nextCursor, append: true });
  }, [currentState.loading, currentState.nextCursor, loadPage]);

  return {
    items: currentState.items,
    nextCursor: currentState.nextCursor,
    loading: currentState.loading,
    error: currentState.error,
    refresh,
    retry,
    loadMore,
  };
}
