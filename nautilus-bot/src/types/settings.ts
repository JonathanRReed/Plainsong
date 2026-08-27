type DictationBaseModePreset =
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
  theme: "light" | "dark" | "system";
}

export type DictationAppCategoryKey =
  | "other"
  | "messaging"
  | "email"
  | "notes"
  | "worklog"
  | "ai_chat"
  | "code_editor";

export interface DictationAppCategoryOverride {
  id: string;
  appMatcher: string;
  category: DictationAppCategoryKey;
  enabled: boolean;
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
  insertionMode: "auto" | "clipboard_only";
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

/**
 * A user-saved meeting template ("recipe"), alongside the built-in set in
 * `src/lib/meeting-templates.ts`. Mirrors `MeetingCustomTemplate` in
 * rust-sidecar/src/settings.rs -- same shape, same sanitization discipline
 * on the Rust side (dropped if malformed, capped in count and length).
 */
export interface MeetingCustomTemplate {
  id: string;
  name: string;
  summaryPrompt: string;
  notesOutline: string[];
}

interface AudioSettings {
  preferredInputDevice?: AudioInputDevicePreference | null;
  dictationInputOverrideEnabled?: boolean;
  dictationInputDevice?: AudioInputDevicePreference | null;
  meetingInputOverrideEnabled?: boolean;
  meetingInputDevice?: AudioInputDevicePreference | null;
}

interface AudioInputDevicePreference {
  deviceId: string;
  deviceName: string;
  transportType?: "builtin" | "bluetooth" | "usb" | "virtual" | "unknown" | null;
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
  // `mlxAcceleratedProviders`, `dictationMlxEnabled` and `meetingMlxEnabled`
  // were removed: no MLX inference path was ever shipped, so every one of them
  // could only ever describe a route that did not exist. The Rust side still
  // accepts the keys for now, so old settings files load without error.
  enableDiarization: boolean;
  /// Selected diarization speaker embedding model. Defaults to
  /// `ecapa_tdnn_speaker` when unset (the Rust side applies the same
  /// default). When set, the diarization engine uses this model for
  /// speaker embedding extraction.
  diarizationModelId?: string;
  language: string | null;
  silenceSkipEnabled: boolean;
  dictationCopyToClipboard?: boolean;
  dictationAutoRequestPermissions?: boolean;
  dictationPushToTalk: boolean;
  dictationHandsFreeEnabled?: boolean;
  dictationRoutePreference?: "local" | "cloud";
  dictationRouteOverrideEnabled?: boolean;
  dictationKeepWarm?: "off" | "on";
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
  dictationInsertionMode?: "auto" | "clipboard_only";
  dictationActiveLanguages?: string[];
  dictationSnippetsEnabled?: boolean;
  dictationAutoLearnCorrections?: boolean;
  dictationCustomPrompt: string | null;
  meetingCustomPrompt: string | null;
  meetingAutoNameEnabled?: boolean;
  meetingAutoNameModel?: string | null;
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
  dictationVadBackend?: "energy_threshold" | "silero";
  memorySearchMode: "fts" | "ollama_embeddings";
  embeddingModel: string;
  enableAutoAnalysis: boolean;
  platformOptimization?: PlatformOptimizationSettings;
  dictationCategoryFormattingEnabled?: boolean;
  dictationAppCategoryOverrides?: DictationAppCategoryOverride[];
  meetingCustomTemplates?: MeetingCustomTemplate[];
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

interface UiSettings {
  alwaysOnTop: boolean;
  minimizeToTray: boolean;
  showDictationPopup: boolean;
  showRecordingPopup: boolean;
  colorScheme: string;
}

// Transitional empty container -- kept because Settings.export is a required
// key on the wire; every field that used to live here had no runtime reader
// and was removed (see rust-sidecar/src/settings.rs's REMOVED_SETTINGS_KEYS).
type ExportSettings = Record<string, never>;

/**
 * One AI lane: which analysis provider runs a class of work, and on which
 * model. Mirrors `AiLaneSettings` in rust-sidecar/src/settings.rs.
 *
 * `modelId: null` means "the provider's own default model", not "unset".
 */
export interface AiLaneSettings {
  provider: string;
  modelId: string | null;
}

interface PrivacySettings {
  remoteProcessingEnabled: boolean;
  /**
   * Dictation cleanup and formatting. Latency-critical — it runs on every
   * capture behind a short timeout, so it usually wants a smaller, faster
   * model than the meetings lane.
   */
  dictationAi: AiLaneSettings;
  /**
   * Meeting summaries, action items, and meeting Q&A. Batch work, so it can
   * afford a slower, smarter model.
   */
  meetingsAi: AiLaneSettings;
  exportRoot: string | null;
  exportLocationId?: string | null;
  exportLocationLabel?: string | null;
  exportLocationApproved?: boolean;
  vaultInitialized: boolean;
  vaultSalt: string | null;
}

interface UpdateSettings {
  channel: "stable" | "beta";
  autoCheck: boolean;
  lastCheckAt: string | null;
  lastSeenVersion: string | null;
}

interface KeyboardShortcuts {
  toggleDictation: string;
  toggleDictationAlternates?: string[];
  openWindow: string;
  // Recovery bindings for the last dictation result. Empty string = unbound.
  repasteLastDictation?: string;
  recopyLastDictation?: string;
}
