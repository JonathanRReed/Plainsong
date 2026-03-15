export type DictationBaseModePreset =
  | "voice"
  | "messages"
  | "email"
  | "notes"
  | "meeting_follow_up";

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

export interface DictationCustomMode {
  id: string;
  name: string;
  description: string;
  baseModePreset?: DictationBaseModePreset | null;
  customPrompt?: string | null;
  profile: "normal_speed" | "power_rewrite";
  routePreference?: "local" | "cloud" | null;
  languageOverride?: string | null;
  livePreviewEnabled?: boolean | null;
  insertionMode: "auto" | "paste" | "inline" | "clipboard_only";
  contextSource: "none" | "clipboard" | "selected_text" | "application_context";
  saveToInbox: boolean;
  copyToClipboard: boolean;
  commandModeEnabled: boolean;
  dictationProvider?: string | null;
  dictationModelId?: string | null;
  aiProvider?: string | null;
  aiModelId?: string | null;
  activationAppMatcher?: string | null;
  activationDomainMatcher?: string | null;
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
  useSharedAsrSelection?: boolean;
  dictationProvider?: string;
  dictationModelId?: string;
  meetingProvider?: string;
  meetingModelId?: string;
  meetingRoutePolicy?: "prefer_local" | "best_available";
  providerModelIds?: Record<string, string>;
  /** @deprecated – kept for migration; use dictationMlxEnabled / meetingMlxEnabled instead */
  mlxAcceleratedProviders?: string[];
  /** MLX acceleration for the dictation route slot only */
  dictationMlxEnabled?: boolean;
  /** MLX acceleration for the meeting route slot only */
  meetingMlxEnabled?: boolean;
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
  dictationAutoRequestPermissions?: boolean;
  dictationPushToTalk: boolean;
  dictationHandsFreeEnabled?: boolean;
  dictationRoutePreference?: "local" | "cloud";
  dictationRouteOverrideEnabled?: boolean;
  dictationKeepWarm?: "off" | "short" | "long";
  dictationLivePreviewEnabled?: boolean;
  dictationAiFormatting: boolean;
  dictationModePreset?:
    | "voice"
    | "messages"
    | "email"
    | "notes"
    | "meeting_follow_up"
    | "custom";
  dictationSelectedCustomModeId?: string | null;
  dictationCustomModes?: DictationCustomMode[];
  dictationContextSource?: "none" | "clipboard" | "selected_text" | "application_context";
  dictationCommandModeEnabled?: boolean;
  dictationCommandPrefix?: string;
  dictationInsertionMode?: "auto" | "paste" | "inline" | "clipboard_only";
  dictationActiveLanguages?: string[];
  dictationSnippetsEnabled?: boolean;
  dictationAutoLearnCorrections?: boolean;
  dictationCustomPrompt: string | null;
  meetingCustomPrompt: string | null;
  meetingAutoNameEnabled?: boolean;
  meetingAutoNameModel?: string | null;
  saveRawTranscript: boolean;
  dictationSaveToInbox: boolean;
  dictationProfile: "normal_speed" | "power_rewrite";
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
  platformOptimization?: PlatformOptimizationSettings;
}

export interface PlatformOptimizationSettings {
  mode: "auto" | "manual";
  fallbackPolicy: "local_only" | "allow_cloud" | "fail_fast";
  macos: {
    appleNativeEnabled: boolean;
    mlxEnabled: boolean;
  };
  windows: {
    foundryEnabled: boolean;
    windowsSdkDictationEnabled: boolean;
  };
  manualEnginePriority: string[];
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
