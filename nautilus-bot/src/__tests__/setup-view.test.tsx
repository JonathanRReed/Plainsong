import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SetupView } from "@/components/views/setup-view";
import type { ProductReadinessSnapshot } from "@/features/readiness/product-readiness";

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
    microphonePermissionReady: true,
    speechRecognitionReady: true,
    accessibilityReady: true,
    cursorInsertionReady: true,
    automationReady: true,
    notes: [],
  },
  microphoneReady: true,
  systemAudioAvailable: false,
  loopbackDevice: null as string | null,
  systemAudioCapability: {
    backend: "none",
    nativeOsSupported: true,
    nativeOsEnabled: true,
    routeDevice: null,
    routeId: null,
    nativeSampleRate: null,
    nativeChannels: null,
    readiness: "unavailable",
    ready: false,
    reason: "no_eligible_route",
    actionableReason: "Start in Mic only mode or configure a system-audio route.",
  } as any,
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
    reason: "Meetings need a meeting-grade ASR route." as string | null,
  },
  dictationReady: true,
  meetingReady: false,
  fullCaptureReady: false,
  dictationBlockers: [] as string[],
  meetingBlockers: ["Meetings need a meeting-grade ASR route."],
  fullCaptureBlockers: [
    "Start in Mic only mode or configure a system-audio route.",
  ],
  productReadiness: {
    evidenceObservedAt: 1,
    dictation: { domain: "dictation", state: "ready", cause: null },
    meetings: {
      domain: "meetings",
      state: "blocked",
      cause: {
        id: "meeting_route",
        message: "Meetings need a meeting-grade ASR route.",
        action: {
          id: "open_models",
          label: "Review models",
          destination: "models",
        },
      },
    },
    fullCapture: {
      domain: "full_capture",
      state: "blocked",
      cause: {
        id: "meeting_route",
        message: "Meetings need a meeting-grade ASR route.",
        action: {
          id: "open_models",
          label: "Review models",
          destination: "models",
        },
      },
    },
    overall: {
      domain: "overall",
      state: "blocked",
      cause: {
        id: "meeting_route",
        message: "Meetings need a meeting-grade ASR route.",
        action: {
          id: "open_models",
          label: "Review models",
          destination: "models",
        },
      },
    },
  } as ProductReadinessSnapshot,
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
      selectedModelId: "parakeet-tdt-0.6b-v3",
      modelOptions: [{ id: "parakeet-tdt-0.6b-v3", label: "TDT 0.6B v3" }],
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
  ] as any[],
}));

const backendMocks = vi.hoisted(() => ({
  downloadAsrModels: vi.fn(async () => {}),
  openPermissionSettings: vi.fn(async () => {}),
  refreshAsrRuntimeProbes: vi.fn(async () => {}),
  repairCursorInsertPermissions: vi.fn(async () => {}),
  repairLocalModelCache: vi.fn(async () => ({ repairedCount: 0, removedPaths: [], notes: [] })),
  requestAppleSpeechPermission: vi.fn(async () => {}),
  requestDictationPermissions: vi.fn(async () => {}),
  testSystemAudioCapture: vi.fn(async () => ({
    capability: {
      backend: "core_audio_process_tap",
      nativeOsSupported: true,
      nativeOsEnabled: true,
      routeDevice: "MacBook Pro Speakers",
      routeId: "coreaudio:BuiltInSpeakerDevice",
      nativeSampleRate: 48000,
      nativeChannels: 2,
      readiness: "ready",
      ready: true,
      reason: null,
      actionableReason: null,
    },
    callbacks: 10,
    capturedFrames: 48000,
    nonSilentFrames: 12000,
    peak: 0.1,
    expectedToneHz: 997,
    detectedToneAmplitude: 0.05,
    verificationMethod: "known_tone",
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

vi.mock("@/features/readiness/product-readiness-context", () => ({
  useProductReadinessStatus: () => setupStatusMock,
}));

vi.mock("@/lib/backend/asr", () => ({
  downloadAsrModels: backendMocks.downloadAsrModels,
  refreshAsrRuntimeProbes: backendMocks.refreshAsrRuntimeProbes,
  repairLocalModelCache: backendMocks.repairLocalModelCache,
}));
vi.mock("@/lib/backend/recordings", () => ({
  testSystemAudioCapture: backendMocks.testSystemAudioCapture,
}));
vi.mock("@/lib/backend/settings", () => ({
  openPermissionSettings: backendMocks.openPermissionSettings,
  repairCursorInsertPermissions: backendMocks.repairCursorInsertPermissions,
  requestAppleSpeechPermission: backendMocks.requestAppleSpeechPermission,
  requestDictationPermissions: backendMocks.requestDictationPermissions,
  verifyDictationSetup: backendMocks.verifyDictationSetup,
  verifyMeetingSetup: backendMocks.verifyMeetingSetup,
  verifySystemAudioSetup: backendMocks.verifySystemAudioSetup,
}));
vi.mock("@/lib/onboarding", () => onboardingMocks);
vi.mock("@/lib/navigation", () => navigationMocks);

describe("SetupView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupStatusMock.providers = setupStatusMock.providers.filter(
      (provider) => provider.providerType !== "macos_apple_speech",
    );
    setupStatusMock.loading = false;
    setupStatusMock.error = null;
    setupStatusMock.settings = {
      transcription: {
        dictationInsertionMode: "auto",
      },
    };
    setupStatusMock.permissions = {
      microphoneReady: true,
      microphonePermissionReady: true,
      speechRecognitionReady: true,
      accessibilityReady: true,
      cursorInsertionReady: true,
      automationReady: true,
      notes: [],
    };
    setupStatusMock.microphoneReady = true;
    setupStatusMock.systemAudioAvailable = false;
    setupStatusMock.loopbackDevice = null;
    setupStatusMock.systemAudioCapability = {
      backend: "none",
      nativeOsSupported: true,
      nativeOsEnabled: true,
      routeDevice: null,
      routeId: null,
      nativeSampleRate: null,
      nativeChannels: null,
      readiness: "unavailable",
      ready: false,
      reason: "no_eligible_route",
      actionableReason: "Start in Mic only mode or configure a system-audio route.",
    };
    setupStatusMock.meetingCaptureMode = "mic_only";
    setupStatusMock.dictationRoutePreference = "local";
    setupStatusMock.dictationLocalReady = true;
    setupStatusMock.dictationCloudReady = false;
    setupStatusMock.meetingRoutePolicy = "prefer_local";
    setupStatusMock.meetingRoute = {
      providerType: "parakeet",
      modelId: "parakeet-ctc-0.6b",
      provider: null,
      summary: "Parakeet · CTC 0.6B",
      ready: false,
      reason: "Meetings need a meeting-grade ASR route." as string | null,
    };
    setupStatusMock.meetingReady = false;
    setupStatusMock.fullCaptureReady = false;
    setupStatusMock.dictationBlockers = [];
    setupStatusMock.meetingBlockers = [
      "Meetings need a meeting-grade ASR route.",
    ];
    setupStatusMock.fullCaptureBlockers = [
      "Start in Mic only mode or configure a system-audio route.",
    ];
    setupStatusMock.productReadiness = {
      evidenceObservedAt: 1,
      dictation: { domain: "dictation", state: "ready", cause: null },
      meetings: {
        domain: "meetings",
        state: "blocked",
        cause: {
          id: "meeting_route",
          message: "Meetings need a meeting-grade ASR route.",
          action: {
            id: "open_models",
            label: "Review models",
            destination: "models",
          },
        },
      },
      meetingsCapture: {
        domain: "meetings_capture",
        state: "blocked",
        cause: {
          id: "meeting_route",
          message: "Meetings need a meeting-grade ASR route.",
          action: {
            id: "open_models",
            label: "Review models",
            destination: "models",
          },
        },
      },
      fullCapture: {
        domain: "full_capture",
        state: "blocked",
        cause: {
          id: "meeting_route",
          message: "Meetings need a meeting-grade ASR route.",
          action: {
            id: "open_models",
            label: "Review models",
            destination: "models",
          },
        },
      },
      overall: {
        domain: "overall",
        state: "blocked",
        cause: {
          id: "meeting_route",
          message: "Meetings need a meeting-grade ASR route.",
          action: {
            id: "open_models",
            label: "Review models",
            destination: "models",
          },
        },
      },
    };
  });

  it("surfaces guided setup actions in a permanent setup workspace", async () => {
    render(<SetupView />);

    expect(screen.getByText("Guided setup and repairs")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rerun onboarding" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Fix dictation setup" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Set up meetings" }).length).toBeGreaterThan(0);
    expect(screen.getByText(/every route's runtime state/i)).toBeInTheDocument();
    expect(screen.getByText(/Permission and insert tests may open macOS settings/i)).toBeInTheDocument();
  });

  it("uses the canonical snapshot when legacy readiness booleans disagree", () => {
    setupStatusMock.dictationReady = true;
    setupStatusMock.productReadiness.dictation = {
      domain: "dictation",
      state: "blocked",
      cause: {
        id: "dictation_route",
        message: "Download the selected dictation model.",
        action: {
          id: "open_models",
          label: "Review models",
          destination: "models",
        },
      },
    };

    render(<SetupView />);

    expect(
      screen.getByText("Download the selected dictation model."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        "Dictation is ready. If it stops working, run the checks below.",
      ),
    ).not.toBeInTheDocument();
  });

  it("offers Apple Speech permission recovery without making the route look ready", async () => {
    setupStatusMock.providers.push({
      ...setupStatusMock.providers[1],
      providerType: "macos_apple_speech",
      name: "Apple Speech (On-Device)",
      description: "Dictation-only on-device route",
      isAvailable: false,
      selectedModelId: "macos_apple_speech",
      modelOptions: [
        { id: "macos_apple_speech", label: "Apple Speech · on-device dictation" },
      ],
      runtimeStatus: "error",
      runtimeMessage: "Speech Recognition permission has not been decided.",
      platformReadiness: {
        status: "authorization_not_determined",
        ready: false,
        platformSupported: true,
        helperPresent: true,
        authorization: "not_determined",
        locale: "en_US",
        localeSupported: true,
        onDeviceAvailable: true,
        recognizerAvailable: true,
        message: "Speech Recognition permission has not been decided.",
        setupAction: "Request Speech Recognition permission.",
      },
    });

    render(<SetupView />);

    expect(screen.getByText("Permission required")).toBeInTheDocument();
    expect(screen.getByText(/server fallback is disabled/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Request permission" }));

    await waitFor(() => {
      expect(backendMocks.requestAppleSpeechPermission).toHaveBeenCalledTimes(1);
      expect(setupStatusMock.refresh).toHaveBeenCalled();
    });
  });

  it("downloads a missing provider model and refreshes runtime probes", async () => {
    render(<SetupView />);

    fireEvent.click(screen.getAllByRole("button", { name: "Download" })[0]);

    await waitFor(() => {
      expect(backendMocks.downloadAsrModels).toHaveBeenCalledWith(
        "parakeet",
        "parakeet-tdt-0.6b-v3"
      );
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

  it("shows mic-only readiness without claiming Me + Them is verified", async () => {
    setupStatusMock.meetingRoute = {
      ...setupStatusMock.meetingRoute,
      ready: true,
      reason: null,
    };
    setupStatusMock.meetingReady = true;
    setupStatusMock.meetingBlockers = [];
    setupStatusMock.productReadiness.meetings = {
      domain: "meetings",
      state: "ready",
      cause: null,
    };
    setupStatusMock.productReadiness.meetingsCapture = {
      domain: "meetings_capture",
      state: "ready",
      cause: null,
    };
    setupStatusMock.productReadiness.fullCapture = {
      domain: "full_capture",
      state: "degraded",
      cause: {
        id: "system_audio_unavailable",
        message: "Mic-only meetings are ready, but system audio is not configured.",
        action: {
          id: "configure_system_audio",
          label: "Set up system audio",
          destination: "transcription",
        },
      },
    };
    setupStatusMock.productReadiness.overall = {
      domain: "overall",
      state: "degraded",
      cause: setupStatusMock.productReadiness.fullCapture.cause,
    };

    render(<SetupView />);

    expect(screen.getByText("Meeting capture mode")).toBeInTheDocument();
    expect(screen.getByText("Mic only ready")).toBeInTheDocument();
    expect(screen.getAllByText(/Mic-only meetings are ready/i)).toHaveLength(2);
    expect(screen.getByText("Me + Them not verified")).toBeInTheDocument();
    expect(screen.queryByText("Me + Them verified")).not.toBeInTheDocument();
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

  it("runs the signal-based system audio test from setup", async () => {
    setupStatusMock.systemAudioAvailable = true;
    setupStatusMock.systemAudioCapability = {
      ...setupStatusMock.systemAudioCapability,
      backend: "core_audio_process_tap",
      routeDevice: "MacBook Pro Speakers",
      routeId: "coreaudio:BuiltInSpeakerDevice",
      readiness: "unverified",
      reason: null,
      actionableReason: "Run Test system audio.",
    };

    render(<SetupView />);

    fireEvent.click(screen.getByRole("button", { name: "Open privacy settings" }));
    expect(backendMocks.openPermissionSettings).toHaveBeenCalledWith("system_audio");

    fireEvent.click(screen.getByRole("button", { name: "Test system audio" }));

    await waitFor(() => {
      expect(backendMocks.testSystemAudioCapture).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/System audio test: Verified/i)).toBeInTheDocument();
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
      microphonePermissionReady: true,
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
      microphonePermissionReady: true,
      speechRecognitionReady: true,
      accessibilityReady: false,
      cursorInsertionReady: true,
      automationReady: false,
      notes: [],
    };

    render(<SetupView />);

    expect(screen.getByText("Keyboard fallback")).toBeInTheDocument();
  });

  it("does not mark speech permission ready before diagnostics load", () => {
    setupStatusMock.loading = true;
    setupStatusMock.permissions = null as never;

    render(<SetupView />);

    expect(screen.getByText("Apple Speech permission")).toBeInTheDocument();
    expect(screen.getAllByText("Checking").length).toBeGreaterThan(0);
  });
});
