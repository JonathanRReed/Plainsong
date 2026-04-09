import { useEffect, useCallback } from "react";
import { checkForUpdates, getUpdateStatus, type UpdateStatusInfo } from "@/lib/backend";

interface UseUpdateCheckOptions {
  enabled?: boolean;
  onStatusChange?: (status: UpdateStatusInfo) => void;
  onError?: (error: Error) => void;
}

export function useUpdateCheck({
  enabled = true,
  onStatusChange,
  onError,
}: UseUpdateCheckOptions = {}) {
  const checkUpdates = useCallback(async () => {
    if (!enabled) return;
    
    try {
      await checkForUpdates();
      const status = await getUpdateStatus();
      onStatusChange?.(status);
    } catch (error) {
      onError?.(error as Error);
    }
  }, [enabled, onStatusChange, onError]);

  // Check on mount if enabled
  useEffect(() => {
    if (enabled) {
      checkUpdates();
    }
  }, [enabled, checkUpdates]);

  return { checkUpdates };
}
