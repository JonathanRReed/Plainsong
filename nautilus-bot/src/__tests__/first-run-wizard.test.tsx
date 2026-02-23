import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { FirstRunWizard } from "@/components/first-run-wizard";

const baseSettings = {
  audio: {
    sampleRate: 16000,
    channels: 1,
    captureSystemAudio: true,
    captureMicrophone: true,
    noiseSuppression: true,
    voiceActivityDetection: true,
    silenceTimeoutSeconds: 3,
    autoGainControl: true,
    manualGainDb: 0,
  },
  transcription: {
    defaultProvider: "whisper",
    selectedModelId: "base.en",
    providerModelIds: {},
    autoTranscribe: true,
    enableDiarization: true,
    intelligentPunctuation: true,
    language: null,
    numSpeakers: 0,
    speakerNamingMethod: "auto" as const,
    diarizationModelId: "ecapa_tdnn_speaker",
    silenceSkipEnabled: false,
    dictationPasteToCursor: true,
    dictationCopyToClipboard: true,
    dictationPushToTalk: true,
    dictationAiFormatting: false,
    dictationCustomPrompt: null,
    meetingCustomPrompt: null,
    meetingAutoNameEnabled: true,
    meetingAutoNameModel: null,
    saveRawTranscript: false,
    dictationSaveToInbox: true,
    dictationProfile: "speed" as const,
    dictationProjectId: "inbox",
    dictationRetentionPreset: "never" as const,
    dictationRetentionCustomHours: 24,
    meetingAudioStorageMode: "always" as const,
    meetingRetentionPreset: "never" as const,
    meetingRetentionCustomMonths: 1,
    meetingRetentionDeleteMode: "audio_only" as const,
    dictationSilenceTimeoutSeconds: 0,
    memorySearchMode: "fts" as const,
    embeddingModel: "nomic-embed-text",
    enableAutoAnalysis: true,
  },
  ui: {
    alwaysOnTop: false,
    showInDock: true,
    minimizeToTray: true,
    startMinimized: false,
    windowPosition: null,
    windowSize: null,
    fontSize: 14,
    showDictationPopup: true,
    showRecordingPopup: true,
    colorScheme: "default",
  },
  export: {
    defaultFormat: "markdown",
    autoExport: false,
    exportDirectory: null,
    includeTimestamps: true,
    includeSpeakers: true,
    openAfterExport: false,
  },
  privacy: {
    encryptRecordings: false,
    autoDeleteDays: 0,
    requirePassword: false,
    auditLogging: true,
    cloudSync: false,
    remoteProcessingEnabled: false,
    llmProvider: "ollama",
    llmModelId: null,
    exportRoot: null,
    vaultInitialized: false,
    vaultSalt: null,
  },
  shortcuts: {
    toggleRecording: "Ctrl+Shift+R",
    toggleDictation: "Cmd+Shift+Space",
    toggleDictationAlternates: [],
    openWindow: "Ctrl+Shift+N",
    quickExport: "Ctrl+Shift+E",
    focusSearch: "Ctrl+Shift+F",
  },
  updates: {
    channel: "stable",
    autoCheck: true,
    lastCheckAt: null,
    lastSeenVersion: null,
  },
  defaultTemplate: "meeting",
  theme: "system" as const,
};

vi.mock("@/lib/tauri", () => ({
  getPermissionDiagnostics: vi.fn(async () => ({
    microphoneReady: true,
    accessibilityReady: true,
    automationReady: true,
    notes: [],
  })),
  openPermissionSettings: vi.fn(),
  downloadWhisperModel: vi.fn(async () => {}),
  getSettings: vi.fn(async () => structuredClone(baseSettings)),
  saveSettings: vi.fn(async () => {}),
}));

describe("FirstRunWizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists power-user meeting retention and transcript-only settings", async () => {
    const onComplete = vi.fn();
    const tauri = await import("@/lib/tauri");
    const saveSettings = vi.mocked(tauri.saveSettings);

    render(<FirstRunWizard onComplete={onComplete} />);
    fireEvent.click(screen.getByRole("button", { name: /Power User/i }));

    const clickContinue = async () => {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Continue|Finish/i }));
      });
    };

    await clickContinue(); // permissions -> model-choice
    await clickContinue(); // model-choice -> hotkey
    await clickContinue(); // hotkey save -> privacy

    await screen.findByText("Meeting storage defaults");
    const selects = screen.getAllByRole("combobox");
    const meetingAudioSelect = selects[0];
    const retentionSelect = selects[1];
    const deleteModeSelect = selects[2];
    fireEvent.change(meetingAudioSelect, { target: { value: "transcript_only" } });
    fireEvent.change(retentionSelect, { target: { value: "custom" } });
    const monthsInput = screen.getByRole("spinbutton");
    fireEvent.change(monthsInput, { target: { value: "5" } });
    fireEvent.change(deleteModeSelect, { target: { value: "audio_and_transcript" } });
    await clickContinue(); // finish

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalled();
    });
    const lastSaved = saveSettings.mock.calls[saveSettings.mock.calls.length - 1]?.[0];
    expect(lastSaved?.transcription.meetingAudioStorageMode).toBe("transcript_only");
    expect(lastSaved?.transcription.meetingRetentionPreset).toBe("custom");
    expect(lastSaved?.transcription.meetingRetentionCustomMonths).toBe(5);
    expect(lastSaved?.transcription.meetingRetentionDeleteMode).toBe("audio_and_transcript");
  });

  it("keeps normal onboarding lightweight (no privacy-step save)", async () => {
    const onComplete = vi.fn();
    const tauri = await import("@/lib/tauri");
    const saveSettings = vi.mocked(tauri.saveSettings);

    render(<FirstRunWizard onComplete={onComplete} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Normal/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
    }); // permissions -> model
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
    }); // model -> hotkey
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Finish/i }));
    }); // hotkey -> finish

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalled();
    });
    expect(saveSettings).toHaveBeenCalledTimes(1);
  });
});
