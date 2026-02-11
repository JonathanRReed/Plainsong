import { describe, expect, it } from "vitest";
import { getProviderSelectionStatus } from "@/lib/asr-provider-selection";

describe("getProviderSelectionStatus", () => {
  it("is selectable only when downloaded + available + enabled", () => {
    expect(
      getProviderSelectionStatus({
        inferenceEnabled: true,
        isAvailable: true,
        downloadStatus: "Downloaded",
        runtimeStatus: "ready",
      })
    ).toEqual({ selectable: true, reason: null });
  });

  it("requires download when not downloaded", () => {
    expect(
      getProviderSelectionStatus({
        inferenceEnabled: true,
        isAvailable: true,
        downloadStatus: "NotDownloaded",
        runtimeStatus: "missing_model",
      })
    ).toEqual({ selectable: false, reason: "download_required" });
  });

  it("blocks when runtime is unavailable", () => {
    expect(
      getProviderSelectionStatus({
        inferenceEnabled: true,
        isAvailable: false,
        downloadStatus: "Downloaded",
        runtimeStatus: "missing_runtime",
      })
    ).toEqual({ selectable: false, reason: "runtime_unavailable" });
  });

  it("blocks when inference is disabled", () => {
    expect(
      getProviderSelectionStatus({
        inferenceEnabled: false,
        isAvailable: true,
        downloadStatus: "Downloaded",
        runtimeStatus: "ready",
      })
    ).toEqual({ selectable: false, reason: "not_enabled" });
  });
});
