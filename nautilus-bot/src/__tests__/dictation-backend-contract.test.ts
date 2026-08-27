import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@/lib/electron", () => ({
  invoke: electronMocks.invoke,
  listen: vi.fn(),
}));

import { downloadAsrModels, stopDictation } from "@/lib/backend";

describe("dictation backend wire contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends the exact requested model with a download", async () => {
    electronMocks.invoke.mockResolvedValue(undefined);

    await downloadAsrModels("whisper", "small.en");

    expect(electronMocks.invoke).toHaveBeenCalledWith("download_asr_models", {
      providerType: "whisper",
      modelId: "small.en",
    });
  });

  it("normalizes the sidecar stop response to transcript text", async () => {
    electronMocks.invoke.mockResolvedValue({
      text: "This is my first Plainsong dictation.",
    });

    await expect(stopDictation()).resolves.toBe(
      "This is my first Plainsong dictation."
    );
    expect(electronMocks.invoke).toHaveBeenCalledWith("stop_dictation");
  });

  it("accepts the legacy raw-string stop response", async () => {
    electronMocks.invoke.mockResolvedValue("Legacy transcript text.");

    await expect(stopDictation()).resolves.toBe("Legacy transcript text.");
  });

  it("rejects malformed stop responses before they reach the UI", async () => {
    electronMocks.invoke.mockResolvedValue({ text: 42 });

    await expect(stopDictation()).rejects.toThrow(
      "Plainsong returned an invalid dictation stop result."
    );
  });
});
