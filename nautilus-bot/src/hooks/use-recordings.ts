import { useState, useEffect, useCallback } from "react";
import { getRecordings } from "@/lib/tauri";
import { useDataCache } from "@/hooks/data-cache-context";
import type { Recording } from "@/types";

export function useRecordings(projectId?: string) {
  const cache = useDataCache();
  const [recordings, setRecordings] = useState<Recording[]>(() => cache.peekRecordings(projectId) ?? []);
  const [isLoading, setIsLoading] = useState(() => !cache.peekRecordings(projectId));
  const [error, setError] = useState<string | null>(null);

  const fetchRecordings = useCallback(async (forceRefresh = false) => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await cache.getRecordings(
        projectId,
        () => getRecordings(projectId),
        forceRefresh
      );
      setRecordings(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch recordings");
    } finally {
      setIsLoading(false);
    }
  }, [cache, projectId]);

  useEffect(() => {
    void fetchRecordings();
  }, [fetchRecordings]);

  return {
    recordings,
    isLoading,
    error,
    refetch: () => fetchRecordings(true),
  };
}
