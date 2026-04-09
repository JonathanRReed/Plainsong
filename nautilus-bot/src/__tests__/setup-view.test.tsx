import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SetupView } from "@/components/views/setup-view";

const setupStatusMock = vi.hoisted(() => ({
  loading: false,
  error: null as string | null,
  refresh: vi.fn(async () => {}),
  settings: {
    transcription: {
      dictationInsertionMode: "auto",
    },
  },
  permissions: {
    microphoneReady: true,
    speechRecognitionReady: true,
    accessibilityReady: true,
    cursorInsertionReady: true,
    automationReady: true,
    notes: [],
  },
  systemAudioAvailable: false,
  loopbackDevice: null as string | null,
  meetingCaptureMode: "mic_only" as "me_and_them" | "mic_only" | "unknown",
  dictationRoutePreference: "local" as "local" | "cloud",
  dictationLocalReady: true,
  dictationCloudReady: false,
  meetingRoutePolicy: "prefer_local" as "prefer_local" | "best_available",
  dictationRoute: {
    providerType: "distil_whisper",
    modelId: "distil-large-v3",
    provider: null,
    summary: "Distil Whisper · Large V3",
    ready: true,
    reason: null as string | null,
  },
  meetingRoute: {
    providerType: "parakeet",
    modelId: "parakeet-ctc-0.6b",
    provider: null,
    summary: "Parakeet · CTC 0.6B",
    ready: false,
    reason: "Meetings need a meeting-grade ASR route.",
  },
  dictationReady: true,
  meetingReady: false,
  dictationBlockers: [] as string[],
  meetingBlockers: [
    "System audio capture is not available yet.",
    "No loopback device was detected for meeting capture.",
  ],
  providers: [
    {
      providerType: "parakeet",
      name: "Parakeet",
      description: "Fast local ONNX",
      isAvailable: true,
      inferenceEnabled: true,
      modelInfo: {
        name: "Parakeet",
        version: "1",
        sizeMb: 120,
        parameters: "110M",
        languages: ["en"],
        license: "NVIDIA",
        sourceUrl: "https://example.com/parakeet",
      },
      selectedModelId: "parakeet-ctc-0.6b",
      modelOptions: [{ id: "parakeet-ctc-0.6b", label: "CTC 0.6B" }],
      downloadStatus: "NotDownloaded",
      runtimeStatus: "missing_model",
      runtimeMessage: "Parakeet model not downloaded.",
      runtimeDetails: {
        missingFiles: ["manifest.json"],
        setupAction: "Download the selected Parakeet model bundle.",
      },
    },
    {
      providerType: "distil_whisper",
      name: "Distil Whisper",
      description: "Meeting-grade",
      isAvailable: true,
      inferenceEnabled: true,
      modelInfo: {
        name: "Distil Whisper",
        version: "1",
        sizeMb: 756,
        parameters: "large-v3-distilled",
        languages: ["en"],
        license: "MIT",
        sourceUrl: "https://example.com/distil",
      },
      selectedModelId: "distil-large-v3",
      modelOptions: [{ id: "distil-large-v3", label: "Large V3" }],
      downloadStatus: "Downloaded",
      runtimeStatus: "ready",
      runtimeMessage: "Distil Whisper ready.",
      runtimeDetails: {},
    },
  ],
}));

const backendMocks = vi.hoisted(() => ({
  downloadAsrModels: vi.fn(async () => {}),
  openPermissionSettings: vi.fn(async () => {}),
  refreshAsrRuntimeProbes: vi.fn(async () => {}),
  repairCursorInsertPermissions: vi.fn(async () => {}),
  repairLocalModelCache: vi.fn(async () => ({ repairedCount: 0, removedPaths: [], notes: [] })),
  requestDictationPermissions: vi.fn(async () => {}),
  smokeTestCursorInsert: vi.fn(async () => ({
    text: "Nautilus insert test",
    targetApp: "Notes",
    pasted: true,
    copied: false,
    error: null,
  })),
  verifyDictationSetup: vi.fn(async () => ({
    ok: true,
    title: "Dictation verification",
    summary: "Dictation is ready.",
    details: ["Microphone ready.", "Cursor insert ready."],
  })),
  verifyMeetingSetup: vi.fn(async () => ({
    ok: false,
    title: "Meeting verification",
    summary: "Meeting route is partial.",
    details: ["System audio is not available."],
  })),
  verifySystemAudioSetup: vi.fn(async () => ({
    ok: false,
    title: "System audio verification",
    summary: "System audio capture is not ready yet.",
    details: ["No loopback device detected."],
  })),
}));

const onboardingMocks = vi.hoisted(() => ({
  requestOnboarding: vi.fn(),
}));

const navigationMocks = vi.hoisted(() => ({
  requestMainView: vi.fn(),
}));

vi.mock("@/hooks/use-setup-status", () => ({
  useSetupStatus: () => setupStatusMock,
}));

vi.mock("@/lib/backend", () => backendMocks);
vi.mock("@/lib/onboarding", () => onboardingMocks);
vi.mock("@/lib/navigation", () => navigationMocks);

describe("SetupView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupStatusMock.loading = false;
    setupStatusMock.error = null;
    setupStatusMock.settings = {
      transcription: {
        dictationInsertionMode: "auto",
      },
    };
    setupStatusMock.permissions = {
      microphoneReady: true,
      speechRecognitionReady: true,
      accessibilityReady: true,
      cursorInsertionReady: true,
      automationReady: true,
      notes: [],
    };
    setupStatusMock.systemAudioAvailable = false;
    setupStatusMock.loopbackDevice = null;
    setupStatusMock.meetingCaptureMode = "mic_only";
    setupStatusMock.dictationRoutePreference = "local";
    setupStatusMock.dictationLocalReady = true;
    setupStatusMock.dictationCloudReady = false;
    setupStatusMock.meetingRoutePolicy = "prefer_local";
    setupStatusMock.meetingReady = false;
    setupStatusMock.dictationBlockers = [];
    setupStatusMock.meetingBlockers = [
      "System audio capture is not available yet.",
      "No loopback device was detected for meeting capture.",
    ];
  });

  it("surfaces guided setup actions in a permanent setup workspace", async () => {
    render(<SetupView />);

    expect(screen.getByText("Guided setup and repairs")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rerun onboarding" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Fix dictation setup" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Set up meetings" }).length).toBeGreaterThan(0);
    expect(screen.getByText(/every route's runtime state/i)).toBeInTheDocument();
  });

  it("downloads a missing provider model and refreshes runtime probes", async () => {
    render(<SetupView />);

    fireEvent.click(screen.getAllByRole("button", { name: "Download" })[0]);

    await waitFor(() => {
      expect(backendMocks.downloadAsrModels).toHaveBeenCalledWith("parakeet");
      expect(backendMocks.refreshAsrRuntimeProbes).toHaveBeenCalled();
      expect(setupStatusMock.refresh).toHaveBeenCalled();
    });
  });

  it("shows the active meeting routing policy", async () => {
    setupStatusMock.meetingRoutePolicy = "best_available";

    render(<SetupView />);

    expect(screen.getByText("Meeting policy")).toBeInTheDocument();
    expect(screen.getByText("Best available")).toBeInTheDocument();
  });

  it("shows meeting capture mode and current blockers", async () => {
    render(<SetupView />);

    expect(screen.getByText("Meeting capture mode")).toBeInTheDocument();
    expect(screen.getByText("Mic only")).toBeInTheDocument();
    expect(
      screen.getByText(/Only microphone capture is ready/i)
    ).toBeInTheDocument();
    expect(screen.getAllByText("Current blockers").length).toBeGreaterThan(0);
  });

  it("runs setup verification checks from the doctor actions", async () => {
    render(<SetupView />);

    fireEvent.click(screen.getByRole("button", { name: "Test dictation" }));

    await waitFor(() => {
      expect(backendMocks.verifyDictationSetup).toHaveBeenCalled();
      expect(
        screen.getByText(/Dictation verification: Dictation is ready/i)
      ).toBeInTheDocument();
    });
  });

  it("runs the insert-permission smoke test from setup", async () => {
    render(<SetupView />);

    fireEvent.click(screen.getByRole("button", { name: "Test insert permissions" }));

    await waitFor(() => {
      expect(backendMocks.smokeTestCursorInsert).toHaveBeenCalledWith("Nautilus insert test");
      expect(
        screen.getByText(/Insert permissions test: Sent a test insert to Notes/i)
      ).toBeInTheDocument();
    });
  });

  it("runs permission repair actions from setup", async () => {
    render(<SetupView />);

    fireEvent.click(screen.getByRole("button", { name: "Request permissions" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Accessibility" }));

    await waitFor(() => {
      expect(backendMocks.requestDictationPermissions).toHaveBeenCalledTimes(1);
      expect(backendMocks.openPermissionSettings).toHaveBeenCalledWith("accessibility");
    });
  });

  it("shows cursor insert as not needed in clipboard-only mode", () => {
    setupStatusMock.settings = {
      transcription: {
        dictationInsertionMode: "clipboard_only",
      },
    };
    setupStatusMock.permissions = {
      microphoneReady: true,
      speechRecognitionReady: true,
      accessibilityReady: false,
      cursorInsertionReady: false,
      automationReady: false,
      notes: [],
    };

    render(<SetupView />);

    expect(screen.getByText("Cursor insert")).toBeInTheDocument();
    expect(screen.getByText("Not needed")).toBeInTheDocument();
  });

  it("shows keyboard fallback when direct accessibility is unavailable", () => {
    setupStatusMock.permissions = {
      microphoneReady: true,
      speechRecognitionReady: true,
      accessibilityReady: false,
      cursorInsertionReady: true,
      automationReady: false,
      notes: [],
    };

    render(<SetupView />);

    expect(screen.getByText("Keyboard fallback")).toBeInTheDocument();
  });
});
