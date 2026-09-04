import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FirstRunWizard } from "@/components/first-run-wizard";
import { PERMISSION_GATES } from "@/features/onboarding/permission-gates";

/**
 * The permissions step, judged on the thing that failed the reader: they
 * installed the DMG, never saw this screen, and had to go and find every macOS
 * switch themselves.
 *
 * So each row owes them four things, and each is asserted here: what Plainsong
 * does with the grant, what stops working without it, whether it is on right
 * now, and a button to the exact pane. Plus the two claims that must never be
 * made — that an optional feature is required, or that a grant Plainsong
 * cannot read is denied.
 */

vi.mock("@/lib/electron", () => ({
  invoke: vi.fn(async () => null),
  listen: vi.fn(async () => () => {}),
}));

vi.mock("@/lib/backend/asr", () => ({
  downloadAsrModels: vi.fn(async () => {}),
  getAsrProviders: vi.fn(async () => []),
}));

vi.mock("@/lib/backend/ai", () => ({
  getOllamaStatus: vi.fn(async () => true),
}));

vi.mock("@/lib/backend/dictation", () => ({
  startDictation: vi.fn(async () => {}),
  stopDictation: vi.fn(async () => ""),
}));

vi.mock("@/lib/backend/recordings", () => ({
  getSystemAudioCapability: vi.fn(async () => ({
    backend: "none",
    nativeOsSupported: false,
    nativeOsEnabled: false,
    routeDevice: null,
    routeId: null,
    nativeSampleRate: null,
    nativeChannels: null,
    readiness: "unavailable",
    ready: false,
    reason: null,
    actionableReason: null,
  })),
  testSystemAudioCapture: vi.fn(async () => ({})),
}));

vi.mock("@/lib/backend/calendar", () => ({
  getCalendarSnapshot: vi.fn(async () => ({
    authorization: "not_determined" as const,
    observedAt: 0,
    events: [],
    calendars: [],
    errorCode: null,
  })),
  openCalendarPrivacySettings: vi.fn(async () => {}),
}));

const settings = {
  audio: {},
  transcription: {
    defaultProvider: "whisper",
    selectedModelId: "base.en",
    useSharedAsrSelection: true,
    dictationProvider: "whisper",
    dictationModelId: "base.en",
    meetingProvider: "whisper",
    meetingModelId: "base.en",
    providerModelIds: {},
    dictationAutoRequestPermissions: true,
    dictationPushToTalk: false,
    dictationHandsFreeEnabled: false,
  },
  ui: { colorScheme: "default" },
  export: {},
  privacy: {
    remoteProcessingEnabled: false,
    dictationAi: { provider: "ollama", modelId: null },
    meetingsAi: { provider: "ollama", modelId: null },
  },
  shortcuts: { toggleDictation: "Cmd+Shift+Space", openWindow: "Ctrl+Shift+N" },
  updates: { channel: "stable", autoCheck: true },
  theme: "system",
};

vi.mock("@/lib/backend/settings", () => ({
  recordOnboardingState: vi.fn(async () => ({})),
  getPermissionDiagnostics: vi.fn(async () => ({
    microphoneReady: true,
    microphonePermissionReady: true,
    speechRecognitionReady: false,
    accessibilityReady: false,
    postEventReady: false,
    automationReady: false,
    notes: [],
    runningFromDiskImage: false,
  })),
  getSettings: vi.fn(async () => structuredClone(settings)),
  openInstalledPlainsongApp: vi.fn(async () => {}),
  openPermissionSettings: vi.fn(async () => {}),
  requestDictationPermissions: vi.fn(async () => ({})),
  saveSettings: vi.fn(async () => {}),
  verifyMeetingSetup: vi.fn(async () => ({
    ok: true,
    title: "",
    summary: "",
    details: [],
  })),
}));

describe("first-run permissions step", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("states, for every permission, what it is for and what stops working without it", async () => {
    render(<FirstRunWizard mode="dictation" onComplete={vi.fn()} />);

    await screen.findByText("Microphone");

    for (const gate of PERMISSION_GATES) {
      expect(screen.getByText(gate.label)).toBeInTheDocument();
      expect(screen.getByText(gate.purpose)).toBeInTheDocument();
      expect(screen.getByText(gate.consequence)).toBeInTheDocument();
    }
  });

  it("covers the six macOS grants Plainsong asks for, plus the keyboard fallback", () => {
    expect(PERMISSION_GATES.map((gate) => gate.key)).toEqual([
      "microphone",
      "accessibility",
      "keyboard_fallback",
      "system_audio",
      "speech",
      "calendar",
      "notifications",
    ]);
  });

  it("shows live state per row and a button to that exact pane", async () => {
    render(<FirstRunWizard mode="dictation" onComplete={vi.fn()} />);

    // Granted, so no fix button: nothing to send the reader off to do.
    await waitFor(() => {
      expect(screen.getAllByText("Granted").length).toBeGreaterThan(0);
    });
    expect(
      screen.queryByRole("button", {
        name: "Open macOS Microphone settings for Microphone",
      }),
    ).not.toBeInTheDocument();

    // Required and missing: named as still needed, with the pane to fix it.
    expect(screen.getAllByText("Still needed").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", {
        name: "Open macOS Accessibility settings for Accessibility",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Open macOS Calendars settings for Calendar",
      }),
    ).toBeInTheDocument();
  });

  it("never calls an optional grant a requirement", async () => {
    render(<FirstRunWizard mode="dictation" onComplete={vi.fn()} />);

    await screen.findByText("Screen & System Audio");
    const optional = PERMISSION_GATES.filter((gate) => gate.optional);
    expect(optional.map((gate) => gate.key)).toEqual([
      "system_audio",
      "speech",
      "calendar",
      "notifications",
    ]);
    // Every one of them is off in this fixture, and none of them says so in
    // the words used for a missing requirement.
    expect(screen.getAllByText("Optional")).toHaveLength(optional.length);
    expect(screen.getAllByText("Not granted").length).toBeGreaterThan(0);
  });

  it("says plainly that it cannot read the notifications grant instead of guessing", async () => {
    render(<FirstRunWizard mode="dictation" onComplete={vi.fn()} />);

    await screen.findByText("Notifications");
    expect(screen.getByText("Plainsong cannot read this one")).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Open macOS Notifications settings for Notifications",
      }),
    ).toBeInTheDocument();
  });

  it("re-checks every grant when the window comes back from System Settings", async () => {
    const backend = await import("@/lib/backend/settings");
    const calendar = await import("@/lib/backend/calendar");
    render(<FirstRunWizard mode="dictation" onComplete={vi.fn()} />);

    await waitFor(() => {
      expect(backend.getPermissionDiagnostics).toHaveBeenCalledTimes(1);
    });

    vi.mocked(backend.getPermissionDiagnostics).mockResolvedValueOnce({
      microphoneReady: true,
      microphonePermissionReady: true,
      speechRecognitionReady: false,
      accessibilityReady: true,
      postEventReady: true,
      automationReady: false,
      notes: [],
      runningFromDiskImage: false,
    });
    window.dispatchEvent(new Event("focus"));

    await waitFor(() => {
      expect(backend.getPermissionDiagnostics).toHaveBeenCalledTimes(2);
      expect(calendar.getCalendarSnapshot).toHaveBeenCalledTimes(2);
    });
    // The row the reader just switched on catches up without a relaunch.
    await waitFor(() => {
      expect(
        screen.queryByRole("button", {
          name: "Open macOS Accessibility settings for Accessibility",
        }),
      ).not.toBeInTheDocument();
    });
  });
});
