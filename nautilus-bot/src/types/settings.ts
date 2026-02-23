export interface Settings {
  audio: AudioSettings;
  transcription: TranscriptionSettings;
  ui: UiSettings;
  export: ExportSettings;
  privacy: PrivacySettings;
  shortcuts: KeyboardShortcuts;
  updates: UpdateSettings;
  defaultTemplate: string;
  theme: "light" | "dark" | "system";
}

export interface AudioSettings {
  sampleRate: number;
  channels: number;
  captureSystemAudio: boolean;
  captureMicrophone: boolean;
  noiseSuppression: boolean;
  voiceActivityDetection: boolean;
  silenceTimeoutSeconds: number;
  autoGainControl: boolean;
  manualGainDb: number;
}

export interface TranscriptionSettings {
  defaultProvider: string;
  selectedModelId: string;
  providerModelIds?: Record<string, string>;
  autoTranscribe: boolean;
  enableDiarization: boolean;
  intelligentPunctuation: boolean;
  language: string | null;
  numSpeakers: number;
  speakerNamingMethod: "auto" | "numbered" | "manual";
  diarizationModelId?: string;
  silenceSkipEnabled: boolean;
  dictationPasteToCursor: boolean;
  dictationCopyToClipboard?: boolean;
  dictationPushToTalk: boolean;
  dictationAiFormatting: boolean;
  dictationCustomPrompt: string | null;
  meetingCustomPrompt: string | null;
  meetingAutoNameEnabled?: boolean;
  meetingAutoNameModel?: string | null;
  saveRawTranscript: boolean;
  dictationSaveToInbox: boolean;
  dictationProfile: "speed" | "accuracy";
  dictationProjectId: string;
  dictationRetentionPreset?: "immediate" | "24h" | "72h" | "never" | "custom";
  dictationRetentionCustomHours?: number;
  meetingAudioStorageMode?: "always" | "transcript_only";
  meetingRetentionPreset?: "1m" | "2m" | "3m" | "custom" | "never";
  meetingRetentionCustomMonths?: number;
  meetingRetentionDeleteMode?: "audio_only" | "audio_and_transcript";
  dictationSilenceTimeoutSeconds: number;
  memorySearchMode: "fts" | "ollama_embeddings";
  embeddingModel: string;
  enableAutoAnalysis: boolean;
}

export interface UiSettings {
  alwaysOnTop: boolean;
  showInDock: boolean;
  minimizeToTray: boolean;
  startMinimized: boolean;
  windowPosition: [number, number] | null;
  windowSize: [number, number] | null;
  fontSize: number;
  showDictationPopup: boolean;
  showRecordingPopup: boolean;
  colorScheme: string;
}

export interface ExportSettings {
  defaultFormat: string;
  autoExport: boolean;
  exportDirectory: string | null;
  includeTimestamps: boolean;
  includeSpeakers: boolean;
  openAfterExport: boolean;
}

export interface PrivacySettings {
  encryptRecordings: boolean;
  autoDeleteDays: number;
  requirePassword: boolean;
  auditLogging: boolean;
  cloudSync: boolean;
  remoteProcessingEnabled: boolean;
  llmProvider: string;
  llmModelId: string | null;
  exportRoot: string | null;
  vaultInitialized: boolean;
  vaultSalt: string | null;
}

export interface UpdateSettings {
  channel: "stable" | "beta";
  autoCheck: boolean;
  lastCheckAt: string | null;
  lastSeenVersion: string | null;
}

export interface KeyboardShortcuts {
  toggleRecording: string;
  toggleDictation: string;
  toggleDictationAlternates?: string[];
  openWindow: string;
  quickExport: string;
  focusSearch: string;
}
