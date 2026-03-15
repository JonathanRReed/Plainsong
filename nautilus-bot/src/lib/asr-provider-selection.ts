import type { AsrProviderInfo } from "@/types";
import { normalizeDownloadStatus } from "@/lib/download-status";

export interface ProviderSelectionStatus {
  selectable: boolean;
  reason: string | null;
}

export function getProviderSelectionStatus(
  provider: Pick<
    AsrProviderInfo,
    "downloadStatus" | "inferenceEnabled" | "isAvailable" | "runtimeStatus" | "engineDiagnostics"
  >
): ProviderSelectionStatus {
  const normalized = normalizeDownloadStatus(provider.downloadStatus);
  if (!provider.inferenceEnabled) {
    return { selectable: false, reason: "not_enabled" };
  }
  if (normalized.kind !== "downloaded") {
    return { selectable: false, reason: "download_required" };
  }
  if (provider.runtimeStatus !== "ready" || !provider.isAvailable) {
    return { selectable: false, reason: "runtime_unavailable" };
  }
  if (
    provider.engineDiagnostics &&
    provider.engineDiagnostics.availableEngines.length === 0
  ) {
    return { selectable: false, reason: "runtime_unavailable" };
  }
  return { selectable: true, reason: null };
}
