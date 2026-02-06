import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Recording } from "@/types";

export function useRecordings(projectId?: string) {
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchRecordings = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await invoke<Recording[]>("get_recordings", { projectId });
      setRecordings(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch recordings");
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    fetchRecordings();
  }, [fetchRecordings]);

  return {
    recordings,
    isLoading,
    error,
    refetch: fetchRecordings,
  };
}
