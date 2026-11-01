import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSetupStatus } from "@/hooks/use-setup-status";
import type { Settings } from "@/types/settings";

const liveMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  getSettings: vi.fn(),
  getAsrProviders: vi.fn(),
  listDownloadedModels: vi.fn(),
  getPermissionDiagnostics: vi.fn(),
  getSystemAudioCapability: vi.fn(),
  hasProviderSecret: vi.fn(),
  getOllamaStatus: vi.fn(),
  listOllamaModels: vi.fn(),
  listOllamaModelCatalog: vi.fn(),
  getLocalTextRuntimeHealth: vi.fn(),
}));

vi.mock("@/lib/electron", () => ({
  invoke: liveMocks.invoke,
  listen: vi.fn(
    async (
      eventName: string,
      handler: (event: { payload: unknown }) => void,
    ) => {
      liveMocks.listeners.set(eventName, handler);
      return () => {
        liveMocks.listeners.delete(eventName);
      };
    },
  ),
}));

vi.mock("@/lib/backend/asr", () => ({
  getAsrProviders: liveMocks.getAsrProviders,
  listDownloadedModels: liveMocks.listDownloadedModels,
}));

vi.mock("@/lib/backend/settings", () => ({
  getSettings: liveMocks.getSettings,
  getPermissionDiagnostics: liveMocks.getPermissionDiagnostics,
  hasProviderSecret: liveMocks.hasProviderSecret,
}));

vi.mock("@/lib/backend/ai", () => ({
  getOllamaStatus: liveMocks.getOllamaStatus,
  listOllamaModels: liveMocks.listOllamaModels,
  listOllamaModelCatalog: liveMocks.listOllamaModelCatalog,
  getLocalTextRuntimeHealth: liveMocks.getLocalTextRuntimeHealth,
}));

vi.mock("@/lib/backend/recordings", () => ({
  getSystemAudioCapability: liveMocks.getSystemAudioCapability,
}));

function settings(): Settings {
  return {
    transcription: {
      useSharedAsrSelection: false,
      defaultProvider: "moonshine",
      dictationProvider: "moonshine",
      dictationModelId: "moonshine-base",
      meetingProvider: "parakeet",
      meetingModelId: "parakeet-tdt-0.6b-v3",
      selectedModelId: "moonshine-base",
      dictationInsertionMode: "clipboard_only",
    },
  } as Settings;
}

describe("useSetupStatus live refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    liveMocks.listeners.clear();
    liveMocks.invoke.mockReset();
    liveMocks.getSettings.mockResolvedValue(settings());
    liveMocks.getAsrProviders.mockResolvedValue([]);
    liveMocks.listDownloadedModels.mockResolvedValue([]);
    liveMocks.getPermissionDiagnostics.mockResolvedValue(null);
    liveMocks.getSystemAudioCapability.mockResolvedValue(null);
    liveMocks.hasProviderSecret.mockResolvedValue(false);
    liveMocks.getOllamaStatus.mockResolvedValue(true);
    liveMocks.listOllamaModels.mockResolvedValue([]);
    liveMocks.listOllamaModelCatalog.mockResolvedValue([]);
    liveMocks.getLocalTextRuntimeHealth.mockResolvedValue({ localGateApplies: true, runtimeHealth: { state: "available", message: null } });
  });

  it.each(["ready", "missing_model", "probe_failed", "wrong_model", "legacy_response"] as const)(
    "rechecks cached missing-model status and honors %s native evidence",
    async (outcome) => {
      const provider = {
        providerType: "parakeet", name: "Parakeet", inferenceEnabled: true,
        runtimeStatus: "missing_model", runtimeMessage: "Cached missing model",
        selectedModelId: "parakeet-tdt-0.6b-v3",
        modelOptions: [{ id: "parakeet-tdt-0.6b-v3", label: "TDT v3" }],
      };
      liveMocks.getAsrProviders.mockResolvedValue([provider]);
      const files = outcome === "ready"
        ? ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"]
        : ["encoder.int8.onnx"];
      liveMocks.listDownloadedModels.mockResolvedValue(files.map((name) => ({
        name, provider: "parakeet",
        path: `/models/parakeet/parakeet-tdt-0.6b-v3/${name}`,
        sizeBytes: 64 * 1024 * 1024,
      })));
      liveMocks.getPermissionDiagnostics.mockResolvedValue({
        microphoneReady: true, microphonePermissionReady: true,
      });
      liveMocks.invoke.mockImplementation(async (command: string) => {
        if (command !== "get_asr_runtime_diagnostics") return null;
        if (outcome === "probe_failed") throw new Error("Probe unavailable");
        return {
          providerType: "parakeet",
          selectedModelId: outcome === "wrong_model" ? "parakeet-tdt-0.6b-v2"
            : outcome === "legacy_response" ? undefined : "parakeet-tdt-0.6b-v3",
          runtimeStatus: outcome === "wrong_model" || outcome === "legacy_response" ? "ready" : outcome,
          runtimeMessage: null,
          runtimeDetails: { missingFiles: outcome === "ready" ? [] : ["tokens.txt"] },
        };
      });
      const { result, unmount } = renderHook(() => useSetupStatus());
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(liveMocks.invoke).toHaveBeenCalledWith("get_asr_runtime_diagnostics", {
        providerType: "parakeet", modelId: "parakeet-tdt-0.6b-v3",
      });
      expect(result.current.meetingReady).toBe(outcome === "ready");
      if (outcome === "missing_model") {
        expect(result.current.meetingRoute.reason).toContain("files are missing or damaged");
      }
      unmount();
    },
  );

  it.each(["missing_model", "ready"] as const)(
    "checks two exact Whisper variants with cached %s provider status",
    async (globalStatus) => {
      const selected = settings();
      Object.assign(selected.transcription, {
        dictationProvider: "whisper", dictationModelId: "small.en",
        meetingProvider: "whisper", meetingModelId: "base.en",
      });
      liveMocks.getSettings.mockResolvedValue(selected);
      liveMocks.getAsrProviders.mockResolvedValue([{
        providerType: "whisper", name: "Whisper", inferenceEnabled: true,
        runtimeStatus: globalStatus, selectedModelId: "base.en",
        modelOptions: [{ id: "small.en", label: "Small" }, { id: "base.en", label: "Base" }],
      }]);
      liveMocks.listDownloadedModels.mockResolvedValue([{
        name: "ggml-small.en.bin", provider: "whisper",
        path: "/models/whisper/ggml-small.en.bin", sizeBytes: 64 * 1024 * 1024,
      }]);
      liveMocks.getPermissionDiagnostics.mockResolvedValue({
        microphoneReady: true, microphonePermissionReady: true,
      });
      liveMocks.invoke.mockImplementation(async (command, params) => {
        if (command !== "get_asr_runtime_diagnostics") return null;
        return {
          providerType: "whisper", selectedModelId: params.modelId,
          runtimeStatus: params.modelId === "small.en" ? "ready" : "missing_model",
          runtimeMessage: null, runtimeDetails: { missingFiles: [] },
        };
      });
      const { result, unmount } = renderHook(() => useSetupStatus());
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.dictationRoute.ready).toBe(true);
      expect(result.current.meetingRoute.ready).toBe(false);
      expect(liveMocks.invoke).toHaveBeenCalledWith("get_asr_runtime_diagnostics", {
        providerType: "whisper", modelId: "small.en",
      });
      const calls = liveMocks.invoke.mock.calls.filter(([command]) => command === "get_asr_runtime_diagnostics");
      expect(calls).toHaveLength(globalStatus === "missing_model" ? 2 : 1);
      expect(result.current.providers).toHaveLength(1);
      unmount();
    },
  );

  it("probes a shared local route once and blocks a failed nonactive variant", async () => {
    const selected = settings();
    Object.assign(selected.transcription, {
      dictationProvider: "whisper", dictationModelId: "small.en",
      meetingProvider: "whisper", meetingModelId: "small.en",
    });
    liveMocks.getSettings.mockResolvedValue(selected);
    liveMocks.getAsrProviders.mockResolvedValue([{
      providerType: "whisper", name: "Whisper", inferenceEnabled: true,
      runtimeStatus: "ready", selectedModelId: "base.en",
      modelOptions: [{ id: "small.en", label: "Small" }, { id: "base.en", label: "Base" }],
    }]);
    liveMocks.listDownloadedModels.mockResolvedValue([{
      name: "ggml-small.en.bin", provider: "whisper",
      path: "/models/whisper/ggml-small.en.bin", sizeBytes: 64 * 1024 * 1024,
    }]);
    liveMocks.invoke.mockRejectedValue(new Error("Probe unavailable"));
    const { result, unmount } = renderHook(() => useSetupStatus());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.dictationRoute.ready).toBe(false);
    expect(result.current.meetingRoute.ready).toBe(false);
    expect(liveMocks.invoke.mock.calls.filter(([command]) => command === "get_asr_runtime_diagnostics")).toHaveLength(1);
    unmount();
  });

  it("publishes verified dictation readiness while meeting AI is still checking", async () => {
    const selected = settings();
    selected.privacy = { meetingsAi: { provider: "ollama", modelId: "local-notes" } } as Settings["privacy"];
    liveMocks.getSettings.mockResolvedValue(selected);
    liveMocks.getAsrProviders.mockResolvedValue([{
      providerType: "moonshine", name: "Moonshine", inferenceEnabled: true,
      runtimeStatus: "ready", selectedModelId: "moonshine-base",
      modelOptions: [{ id: "moonshine-base", label: "Base" }],
    }]);
    liveMocks.listDownloadedModels.mockResolvedValue([{
      name: "decoder.onnx", provider: "moonshine", path: "/models/moonshine/decoder.onnx", sizeBytes: 1,
    }]);
    liveMocks.getPermissionDiagnostics.mockResolvedValue({
      microphoneReady: true, microphonePermissionReady: true, cursorInsertionReady: true,
    });
    let finishProbe!: (value: boolean) => void;
    liveMocks.getOllamaStatus.mockImplementationOnce(() => new Promise<boolean>(resolve => {
      finishProbe = resolve;
    }));
    const { result, unmount } = renderHook(() => useSetupStatus());
    await waitFor(() => {
      expect(liveMocks.getOllamaStatus).toHaveBeenCalled();
      expect(result.current.loading).toBe(false);
      expect(result.current.productReadiness.dictation.state).toBe("ready");
    });
    await act(async () => { finishProbe(false); });
    await waitFor(() => {
      expect(result.current.meetingNotesRoute.state).not.toBe("unknown");
      expect(result.current.productReadiness.dictation.state).toBe("ready");
    });
    unmount();
  });

  it("ignores an older notes probe after newer settings have been checked", async () => {
    const older = settings();
    older.privacy = { meetingsAi: { provider: "ollama", modelId: "old-notes" } } as Settings["privacy"];
    const newer = { ...older, privacy: { ...older.privacy, meetingsAi: { provider: "ollama", modelId: "new-notes" } } } as Settings;
    let finishOlder!: (value: boolean) => void;
    liveMocks.getSettings.mockResolvedValueOnce(older).mockResolvedValue(newer);
    liveMocks.getOllamaStatus.mockImplementationOnce(() => new Promise<boolean>(resolve => { finishOlder = resolve; })).mockResolvedValue(false);
    liveMocks.listOllamaModels.mockResolvedValue(["old-notes"]);
    const { result, unmount } = renderHook(() => useSetupStatus());
    await waitFor(() => { expect(liveMocks.getOllamaStatus).toHaveBeenCalledTimes(1); });
    await act(async () => { liveMocks.listeners.get("settings-changed")?.({ payload: newer }); });
    await waitFor(() => {
      expect(result.current.settings?.privacy.meetingsAi.modelId).toBe("new-notes");
      expect(result.current.meetingNotesRoute.state).toBe("unconfigured");
    });
    await act(async () => { finishOlder(true); });
    await waitFor(() => { expect(liveMocks.listOllamaModels).toHaveBeenCalled(); });
    expect(result.current.meetingNotesRoute.state).toBe("unconfigured");
    unmount();
  });

  it.each(["unchanged", "revoked", "failed", "invalidated"] as const)(
    "keeps checked readiness still during focus probes and handles %s evidence",
    async (outcome) => {
      liveMocks.getAsrProviders.mockResolvedValue([{
        providerType: "moonshine", name: "Moonshine", inferenceEnabled: true,
        runtimeStatus: "ready", selectedModelId: "moonshine-base",
        modelOptions: [{ id: "moonshine-base", label: "Base" }],
      }]);
      liveMocks.listDownloadedModels.mockResolvedValue([{
        name: "encoder.onnx", provider: "moonshine",
        path: "/models/moonshine/encoder.onnx", sizeBytes: 64 * 1024 * 1024,
      }]);
      const permissions = {
        microphoneReady: true, microphonePermissionReady: true,
        microphoneDeviceReady: true, cursorInsertionReady: true,
      };
      liveMocks.getPermissionDiagnostics.mockResolvedValue(permissions);
      const { result, unmount } = renderHook(() => useSetupStatus());
      await waitFor(() => expect(result.current.productReadiness.dictation.state).toBe("ready"));
      let complete!: (value: typeof permissions) => void;
      let fail!: (error: Error) => void;
      liveMocks.getPermissionDiagnostics.mockReturnValueOnce(new Promise((resolve, reject) => {
        complete = resolve;
        fail = reject;
      }));
      await act(async () => { window.dispatchEvent(new Event("focus")); });
      expect(result.current.loading).toBe(false);
      expect(result.current.productReadiness.dictation.state).toBe("ready");

      if (outcome === "invalidated") {
        // A settings write must invalidate even while a focus probe is pending.
        let finishSettings!: (value: Settings) => void;
        liveMocks.getSettings.mockReturnValueOnce(new Promise((resolve) => { finishSettings = resolve; }));
        await act(async () => {
          liveMocks.listeners.get("settings-changed")?.({ payload: settings() });
        });
        expect(result.current.loading).toBe(true);
        expect(result.current.productReadiness.dictation.state).toBe("unknown");
        await act(async () => { finishSettings(settings()); });
        await waitFor(() => expect(result.current.loading).toBe(false));
        await act(async () => { complete({ ...permissions, microphonePermissionReady: false }); });
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.productReadiness.dictation.state).toBe("ready");
      } else {
        await act(async () => {
          if (outcome === "failed") fail(new Error("Permission probe unavailable"));
          else complete({ ...permissions, microphonePermissionReady: outcome !== "revoked" });
        });
        await waitFor(() => expect(result.current.productReadiness.dictation.state)
          .toBe(outcome === "unchanged" ? "ready" : outcome === "revoked" ? "needs_action" : "unknown"));
      }
      unmount();
    },
  );

  it("refreshes after settings writes, completed model downloads, and app focus", async () => {
    const { unmount } = renderHook(() => useSetupStatus());

    await waitFor(() => {
      expect(liveMocks.getSettings).toHaveBeenCalledTimes(1);
      expect(liveMocks.listeners.has("settings-changed")).toBe(true);
      expect(liveMocks.listeners.has("asr-download-progress")).toBe(true);
      expect(liveMocks.listeners.has("readiness-invalidated")).toBe(true);
      expect(liveMocks.listeners.has("sidecar-runtime-changed")).toBe(true);
    });

    await act(async () => {
      liveMocks.listeners.get("settings-changed")?.({ payload: settings() });
    });
    await waitFor(() => {
      expect(liveMocks.getSettings).toHaveBeenCalledTimes(2);
    });

    await act(async () => {
      liveMocks.listeners.get("asr-download-progress")?.({
        payload: ["moonshine", 99],
      });
    });
    expect(liveMocks.getSettings).toHaveBeenCalledTimes(2);

    await act(async () => {
      liveMocks.listeners.get("asr-download-progress")?.({
        payload: ["moonshine", 100],
      });
    });
    await waitFor(() => {
      expect(liveMocks.getSettings).toHaveBeenCalledTimes(3);
    });

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => {
      expect(liveMocks.getSettings).toHaveBeenCalledTimes(4);
    });

    await act(async () => {
      liveMocks.listeners.get("readiness-invalidated")?.({ payload: {} });
    });
    await waitFor(() => {
      expect(liveMocks.getSettings).toHaveBeenCalledTimes(5);
    });

    unmount();
    expect(liveMocks.listeners.size).toBe(0);

    window.dispatchEvent(new Event("focus"));
    expect(liveMocks.getSettings).toHaveBeenCalledTimes(5);
  });

  it("blocks stale readiness immediately when the sidecar dies and refreshes on recovery", async () => {
    const { result } = renderHook(() => useSetupStatus());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(liveMocks.listeners.has("sidecar-runtime-changed")).toBe(true);
    });

    await act(async () => {
      liveMocks.listeners.get("sidecar-runtime-changed")?.({
        payload: {
          ready: false,
          reason: "crash",
          message: "Sidecar process exited (code=1, signal=null)",
        },
      });
    });
    // The bridge's own log line never reaches the reader.
    expect(result.current.error).not.toContain("code=1");
    expect(result.current.error).toContain(
      "The local transcription engine stopped",
    );
    expect(result.current.engineNotice?.title).toBe(
      "The local transcription engine stopped",
    );
    expect(result.current.productReadiness.dictation.state).toBe("blocked");
    expect(result.current.productReadiness.meetings.state).toBe("blocked");

    await act(async () => {
      liveMocks.listeners.get("sidecar-runtime-changed")?.({
        payload: { ready: true },
      });
    });
    await waitFor(() => {
      expect(liveMocks.getSettings).toHaveBeenCalledTimes(2);
      expect(result.current.error).toBeNull();
      expect(result.current.engineNotice).toBeNull();
    });
  });

  it("keeps a lost engine legible when the bridge sends no typed reason", async () => {
    const { result } = renderHook(() => useSetupStatus());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // A build predating the typed contract still puts a sentence in `reason`.
    await act(async () => {
      liveMocks.listeners.get("sidecar-runtime-changed")?.({
        payload: {
          ready: false,
          reason: "Sidecar process exited (code=1, signal=null)",
        },
      });
    });

    expect(result.current.engineNotice?.title).toBe(
      "The local transcription engine stopped",
    );
    expect(result.current.error).not.toContain("signal=null");
  });

  it("keeps a dismissed engine notice down for the same incident", async () => {
    const { result } = renderHook(() => useSetupStatus());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      liveMocks.listeners.get("sidecar-runtime-changed")?.({
        payload: { ready: false, reason: "crash" },
      });
    });
    expect(result.current.engineNotice).not.toBeNull();

    await act(async () => {
      result.current.dismissEngineNotice();
    });
    expect(result.current.engineNotice).toBeNull();

    // A single dead process emits both 'exit' and 'error', and every restart
    // attempt reports again. None of those is a new incident.
    await act(async () => {
      liveMocks.listeners.get("sidecar-runtime-changed")?.({
        payload: { ready: false, reason: "crash" },
      });
      liveMocks.listeners.get("sidecar-runtime-changed")?.({
        payload: { ready: false, reason: "unresponsive" },
      });
    });
    expect(result.current.engineNotice).toBeNull();
    // Readiness is still blocked; only the banner was dismissed.
    expect(result.current.productReadiness.dictation.state).toBe("blocked");
  });

  it("raises the banner again for a genuinely new incident", async () => {
    const { result } = renderHook(() => useSetupStatus());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      liveMocks.listeners.get("sidecar-runtime-changed")?.({
        payload: { ready: false, reason: "crash" },
      });
    });
    await act(async () => {
      result.current.dismissEngineNotice();
    });
    expect(result.current.engineNotice).toBeNull();

    // Recovery ends the incident...
    await act(async () => {
      liveMocks.listeners.get("sidecar-runtime-changed")?.({
        payload: { ready: true },
      });
    });
    await waitFor(() => {
      expect(result.current.engineNotice).toBeNull();
    });

    // ...so the next failure is a new one and must be seen.
    await act(async () => {
      liveMocks.listeners.get("sidecar-runtime-changed")?.({
        payload: { ready: false, reason: "spawn_failed" },
      });
    });
    expect(result.current.engineNotice?.title).toBe(
      "The local transcription engine could not start",
    );
  });

  it("lets the reader dismiss the engine notice without pretending it recovered", async () => {
    const { result } = renderHook(() => useSetupStatus());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      liveMocks.listeners.get("sidecar-runtime-changed")?.({
        payload: { ready: false, reason: "spawn_failed" },
      });
    });
    expect(result.current.engineNotice?.recovering).toBe(false);

    await act(async () => {
      result.current.dismissEngineNotice();
    });

    expect(result.current.engineNotice).toBeNull();
    // Dismissing the banner does not make readiness claim the engine is back.
    expect(result.current.productReadiness.dictation.state).toBe("blocked");
  });

  it("does not let a slower older refresh overwrite newer readiness data", async () => {
    let resolveOlderSettings: ((value: Settings) => void) | undefined;
    const olderSettings = new Promise<Settings>((resolve) => {
      resolveOlderSettings = resolve;
    });
    const newerSettings = settings();
    newerSettings.transcription.dictationModelId = "moonshine-tiny";

    liveMocks.getSettings
      .mockImplementationOnce(() => olderSettings)
      .mockResolvedValue(newerSettings);

    const { result } = renderHook(() => useSetupStatus());

    await waitFor(() => {
      expect(liveMocks.listeners.has("settings-changed")).toBe(true);
      expect(liveMocks.getSettings).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      liveMocks.listeners.get("settings-changed")?.({ payload: newerSettings });
    });
    await waitFor(() => {
      expect(result.current.settings?.transcription.dictationModelId).toBe(
        "moonshine-tiny",
      );
    });

    await act(async () => {
      resolveOlderSettings?.(settings());
      await olderSettings;
    });

    expect(result.current.settings?.transcription.dictationModelId).toBe(
      "moonshine-tiny",
    );
  });
});
