import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AsrProviderManager } from "@/components/asr-provider-manager";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  getInventory: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getPermissionDiagnostics: vi.fn(),
  requestAppleSpeechPermission: vi.fn(),
}));

vi.mock("@/lib/electron", () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
  listen: vi.fn(async () => () => {}),
}));

vi.mock("@/lib/backend/asr", () => ({
  refreshAsrRuntimeProbes: vi.fn(async () => {}),
  repairLocalModelCache: vi.fn(async () => ({ repairedCount: 0, removedPaths: [], notes: [] })),
  getAsrProviderInventory: (...args: unknown[]) => mocks.getInventory(...args),
}));

vi.mock("@/lib/backend/settings", () => ({
  getSettings: (...args: unknown[]) => mocks.getSettings(...args),
  updateSettings: (...args: unknown[]) => mocks.updateSettings(...args),
  getPermissionDiagnostics: (...args: unknown[]) => mocks.getPermissionDiagnostics(...args),
  requestAppleSpeechPermission: (...args: unknown[]) =>
    mocks.requestAppleSpeechPermission(...args),
  openPermissionSettings: vi.fn(async () => {}),
  cancelAppleSpeechLanguageInstall: vi.fn(async () => {}),
  installAppleSpeechLanguage: vi.fn(async () => ({ notes: [] })),
  openInstalledPlainsongApp: vi.fn(async () => {}),
  repairCursorInsertPermissions: vi.fn(async () => ({})),
}));

vi.mock("@/lib/asr-benchmark-audio", () => ({
  readAsrBenchmarkAudio: vi.fn(),
}));

const appleSettings = {
  transcription: {
    defaultProvider: "macos_apple_speech",
    selectedModelId: "macos_apple_speech",
    useSharedAsrSelection: true,
    dictationProvider: "macos_apple_speech",
    dictationModelId: "macos_apple_speech",
    meetingProvider: "distil_whisper",
    meetingModelId: "distil-large-v3.5",
    meetingRoutePolicy: "prefer_local",
    platformOptimization: {
      mode: "auto",
      fallbackPolicy: "local_only",
      macos: { appleNativeEnabled: true, mlxEnabled: true },
      windows: { foundryEnabled: false, windowsSdkDictationEnabled: false },
      manualEnginePriority: [],
    },
  },
};

function appleInventory(status: string | null) {
  return [
    {
      providerType: "macos_apple_speech",
      name: "Apple Speech (On-Device)",
      description: "On-device Apple Speech",
      isAvailable: true,
      inferenceEnabled: true,
      selectedModelId: "macos_apple_speech",
      modelOptions: [
        { id: "macos_apple_speech", label: "Apple Speech · on-device dictation" },
      ],
      downloadStatus: "Downloaded",
      platformReadiness:
        status === null
          ? null
          : {
              status,
              ready: status === "authorized",
              platformSupported: true,
              helperPresent: true,
              authorization:
                status === "authorized"
                  ? "authorized"
                  : status === "authorization_denied"
                    ? "denied"
                    : "not_determined",
              locale: "en_US",
              localeSupported: true,
              onDeviceAvailable: status === "authorized",
              recognizerAvailable: status === "authorized",
              message: `Apple Speech status: ${status}`,
              setupAction: status === "authorized" ? null : "Allow Speech Recognition.",
            },
    },
  ];
}

describe("AsrProviderManager Apple Speech permission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue(appleSettings);
    mocks.updateSettings.mockResolvedValue(undefined);
    mocks.getPermissionDiagnostics.mockResolvedValue({
      microphoneReady: true,
      speechRecognitionReady: false,
      accessibilityReady: true,
      accessibilityTrusted: true,
      postEventReady: true,
      automationReady: false,
      notes: [],
    });
    mocks.requestAppleSpeechPermission.mockResolvedValue({});
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "list_asr_benchmarks") return [];
      return null;
    });
  });

  it.each([
    ["unknown", null],
    ["loading", "loading"],
    ["not determined", "authorization_not_determined"],
    ["denied", "authorization_denied"],
    ["authorized", "authorized"],
  ] as const)("keeps %s readiness passive on mount and refresh", async (_label, status) => {
    mocks.getInventory.mockResolvedValue(appleInventory(status));
    render(<AsrProviderManager />);

    expect(await screen.findByText("Apple Speech setup")).toBeInTheDocument();
    expect(mocks.requestAppleSpeechPermission).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getAllByRole("button", { name: "Re-check readiness" })[0],
    );
    await waitFor(() => expect(mocks.getInventory.mock.calls.length).toBeGreaterThan(1));
    expect(mocks.requestAppleSpeechPermission).not.toHaveBeenCalled();
  });

  it("requests permission once only from the explicit control, then refreshes", async () => {
    mocks.getInventory.mockResolvedValue(
      appleInventory("authorization_not_determined"),
    );
    render(<AsrProviderManager />);
    const button = await screen.findByRole("button", {
      name: "Request Apple permissions",
    });
    const inventoryCallsBefore = mocks.getInventory.mock.calls.length;
    const diagnosticCallsBefore = mocks.getPermissionDiagnostics.mock.calls.length;

    fireEvent.click(button);

    await waitFor(() =>
      expect(mocks.requestAppleSpeechPermission).toHaveBeenCalledTimes(1),
    );
    await waitFor(() =>
      expect(mocks.getInventory.mock.calls.length).toBeGreaterThan(
        inventoryCallsBefore,
      ),
    );
    expect(mocks.getPermissionDiagnostics.mock.calls.length).toBeGreaterThan(
      diagnosticCallsBefore,
    );
  });
});
