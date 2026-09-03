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
  /**
   * Optional on the wire because a sidecar that predates them omits them;
   * read through `resolveMeetingsSettings` / `resolveNotificationsSettings`
   * in `src/lib/settings-sections.ts`, never directly.
   */
  meetings?: MeetingsSettings;
  notifications?: NotificationsSettings;
  /**
   * Local automation surfaces (the `plainsong` CLI, its read-only MCP server,
   * and `plainsong://` deep links). Optional on the wire only because older
   * settings files predate the section; Rust always serializes it.
   */
  automation?: AutomationSettings;
  theme: "light" | "dark" | "system";
}

/**
 * Meeting behaviours that live around a capture. Mirrors `MeetingsSettings`
 * in rust-sidecar/src/settings.rs.
 */
export interface MeetingsSettings {
  /** Notice a conferencing app with a call in progress and offer to record it. Local only. */
  callDetectionEnabled: boolean;
  /** End a meeting when the call app it was recorded alongside quits. */
  autoStopWhenCallAppQuits: boolean;
  /** End a meeting after this many minutes with nothing audible; 0 turns it off. */
  autoStopAfterSilenceMinutes: number;
  /**
   * Keep a numeric voice signature per speaker on this Mac so a voice named
   * once can be suggested later. Off by default; nothing is stored while off.
   */
  rememberVoices: boolean;
  /**
   * Apply a remembered name without asking when the match clears the stricter
   * per-model threshold. Off by default, and meaningless while
   * `rememberVoices` is off.
   */
  autoApplyConfidentVoices: boolean;
}

/** Which events may become an OS notification. Mirrors `NotificationsSettings` in settings.rs. */
export interface NotificationsSettings {
  meetingEvents: boolean;
  dictationFailures: boolean;
}

export interface AutomationSettings {
  /** Off by default. Mirrors `AutomationSettings` in rust-sidecar/src/settings.rs. */
  localToolsEnabled: boolean;
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
  /**
   * Translate the spoken words into English for this profile. Mirrors
   * `translate_to_english` in rust-sidecar/src/settings.rs; the built-in
   * modes use `TranscriptionSettings.dictationTranslateToEnglish` instead.
   */
  translateToEnglish?: boolean;
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
  /**
   * Translate-to-English for the built-in modes (a saved custom mode carries
   * its own `translateToEnglish`). Mirrors `dictation_translate_to_english`
   * in rust-sidecar/src/settings.rs. How it runs depends on the model: see
   * `resolveTranslateToEnglishAvailability` in src/lib/dictation-translation.ts.
   */
  dictationTranslateToEnglish?: boolean;
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
  /**
   * Mirrors `dictation_learn_from_external_corrections` in
   * `rust-sidecar/src/settings.rs`. Off unless the user turned it on: it is the
   * only dictation setting that reads text back out of another application.
   */
  dictationLearnFromExternalCorrections?: boolean;
  dictationCustomPrompt: string | null;
  meetingCustomPrompt: string | null;
  meetingAutoNameEnabled?: boolean;
  meetingAutoNameModel?: string | null;
  dictationSaveToInbox: boolean;
  dictationProfile: "normal_speed" | "power_rewrite";
  dictationProjectId: string;
  dictationRetentionPreset?: "immediate" | "24h" | "72h" | "never" | "custom";
  dictationRetentionCustomHours?: number;
  /**
   * Keep each dictation's captured audio so a history entry can be run through
   * the recognizer again ("Process again"). Off by default; the audio is
   * deleted with the entry. Mirrors `dictation_keep_audio` in settings.rs.
   */
  dictationKeepAudio?: boolean;
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

/**
 * What physically fires a dictation binding. Mirrors `DictationBindingTrigger`
 * in rust-sidecar/src/settings.rs. A `key` accelerator may be a lone modifier
 * ("Fn", "Cmd"); that and every `mouse` trigger need the native macOS helper.
 */
export type DictationBindingTrigger =
  | { kind: "key"; accelerator: string }
  | { kind: "mouse"; button: 3 | 4 | 5; modifiers?: string[] };

/**
 * What a dictation binding does. `dictation` with `modeId: null` runs the
 * selected mode; a built-in preset id or a saved custom mode id runs that
 * mode for the one session. `behavior: "inherit"` follows the activation
 * setting (toggle / hold / hands-free); `toggle` and `hold` pin it.
 */
export type DictationBindingAction =
  | { kind: "dictation"; modeId: string | null; behavior: "toggle" | "hold" | "inherit" }
  | { kind: "cycleMode" }
  | { kind: "cancel" };

export interface DictationBinding {
  id: string;
  trigger: DictationBindingTrigger;
  action: DictationBindingAction;
}

interface KeyboardShortcuts {
  /**
   * The primary dictation binding's accelerator, kept in step with
   * `dictationBindings` by the sidecar so an older build still has a hotkey.
   * Read it for display; write `dictationBindings` to change it.
   */
  toggleDictation: string;
  openWindow: string;
  // Recovery bindings for the last dictation result. Empty string = unbound.
  repasteLastDictation?: string;
  recopyLastDictation?: string;
  /** The dictation binding table (roadmap item B4). Absent on older files. */
  dictationBindings?: DictationBinding[];
}
