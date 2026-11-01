import { useEffect } from "react";
import { getSettings, updateSettings } from "@/lib/backend/settings";

export const PARAKEET_UPGRADE_NOTICE = "Plainsong now uses the faster version of Parakeet v3.";

/**
 * Says once that the sidecar moved this install from the ONNX build of
 * Parakeet v3 to the GGUF build (`upgrade_onnx_parakeet_slots` in
 * rust-sidecar/src/settings.rs), then clears the flag so it is never said
 * again. The move happens at launch, before there is a window to tell, so the
 * flag in settings is what carries it here.
 */
export function useParakeetUpgradeNotice(
  toast: (message: string, variant?: "success" | "error" | "info") => void,
) {
  useEffect(() => {
    let cancelled = false;
    void getSettings()
      .then(async (settings) => {
        if (cancelled || settings?.transcription?.parakeetUpgradeNoticePending !== true) {
          return;
        }
        toast(PARAKEET_UPGRADE_NOTICE, "info");
        await updateSettings((draft) => {
          draft.transcription.parakeetUpgradeNoticePending = false;
        });
      })
      .catch((error) => {
        console.warn("Could not read or clear the Parakeet v3 notice:", error);
      });
    return () => {
      cancelled = true;
    };
  }, [toast]);
}
