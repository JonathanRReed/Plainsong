import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSetupStatus } from "@/hooks/use-setup-status";
import type { Settings } from "@/types/settings";

const liveMocks = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  getSettings: vi.fn(),
  getAsrProviders: vi.fn(),
  listDownloadedModels: vi.fn(),
  getPermissionDiagnostics: vi.fn(),
  getSystemAudioCapability: vi.fn(),
  hasProviderSecret: vi.fn(),
  getOllamaStatus: vi.fn(),
}));

vi.mock("@/lib/electron", () => ({
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
    liveMocks.getSettings.mockResolvedValue(settings());
    liveMocks.getAsrProviders.mockResolvedValue([]);
    liveMocks.listDownloadedModels.mockResolvedValue([]);
    liveMocks.getPermissionDiagnostics.mockResolvedValue(null);
    liveMocks.getSystemAudioCapability.mockResolvedValue(null);
    liveMocks.hasProviderSecret.mockResolvedValue(false);
    liveMocks.getOllamaStatus.mockResolvedValue(true);
  });

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
