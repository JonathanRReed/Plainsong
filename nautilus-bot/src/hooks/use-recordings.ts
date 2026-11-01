import { useState, useEffect, useCallback, useRef } from "react";
import { listen } from "@/lib/electron";
import { getRecordings } from "@/lib/backend/recordings";
import { useDataCache } from "@/hooks/data-cache-context";
import type { Recording } from "@/types";
import { userFacingErrorMessage } from "@/lib/user-facing-error";

export function useRecordings(projectId?: string) {
  const cache = useDataCache();
  const [recordings, setRecordings] = useState<Recording[]>(() => cache.peekRecordings(projectId) ?? []);
  const [isLoading, setIsLoading] = useState(() => !cache.peekRecordings(projectId));
  const [hasLoaded, setHasLoaded] = useState(() => cache.peekRecordings(projectId) !== null);
  const [error, setError] = useState<string | null>(null);
  const requestRevisionRef = useRef(0);
  const scopeRef = useRef({ projectId });
  if (scopeRef.current.projectId !== projectId) scopeRef.current = { projectId };
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      ++requestRevisionRef.current;
    };
  }, []);

  const fetchRecordings = useCallback(async (forceRefresh = false) => {
    const scope = scopeRef.current;
    if (!mountedRef.current || scope.projectId !== projectId) return;
    const request = ++requestRevisionRef.current;
    const isCurrent = () => mountedRef.current && scopeRef.current === scope
      && scope.projectId === projectId && requestRevisionRef.current === request;
    setIsLoading(true);
    setError(null);
    try {
      const data = await cache.getRecordings(
        projectId,
        () => getRecordings(projectId),
        forceRefresh
      );
      if (!isCurrent()) return;
      setRecordings(data);
      setHasLoaded(true);
    } catch (err) {
      if (!isCurrent()) return;
      setError(userFacingErrorMessage(err, "Couldn't load recordings. Try again."));
    } finally {
      if (isCurrent()) setIsLoading(false);
    }
  }, [cache, projectId]);

  useEffect(() => {
    const cached = cache.peekRecordings(projectId);
    setRecordings(cached ?? []);
    setHasLoaded(cached !== null);
    void fetchRecordings();
  }, [cache, projectId, fetchRecordings]);

  const refetch = useCallback(() => fetchRecordings(true), [fetchRecordings]);

  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const refresh = () => {
      if (disposed) return;
      cache.invalidateRecordings(projectId);
      void fetchRecordings(true);
    };
    // Recovery updates must not wait on an unrelated subscription. Each
    // registration owns its cleanup even if another registration fails.
    void Promise.allSettled([
      "meeting-recording-state-changed",
      "recording-status-changed",
      "recording-analysis-ready",
      "recording-title-updated",
      "recording-notes-updated",
      "dictation-history-changed",
    ].map(async (event) => {
      const unlisten = await listen(event, refresh);
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    }));
    // Auto-delete runs after a dictation is delivered, which is after the
    // list above refreshed for it, so the entries it removed stayed listed
    // (and failed to open) until something else changed.
    void listen<{ deletedRecordings?: number }>("dictation-retention-cleanup", (event) => {
      if ((event.payload?.deletedRecordings ?? 0) > 0) refresh();
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    });
    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [cache, fetchRecordings, projectId]);

  return {
    recordings,
    isLoading,
    hasLoaded,
    error,
    refetch,
  };
}
