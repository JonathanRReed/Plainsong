export interface Settings {
  audio: AudioSettings;
  transcription: TranscriptionSettings;
  ui: UiSettings;
  export: ExportSettings;
  privacy: PrivacySettings;
  shortcuts: KeyboardShortcuts;
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
  allowWhisperFallback: boolean;
  autoTranscribe: boolean;
  enableDiarization: boolean;
  intelligentPunctuation: boolean;
  language: string | null;
  numSpeakers: number;
  speakerNamingMethod: "auto" | "numbered" | "manual";
  silenceSkipEnabled: boolean;
  dictationPasteToCursor: boolean;
  dictationPushToTalk: boolean;
  dictationAiFormatting: boolean;
  saveRawTranscript: boolean;
  dictationSaveToInbox: boolean;
  dictationProfile: "speed" | "accuracy";
  dictationProjectId: string;
  memorySearchMode: "fts" | "ollama_embeddings";
  embeddingModel: string;
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

export interface KeyboardShortcuts {
  toggleRecording: string;
  toggleDictation: string;
  toggleDictationAlternates?: string[];
  openWindow: string;
  quickExport: string;
  focusSearch: string;
}
