import { useState, useEffect, useCallback } from "react";
import { listen } from "@/lib/electron";
import { getRecordings } from "@/lib/backend/recordings";
import { useDataCache } from "@/hooks/data-cache-context";
import type { Recording } from "@/types";

export function useRecordings(projectId?: string) {
  const cache = useDataCache();
  const [recordings, setRecordings] = useState<Recording[]>(() => cache.peekRecordings(projectId) ?? []);
  const [isLoading, setIsLoading] = useState(() => !cache.peekRecordings(projectId));
  const [hasLoaded, setHasLoaded] = useState(() => cache.peekRecordings(projectId) !== null);
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
      setHasLoaded(true);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : typeof err === "string" ? err : "";
      setError(message.trim() || "Failed to fetch recordings");
    } finally {
      setIsLoading(false);
    }
  }, [cache, projectId]);

  useEffect(() => {
    void fetchRecordings();
  }, [fetchRecordings]);

  useEffect(() => {
    let disposed = false;
    let unlistenStatus: (() => void) | undefined;
    let unlistenAnalysis: (() => void) | undefined;
    let unlistenTitle: (() => void) | undefined;

    const retainUnlistener = (
      assign: (unlisten: () => void) => void,
      unlisten: () => void,
    ) => {
      if (disposed) {
        unlisten();
        return;
      }
      assign(unlisten);
    };

    const refresh = () => {
      cache.invalidateRecordings(projectId);
      void fetchRecordings(true);
    };

    const setup = async () => {
      retainUnlistener(
        (unlisten) => {
          unlistenStatus = unlisten;
        },
        await listen("recording-status-changed", refresh),
      );
      retainUnlistener(
        (unlisten) => {
          unlistenAnalysis = unlisten;
        },
        await listen("recording-analysis-ready", refresh),
      );
      retainUnlistener(
        (unlisten) => {
          unlistenTitle = unlisten;
        },
        await listen("recording-title-updated", refresh),
      );
    };

    void setup();

    return () => {
      disposed = true;
      unlistenStatus?.();
      unlistenAnalysis?.();
      unlistenTitle?.();
    };
  }, [cache, fetchRecordings, projectId]);

  return {
    recordings,
    isLoading,
    hasLoaded,
    error,
    refetch: () => fetchRecordings(true),
  };
}
