import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSetupStatus } from "@/hooks/use-setup-status";
import type { Settings } from "@/types/settings";

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  invoke: vi.fn(),
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
  invoke: mocks.invoke,
  listen: vi.fn(async (eventName: string, handler: (event: { payload: unknown }) => void) => {
    mocks.listeners.set(eventName, handler);
    return () => mocks.listeners.delete(eventName);
  }),
}));

vi.mock("@/lib/backend/asr", () => ({
  getAsrProviders: mocks.getAsrProviders,
  listDownloadedModels: mocks.listDownloadedModels,
}));
vi.mock("@/lib/backend/settings", () => ({
  getSettings: mocks.getSettings,
  getPermissionDiagnostics: mocks.getPermissionDiagnostics,
  hasProviderSecret: mocks.hasProviderSecret,
}));
vi.mock("@/lib/backend/ai", () => ({
  getOllamaStatus: mocks.getOllamaStatus,
  listOllamaModels: mocks.listOllamaModels,
  listOllamaModelCatalog: mocks.listOllamaModelCatalog,
  getLocalTextRuntimeHealth: mocks.getLocalTextRuntimeHealth,
}));
vi.mock("@/lib/backend/recordings", () => ({
  getSystemAudioCapability: mocks.getSystemAudioCapability,
}));

const settings = { transcription: { useSharedAsrSelection: false } } as Settings;

describe("useSetupStatus runtime snapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listeners.clear();
    mocks.getSettings.mockResolvedValue(settings);
    mocks.getAsrProviders.mockResolvedValue([]);
    mocks.listDownloadedModels.mockResolvedValue([]);
    mocks.getPermissionDiagnostics.mockResolvedValue(null);
    mocks.getSystemAudioCapability.mockResolvedValue(null);
    mocks.hasProviderSecret.mockResolvedValue(false);
    mocks.getOllamaStatus.mockResolvedValue(false);
    mocks.listOllamaModels.mockResolvedValue([]);
    mocks.listOllamaModelCatalog.mockResolvedValue([]);
    mocks.getLocalTextRuntimeHealth.mockResolvedValue(null);
  });

  it("shows a cached credential notice when startup failure happened before mount", async () => {
    mocks.invoke.mockResolvedValue({ ready: false, reason: "credential_required" });

    const { result, unmount } = renderHook(() => useSetupStatus());

    await waitFor(() => expect(result.current.engineNotice?.action).toBe("unlock_credentials"));
    expect(result.current.engineNotice?.title).toBe("Secure storage needs your approval");
    expect(mocks.invoke).toHaveBeenCalledWith("get_sidecar_runtime_status");
    unmount();
  });

  it("does not let a stale cached failure override a newer live ready event", async () => {
    let resolveSnapshot!: (value: unknown) => void;
    mocks.invoke.mockReturnValue(new Promise((resolve) => { resolveSnapshot = resolve; }));
    const { result, unmount } = renderHook(() => useSetupStatus());

    await waitFor(() => expect(mocks.listeners.has("sidecar-runtime-changed")).toBe(true));
    await act(async () => {
      mocks.listeners.get("sidecar-runtime-changed")?.({ payload: { ready: true } });
    });
    await act(async () => {
      resolveSnapshot({ ready: false, reason: "credential_required" });
    });

    await waitFor(() => expect(result.current.engineNotice).toBeNull());
    expect(result.current.error).toBeNull();
    unmount();
  });
});
