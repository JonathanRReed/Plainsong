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

  it("stays selectable when download is required", () => {
    expect(
      getProviderSelectionStatus({
        inferenceEnabled: true,
        isAvailable: true,
        downloadStatus: "NotDownloaded",
        runtimeStatus: "missing_model",
      })
    ).toEqual({ selectable: true, reason: "download_required" });
  });

  it("stays selectable when runtime is unavailable", () => {
    expect(
      getProviderSelectionStatus({
        inferenceEnabled: true,
        isAvailable: false,
        downloadStatus: "Downloaded",
        runtimeStatus: "missing_runtime",
      })
    ).toEqual({ selectable: true, reason: "runtime_unavailable" });
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
