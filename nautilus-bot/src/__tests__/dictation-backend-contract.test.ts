import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@/lib/electron", () => ({
  invoke: electronMocks.invoke,
  listen: vi.fn(),
}));

import { createDictationSnippet, downloadAsrModels, stopDictation, updateDictationSnippet } from "@/lib/backend";
import * as backend from "@/lib/backend";
import { diffSettings } from "@/lib/settings-patch";

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

  it("sends snippet creation fields under the native snippet key", async () => {
    const snippet = { trigger: "qa-first", expansion: "Preserve names and 12.50.", appScope: null,
      caseSensitive: false, enabled: true };
    await createDictationSnippet(snippet);
    expect(electronMocks.invoke).toHaveBeenCalledWith("create_dictation_snippet", { snippet });
  });

  it("sends snippet updates and identity under the native keys", async () => {
    const snippet = { expansion: "Preserve maybe and exact wording.", categoryScope: null };
    await updateDictationSnippet("qa-snippet", snippet);
    expect(electronMocks.invoke).toHaveBeenCalledWith("update_dictation_snippet", {
      snippetId: "qa-snippet", snippet,
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

  it("sends explicit correction consent in order across overlapping callers", async () => {
    let finishEnable!: (enabled: boolean) => void;
    electronMocks.invoke
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => { finishEnable = resolve; }))
      .mockResolvedValueOnce(false);
    const enable = backend.setDictationExternalCorrectionLearning(true);
    const disable = backend.setDictationExternalCorrectionLearning(false);
    await Promise.resolve();
    expect(electronMocks.invoke.mock.calls).toEqual([
      ["set_dictation_external_correction_learning", { enabled: true }],
    ]);
    finishEnable(true);
    await expect(enable).resolves.toBe(true);
    await expect(disable).resolves.toBe(false);
    expect(electronMocks.invoke.mock.calls).toEqual([
      ["set_dictation_external_correction_learning", { enabled: true }],
      ["set_dictation_external_correction_learning", { enabled: false }],
    ]);
  });

  it("still applies correction opt-out after an earlier consent write fails", async () => {
    electronMocks.invoke
      .mockRejectedValueOnce(new Error("Disk unavailable"))
      .mockResolvedValueOnce(false);
    const enable = backend.setDictationExternalCorrectionLearning(true);
    const disable = backend.setDictationExternalCorrectionLearning(false);
    await expect(enable).rejects.toThrow("Disk unavailable");
    await expect(disable).resolves.toBe(false);
    expect(electronMocks.invoke.mock.calls).toEqual([
      ["set_dictation_external_correction_learning", { enabled: true }],
      ["set_dictation_external_correction_learning", { enabled: false }],
    ]);
  });

  it("rejects unconfirmed consent responses without blocking a later opt-out", async () => {
    electronMocks.invoke.mockResolvedValueOnce({ enabled: true }).mockResolvedValueOnce(false);
    await expect(backend.setDictationExternalCorrectionLearning(true)).rejects.toThrow(
      "Plainsong did not confirm correction learning.",
    );
    await expect(backend.setDictationExternalCorrectionLearning(false)).resolves.toBe(false);
    expect(electronMocks.invoke).toHaveBeenLastCalledWith(
      "set_dictation_external_correction_learning", { enabled: false },
    );
  });

  it("queues settings intent before reading so a later opt-out follows a held enable", async () => {
    let finishRead!: (settings: object) => void;
    const canonical = { transcription: { dictationKeepAudio: false }, theme: "light" };
    const writes: unknown[] = [];
    let reads = 0;
    electronMocks.invoke.mockImplementation(async (command, args) => {
      if (command === "get_settings") {
        reads += 1;
        if (reads === 1) return new Promise<object>((resolve) => { finishRead = resolve; });
        return structuredClone(canonical);
      }
      if (command === "save_settings") {
        writes.push(args);
        canonical.transcription.dictationKeepAudio = writes.length === 1;
      }
    });
    const enable = backend.updateSettings((settings) => { settings.transcription.dictationKeepAudio = true; });
    const disable = backend.updateSettings((settings) => { settings.transcription.dictationKeepAudio = false; });
    await Promise.resolve();
    expect(reads).toBe(1);
    expect(writes).toEqual([]);
    finishRead(structuredClone(canonical));
    await Promise.all([enable, disable]);
    expect(writes).toEqual([true, false].map((value) => ({
      patch: [{ op: "set", path: ["transcription", "dictationKeepAudio"], value }],
      preserveSavedPrompts: true,
    })));
    expect(canonical.transcription.dictationKeepAudio).toBe(false);
  });

  it("keeps explicit settings patches ordered with mutations and freezes their intent", async () => {
    let finishSave!: () => void;
    const before = { transcription: { dictationKeepAudio: true }, theme: "light" };
    const after = { ...before, theme: "dark" };
    const patch = diffSettings(before, after);
    electronMocks.invoke
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finishSave = resolve; }))
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(undefined);
    const theme = backend.patchSettings(patch);
    const audio = backend.updateSettings((settings) => { settings.transcription.dictationKeepAudio = false; });
    await Promise.resolve();
    expect(electronMocks.invoke.mock.calls).toEqual([
      ["save_settings", { patch: [{ op: "set", path: ["theme"], value: "dark" }], preserveSavedPrompts: true }],
    ]);
    after.theme = "light";
    finishSave();
    await Promise.all([theme, audio]);
    expect(electronMocks.invoke.mock.calls).toEqual([
      ["save_settings", { patch: [{ op: "set", path: ["theme"], value: "dark" }], preserveSavedPrompts: true }],
      ["get_settings"],
      ["save_settings", { patch: [{ op: "set", path: ["transcription", "dictationKeepAudio"], value: false }], preserveSavedPrompts: true }],
    ]);
  });

  it("continues settings writes after failure without sending an old snapshot", async () => {
    const current = { transcription: { dictationKeepAudio: true }, theme: "dark" };
    electronMocks.invoke
      .mockRejectedValueOnce(new Error("Disk unavailable"))
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(undefined);
    const failed = backend.patchSettings(diffSettings({ theme: "light" }, { theme: "dark" }));
    const recovered = backend.updateSettings((settings) => { settings.transcription.dictationKeepAudio = false; });
    await expect(failed).rejects.toThrow("Disk unavailable");
    await expect(recovered).resolves.toBeUndefined();
    expect(electronMocks.invoke).toHaveBeenLastCalledWith("save_settings", {
      patch: [{ op: "set", path: ["transcription", "dictationKeepAudio"], value: false }],
      preserveSavedPrompts: true,
    });
    expect(current).toEqual({ transcription: { dictationKeepAudio: true }, theme: "dark" });
  });

  it("sends an explicit opt-out even when the read already reports off", async () => {
    electronMocks.invoke
      .mockResolvedValueOnce({ transcription: { dictationKeepAudio: false }, theme: "light" })
      .mockResolvedValueOnce(undefined);
    await backend.updateSettings((settings) => { settings.transcription.dictationKeepAudio = false; });
    expect(electronMocks.invoke).toHaveBeenLastCalledWith("save_settings", {
      patch: [{ op: "set", path: ["transcription", "dictationKeepAudio"], value: false }],
      preserveSavedPrompts: true,
    });
  });
});
