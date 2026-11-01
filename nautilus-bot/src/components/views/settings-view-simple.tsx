import { NotePublishSettingsSection } from "@/components/meetings/note-publish-settings";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { AsrProviderManager } from "@/components/asr-provider-manager";
import {
  settingsErrorMessage,
  settingsSaveErrorMessage,
} from "@/components/settings/settings-error-message";
import {
  OptionSelect,
  SettingsOptionSelect,
} from "@/components/settings/option-select";
import { ModelsScreen } from "@/components/models/models-screen";
import {
  AI_LANE_KEYS,
  describeAnalysisDestination,
  isRemoteAnalysisProvider,
  isZeroSetupAnalysisProvider,
  type AiLaneKey,
} from "@/components/models/ai-lanes";
import { SavedPromptManagerDialog } from "@/components/prompts/saved-prompt-manager-dialog";
import { resolveSavedPrompts, type SavedPrompt } from "@/lib/saved-prompts";
import { listen } from "@/lib/electron";
import {
  CHATGPT_PLAN_PROVIDER,
  getChatGptPlanStatus,
} from "@/lib/backend/chatgpt-plan";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  SettingsGroup,
  SettingsInput,
  SettingsMore,
  SettingsRow,
  SettingsSwitch,
  settingAnchorId,
} from "@/components/ui/settings-control";
import { CalendarSettingsSection } from "@/components/meetings/calendar-settings-section";
import { LocalToolsSection } from "@/components/local-tools-section";
import { RememberedVoicesSection } from "@/components/remembered-voices-section";
import { MeetingAudioStorage } from "@/components/settings/meeting-audio-storage";
import { MeaningSearchSection } from "@/components/settings/meaning-search-section";
import { NameSourcesSetting } from "@/components/settings/name-sources-setting";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  MEETING_AUTO_STOP_SILENCE_MINUTES_MAX,
  MEETING_MAX_RECORDING_MINUTES,
  resolveMeetingsSettings,
  resolveNotificationsSettings,
} from "@/lib/settings-sections";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTheme } from "@/components/theme-provider";
import {
  applyGlobalShortcutsNow,
  clearProviderSecret,
  getDictationShortcutCapabilityStatus,
  getPermissionDiagnostics,
  getSecurityStatus,
  getSettings,
  getShortcutConflicts,
  hasProviderSecret,
  lockVault,
  migrateToEncryptedStorage,
  openPermissionSettings,
  repairCursorInsertPermissions,
  requestDictationPermissions,
  patchSettings as persistSettingsPatch,
  setSavedPrompts,
  selectExportLocation,
  setProviderSecret,
  resetAppState,
  unlockVault,
} from "@/lib/backend/settings";
import {
  createBackupDefault,
  createSettingsBackupDefault,
  getBackupConfig,
  getBackupSetupReport,
  listBackups,
  restoreBackupDefault,
  saveBackupConfig,
  selectBackupLocation,
  selectCloudBackupLocation,
  syncBackupToCloud,
  verifyBackupCloudConnection,
} from "@/lib/backend/storage";
import {
  getOllamaStatus,
  listAnthropicModels,
  listDeepSeekModels,
  listGeminiModels,
  listOpenAiModels,
  listOllamaCloudModels,
  listOllamaModels,
} from "@/lib/backend/ai";
import { speakerModelName, speakerModelOptionLabel } from "@/lib/speaker-models";
import { TurnedOffSpeakerModelFile } from "@/components/settings/turned-off-speaker-model-file";
import {
  downloadDiarizationModel,
  downloadSileroVadModel,
  getAsrProviders,
  getDiarizationModelPlan,
  listDiarizationModels,
  refreshAsrRuntimeProbes,
  isSileroVadModelDownloaded,
  type DiarizationModelOption,
} from "@/lib/backend/asr";
import {
  getSystemAudioCapability,
  listAudioInputDevices,
  testSystemAudioCapture,
  type AudioInputDeviceInfo,
  type AudioInputDeviceInventory,
  type SystemAudioCapability,
} from "@/lib/backend/recordings";
import type {
  BackupConfig,
  BackupInfo,
  CloudSetupReport,
} from "@/lib/backend/storage";
import type {
  DictationShortcutCapabilityStatus,
  PermissionDiagnostics,
  SecurityStatus,
  ShortcutConflict,
} from "@/lib/backend/settings";
import type { AsrProviderInfo } from "@/types";
import type { Settings } from "@/types/settings";
import { applyThemeScheme, normalizeThemeScheme } from "@/lib/theme-schemes";
import {
  defaultDictationShortcut,
  formatShortcutForDisplay,
  normalizeShortcut,
} from "@/lib/shortcuts";
import {
  probeDictationAiLane,
  resolveDictationRecognizer,
  resolveTranslateToEnglishAvailability,
} from "@/lib/dictation-translation";
import {
  describeDictationBindingTrigger,
  DICTATION_MODE_CYCLE_ORDER,
  dictationBindingConflictSources,
  dictationModeLabelFor,
  findPrimaryDictationBinding,
  isRecordedDictationTrigger,
  resolveDictationBindings,
  validateDictationBindings,
  type DictationBinding,
  type DictationBindingAction,
  type DictationBindingIssue,
  type DictationBindingTrigger,
} from "../../../electron/dictation-bindings";
import { findConflictingShortcuts } from "../../../electron/shortcut-registration";
import {
  MEETING_ONBOARDING_STORAGE_KEY,
  ONBOARDING_STORAGE_KEY,
  requestOnboarding,
} from "@/lib/onboarding";
import {
  consumePendingSettingsTab,
  OPEN_SETTINGS_TAB_EVENT,
  requestMainView,
  resolveSettingsSection,
  type SettingsSectionId,
  type SettingsTabRequest,
} from "@/lib/navigation";
import {
  SETTINGS_SECTIONS,
  searchSettings,
  settingsSectionLabel,
  type SettingsIndexEntry,
} from "@/components/settings/settings-sections";
import {
  AlertCircle,
  Mic,
  Monitor,
  Search,
  Sun,
  Moon,
  Loader2,
  Download,
  RefreshCw,
} from "lucide-react";
import { UpdateStatusWidget, BetaChannelToggle } from "@/components/update";
import { useToast } from "@/components/toast";
import { SupportBundlePanel } from "@/components/settings/support-bundle-panel";
import { useProductReadinessStatus } from "@/features/readiness/product-readiness-context";
import type { ReadinessAssessment } from "@/features/readiness/product-readiness";
import { formatDateTime } from "@/lib/format-locale";
import { describeMeetingAudio, MEETING_AUDIO_EXPLAINER } from "@/lib/meeting-audio-status";
import { micErrorMessage, useMicLevel } from "@/hooks/use-mic-level";

import { applySettingsPatch, diffSettings, mergeSettingsPatches, type SettingsPatch } from "@/lib/settings-patch";

type TabId = SettingsSectionId;
type QueuedSettingsSave = {
  version: number;
  settings: Settings;
  patch: SettingsPatch;
  waiters: Array<{
    resolve: () => void;
    reject: (error: unknown) => void;
  }>;
};

type SettingsSaveScheduler = {
  nextVersion: number;
  latestAppliedVersion: number;
  pending: QueuedSettingsSave | null;
  timer: ReturnType<typeof setTimeout> | null;
  flushing: boolean;
  inFlight: SettingsPatch | null;
  failed: SettingsPatch;
};

type ShortcutFieldKey =
  | "toggleDictation"
  | "openWindow"
  | "repasteLastDictation"
  | "recopyLastDictation";

const SHORTCUT_FIELD_CONFIG: Array<{
  key: ShortcutFieldKey;
  label: string;
}> = [
  { key: "toggleDictation", label: "Dictation" },
  { key: "repasteLastDictation", label: "Paste last result" },
  { key: "recopyLastDictation", label: "Copy last result" },
  { key: "openWindow", label: "Open window" },
];

// Base characters for punctuation keys, keyed by KeyboardEvent.code, so a
// captured shortcut stores the unshifted key the OS-level matchers expect.
const SHORTCUT_PUNCTUATION_BY_CODE: Record<string, string> = {
  Backquote: "`",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Equal: "=",
  Minus: "-",
  Period: ".",
  Quote: "'",
  Semicolon: ";",
  Slash: "/",
};

const SETTINGS_SAVE_DEBOUNCE_MS = 350;
const SETTINGS_SECONDARY_LOAD_TIMEOUT_MS = 2500;
const DICTATION_ACTIVE_LANGUAGE_OPTIONS = [
  { value: "en", label: "English" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "it", label: "Italian" },
  { value: "pt", label: "Portuguese" },
  { value: "ja", label: "Japanese" },
  { value: "ko", label: "Korean" },
  { value: "zh", label: "Chinese" },
  { value: "ru", label: "Russian" },
  { value: "ar", label: "Arabic" },
  { value: "hi", label: "Hindi" },
] as const;

type ProviderModelListValue =
  | string
  | {
      id?: unknown;
      name?: unknown;
      model?: unknown;
    }
  | null
  | undefined;

function normalizeProviderModelList(models: unknown): string[] {
  if (!Array.isArray(models)) {
    return [];
  }

  const normalized = models
    .map((model: ProviderModelListValue) => {
      if (typeof model === "string") {
        return model;
      }
      if (model && typeof model === "object") {
        const candidate = model.id ?? model.name ?? model.model;
        return typeof candidate === "string" ? candidate : "";
      }
      return "";
    })
    .map((model) => model.replace(/^models\//, "").trim())
    .filter(Boolean);

  return Array.from(new Set(normalized));
}

async function withSettingsSectionTimeout<T>(
  section: string,
  task: Promise<T>,
  timeoutMs = SETTINGS_SECONDARY_LOAD_TIMEOUT_MS,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${section} took too long to load`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([task, timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function dictationLanguageLabel(value: string): string {
  return (
    DICTATION_ACTIVE_LANGUAGE_OPTIONS.find((option) => option.value === value)
      ?.label ?? value
  );
}

function normalizeActiveLanguageSet(languages: string[] | undefined): string[] {
  const allowed = new Set<string>(
    DICTATION_ACTIVE_LANGUAGE_OPTIONS.map((option) => option.value),
  );
  const normalized: string[] = [];
  for (const language of languages ?? []) {
    const value = language.trim().toLowerCase();
    if (!allowed.has(value) || normalized.includes(value)) {
      continue;
    }
    normalized.push(value);
  }
  return normalized;
}

// The sidecar has replied without `conflicts` (and with no payload at all), and
// iterating that took down the whole Settings view. Anything but an array
// reads as "no conflicts known".
function normalizeShortcutConflicts(
  reply: { conflicts?: ShortcutConflict[] | null } | null | undefined,
): ShortcutConflict[] {
  return Array.isArray(reply?.conflicts) ? reply.conflicts : [];
}

function markSettingsPerf(markName: string) {
  if (!import.meta.env.DEV || typeof performance === "undefined") {
    return;
  }
  performance.mark(markName);
  console.debug(`[perf] ${markName}`);
}

function deviceTransportLabel(device: AudioInputDeviceInfo) {
  switch (device.transportType) {
    case "builtin":
      return "Built-in";
    case "bluetooth":
      return "Bluetooth";
    case "usb":
      return "USB";
    case "virtual":
      return "Virtual";
    default:
      return "Audio input";
  }
}

function renderDeviceOptionLabel(device: AudioInputDeviceInfo) {
  const details = [deviceTransportLabel(device)];
  if (device.isDefault) {
    details.push("system default");
  }
  return `${device.deviceName} - ${details.join(" - ")}`;
}

type DictationHotkeyBehavior = "hold_to_talk" | "toggle" | "hands_free";

function resolveDictationHotkeyBehavior(
  settings: Settings | null,
): DictationHotkeyBehavior {
  if (settings?.transcription.dictationHandsFreeEnabled) {
    return "hands_free";
  }
  return settings?.transcription.dictationPushToTalk
    ? "hold_to_talk"
    : "toggle";
}

type ReadinessChipState = {
  label: string;
  status: string;
  tone: boolean | "neutral";
};

type RecordingEncryptionSummary = {
  chip: string;
  description: string;
  allEncrypted: boolean;
};

/**
 * Describe what is actually encrypted on disk.
 *
 * Encryption happens in the vault migration, which rewrites existing files;
 * capture always writes a plain WAV. So a vault that was initialized once does
 * not make everything recorded since encrypted, and a bare "Encrypted at rest"
 * claim would be contradicted by the bytes.
 */
function describeRecordingEncryption(
  status: SecurityStatus | null,
): RecordingEncryptionSummary {
  if (!status) {
    return {
      chip: "Checking",
      description: "Reading the state of the recordings on disk.",
      allEncrypted: false,
    };
  }

  const stored = status.recordingsStoredCount ?? 0;
  const encrypted = status.recordingsEncryptedCount ?? 0;

  if (stored === 0) {
    return {
      chip: "No recordings",
      description: status.vaultInitialized
        ? "The vault is set up, but new recordings are written unencrypted until you migrate again."
        : "Nothing is stored yet. Use “Migrate to Encrypted Storage” below to encrypt recordings.",
      allEncrypted: false,
    };
  }

  if (encrypted === stored) {
    return {
      chip: `${encrypted} of ${stored} encrypted`,
      description:
        "Every stored recording is encrypted. New recordings are written unencrypted until you migrate again.",
      allEncrypted: true,
    };
  }

  if (encrypted === 0) {
    return {
      chip: `0 of ${stored} encrypted`,
      description:
        "No stored recording is encrypted. Use “Migrate to Encrypted Storage” below to encrypt them.",
      allEncrypted: false,
    };
  }

  return {
    chip: `${encrypted} of ${stored} encrypted`,
    description:
      "Recordings made since the last migration are still plaintext. Migrate again to encrypt them.",
    allEncrypted: false,
  };
}

/**
 * Who writes meeting summaries and who does AI cleanup, in one sentence,
 * naming the destination once when both use the same one.
 */
function describeAiWriters(
  meetingsProvider: string | undefined,
  dictationProvider: string | undefined,
): string {
  const summaries = describeAnalysisDestination(meetingsProvider);
  const cleanup = describeAnalysisDestination(dictationProvider);
  return summaries === cleanup
    ? `Summaries and AI cleanup both use ${summaries}. Both are chosen in Models.`
    : `Summaries are written by ${summaries}, and AI cleanup by ${cleanup}. Both are chosen in Models.`;
}

function resolveDictationReadinessChip(
  readiness: ReadinessAssessment,
): ReadinessChipState {
  if (readiness.state === "ready") {
    return {
      label: "Dictation",
      status: "Ready",
      tone: true,
    };
  }

  if (readiness.state === "unknown") {
    return {
      label: "Dictation",
      status: "Checking",
      tone: "neutral",
    };
  }

  const label =
    readiness.cause?.id === "microphone_permission" ||
    readiness.cause?.id === "microphone_device"
      ? "Microphone"
      : readiness.cause?.id === "cursor_insertion"
        ? "Text insertion"
        : readiness.cause?.id === "dictation_route"
          ? "Speech model"
          : "Dictation";

  return {
    label,
    status: readiness.state === "degraded" ? "Limited" : "Needs setup",
    tone: false,
  };
}

export function SettingsView() {
  const { theme, setTheme } = useTheme();
  const { productReadiness } = useProductReadinessStatus();
  const [activeTab, setActiveTab] = useState<TabId>("general");
  const tabButtonRefs = useRef<Partial<Record<TabId, HTMLButtonElement | null>>>(
    {},
  );
  // Settings search, and the row a search result or deep link should land on
  // once its section has rendered.
  const [settingsQuery, setSettingsQuery] = useState("");
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  const contentScrollRef = useRef<HTMLDivElement | null>(null);
  // Up/down (and left/right) move along the section list and open the section
  // they land on (the tablist pattern); Tab leaves the list for the section.
  const handleTabKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      const index = SETTINGS_SECTIONS.findIndex((tab) => tab.id === activeTab);
      const last = SETTINGS_SECTIONS.length - 1;
      let nextIndex: number;
      switch (event.key) {
        case "ArrowDown":
        case "ArrowRight":
          nextIndex = index === last ? 0 : index + 1;
          break;
        case "ArrowUp":
        case "ArrowLeft":
          nextIndex = index === 0 ? last : index - 1;
          break;
        case "Home":
          nextIndex = 0;
          break;
        case "End":
          nextIndex = last;
          break;
        default:
          return;
      }
      event.preventDefault();
      const nextTab = SETTINGS_SECTIONS[nextIndex].id;
      setSettingsQuery("");
      setActiveTab(nextTab);
      tabButtonRefs.current[nextTab]?.focus();
    },
    [activeTab],
  );
  const [savedPromptsOpen, setSavedPromptsOpen] = useState(false);
  const [savedPromptsSaveError, setSavedPromptsSaveError] = useState<
    string | null
  >(null);
  const [draftSettings, setDraftSettings] = useState<Settings | null>(null);
  const [persistedSettings, setPersistedSettings] = useState<Settings | null>(
    null,
  );
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settingsSaveError, setSettingsSaveError] = useState<string | null>(null);
  const [initialLoadFailed, setInitialLoadFailed] = useState(false);
  const [provider, setProvider] = useState("openai");
  const [apiKey, setApiKey] = useState("");
  const [hasApiKey, setHasApiKey] = useState(false);
  // Whether the Key Manager's currently-selected credential provider (`provider`,
  // independent of settings.privacy.meetingsAi.provider) has a stored secret. Kept
  // separate from `hasApiKey` (which tracks the meetings analysis provider) so browsing
  // Key Manager never has to rewrite the analysis provider just to stay accurate.
  const [keyManagerHasApiKey, setKeyManagerHasApiKey] = useState(false);
  const [savingApiKey, setSavingApiKey] = useState(false);
  const [backupConfig, setBackupConfig] = useState<BackupConfig | null>(null);
  const [backupConfigLoading, setBackupConfigLoading] = useState(false);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupStatus, setBackupStatus] = useState<string | null>(null);
  const [backupSetupReport, setBackupSetupReport] =
    useState<CloudSetupReport | null>(null);
  const [permissionDiagnostics, setPermissionDiagnostics] =
    useState<PermissionDiagnostics | null>(null);
  const [, setAsrProviders] = useState<AsrProviderInfo[]>([]);
  const [nativeShortcutAvailable, setNativeShortcutAvailable] =
    useState(false);
  // Problems Electron found with the binding table on its last registration
  // pass (a mouse button with no helper, ...), merged with the local check
  // below so a freshly recorded duplicate is flagged before the save lands.
  const [remoteBindingIssues, setRemoteBindingIssues] = useState<
    DictationBindingIssue[]
  >([]);
  // Which binding's recorder is listening for keys or a mouse button.
  const [recordingBindingId, setRecordingBindingId] = useState<string | null>(
    null,
  );
  // A row "Add binding" created that has no trigger yet. It is deliberately
  // NOT saved: the sidecar's `reconcile_keyboard_shortcuts` drops any binding
  // with an empty accelerator, so writing it produced a row that showed up in
  // the draft settings, vanished from the file, and then disappeared from the
  // screen on the next reload with no explanation. It is written the moment
  // the recorder captures a trigger, and never before.
  const [draftBinding, setDraftBinding] = useState<DictationBinding | null>(
    null,
  );
  // Whether the dictation AI lane can answer right now: `null` until the
  // probe returns. Gates the translate-to-English toggle for models that
  // translate through that lane.
  const [dictationAiLaneReady, setDictationAiLaneReady] = useState<
    boolean | null
  >(null);
  const [shortcutConflicts, setShortcutConflicts] = useState<
    ShortcutConflict[]
  >([]);
  const [securityStatus, setSecurityStatus] = useState<SecurityStatus | null>(
    null,
  );
  const [vaultPassword, setVaultPassword] = useState("");
  const [cloudReadinessMessage, setCloudReadinessMessage] = useState<
    string | null
  >(null);
  const [ollamaAvailable, setOllamaAvailable] = useState<boolean | null>(null);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [ollamaCloudModels, setOllamaCloudModels] = useState<string[]>([]);
  const [diarizationDownloading, setDiarizationDownloading] = useState(false);
  const [diarizationModels, setDiarizationModels] = useState<
    DiarizationModelOption[]
  >([]);
  // The model the next meeting will actually run (a downloaded stand-in
  // when the selected one is missing; null when none is on this Mac), so the
  // remembered-voices note describes what will happen, not what was picked.
  const [diarizationRunModelId, setDiarizationRunModelId] = useState<
    string | null | undefined
  >(undefined);
  // The model setup and meetings offer for download, which differs from the
  // saved one only when the saved one is no longer offered.
  const [diarizationPlanModelId, setDiarizationPlanModelId] = useState<string | undefined>(undefined);
  const [sileroVadAvailable, setSileroVadAvailable] = useState(false);
  const [sileroVadDownloading, setSileroVadDownloading] = useState(false);
  const micTest = useMicLevel();
  const micTestActive = micTest.state === "live";
  const micTestLevel = Math.round(micTest.level * 100);
  const [micTestRecording, setMicTestRecording] = useState(false);
  const [micTestPlaybackUrl, setMicTestPlaybackUrl] = useState<string | null>(
    null,
  );
  const [audioDeviceInventory, setAudioDeviceInventory] =
    useState<AudioInputDeviceInventory | null>(null);
  const [systemAudioCapability, setSystemAudioCapability] =
    useState<SystemAudioCapability | null>(null);
  const [systemAudioTestLoading, setSystemAudioTestLoading] = useState(false);
  const [systemAudioTestStatus, setSystemAudioTestStatus] = useState<string | null>(null);
  const [systemAudioCheckFailed, setSystemAudioCheckFailed] = useState(false);
  const meetingAudio = describeMeetingAudio(systemAudioCapability, systemAudioCheckFailed);
  const micTestRecorderRef = useRef<MediaRecorder | null>(null);
  const micTestChunksRef = useRef<BlobPart[]>([]);
  const backupConfigLoadInFlightRef = useRef(false);
  const [openaiModels, setOpenaiModels] = useState<string[]>([]);
  const [anthropicModels, setAnthropicModels] = useState<string[]>([]);
  const [geminiModels, setGeminiModels] = useState<string[]>([]);
  const [deepseekModels, setDeepseekModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [hasLoadedSecurityTab, setHasLoadedSecurityTab] = useState(false);
  const [hasLoadedStorageTab, setHasLoadedStorageTab] = useState(false);
  const [resettingApp, setResettingApp] = useState(false);
  const [showResetDialog, setShowResetDialog] = useState(false);
  const [resetPhrase, setResetPhrase] = useState("");
  const [capturingShortcut, setCapturingShortcut] =
    useState<ShortcutFieldKey | null>(null);
  const mountedRef = useRef(true);
  const settingsRevisionRef = useRef(0);
  const saveSchedulerRef = useRef<SettingsSaveScheduler>({
    nextVersion: 0,
    latestAppliedVersion: 0,
    pending: null,
    timer: null,
    flushing: false,
    inFlight: null,
    failed: diffSettings({}, {}),
  });
  // Canonical snapshots come from native broadcasts and completed writes.
  const persistedSettingsRef = useRef<Settings | null>(null);

  const settings = draftSettings;
  // Sections a sidecar may omit, resolved to the Rust defaults so the
  // switches below never render an undefined as "off".
  const meetingsSettings = resolveMeetingsSettings(settings);
  const notificationsSettings = resolveNotificationsSettings(settings);
  // The newest draft, for effects that write a whole Settings object back.
  // Such an effect can run a commit behind — a provider's model list resolves
  // in a promise, and React flushes the effect that resolution scheduled
  // before rendering whatever the user did in the meantime — so rebuilding
  // the object from the effect's own closure silently reverts that newer
  // edit. `updateSettings` republishes this ref as it writes, so an effect
  // reading it changes only its own field. Kept in sync on render too, for
  // the setters that go straight to `setDraftSettings`.
  const latestSettingsRef = useRef<Settings | null>(null);
  latestSettingsRef.current = settings;
  const { toast } = useToast();
  const latestSettingsSnapshot = useMemo(
    () => backups.find((backup) => backup.backupType === "settings") ?? null,
    [backups],
  );
  const latestFullBackup = useMemo(
    () => backups.find((backup) => backup.backupType === "full") ?? null,
    [backups],
  );
  const microphonePermissionReady =
    permissionDiagnostics?.microphonePermissionReady ??
    permissionDiagnostics?.microphoneReady ??
    false;
  const dictationReadinessChip = useMemo(
    () => resolveDictationReadinessChip(productReadiness.dictation),
    [productReadiness.dictation],
  );
  const recordingEncryptionSummary = useMemo(
    () => describeRecordingEncryption(securityStatus),
    [securityStatus],
  );
  const dictationShortcutBehavior = resolveDictationHotkeyBehavior(settings);
  const dictationHoldToTalkActive =
    nativeShortcutAvailable && settings?.transcription.dictationPushToTalk;
  const dictationShortcutBehaviorHint = settings?.transcription
    .dictationHandsFreeEnabled
    ? "Dictation starts on its own when you speak. Stop talking, or press the shortcut, to end it."
    : dictationHoldToTalkActive
      ? "Hold the shortcut down while you talk, and let go when you are done."
      : "Press the shortcut once to start, and again to stop.";

  const applySecurityStatusFromSettings = useCallback((next: Settings) => {
    setSecurityStatus((current) =>
      current
        ? {
            ...current,
            vaultInitialized: next.privacy.vaultInitialized,
            // recordingsEncrypted and its counts are read off the files on
            // disk (lib.rs build_security_status), so a settings save cannot
            // re-derive them and must leave them alone.
            // SecurityStatus.llmProvider is the meetings lane (see lib.rs's
            // build_security_status) — mirror that lane, not the dictation one.
            llmProvider: next.privacy.meetingsAi.provider,
            remoteProcessingEnabled: next.privacy.remoteProcessingEnabled,
            exportRoot: next.privacy.exportRoot ?? null,
          }
        : current,
    );
  }, []);

  const flushPendingSettingsSave = useCallback(
    async (suppressUiState = false) => {
      const scheduler = saveSchedulerRef.current;
      if (scheduler.timer) {
        clearTimeout(scheduler.timer);
        scheduler.timer = null;
      }
      if (scheduler.flushing || !scheduler.pending) {
        return;
      }

      scheduler.flushing = true;
      if (!suppressUiState && mountedRef.current) {
        setIsSaving(true);
      }
      markSettingsPerf("settings-save-flush-start");

      try {
        while (scheduler.pending) {
          const queued = scheduler.pending;
          scheduler.pending = null;
          scheduler.inFlight = queued.patch;

          try {
            const baselineBeforeSave = persistedSettingsRef.current;
            await persistSettingsPatch(queued.patch);
            if (mountedRef.current) {
              setSettingsSaveError(null);
            }
            if (queued.version >= scheduler.latestAppliedVersion) {
              scheduler.latestAppliedVersion = queued.version;
              if (mountedRef.current) {
                const committed = persistedSettingsRef.current !== baselineBeforeSave
                  ? persistedSettingsRef.current ?? queued.settings
                  : applySettingsPatch(baselineBeforeSave ?? queued.settings, queued.patch);
                persistedSettingsRef.current = committed;
                setPersistedSettings(committed);
                applySecurityStatusFromSettings(committed);
                scheduler.inFlight = null;
                const pending = saveSchedulerRef.current.pending;
                const remaining = mergeSettingsPatches(
                  scheduler.failed,
                  ...(pending ? [pending.patch] : []),
                );
                const draft = applySettingsPatch(committed, remaining);
                latestSettingsRef.current = draft;
                setDraftSettings(draft);
                if (pending) pending.settings = draft;
              }
            }
            queued.waiters.forEach(({ resolve }) => resolve());
          } catch (e) {
            // Other callbacks can enqueue while the native write is awaited.
            const pending = saveSchedulerRef.current.pending;
            if (pending) {
              pending.patch = mergeSettingsPatches(queued.patch, pending.patch);
            } else {
              scheduler.failed = mergeSettingsPatches(scheduler.failed, queued.patch);
            }
            queued.waiters.forEach(({ reject }) => reject(e));
            if (mountedRef.current) {
              setSettingsSaveError(settingsSaveErrorMessage(e));
            }
          } finally {
            scheduler.inFlight = null;
          }
        }
      } finally {
        scheduler.flushing = false;
        if (!suppressUiState && mountedRef.current) {
          setIsSaving(false);
        }
        markSettingsPerf("settings-save-flush-end");
      }
    },
    [applySecurityStatusFromSettings],
  );

  const queueSettingsSave = useCallback(
    (
      next: Settings,
      debounceMs = SETTINGS_SAVE_DEBOUNCE_MS,
      awaitCompletion = false,
    ): Promise<void> | undefined => {
      const scheduler = saveSchedulerRef.current;
      settingsRevisionRef.current += 1;
      const previous = latestSettingsRef.current ?? persistedSettingsRef.current ?? next;
      // Each edit is compared with the preceding optimistic draft. Comparing
      // with disk would lose an explicit return to the original value.
      const patch = diffSettings(
        { ...previous, ai: undefined },
        { ...next, ai: undefined },
      );
      latestSettingsRef.current = next;
      scheduler.nextVersion += 1;
      let waiter: QueuedSettingsSave["waiters"][number] | undefined;
      const completion = awaitCompletion
        ? new Promise<void>((resolve, reject) => {
            waiter = { resolve, reject };
          })
        : undefined;
      scheduler.pending = {
        version: scheduler.nextVersion,
        settings: next,
        patch: mergeSettingsPatches(
          scheduler.failed,
          ...(scheduler.pending ? [scheduler.pending.patch] : []),
          patch,
        ),
        // Replacing a debounced snapshot subsumes it. Its callers therefore
        // complete only when the newer snapshot has actually landed.
        waiters: [
          ...(scheduler.pending?.waiters ?? []),
          ...(waiter ? [waiter] : []),
        ],
      };

      scheduler.failed = diffSettings({}, {});
      if (scheduler.timer) {
        clearTimeout(scheduler.timer);
      }
      scheduler.timer = setTimeout(() => {
        void flushPendingSettingsSave();
      }, debounceMs);
      markSettingsPerf("settings-save-queued");
      return completion;
    },
    [flushPendingSettingsSave],
  );

  const performReset = useCallback(async () => {
    setResettingApp(true);
    setError(null);
    try {
      const result = await resetAppState();
      // The reset already puts settings back to defaults, and the first-run
      // record lives there now, so the install comes back genuinely unset up.
      // The retired renderer flags are cleared too, in case this profile still
      // carries a pair written before the record existed.
      try {
        localStorage.removeItem(ONBOARDING_STORAGE_KEY);
        localStorage.removeItem(MEETING_ONBOARDING_STORAGE_KEY);
      } catch {
        // Nothing reads them any more.
      }
      toast(
        `Reset complete. Removed ${result.deletedRecordings} recordings and deleted ${result.deletedAudioFiles} audio files.`,
        "success",
      );
      if (
        result.failedAudioFileDeletions.length > 0 ||
        result.failedProviderSecretClears.length > 0
      ) {
        toast(
          "Reset completed with warnings. Open logs for file or keychain cleanup failures.",
          "error",
        );
      }
      window.location.reload();
    } catch (err) {
      const message =
        settingsErrorMessage(err, "Failed to reset application state");
      setError(message);
      toast(message, "error");
    } finally {
      setResettingApp(false);
    }
  }, [toast]);

  // Re-run the electron shortcut registration pass (which respawns the
  // native macOS helper) after permission diagnostics change, so a freshly
  // granted Accessibility permission activates hold-to-talk without an app
  // restart.
  const reapplyGlobalShortcuts = useCallback(async () => {
    try {
      await applyGlobalShortcutsNow();
    } catch (err) {
      console.warn("applyGlobalShortcutsNow failed:", err);
    }
  }, []);

  const formatShortcutFromKeyboardEvent = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      const parts: string[] = [];
      if (event.metaKey) parts.push("Cmd");
      if (event.ctrlKey) parts.push("Ctrl");
      if (event.altKey) parts.push("Alt");
      if (event.shiftKey) parts.push("Shift");

      const key = event.key;
      if (["Meta", "Control", "Alt", "Shift"].includes(key)) {
        return null;
      }
      if (parts.length === 0) {
        return null;
      }

      // Prefer the layout-position `event.code` for the main key: `event.key`
      // is the composed character, so Cmd+Alt+D would store "Cmd+Alt+∂" and
      // Shift+2 would store "@" — tokens both the Electron accelerator
      // conversion and the native macOS helper reject or mis-handle.
      const code = event.code;
      let mainKey = "";
      if (/^Key[A-Z]$/.test(code)) {
        mainKey = code.slice(3);
      } else if (/^Digit[0-9]$/.test(code)) {
        mainKey = code.slice(5);
      } else if (code in SHORTCUT_PUNCTUATION_BY_CODE) {
        mainKey = SHORTCUT_PUNCTUATION_BY_CODE[code];
      } else if (key === " " || code === "Space") {
        mainKey = "Space";
      } else if (key.length === 1) {
        mainKey = key.toUpperCase();
      } else {
        const normalized = key.startsWith("Arrow")
          ? key.replace("Arrow", "")
          : key;
        mainKey = normalized.charAt(0).toUpperCase() + normalized.slice(1);
      }

      return normalizeShortcut([...parts, mainKey].join("+"));
    },
    [],
  );

  const handleShortcutKeyDown = useCallback(
    (field: ShortcutFieldKey) => (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Tab") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();

      if (event.key === "Escape") {
        setCapturingShortcut(null);
        return;
      }

      const nextShortcut = formatShortcutFromKeyboardEvent(event);
      if (!nextShortcut) {
        return;
      }
      const current = latestSettingsRef.current;
      if (!current) {
        return;
      }

      const next: Settings = {
        ...current,
        shortcuts: {
          ...current.shortcuts,
          [field]: nextShortcut,
        },
      };
      setDraftSettings(next);
      setError(null);
      queueSettingsSave(next, 0);
      void flushPendingSettingsSave();
      setCapturingShortcut(null);
    },
    [
      flushPendingSettingsSave,
      formatShortcutFromKeyboardEvent,
      queueSettingsSave,
      settings,
    ],
  );

  const loadInitialSettings = useCallback(async () => {
    const revision = ++settingsRevisionRef.current;
    setInitialLoadFailed(false);
    markSettingsPerf("settings-initial-load-start");
    try {
      const loaded = await getSettings();
      if (mountedRef.current && revision === settingsRevisionRef.current) {
        latestSettingsRef.current = loaded;
        persistedSettingsRef.current = loaded;
        setDraftSettings(loaded);
        setPersistedSettings(loaded);
        setError(null);
        markSettingsPerf("settings-initial-load-complete");
      }
    } catch (loadError) {
      console.warn("Failed to load settings:", loadError);
      if (mountedRef.current && revision === settingsRevisionRef.current) {
        setInitialLoadFailed(true);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void loadInitialSettings();
    return () => {
      mountedRef.current = false;
      settingsRevisionRef.current += 1;
      void flushPendingSettingsSave(true);
    };
  }, [flushPendingSettingsSave, loadInitialSettings]);

  useEffect(() => {
    persistedSettingsRef.current = persistedSettings;
  }, [persistedSettings]);

  // Refresh clean paths from native broadcasts while retaining explicit
  // local edits, including writes that are in flight or failed.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void listen<Settings>("settings-changed", (event) => {
      if (!mountedRef.current) {
        return;
      }
      settingsRevisionRef.current += 1;
      const incoming = event.payload;
      const scheduler = saveSchedulerRef.current;
      const dirty = mergeSettingsPatches(
        scheduler.failed,
        ...(scheduler.inFlight ? [scheduler.inFlight] : []),
        ...(scheduler.pending ? [scheduler.pending.patch] : []),
      );
      const merged = applySettingsPatch(incoming, dirty);
      latestSettingsRef.current = merged;
      setDraftSettings(merged);
      if (scheduler.pending) scheduler.pending.settings = merged;
      persistedSettingsRef.current = incoming;
      setPersistedSettings(incoming);
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!settings || backupConfig || backupConfigLoadInFlightRef.current) {
      return;
    }

    let mounted = true;
    backupConfigLoadInFlightRef.current = true;
    setBackupConfigLoading(true);
    markSettingsPerf("settings-backup-config-load-start");

    const loadBackupConfig = async () => {
      try {
        const loadedBackupConfig = await withSettingsSectionTimeout(
          "Backup settings",
          getBackupConfig(),
        );
        if (mounted && mountedRef.current) {
          setBackupConfig(loadedBackupConfig);
          markSettingsPerf("settings-backup-config-load-complete");
        }
      } catch (e) {
        if (mounted && mountedRef.current) {
          console.warn("Failed to load backup settings:", e);
          markSettingsPerf("settings-backup-config-load-failed");
        }
      } finally {
        backupConfigLoadInFlightRef.current = false;
        if (mounted && mountedRef.current) {
          setBackupConfigLoading(false);
        }
      }
    };

    void loadBackupConfig();
    return () => {
      mounted = false;
    };
  }, [backupConfig, settings]);

  useEffect(() => {
    let mounted = true;
    if (!settings) return;
    if (
      !isRemoteAnalysisProvider(settings.privacy.meetingsAi.provider) ||
      settings.privacy.meetingsAi.provider === CHATGPT_PLAN_PROVIDER
    ) {
      setHasApiKey(false);
      return;
    }
      withSettingsSectionTimeout(
        "Provider secret status",
        hasProviderSecret(settings.privacy.meetingsAi.provider),
      )
      .then((value) => {
        if (mounted) {
          setHasApiKey(value);
        }
      })
      .catch((err) => {
        // Log but do not reset, a keychain error in dev or unsigned builds should not
        // wipe the "Stored securely" indicator from a successful save earlier.
        console.warn("hasProviderSecret check failed:", err);
      });
    return () => {
      mounted = false;
    };
  }, [settings?.privacy.meetingsAi.provider]);

  useEffect(() => {
    let mounted = true;
    if (
      !isRemoteAnalysisProvider(provider) ||
      provider === CHATGPT_PLAN_PROVIDER
    ) {
      setKeyManagerHasApiKey(false);
      return;
    }
    withSettingsSectionTimeout(
      "Key Manager provider secret status",
      hasProviderSecret(provider),
    )
      .then((value) => {
        if (mounted) {
          setKeyManagerHasApiKey(value);
        }
      })
      .catch((err) => {
        console.warn("hasProviderSecret check failed:", err);
      });
    return () => {
      mounted = false;
    };
  }, [provider]);

  useEffect(() => {
    const openRequest = (request: SettingsTabRequest) => {
      const section = resolveSettingsSection(request.tab);
      if (!SETTINGS_SECTIONS.some((tab) => tab.id === section)) {
        return;
      }
      setSettingsQuery("");
      setActiveTab(section);
      setPendingFocus(request.focus ?? null);
    };
    const pendingTab = consumePendingSettingsTab();
    if (pendingTab) {
      openRequest(pendingTab);
    }

    const handleOpenSettingsTab = (event: Event) => {
      const request = (event as CustomEvent<SettingsTabRequest | undefined>)
        .detail;
      if (request?.tab) {
        openRequest(request);
      }
    };

    window.addEventListener(
      OPEN_SETTINGS_TAB_EVENT,
      handleOpenSettingsTab as EventListener,
    );
    return () => {
      window.removeEventListener(
        OPEN_SETTINGS_TAB_EVENT,
        handleOpenSettingsTab as EventListener,
      );
    };
  }, []);

  useEffect(() => {
    markSettingsPerf(`settings-tab-open:${activeTab}`);
    // A new section starts at its top, not wherever the last one was left.
    contentScrollRef.current?.scrollTo?.({ top: 0 });
  }, [activeTab]);

  // Bring a search result or deep-linked row into view once its section has
  // rendered: open any "More options" it sits in, scroll to it, move focus
  // to its control, and mark it for a moment. Some rows wait on a load
  // (permissions, backups), so it looks again briefly before giving up.
  useEffect(() => {
    if (!pendingFocus) {
      return;
    }
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const reveal = () => {
      const target = document.getElementById(settingAnchorId(pendingFocus));
      if (!target) {
        attempts += 1;
        if (attempts < 10) {
          timer = setTimeout(reveal, 100);
        } else {
          setPendingFocus(null);
        }
        return;
      }
      for (
        let node: HTMLElement | null = target;
        node;
        node = node.parentElement
      ) {
        if (node instanceof HTMLDetailsElement) {
          node.open = true;
        }
      }
      target.scrollIntoView?.({ block: "center" });
      const control =
        target instanceof HTMLDetailsElement
          ? target.querySelector<HTMLElement>("summary")
          : target.querySelector<HTMLElement>(
              'button:not([disabled]), [role="switch"], [role="combobox"], input:not([disabled]), textarea, summary',
            );
      control?.focus({ preventScroll: true });
      target.classList.remove("setting-flash");
      void target.offsetWidth;
      target.classList.add("setting-flash");
      setPendingFocus(null);
    };
    timer = setTimeout(reveal, 0);
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [pendingFocus, activeTab]);

  useEffect(() => {
    if (permissionDiagnostics) {
      return;
    }

    let mounted = true;
    const loadPermissionDiagnostics = async () => {
      try {
        const [permissions, providers] = await Promise.all([
          withSettingsSectionTimeout(
            "Permission status",
            getPermissionDiagnostics(),
          ),
          getAsrProviders().catch(() => []),
        ]);
        if (mounted) {
          setPermissionDiagnostics(permissions);
          setAsrProviders(providers);
        }
      } catch (e) {
        if (mounted) {
          setError(
            settingsErrorMessage(e, "Failed to load permission status"),
          );
        }
      }
    };

    void loadPermissionDiagnostics();
    return () => {
      mounted = false;
    };
  }, [permissionDiagnostics]);

  // Whether the dictation AI lane can answer, re-probed whenever the lane's
  // provider or the remote-processing switch changes. Only the
  // translate-to-English toggle reads it.
  const dictationAiProvider = settings?.privacy.dictationAi.provider ?? null;
  const remoteProcessingEnabledForProbe =
    settings?.privacy.remoteProcessingEnabled ?? false;
  useEffect(() => {
    let mounted = true;
    if (!dictationAiProvider) {
      setDictationAiLaneReady(null);
      return;
    }
    void probeDictationAiLane({
      dictationAi: { provider: dictationAiProvider, modelId: null },
      remoteProcessingEnabled: remoteProcessingEnabledForProbe,
    }).then((ready) => {
      if (mounted) {
        setDictationAiLaneReady(ready);
      }
    });
    return () => {
      mounted = false;
    };
  }, [dictationAiProvider, remoteProcessingEnabledForProbe]);

  useEffect(() => {
    let mounted = true;
    getDictationShortcutCapabilityStatus()
      .then((status: DictationShortcutCapabilityStatus) => {
        if (mounted) {
          setNativeShortcutAvailable(status.nativeShortcutAvailable);
          setRemoteBindingIssues(status.bindingIssues ?? []);
        }
      })
      .catch((err) => {
        // A native-helper probe failure should not block settings; hold-to-talk
        // simply stays hidden and the honest toggle-only copy remains in place.
        console.warn("getDictationShortcutCapabilityStatus check failed:", err);
      });
    // Stay in sync when the helper crashes (or comes back) after mount, so
    // the UI stops promising hold-to-talk once the behavior degraded to
    // press-toggle.
    const unlistenPromise = listen<DictationShortcutCapabilityStatus>(
      "dictation-shortcut-capability-changed",
      (event) => {
        if (mounted) {
          setNativeShortcutAvailable(event.payload.nativeShortcutAvailable);
          setRemoteBindingIssues(event.payload.bindingIssues ?? []);
        }
      },
    );
    return () => {
      mounted = false;
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    getShortcutConflicts()
      .then((status) => {
        if (mounted) {
          setShortcutConflicts(normalizeShortcutConflicts(status));
        }
      })
      .catch((err) => {
        // A conflict-probe failure should not block settings; the shortcuts
        // section simply renders without the inline conflict warning.
        console.warn("getShortcutConflicts check failed:", err);
      });
    const unlistenPromise = listen<{ conflicts: ShortcutConflict[] }>(
      "shortcut-conflicts-changed",
      (event) => {
        if (mounted) {
          setShortcutConflicts(normalizeShortcutConflicts(event.payload));
        }
      },
    );
    return () => {
      mounted = false;
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    if (activeTab !== "privacy" || hasLoadedSecurityTab) {
      return;
    }

    let mounted = true;
    markSettingsPerf("settings-security-load-start");
    const loadSecurity = async () => {
      try {
        const security = await withSettingsSectionTimeout(
          "Security details",
          getSecurityStatus(),
        );
        if (mounted) {
          setSecurityStatus(security);
          setHasLoadedSecurityTab(true);
          markSettingsPerf("settings-security-load-complete");
        }
      } catch (e) {
        if (mounted) {
          setError(
            settingsErrorMessage(e, "Failed to load security details"),
          );
        }
      }
    };
    void loadSecurity();
    return () => {
      mounted = false;
    };
  }, [activeTab, hasLoadedSecurityTab]);

  useEffect(() => {
    if (activeTab !== "privacy" || hasLoadedStorageTab) {
      return;
    }

    let mounted = true;
    markSettingsPerf("settings-storage-load-start");
    const loadBackups = async () => {
      try {
        const loadedBackups = await withSettingsSectionTimeout(
          "Storage backups",
          listBackups(),
        );
        if (mounted) {
          setBackups(loadedBackups);
          setHasLoadedStorageTab(true);
          markSettingsPerf("settings-storage-load-complete");
        }
      } catch (e) {
        if (mounted) {
          setError(settingsErrorMessage(e, "Failed to load backups"));
        }
      }
    };
    void loadBackups();
    return () => {
      mounted = false;
    };
  }, [activeTab, hasLoadedStorageTab]);

  // Open the Key Manager on the credential the meetings lane needs, since
  // that's the lane whose provider the "no key saved" warning is about.
  useEffect(() => {
    if (!settings) return;
    const meetingsProvider = settings.privacy.meetingsAi.provider;
    if (
      isRemoteAnalysisProvider(meetingsProvider) &&
      meetingsProvider !== CHATGPT_PLAN_PROVIDER
    ) {
      setProvider(meetingsProvider);
    }
  }, [settings?.privacy.meetingsAi.provider]);

  // Function to refresh models for a specific provider
  const refreshModelsForProvider = useCallback(async (providerName: string) => {
    if (
      isRemoteAnalysisProvider(providerName) &&
      !settings?.privacy.remoteProcessingEnabled
    ) {
      return [];
    }
    // The two on-device providers serve exactly one model and have no
    // catalogue endpoint. Returning early (rather than falling through the
    // switch) keeps the "loading models…" spinner off a picker that will
    // never populate.
    if (isZeroSetupAnalysisProvider(providerName)) {
      return [];
    }
    setModelsLoading(true);
    try {
      switch (providerName) {
        case CHATGPT_PLAN_PROVIDER: {
          const status = await getChatGptPlanStatus();
          return status.models.map((model) => model.slug);
        }
        case "openai": {
          const models = normalizeProviderModelList(await listOpenAiModels());
          setOpenaiModels(models);
          return models;
        }
        case "anthropic": {
          const models = normalizeProviderModelList(await listAnthropicModels());
          setAnthropicModels(models);
          return models;
        }
        case "gemini": {
          const models = normalizeProviderModelList(await listGeminiModels());
          setGeminiModels(models);
          return models;
        }
        case "deepseek": {
          const models = normalizeProviderModelList(await listDeepSeekModels());
          setDeepseekModels(models);
          return models;
        }
        case "ollama-cloud": {
          if (!(await hasProviderSecret("ollama-cloud"))) {
            setOllamaCloudModels([]);
            return [];
          }
          const models = normalizeProviderModelList(
            await listOllamaCloudModels(),
          );
          setOllamaCloudModels(models);
          return models;
        }
        case "ollama": {
          const [available, models] = await Promise.all([
            getOllamaStatus(),
            listOllamaModels(),
          ]);
          const normalizedModels = normalizeProviderModelList(models);
          setOllamaAvailable(available);
          setOllamaModels(normalizedModels);
          return normalizedModels;
        }
      }
    } catch (e) {
      console.error(`Failed to refresh models for ${providerName}:`, e);
    } finally {
      setModelsLoading(false);
    }
    return [];
  }, [settings?.privacy.remoteProcessingEnabled]);

  const storedDiarizationModelId = settings?.transcription.diarizationModelId ?? "ecapa_tdnn_speaker";
  // A saved model the picker no longer offers (ERes2NetV2, turned off while
  // its license is unresolved) is never downloaded or run. Downloads and the
  // remembered-voices note follow the model the sidecar offers in its place.
  const storedDiarizationModelOffered =
    diarizationModels.length === 0 ||
    diarizationModels.some((model) => model.id === storedDiarizationModelId);
  const selectedDiarizationModelId = storedDiarizationModelOffered
    ? storedDiarizationModelId
    : diarizationPlanModelId ?? "ecapa_tdnn_speaker";
  const selectedDiarizationModel = diarizationModels.find(model => model.id === selectedDiarizationModelId);
  const diarizationAvailable = selectedDiarizationModel?.installed === true;

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      const models = await withSettingsSectionTimeout(
        "Diarization model list", listDiarizationModels(),
      ).catch(() => [] as DiarizationModelOption[]);
      if (!mounted) return;
      setDiarizationModels(models);
    };
    load();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        const plan = await withSettingsSectionTimeout(
          "Speaker model plan",
          getDiarizationModelPlan(),
        );
        if (mounted) {
          setDiarizationRunModelId(plan ? plan.runModelId : undefined);
          setDiarizationPlanModelId(plan?.selectedModelId);
        }
      } catch {
        if (mounted) {
          setDiarizationRunModelId(undefined);
          setDiarizationPlanModelId(undefined);
        }
      }
    };
    void load();
    return () => {
      mounted = false;
    };
  }, [storedDiarizationModelId, diarizationModels]);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      const avail = await withSettingsSectionTimeout(
        "Silero VAD availability",
        isSileroVadModelDownloaded(),
      ).catch(() => false);
      if (!mounted) return;
      setSileroVadAvailable(avail);
    };
    load();
    return () => {
      mounted = false;
    };
  }, []);

  // Opening settings may inspect the local Ollama service. Cloud catalogs
  // require choosing a provider, saving its key, or pressing Refresh models.
  useEffect(() => {
    if (activeTab !== "ai" && activeTab !== "models") return;
    let mounted = true;
    setModelsLoading(true);
    void Promise.all([getOllamaStatus(), listOllamaModels()])
      .then(([available, models]) => {
        if (!mounted) return;
        setOllamaAvailable(available);
        setOllamaModels(normalizeProviderModelList(models));
      })
      .catch((error) => {
        console.error("Failed to load local models:", error);
        if (!mounted) return;
        setOllamaAvailable(false);
        setOllamaModels([]);
      })
      .finally(() => {
        if (mounted) setModelsLoading(false);
      });
    return () => { mounted = false; };
  }, [activeTab]);

  const updateSettings = useCallback(
    (
      next: Settings,
      options?: { immediate?: boolean; debounceMs?: number },
    ) => {
      // Publish before the state update, not after: React flushes pending
      // passive effects *before* it renders the change, so an effect scheduled
      // by an earlier commit runs between this call and the re-render. Setting
      // the ref here is what lets that effect see this edit instead of the
      // snapshot it closed over.
      setDraftSettings(next);
      setError(null);
      setSettingsSaveError(null);

      if (options?.immediate) {
        queueSettingsSave(next, 0);
        void flushPendingSettingsSave();
        return;
      }
      queueSettingsSave(next, options?.debounceMs ?? SETTINGS_SAVE_DEBOUNCE_MS);
    },
    [flushPendingSettingsSave, queueSettingsSave],
  );

  const persistSavedPrompts = useCallback(
    async (next: readonly SavedPrompt[]): Promise<boolean> => {
      const current = latestSettingsRef.current;
      if (!current) return false;
      setSavedPromptsSaveError(null);
      try {
        const savedPrompts = await setSavedPrompts(next);
        settingsRevisionRef.current += 1;
        const ai = { savedPrompts };
        const latest = latestSettingsRef.current;
        if (latest) {
          latestSettingsRef.current = { ...latest, ai };
          setDraftSettings((draft) => draft ? { ...draft, ai } : draft);
        }
        const scheduler = saveSchedulerRef.current;
        if (scheduler.pending) {
          scheduler.pending.settings = { ...scheduler.pending.settings, ai };
        }
        if (persistedSettingsRef.current) {
          persistedSettingsRef.current = { ...persistedSettingsRef.current, ai };
          setPersistedSettings(persistedSettingsRef.current);
        }
        return true;
      } catch (e) {
        const message =
          settingsErrorMessage(e, "Plainsong could not save your prompts.");
        if (mountedRef.current) {
          setSavedPromptsSaveError(message);
          setError(message);
        }
        return false;
      }
    },
    [],
  );

  // Background corrections join the pending patch without restarting its timer.
  const patchSettings = useCallback(
    (applyPatch: (previous: Settings) => Settings) => {
      const current = latestSettingsRef.current;
      if (!current) {
        return;
      }

      const scheduler = saveSchedulerRef.current;
      if (scheduler.pending) {
        settingsRevisionRef.current += 1;
        scheduler.pending = {
          version: scheduler.pending.version,
          settings: applyPatch(scheduler.pending.settings),
          patch: mergeSettingsPatches(
            scheduler.pending.patch,
            diffSettings(current, applyPatch(current)),
          ),
          waiters: scheduler.pending.waiters,
        };
        latestSettingsRef.current = applyPatch(current);
        setDraftSettings((previous) =>
          previous ? applyPatch(previous) : previous,
        );
        return;
      }

      updateSettings(applyPatch(current), { immediate: true });
    },
    [updateSettings],
  );

  const getCachedModelsForProvider = useCallback(
    (providerName: string) => {
      switch (providerName) {
        case "ollama":
          return ollamaModels;
        case "openai":
          return openaiModels;
        case "anthropic":
          return anthropicModels;
        case "gemini":
          return geminiModels;
        case "deepseek":
          return deepseekModels;
        case "ollama-cloud":
          return ollamaCloudModels;
        default:
          return [];
      }
    },
    [
      anthropicModels,
      deepseekModels,
      geminiModels,
      ollamaCloudModels,
      ollamaModels,
      openaiModels,
    ],
  );

  const updateAnalysisModel = useCallback(
    (lane: AiLaneKey, modelId: string | null) => {
      if (!settings) {
        return;
      }

      void updateSettings({
        ...settings,
        privacy: {
          ...settings.privacy,
          [lane]: { ...settings.privacy[lane], modelId },
        },
      });
    },
    [settings, updateSettings],
  );

  const updateAnalysisProvider = useCallback(
    async (lane: AiLaneKey, providerName: string) => {
      if (!settings) {
        return;
      }

      // Model ids belong to one provider. Switching providers clears the old
      // id and lets the new provider use its backend default until the reader
      // explicitly chooses another model.
      const initialSettings = {
        ...settings,
        privacy: {
          ...settings.privacy,
          [lane]: { provider: providerName, modelId: null },
        },
      };

      void updateSettings(initialSettings, { immediate: true });
      await refreshModelsForProvider(providerName);
    },
    [
      refreshModelsForProvider,
      settings,
      updateSettings,
    ],
  );

  useEffect(() => {
    if (!settings) {
      return;
    }
    const nextScheme = normalizeThemeScheme(settings.ui.colorScheme);
    applyThemeScheme(nextScheme);
    if (nextScheme !== settings.ui.colorScheme) {
      void updateSettings(
        {
          ...settings,
          ui: {
            ...settings.ui,
            colorScheme: nextScheme,
          },
        },
        { immediate: true },
      );
    }
  }, [settings, updateSettings]);

  const refreshBackups = useCallback(async () => {
    const data = await listBackups();
    setBackups(data);
    setHasLoadedStorageTab(true);
  }, []);

  const refreshAudioDevices = useCallback(async () => {
    try {
      const inventory = await listAudioInputDevices();
      setAudioDeviceInventory(inventory);
    } catch (audioError) {
      console.warn("Failed to load audio input devices:", audioError);
      setAudioDeviceInventory(null);
    }
  }, []);

  const refreshSystemAudioCapability = useCallback(async () => {
    try {
      setSystemAudioCapability(await getSystemAudioCapability());
      setSystemAudioCheckFailed(false);
    } catch (systemAudioError) {
      console.warn("Failed to inspect system audio:", systemAudioError);
      setSystemAudioCapability(null);
      setSystemAudioCheckFailed(true);
    }
  }, []);

  const runSystemAudioTest = useCallback(async () => {
    setSystemAudioTestLoading(true);
    setSystemAudioTestStatus("Checking the meeting audio. If macOS asks, choose Allow.");
    try {
      const result = await testSystemAudioCapture();
      setSystemAudioCapability(result.capability);
      setSystemAudioCheckFailed(false);
      setSystemAudioTestStatus(
        result.capability.ready && result.verificationMethod === "external_audio"
          ? `Heard real audio through ${result.capability.routeDevice ?? "the current device"}.`
          : describeMeetingAudio(result.capability).sentence,
      );
    } catch (systemAudioError) {
      setSystemAudioCheckFailed(true);
      setSystemAudioTestStatus(
        settingsErrorMessage(
          systemAudioError,
          "The meeting audio check could not run. Try again.",
        ),
      );
    } finally {
      setSystemAudioTestLoading(false);
    }
  }, []);

  const resolveAudioDevicePreference = useCallback(
    (deviceId: string | null): Settings["audio"]["preferredInputDevice"] => {
      if (!deviceId || !audioDeviceInventory) {
        return null;
      }
      const device = audioDeviceInventory.devices.find(
        (candidate) => candidate.deviceId === deviceId,
      );
      if (!device) {
        return null;
      }
      return {
        deviceId: device.deviceId,
        deviceName: device.deviceName,
        transportType: device.transportType ?? null,
      };
    },
    [audioDeviceInventory],
  );

  const hasUnsavedChanges = useMemo(() => {
    if (!draftSettings || !persistedSettings) {
      return false;
    }
    return JSON.stringify(draftSettings) !== JSON.stringify(persistedSettings);
  }, [draftSettings, persistedSettings]);

  const currentAudioDevices = audioDeviceInventory?.devices ?? [];
  const appWideDeviceId = settings?.audio.preferredInputDevice?.deviceId ?? "";
  const dictationDeviceId =
    settings?.audio.dictationInputDevice?.deviceId ?? "";
  const meetingDeviceId = settings?.audio.meetingInputDevice?.deviceId ?? "";
  const dictationActiveLanguages = normalizeActiveLanguageSet(
    settings?.transcription.dictationActiveLanguages,
  );
  const saveStateLabel = isSaving
    ? "Saving…"
    : hasUnsavedChanges
      ? "Unsaved changes"
      : "All changes saved";
  const handleSettingsTextBlur = useCallback(() => {
    void flushPendingSettingsSave();
  }, [flushPendingSettingsSave]);

  const handleSettingsTextKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== "Enter") {
        return;
      }
      event.preventDefault();
      void flushPendingSettingsSave();
    },
    [flushPendingSettingsSave],
  );

  useEffect(() => {
    return () => {
      if (micTestPlaybackUrl) URL.revokeObjectURL(micTestPlaybackUrl);
    };
  }, [micTestPlaybackUrl]);

  useEffect(() => {
    void refreshAudioDevices();
    void refreshSystemAudioCapability();
  }, [refreshAudioDevices, refreshSystemAudioCapability]);

  const { start: startMicLevel, stop: stopMicLevel, getStream: getMicTestStream } =
    micTest;

  const stopMicTest = useCallback(() => {
    stopMicLevel();
    setMicTestRecording(false);
  }, [stopMicLevel]);

  const startMicTest = useCallback(async () => {
    const preferredDevice = settings?.audio.dictationInputOverrideEnabled
      ? settings.audio.dictationInputDevice
      : settings?.audio.preferredInputDevice;
    await startMicLevel(preferredDevice ?? null);
  }, [
    settings?.audio.dictationInputDevice,
    settings?.audio.dictationInputOverrideEnabled,
    settings?.audio.preferredInputDevice,
    startMicLevel,
  ]);

  const recordMicTest = useCallback(async () => {
    const stream = getMicTestStream();
    if (!stream) return;
    if (micTestPlaybackUrl) {
      setMicTestPlaybackUrl(null);
    }
    micTestChunksRef.current = [];
    const recorder = new MediaRecorder(stream);
    micTestRecorderRef.current = recorder;
    recorder.ondataavailable = (e) => micTestChunksRef.current.push(e.data);
    recorder.onstop = () => {
      if (!mountedRef.current) return;
      const blob = new Blob(micTestChunksRef.current, { type: "audio/webm" });
      setMicTestPlaybackUrl(URL.createObjectURL(blob));
      setMicTestRecording(false);
    };
    setMicTestRecording(true);
    recorder.start();
    setTimeout(() => {
      if (micTestRecorderRef.current?.state === "recording") {
        micTestRecorderRef.current.stop();
      }
    }, 3000);
  }, [getMicTestStream, micTestPlaybackUrl]);

  // The live answer, from the same `findConflictingShortcuts` Electron runs
  // at registration time (imported from the electron module, so the two
  // layers cannot drift) — including the dictation binding table, which
  // Electron registers *first*, so a binding on Open window's keys shows up
  // here as Open window losing rather than as nothing at all. Recomputed on
  // every render so a freshly-typed shortcut or a just-recorded binding is
  // flagged immediately, without waiting on a save round-trip. The backend's
  // get_shortcut_conflicts result (fetched once above) is merged in as a
  // fallback so a conflict the server already knows about (e.g. detected at
  // startup) still shows even before settings finish loading into this form.
  // Must run before the `if (!settings)` early return below to keep hook
  // call order stable across renders.
  const localShortcutConflictsByField = useMemo(() => {
    const byField = new Map<ShortcutFieldKey, ShortcutConflict>();
    if (!settings) {
      return byField;
    }
    const conflicts = findConflictingShortcuts(
      settings.shortcuts,
      dictationBindingConflictSources(
        resolveDictationBindings(settings.shortcuts),
        (settings.transcription.dictationCustomModes ?? []).map((mode) => ({
          id: mode.id,
          name: mode.name,
        })),
      ),
    );
    for (const conflict of conflicts) {
      if (!byField.has(conflict.field)) {
        byField.set(conflict.field, conflict);
      }
    }
    return byField;
  }, [settings]);

  const shortcutConflictsByField = useMemo(() => {
    const byField = new Map<ShortcutFieldKey, ShortcutConflict>(
      localShortcutConflictsByField,
    );
    for (const conflict of shortcutConflicts) {
      if (!byField.has(conflict.field)) {
        byField.set(conflict.field, conflict);
      }
    }
    return byField;
  }, [localShortcutConflictsByField, shortcutConflicts]);

  if (!settings) {
    if (initialLoadFailed) {
      return (
        <div className="flex h-full items-center justify-center px-6">
          <div
            role="alert"
            className="max-w-md rounded-2xl border border-destructive/25 bg-destructive/10 p-5 text-sm text-destructive"
          >
            <div className="flex items-start gap-3">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-medium">Settings could not load</p>
                <p className="mt-1 leading-6 text-destructive/85">
                  Plainsong could not open your settings right now. Try again.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-4"
                  onClick={() => void loadInitialSettings()}
                >
                  Try again
                </Button>
              </div>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 mr-2 animate-spin" />
        Loading settings…
      </div>
    );
  }

  const dictationRecognizer = resolveDictationRecognizer(settings.transcription);
  const translateAvailability = resolveTranslateToEnglishAvailability({
    provider: dictationRecognizer.provider,
    modelId: dictationRecognizer.modelId,
    aiLaneReady: dictationAiLaneReady,
  });

  const savedDictationBindings = resolveDictationBindings(settings.shortcuts);
  // The draft row (if any) renders last, after everything actually stored.
  // It is never part of what gets saved.
  const dictationBindings = draftBinding
    ? [...savedDictationBindings, draftBinding]
    : savedDictationBindings;
  const dictationCustomModes = (settings.transcription.dictationCustomModes ?? []).map(
    (mode) => ({ id: mode.id, name: mode.name }),
  );
  // Local validation first (it sees the row the user is editing right now);
  // Electron's last verdict fills in anything it knows that this screen
  // cannot, such as a helper that died since the page loaded.
  const bindingIssuesById = new Map<string, DictationBindingIssue>();
  for (const issue of [
    ...validateDictationBindings(dictationBindings, {
      nativeShortcutAvailable,
      customModes: dictationCustomModes,
    }),
    ...remoteBindingIssues,
  ]) {
    if (!bindingIssuesById.has(issue.bindingId)) {
      bindingIssuesById.set(issue.bindingId, issue);
    }
  }

  const saveDictationBindings = (next: DictationBinding[]) => {
    const primary = findPrimaryDictationBinding(next);
    updateSettings(
      {
        ...settings,
        shortcuts: {
          ...settings.shortcuts,
          dictationBindings: next,
          // Kept in step for the legacy readers (menu bar, sidebar copy) and
          // for the local conflict check against "Open window".
          toggleDictation:
            primary?.trigger.kind === "key" ? primary.trigger.accelerator : "",
        },
      },
      { immediate: true },
    );
  };

  const updateDictationBinding = (
    bindingId: string,
    patch: Partial<DictationBinding>,
  ) => {
    if (draftBinding && bindingId === draftBinding.id) {
      const next = { ...draftBinding, ...patch };
      // The draft becomes a real, saved row the instant it has a trigger the
      // sidecar will keep -- and not one edit sooner, because a row with an
      // empty accelerator is dropped on the way to disk and then vanishes
      // from the screen on the next reload.
      if (isRecordedDictationTrigger(next.trigger)) {
        setDraftBinding(null);
        saveDictationBindings([...savedDictationBindings, next]);
      } else {
        setDraftBinding(next);
      }
      return;
    }
    saveDictationBindings(
      savedDictationBindings.map((binding) =>
        binding.id === bindingId ? { ...binding, ...patch } : binding,
      ),
    );
  };

  const removeDictationBinding = (bindingId: string) => {
    if (draftBinding && bindingId === draftBinding.id) {
      // Nothing was ever written, so there is nothing to save.
      setDraftBinding(null);
      if (recordingBindingId === bindingId) {
        setRecordingBindingId(null);
      }
      return;
    }
    saveDictationBindings(
      savedDictationBindings.filter((candidate) => candidate.id !== bindingId),
    );
  };

  const bindingActionValue = (action: DictationBindingAction): string => {
    if (action.kind === "cycleMode") return "cycleMode";
    if (action.kind === "cancel") return "cancel";
    return action.modeId === null ? "dictation" : `dictation:${action.modeId}`;
  };

  const bindingActionFromValue = (
    value: string,
    current: DictationBindingAction,
  ): DictationBindingAction => {
    if (value === "cycleMode") return { kind: "cycleMode" };
    if (value === "cancel") return { kind: "cancel" };
    const behavior = current.kind === "dictation" ? current.behavior : "inherit";
    const submit =
      current.kind === "dictation" && current.submitAfterInsert === true
        ? { submitAfterInsert: true }
        : {};
    if (value === "dictation") return { kind: "dictation", modeId: null, behavior, ...submit };
    return { kind: "dictation", modeId: value.slice("dictation:".length), behavior, ...submit };
  };

  const bindingTriggerTypeValue = (trigger: DictationBindingTrigger): string => {
    if (trigger.kind === "mouse") return `mouse:${trigger.button}`;
    const lone = trigger.accelerator.trim().toLowerCase();
    if (lone === "fn") return "modifier:Fn";
    if (lone === "rightcommand") return "modifier:RightCommand";
    if (lone === "rightoption") return "modifier:RightOption";
    return "keys";
  };

  const bindingTriggerFromTypeValue = (
    value: string,
    current: DictationBindingTrigger,
  ): DictationBindingTrigger => {
    if (value.startsWith("mouse:")) {
      const button = Number(value.slice("mouse:".length)) as 3 | 4 | 5;
      return { kind: "mouse", button, modifiers: [] };
    }
    if (["modifier:Fn", "modifier:RightCommand", "modifier:RightOption"].includes(value)) {
      return { kind: "key", accelerator: value.slice("modifier:".length) };
    }
    // Back to keys: keep a recorded chord, otherwise leave it for the recorder.
    return current.kind === "key" && bindingTriggerTypeValue(current) === "keys"
      ? current
      : { kind: "key", accelerator: "" };
  };

  const handleBindingRecorderKeyDown =
    (bindingId: string) => (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Tab") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setRecordingBindingId(null);
        return;
      }
      const nextShortcut = formatShortcutFromKeyboardEvent(event);
      if (!nextShortcut) {
        return;
      }
      updateDictationBinding(bindingId, {
        trigger: { kind: "key", accelerator: nextShortcut },
      });
      setRecordingBindingId(null);
    };

  // An extra mouse button pressed on a row's own recorder becomes a mouse
  // trigger. DOM numbers them 1 (middle), 3 (back), 4 (forward); Plainsong
  // uses 3-5.
  //
  // There is deliberately no "is this recorder already listening" check:
  // `mousedown` fires BEFORE `focus`, so requiring `recordingBindingId` to
  // already name this row threw away the first click on an unfocused
  // recorder -- the user had to click once to focus and again to bind. The
  // gate that remains is the same one `onFocus` applies: a row whose trigger
  // type is "Fn on its own" is not recording anything.
  const handleBindingRecorderMouseDown =
    (bindingId: string, recordable: boolean) =>
    (event: ReactMouseEvent<HTMLInputElement>) => {
      const button =
        event.button === 1 ? 3 : event.button === 3 ? 4 : event.button === 4 ? 5 : null;
      if (button === null || !recordable) {
        return;
      }
      event.preventDefault();
      const modifiers: string[] = [];
      if (event.metaKey) modifiers.push("Cmd");
      if (event.ctrlKey) modifiers.push("Ctrl");
      if (event.altKey) modifiers.push("Alt");
      if (event.shiftKey) modifiers.push("Shift");
      updateDictationBinding(bindingId, { trigger: { kind: "mouse", button, modifiers } });
      setRecordingBindingId(null);
    };

  const renderDictationBindingRow = (binding: DictationBinding, index: number) => {
    const isPrimary =
      binding.trigger.kind === "key" &&
      binding.action.kind === "dictation" &&
      binding.action.modeId === null &&
      findPrimaryDictationBinding(dictationBindings)?.id === binding.id;
    const rowLabel = isPrimary ? "Dictation" : `Binding ${index + 1}`;
    const triggerType = bindingTriggerTypeValue(binding.trigger);
    const isRecording = recordingBindingId === binding.id;
    const issue = bindingIssuesById.get(binding.id);
    // A saved `hold` row on a machine whose helper is not running: Electron's
    // press-only fallback runs it as toggle (see
    // `resolveDictationShortcutCapability`), so the row has to say so rather
    // than silently reading as something else.
    // "Fn on its own" needs no recorder; everything else records.
    const triggerIsRecordable = triggerType === "keys" || binding.trigger.kind === "mouse";
    const holdWithoutHelper =
      !nativeShortcutAvailable &&
      binding.action.kind === "dictation" &&
      binding.action.behavior === "hold";
    const triggerText =
      binding.trigger.kind === "key" && !binding.trigger.accelerator.trim()
        ? "None"
        : binding.trigger.kind === "key" && triggerType === "keys"
          ? formatShortcutForDisplay(binding.trigger.accelerator)
          : describeDictationBindingTrigger(binding.trigger);
    return (
      <div
        key={binding.id}
        className="flex flex-col gap-3 rounded-lg border border-border/60 p-3"
      >
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium">{rowLabel}</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 px-2.5 text-muted-foreground hover:text-foreground"
            aria-label={`Remove ${rowLabel.toLowerCase()} binding`}
            onClick={() => removeDictationBinding(binding.id)}
          >
            Remove
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <OptionSelect
            aria-label={`${rowLabel} trigger type`}
            aria-describedby="dictation-bindings-description"
            className="h-9 w-auto min-w-40"
            value={triggerType}
            onValueChange={(value) =>
              updateDictationBinding(binding.id, {
                trigger: bindingTriggerFromTypeValue(value, binding.trigger),
              })
            }
          >
            <option value="keys">Keys</option>
            <option value="modifier:Fn">Fn on its own</option>
            <option value="modifier:RightCommand">Right Command on its own</option>
            <option value="modifier:RightOption">Right Option on its own</option>
            <option value="mouse:3">Middle mouse button</option>
            <option value="mouse:4">Mouse button 4</option>
            <option value="mouse:5">Mouse button 5</option>
          </OptionSelect>
          <div className="w-36 shrink-0">
            <Input
              value={isRecording ? "Listening..." : triggerText}
              readOnly
              aria-label={isPrimary ? "Dictation shortcut" : `${rowLabel} trigger`}
              aria-invalid={issue ? true : undefined}
              className={`h-9 w-36 text-center font-mono text-xs ${
                isRecording
                  ? "border-primary ring-1 ring-primary"
                  : issue
                    ? "border-destructive/60"
                    : ""
              }`}
              onFocus={() => {
                if (triggerIsRecordable) {
                  setRecordingBindingId(binding.id);
                }
              }}
              onBlur={() => {
                if (recordingBindingId === binding.id) {
                  setRecordingBindingId(null);
                }
              }}
              onKeyDown={handleBindingRecorderKeyDown(binding.id)}
              onMouseDown={handleBindingRecorderMouseDown(binding.id, triggerIsRecordable)}
            />
          </div>
          <OptionSelect
            aria-label={`${rowLabel} action`}
            aria-describedby="dictation-bindings-description"
            className="h-9 w-auto min-w-40"
            value={bindingActionValue(binding.action)}
            onValueChange={(value) =>
              updateDictationBinding(binding.id, {
                action: bindingActionFromValue(value, binding.action),
              })
            }
          >
            <option value="dictation">Dictation in the selected profile</option>
            {DICTATION_MODE_CYCLE_ORDER.map((preset) => (
              <option key={preset} value={`dictation:${preset}`}>
                Dictation · {dictationModeLabelFor(preset, dictationCustomModes)}
              </option>
            ))}
            {dictationCustomModes.map((mode) => (
              <option key={mode.id} value={`dictation:${mode.id}`}>
                Dictation · {mode.name}
              </option>
            ))}
            <option value="cycleMode">Next profile</option>
            <option value="cancel">Cancel dictation</option>
          </OptionSelect>
          {binding.action.kind === "dictation" && (
            <OptionSelect
              aria-label={`${rowLabel} behavior`}
              aria-describedby="dictation-bindings-description"
              className="h-9 w-auto min-w-40"
              value={binding.action.behavior}
              onValueChange={(value) =>
                updateDictationBinding(binding.id, {
                  action: {
                    ...(binding.action as Extract<
                      DictationBindingAction,
                      { kind: "dictation" }
                    >),
                    behavior: value as "toggle" | "hold" | "inherit",
                  },
                })
              }
            >
              <option value="inherit">Follows the setting above</option>
              <option value="toggle">Press to start, press to stop</option>
              {/* Always rendered, disabled without the helper. Hiding it left
                  a saved `hold` row with no matching option, so the row
                  misreported the stored behavior (a native select showed
                  "Follows the setting above" while it was still hold). */}
              <option value="hold" disabled={!nativeShortcutAvailable}>
                {nativeShortcutAvailable
                  ? "Hold to record, release to stop"
                  : "Hold to record (needs Accessibility)"}
              </option>
            </OptionSelect>
          )}
        </div>
        {binding.action.kind === "dictation" && (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 accent-gold"
              aria-label={`Press Return after inserting (${rowLabel})`}
              aria-describedby={`${binding.id}-submit-description`}
              checked={binding.action.submitAfterInsert === true}
              onChange={(event) =>
                updateDictationBinding(binding.id, {
                  action: {
                    ...(binding.action as Extract<
                      DictationBindingAction,
                      { kind: "dictation" }
                    >),
                    submitAfterInsert: event.target.checked,
                  },
                })
              }
            />
            <span>
              <span className="font-medium">Press Return after inserting</span>
              <span
                id={`${binding.id}-submit-description`}
                className="block text-sm text-muted-foreground"
              >
                Presses Return once Plainsong confirms the text is in the same
                field. In chat and AI prompt boxes this sends the message before
                you can review it. Off by default. To send only sometimes, add a
                second binding with this on.
              </span>
            </span>
          </label>
        )}
        {holdWithoutHelper && !issue && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <p className="text-sm text-muted-foreground">
              Hold works once Accessibility is on for Plainsong. Until then,
              this binding presses to start and presses again to stop.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              aria-label={`Open System Settings to turn on Accessibility for ${rowLabel.toLowerCase()} hold`}
              onClick={() => void openPermissionSettings("accessibility")}
            >
              Open System Settings
            </Button>
          </div>
        )}
        {issue && (
          <div className="flex items-start gap-2 rounded-xl border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{issue.message}</span>
          </div>
        )}
      </div>
    );
  };

  // A saved per-binding `hold` uses the lock options too, so they show for
  // any hold binding, not only when the shared behavior is hold.
  const holdLockOptionsApply =
    dictationShortcutBehavior === "hold_to_talk" ||
    dictationBindings.some(
      (binding) =>
        binding.action.kind === "dictation" && binding.action.behavior === "hold",
    );

  // One-field writers, so each row below says what it changes and nothing
  // else. They read the same render's `settings`, as every handler here does.
  const updateTranscription = (patch: Partial<Settings["transcription"]>) =>
    void updateSettings({
      ...settings,
      transcription: { ...settings.transcription, ...patch },
    });
  const updateUi = (patch: Partial<Settings["ui"]>) =>
    void updateSettings({ ...settings, ui: { ...settings.ui, ...patch } });
  const updateMeetings = (patch: Partial<typeof meetingsSettings>) =>
    void updateSettings({
      ...settings,
      meetings: { ...meetingsSettings, ...patch },
    });
  const updateNotifications = (patch: Partial<typeof notificationsSettings>) =>
    void updateSettings({
      ...settings,
      notifications: { ...notificationsSettings, ...patch },
    });

  const activeSection =
    SETTINGS_SECTIONS.find((section) => section.id === activeTab) ??
    SETTINGS_SECTIONS[0];
  const searchResults = searchSettings(settingsQuery);
  const searching = settingsQuery.trim().length > 0;
  const openSearchResult = (entry: SettingsIndexEntry) => {
    setSettingsQuery("");
    setActiveTab(entry.section);
    setPendingFocus(entry.sectionOnly ? null : entry.id);
  };

  // The microphone the whole app records from: the chosen one, or the
  // system default when none is chosen. Only its Bluetooth warning shows.
  const effectiveMicrophone =
    currentAudioDevices.find((device) =>
      appWideDeviceId ? device.deviceId === appWideDeviceId : device.isDefault,
    ) ?? null;

  const renderDictationShortcutBehavior = () => (
    <>
      <SettingsOptionSelect
        settingId="shortcut-behavior"
        label="How the dictation shortcut works"
        description={dictationShortcutBehaviorHint}
        selectClassName="@md:w-72"
        value={dictationShortcutBehavior}
        onChange={(value) => {
          const behavior = value as DictationHotkeyBehavior;
          updateTranscription({
            dictationPushToTalk: behavior === "hold_to_talk",
            dictationHandsFreeEnabled: behavior === "hands_free",
          });
        }}
      >
        <option value="toggle">
          Press to start, press again to stop
        </option>
        {/* Always listed, so a saved hold-to-talk choice never shows
            as an empty box while the key helper is down or starting. */}
        <option value="hold_to_talk" disabled={!nativeShortcutAvailable}>
          {nativeShortcutAvailable
            ? "Hold to record, release to stop"
            : "Hold to record, release to stop (needs Accessibility)"}
        </option>
        <option value="hands_free">
          Start on its own when you speak
        </option>
      </SettingsOptionSelect>
      {holdLockOptionsApply && (
        <SettingsSwitch
          label="Double-tap to lock"
          description="In hold mode, two quick taps keep listening until you press again. Replaces single-tap locking while on, including for Fn."
          checked={settings.transcription.dictationDoubleTapToLock === true}
          onCheckedChange={(checked) =>
            updateTranscription({ dictationDoubleTapToLock: checked })
          }
        />
      )}
      {holdLockOptionsApply && (
        <SettingsSwitch
          label="Tap to lock"
          description="A quick tap keeps listening without holding the key; tap again to finish. Holding still works."
          checked={settings.transcription.dictationTapToLock !== false}
          onCheckedChange={(checked) =>
            updateTranscription({ dictationTapToLock: checked })
          }
        />
      )}
    </>
  );

  const renderShortcutsSection = () => (
    <div className="settings-section">
      <SettingsGroup title="Starting and stopping">
        {renderDictationShortcutBehavior()}
      </SettingsGroup>

      <SettingsGroup
        title="Dictation shortcuts"
        settingId="dictation-bindings"
        descriptionId="dictation-bindings-description"
        description={
          <>
            Each one starts dictation in the selected profile or a named one,
            moves to the next profile, or cancels.{" "}
            {nativeShortcutAvailable
              ? "Mouse buttons, Fn and right-side modifier keys on their own work too."
              : "Mouse buttons, Fn and right-side modifier keys on their own work once Accessibility is on for Plainsong."}
          </>
        }
      >
        <div className="grid gap-3 py-3.5">
          {dictationBindings.map(renderDictationBindingRow)}
          {dictationBindings.length === 0 && (
            <p className="text-sm text-rust">
              No dictation shortcut. Add one or choose Reset to default.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={draftBinding !== null}
              onClick={() => {
                const id = `binding-${Date.now().toString(36)}`;
                // Held locally, not saved: see `draftBinding`.
                setDraftBinding({
                  id,
                  trigger: { kind: "key", accelerator: "" },
                  action: { kind: "dictation", modeId: null, behavior: "inherit" },
                });
                setRecordingBindingId(id);
              }}
            >
              Add binding
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDraftBinding(null);
                saveDictationBindings([
                  {
                    id: "primary",
                    trigger: { kind: "key", accelerator: defaultDictationShortcut() },
                    action: { kind: "dictation", modeId: null, behavior: "inherit" },
                  },
                ]);
              }}
            >
              Reset to default
            </Button>
          </div>
        </div>
      </SettingsGroup>

      <SettingsGroup
        title="Other shortcuts"
        settingId="other-shortcuts"
        description="Get the last result back, or bring Plainsong forward."
      >
        {SHORTCUT_FIELD_CONFIG.filter(({ key }) => key !== "toggleDictation").map(({ key, label }) => {
          const currentVal = settings.shortcuts[key]
            ? formatShortcutForDisplay(settings.shortcuts[key])
            : "None";
          const isCapturing = capturingShortcut === key;
          const conflict = shortcutConflictsByField.get(key);
          return (
            <div key={key} className="py-3">
              <div className="flex items-center justify-between gap-4">
                <span className="text-sm font-medium">{label}</span>
                <div className="flex items-center gap-1">
                  <div className="w-36 shrink-0">
                    <Input
                      value={isCapturing ? "Listening..." : currentVal}
                      readOnly
                      aria-label={`${label} shortcut`}
                      aria-invalid={conflict ? true : undefined}
                      className={`h-9 w-36 text-center font-mono text-xs ${isCapturing ? "border-primary ring-1 ring-primary" : conflict ? "border-destructive/60" : ""}`}
                      onFocus={() => setCapturingShortcut(key)}
                      onBlur={() => {
                        if (capturingShortcut === key) {
                          setCapturingShortcut(null);
                        }
                      }}
                      onKeyDown={handleShortcutKeyDown(key)}
                    />
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-9 px-3"
                    aria-label={`Clear ${label} shortcut`}
                    onClick={() => {
                      const current = latestSettingsRef.current;
                      if (!current) return;
                      const next: Settings = {
                        ...current,
                        shortcuts: { ...current.shortcuts, [key]: "" },
                      };
                      setDraftSettings(next);
                      queueSettingsSave(next, 0);
                    }}
                  >
                    Clear
                  </Button>
                </div>
              </div>
              {conflict && (
                <div className="mt-2 flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    Same keys as {conflict.conflictsWith} — only one of them
                    will work.
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </SettingsGroup>
    </div>
  );

  const renderGeneralSection = () => (
    <div className="settings-section">
      <SettingsGroup title="Appearance and window">
        <SettingsRow
          settingId="appearance"
          label="Appearance"
          labelId="theme-label"
          description="System follows your Mac's light or dark setting."
          control={
            <div
              role="group"
              aria-labelledby="theme-label"
              className="inline-flex gap-0.5 rounded-lg border border-border/80 p-0.5"
            >
              {(
                [
                  { value: "light", label: "Light", icon: Sun },
                  { value: "dark", label: "Dark", icon: Moon },
                  { value: "system", label: "System", icon: Monitor },
                ] as const
              ).map((option) => (
                <Button
                  key={option.value}
                  variant={theme === option.value ? "active" : "ghost"}
                  size="sm"
                  aria-pressed={theme === option.value}
                  onClick={() => setTheme(option.value)}
                  className="h-8 gap-1.5 px-2.5"
                >
                  <option.icon aria-hidden="true" className="h-3.5 w-3.5" />
                  {option.label}
                </Button>
              ))}
            </div>
          }
        />
        <SettingsSwitch
          settingId="menu-bar"
          label="Keep running in the menu bar"
          description="Closing the window leaves Plainsong in the menu bar, so shortcuts and recording keep working."
          checked={settings.ui.minimizeToTray}
          // The setting travels on `settings-changed`, which the main
          // process already listens for.
          onCheckedChange={(checked) => updateUi({ minimizeToTray: checked })}
        />
        <SettingsSwitch
          settingId="always-on-top"
          label="Keep the window on top"
          description="Keeps the Plainsong window above other apps."
          checked={settings.ui.alwaysOnTop}
          onCheckedChange={(checked) => updateUi({ alwaysOnTop: checked })}
        />
      </SettingsGroup>

      <SettingsGroup title="Microphone and language">
        <SettingsRow
          settingId="microphone"
          label="Microphone"
          descriptionId="app-wide-microphone-description"
          description="Used for dictation and meetings."
          control={
            <>
              <OptionSelect
                aria-label="App-wide microphone"
                className="w-56"
                aria-describedby="app-wide-microphone-description"
                value={appWideDeviceId}
                onValueChange={(value) => {
                  const nextDevice =
                    resolveAudioDevicePreference(
                      value || null,
                    );
                  void updateSettings({
                    ...settings,
                    audio: {
                      ...settings.audio,
                      preferredInputDevice: nextDevice,
                    },
                  });
                }}
              >
                <option value="">
                  System default microphone
                </option>
                {currentAudioDevices.map((device) => (
                  <option
                    key={device.deviceId}
                    value={device.deviceId}
                  >
                    {renderDeviceOptionLabel(device)}
                  </option>
                ))}
                {appWideDeviceId &&
                !currentAudioDevices.some((device) => device.deviceId === appWideDeviceId) ? (
                  <option value={appWideDeviceId}>
                    {`${settings.audio.preferredInputDevice?.deviceName ?? "Saved microphone"} (not connected)`}
                  </option>
                ) : null}
              </OptionSelect>
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9"
                aria-label="Refresh the list of microphones"
                title="Refresh the list of microphones"
                onClick={() => void refreshAudioDevices()}
              >
                <RefreshCw aria-hidden="true" className="h-4 w-4" />
              </Button>
            </>
          }
        >
          {effectiveMicrophone?.isBluetoothLike ? (
            <p className="text-sm text-rust">
              Bluetooth headset mics can dull your audio while you dictate. A
              built-in or USB mic usually sounds cleaner.
            </p>
          ) : null}
        </SettingsRow>

        <SettingsRow
          settingId="microphone-test"
          label="Test your microphone"
          description="Hear yourself back and check the level."
          control={
            <Button
              variant={micTestActive ? "destructive" : "outline"}
              size="sm"
              onClick={() =>
                micTestActive ? stopMicTest() : void startMicTest()
              }
            >
              <Mic aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
              {micTestActive ? "Stop" : "Start"}
            </Button>
          }
        >
          {micTest.error || micTestActive ? (
            <div>
              {micTest.error && !micTestActive && (
                // Mic failure is exactly what this test exists to diagnose,
                // so it says which failure it was.
                <p
                  role="alert"
                  className="mt-3 rounded-md bg-rust/10 p-2 text-sm text-rust"
                >
                  {micErrorMessage(micTest.error)}
                </p>
              )}

              {micTestActive && (
                <>
                  {micTest.usingSystemDefault ? (
                    <p className="mt-3 text-xs text-muted-foreground">
                      The chosen microphone can&apos;t be checked here, so
                      this is the system default. Dictation still uses the
                      one you chose.
                    </p>
                  ) : null}
                  <div className="mt-4 space-y-1">
                    <div className="flex items-center justify-between text-sm text-muted-foreground">
                      <span>Level</span>
                      <span>{micTestLevel}%</span>
                    </div>
                    <div className="h-3 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className={`h-full rounded-full transition-none ${
                          micTestLevel > 80
                            ? "bg-rust"
                            : micTestLevel > 50
                              ? "bg-rust/70"
                              : "bg-gold"
                        }`}
                        style={{ width: `${micTestLevel}%` }}
                      />
                    </div>
                  </div>

                  <div className="mt-4 flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={micTestRecording}
                      onClick={() => void recordMicTest()}
                    >
                      {micTestRecording ? (
                        <>
                          <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                          Recording 3s…
                        </>
                      ) : (
                        "Record 3s"
                      )}
                    </Button>
                    {micTestPlaybackUrl && !micTestRecording && (
                      <audio
                        key={micTestPlaybackUrl}
                        src={micTestPlaybackUrl}
                        controls
                        autoPlay
                        className="h-8 flex-1"
                      />
                    )}
                  </div>
                </>
              )}
            </div>
          ) : null}
        </SettingsRow>

        <SettingsMore
          settingId="microphone-overrides"
          label="Use a different microphone for dictation or meetings"
        >
          <SettingsRow
            label="Dictation microphone"
            descriptionId="dictation-microphone-description"
            description="A headset mic for dictation, the room for meetings."
            control={
              <>
                <OptionSelect
                  aria-label="Dictation microphone override"
                  className="w-52"
                  aria-describedby="dictation-microphone-description"
                  disabled={
                    !(
                      settings.audio
                        .dictationInputOverrideEnabled ?? false
                    )
                  }
                  value={dictationDeviceId}
                  onValueChange={(value) => {
                    const nextDevice =
                      resolveAudioDevicePreference(
                        value || null,
                      );
                    void updateSettings({
                      ...settings,
                      audio: {
                        ...settings.audio,
                        dictationInputDevice: nextDevice,
                      },
                    });
                  }}
                >
                  <option value="">
                    Use the whole-app microphone
                  </option>
                  {currentAudioDevices.map((device) => (
                    <option
                      key={`dictation-${device.deviceId}`}
                      value={device.deviceId}
                    >
                      {renderDeviceOptionLabel(device)}
                    </option>
                  ))}
                  {dictationDeviceId &&
                  !currentAudioDevices.some((device) => device.deviceId === dictationDeviceId) ? (
                    <option value={dictationDeviceId}>
                      {`${settings.audio.dictationInputDevice?.deviceName ?? "Saved microphone"} (not connected)`}
                    </option>
                  ) : null}
                </OptionSelect>
                <Switch
                  aria-label="Use a different microphone for dictation"
                  aria-describedby="dictation-microphone-description"
                  checked={
                    settings.audio
                      .dictationInputOverrideEnabled ?? false
                  }
                  onCheckedChange={(checked) =>
                    void updateSettings({
                      ...settings,
                      audio: {
                        ...settings.audio,
                        dictationInputOverrideEnabled: checked,
                        dictationInputDevice: checked
                          ? (settings.audio
                              .dictationInputDevice ??
                            settings.audio
                              .preferredInputDevice ??
                            null)
                          : null,
                      },
                    })
                  }
                />
              </>
            }
          />
          <SettingsRow
            label="Meeting microphone"
            descriptionId="meeting-microphone-description"
            description="Record meetings through a different mic from dictation."
            control={
              <>
                <OptionSelect
                  aria-label="Meeting microphone override"
                  className="w-52"
                  aria-describedby="meeting-microphone-description"
                  disabled={
                    !(
                      settings.audio
                        .meetingInputOverrideEnabled ?? false
                    )
                  }
                  value={meetingDeviceId}
                  onValueChange={(value) => {
                    const nextDevice =
                      resolveAudioDevicePreference(
                        value || null,
                      );
                    void updateSettings({
                      ...settings,
                      audio: {
                        ...settings.audio,
                        meetingInputDevice: nextDevice,
                      },
                    });
                  }}
                >
                  <option value="">
                    Use the whole-app microphone
                  </option>
                  {currentAudioDevices.map((device) => (
                    <option
                      key={`meeting-${device.deviceId}`}
                      value={device.deviceId}
                    >
                      {renderDeviceOptionLabel(device)}
                    </option>
                  ))}
                  {meetingDeviceId &&
                  !currentAudioDevices.some((device) => device.deviceId === meetingDeviceId) ? (
                    <option value={meetingDeviceId}>
                      {`${settings.audio.meetingInputDevice?.deviceName ?? "Saved microphone"} (not connected)`}
                    </option>
                  ) : null}
                </OptionSelect>
                <Switch
                  aria-label="Use a different microphone for meetings"
                  aria-describedby="meeting-microphone-description"
                  checked={
                    settings.audio
                      .meetingInputOverrideEnabled ?? false
                  }
                  onCheckedChange={(checked) =>
                    void updateSettings({
                      ...settings,
                      audio: {
                        ...settings.audio,
                        meetingInputOverrideEnabled: checked,
                        meetingInputDevice: checked
                          ? (settings.audio
                              .meetingInputDevice ??
                            settings.audio
                              .preferredInputDevice ??
                            null)
                          : null,
                      },
                    })
                  }
                />
              </>
            }
          />
        </SettingsMore>
        <SettingsOptionSelect
          settingId="language"
          label="Language you speak"
          description="Dictation and meetings are transcribed in this language. Auto-detect lets the speech model decide each time."
          value={settings.transcription.language ?? ""}
          onChange={(value) => updateTranscription({ language: value || null })}
        >
          <option value="">Auto-detect</option>
          {DICTATION_ACTIVE_LANGUAGE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </SettingsOptionSelect>
        {!settings.transcription.language ? (
          <SettingsMore
            settingId="dictation-languages"
            label="Languages you dictate in"
            hint={
              dictationActiveLanguages.length === 0
                ? "Any language"
                : dictationActiveLanguages.map(dictationLanguageLabel).join(", ")
            }
          >
          <SettingsRow
            label="Narrow auto-detect"
            description="Pick one to always dictate in it, or a few for auto-detect to choose between."
          >
            <div className="flex flex-wrap gap-2">
              {DICTATION_ACTIVE_LANGUAGE_OPTIONS.map(
                (option) => {
                  const selected =
                    dictationActiveLanguages.includes(
                      option.value,
                    );
                  return (
                    <button
                      key={option.value}
                      type="button"
                      aria-pressed={selected}
                      aria-label={`Dictate in ${option.label}`}
                      className={`rounded-full border px-3 py-1 text-sm transition-colors ${
                        selected
                          ? "border-foreground bg-foreground text-background"
                          : "border-border bg-background text-muted-foreground hover:text-foreground"
                      }`}
                      onClick={() => {
                        const nextActiveLanguages = selected
                          ? dictationActiveLanguages.filter(
                              (language) =>
                                language !== option.value,
                            )
                          : [
                              ...dictationActiveLanguages,
                              option.value,
                            ];
                        void updateSettings({
                          ...settings,
                          transcription: {
                            ...settings.transcription,
                            dictationActiveLanguages:
                              normalizeActiveLanguageSet(
                                nextActiveLanguages,
                              ),
                          },
                        });
                      }}
                    >
                      {option.label}
                    </button>
                  );
                },
              )}
            </div>
            <p className="mt-3 text-sm text-muted-foreground">
              {dictationActiveLanguages.length === 0
                ? "Nothing picked, so auto-detect considers every language."
                : dictationActiveLanguages.length === 1
                  ? `Dictation will always use ${dictationLanguageLabel(dictationActiveLanguages[0])}.`
                  : `Dictation will choose between ${dictationActiveLanguages
                      .map(dictationLanguageLabel)
                      .join(", ")}.`}
            </p>
          </SettingsRow>
          </SettingsMore>
        ) : null}
      </SettingsGroup>

      <SettingsGroup title="Updates and setup">
        <UpdateStatusWidget />
        <BetaChannelToggle />
        <SettingsRow
          settingId="setup"
          label="Setup guide"
          description="Walk through permissions, speech models and meetings again."
          control={
            <>
              <Button variant="ghost" size="sm" onClick={() => requestMainView("setup")}>
                Open Setup
              </Button>
              <Button variant="outline" size="sm" onClick={() => requestOnboarding("full")}>
                Run setup again
              </Button>
            </>
          }
        />
      </SettingsGroup>
    </div>
  );

  const renderDictationSection = () => (
    <div className="settings-section">
      <SettingsGroup title="While you dictate">
        <SettingsSwitch
          settingId="dictation-pill"
          label="Show the dictation pill"
          description="A small window with the level, your words as they arrive, and why an insert failed."
          checked={settings.ui.showDictationPopup}
          onCheckedChange={(checked) => updateUi({ showDictationPopup: checked })}
        />
        <SettingsOptionSelect
          settingId="pill-size"
          label="Pill size"
          description="How big the dictation pill is on screen."
          selectClassName="@md:w-40"
          value={settings.ui.dictationPillSize ?? "default"}
          onChange={(value) =>
            updateUi({
              dictationPillSize: value as NonNullable<Settings["ui"]["dictationPillSize"]>,
            })
          }
        >
          <option value="small">Small</option>
          <option value="default">Default</option>
          <option value="large">Large</option>
          <option value="xlarge">Extra large</option>
        </SettingsOptionSelect>
        <SettingsOptionSelect
          settingId="pill-position"
          label="Pill position"
          description="Bottom center, or docked to a screen edge. Dragging it near an edge docks it too."
          selectClassName="@md:w-40"
          value={settings.ui.dictationPillDock ?? "bottom"}
          onChange={(value) =>
            updateUi({
              dictationPillDock: value as NonNullable<Settings["ui"]["dictationPillDock"]>,
            })
          }
        >
          <option value="bottom">Bottom center</option>
          <option value="left">Left edge</option>
          <option value="right">Right edge</option>
        </SettingsOptionSelect>
        <SettingsSwitch
          settingId="dictation-sounds"
          label="Dictation sounds"
          description="A soft tick when the mic goes live, a pop when your words land, and a low tone if a dictation fails."
          checked={settings.ui.dictationSounds !== false}
          onCheckedChange={(checked) => updateUi({ dictationSounds: checked })}
        />
        <SettingsSwitch
          settingId="mute-media"
          label="Mute other audio while dictating"
          description="Silences music, calls and alerts while the mic is live, then turns back on only what Plainsong muted."
          checked={settings.ui.muteMediaWhileDictating === true}
          onCheckedChange={(checked) => updateUi({ muteMediaWhileDictating: checked })}
        />
        <SettingsSwitch
          settingId="dictation-failure-notifications"
          label="Notify me when a dictation fails"
          description="A macOS notification when an insert is refused or fails while the pill is hidden."
          checked={notificationsSettings.dictationFailures}
          onCheckedChange={(checked) =>
            updateNotifications({ dictationFailures: checked })
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Your words">
        <SettingsSwitch
          settingId="remove-fillers"
          label="Remove filler words"
          description="Drops um and uh, repeated words, and spoken corrections like “Tuesday, no wait, Wednesday”, on this Mac. Anything unclear stays as you said it."
          checked={settings.transcription.dictationRemoveDisfluencies ?? true}
          onCheckedChange={(checked) =>
            updateTranscription({ dictationRemoveDisfluencies: checked })
          }
        />
        <SettingsSwitch
          settingId="ai-cleanup"
          label="AI cleanup"
          description="Tidies punctuation, grammar and layout before the text is inserted, using the text model chosen in Models. A cloud service only gets your words if Privacy & data allows it."
          checked={settings.transcription.dictationAiFormatting}
          onCheckedChange={(checked) =>
            updateTranscription({ dictationAiFormatting: checked })
          }
        />
        <SettingsSwitch
          settingId="nearby-spelling"
          label="Spell names from nearby text"
          description="Use text on screen near where you're typing to spell names correctly. Stays on this Mac."
          checked={settings.transcription.dictationNearbySpelling ?? false}
          onCheckedChange={(checked) =>
            updateTranscription({ dictationNearbySpelling: checked })
          }
        />
        <NameSourcesSetting
          calendarEnabled={settings.transcription.dictationCalendarNames ?? false}
          contactsEnabled={settings.transcription.dictationContactNames ?? false}
          onCalendarChange={(enabled) => updateTranscription({ dictationCalendarNames: enabled })}
          onContactsChange={(enabled) => updateTranscription({ dictationContactNames: enabled })}
        />
        <SettingsSwitch
          settingId="match-surrounding"
          label="Match surrounding text"
          description="Mid-sentence, adds the space and keeps lowercase, and spells names the way the field already does. Password fields are skipped, and nothing it reads is kept or sent."
          checked={settings.transcription.dictationMatchSurroundingText ?? true}
          onCheckedChange={(checked) =>
            updateTranscription({ dictationMatchSurroundingText: checked })
          }
        />
        <SettingsSwitch
          settingId="translate"
          label="Translate to English"
          description={
            translateAvailability.enabled
              ? `For the built-in profiles; a saved profile has its own switch. ${translateAvailability.description}`
              : translateAvailability.description
          }
          checked={
            translateAvailability.enabled &&
            Boolean(settings.transcription.dictationTranslateToEnglish)
          }
          disabled={!translateAvailability.enabled}
          onCheckedChange={(checked) =>
            updateTranscription({ dictationTranslateToEnglish: checked })
          }
        />
        <SettingsSwitch
          settingId="copy-to-clipboard"
          label="Also copy to the clipboard"
          description="Leaves each result on the clipboard so you can paste it again yourself."
          checked={settings.transcription.dictationCopyToClipboard ?? false}
          onCheckedChange={(checked) =>
            updateTranscription({ dictationCopyToClipboard: checked })
          }
        />
        <SettingsMore
          label="More dictation options"
          hint="Spoken commands, snippets, corrections, instructions"
        >
          <SettingsSwitch
            settingId="spoken-commands"
            label="Spoken commands"
            description={'Say “command undo that” or “command uppercase selection” and Plainsong acts on it instead of typing it.'}
            checked={settings.transcription.dictationCommandModeEnabled ?? false}
            onCheckedChange={(checked) =>
              updateTranscription({ dictationCommandModeEnabled: checked })
            }
          />
          <SettingsInput
            settingId="command-word"
            label="Command word"
            description="Starts a spoken command. Pick a word you would not say by accident; it is never inserted."
            inputClassName="@md:w-40"
            value={settings.transcription.dictationCommandPrefix ?? "command"}
            onChange={(value) => updateTranscription({ dictationCommandPrefix: value })}
          />
          <SettingsSwitch
            settingId="snippets"
            label="Snippets"
            description="Replaces saved abbreviations with the full text you set for them."
            checked={settings.transcription.dictationSnippetsEnabled ?? true}
            onCheckedChange={(checked) =>
              updateTranscription({ dictationSnippetsEnabled: checked })
            }
          />
          <SettingsSwitch
            settingId="learn-in-plainsong"
            label="Suggest corrections from edits in Plainsong"
            description="Suggests dictionary entries when you fix a word or short phrase here. Review them under Dictation > Corrections."
            checked={settings.transcription.dictationAutoLearnCorrections ?? true}
            onCheckedChange={(checked) =>
              updateTranscription({ dictationAutoLearnCorrections: checked })
            }
          />
          <SettingsSwitch
            settingId="learn-other-apps"
            label="Learn from corrections you make in other apps"
            description="Off by default. For 8 seconds after an insert, Plainsong re-reads that one field on this Mac and keeps only the word-level changes, never the sentence, for your review under Dictation > Corrections. Unapproved changes are deleted within a week."
            checked={
              settings.transcription.dictationLearnFromExternalCorrections ?? false
            }
            onCheckedChange={(checked) =>
              updateTranscription({ dictationLearnFromExternalCorrections: checked })
            }
          />
          <SettingsRow
            settingId="cleanup-instructions"
            label="Your own AI cleanup instructions"
            description="Replaces the built-in instructions. Plainsong still tells it which app you are typing into."
          >
            <Textarea
              aria-label="Your own AI cleanup instructions"
              placeholder="e.g. Format as an email, fix grammar, make it sound professional..."
              value={settings.transcription.dictationCustomPrompt ?? ""}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
                updateTranscription({ dictationCustomPrompt: e.target.value })
              }
              className="min-h-[88px]"
            />
          </SettingsRow>
        </SettingsMore>
      </SettingsGroup>

      <SettingsGroup title="Profiles and setup">
        <SettingsRow
          settingId="dictation-page"
          label="Word list, snippets and profiles"
          description="These live on the Dictation page, with where text gets inserted."
          control={
            <Button variant="outline" size="sm" onClick={() => requestMainView("dictation")}>
              Open Dictation
            </Button>
          }
        />
        <SettingsRow
          settingId="fix-dictation"
          label="Fix dictation setup"
          description="Checks the microphone, permissions and speech model, one step at a time."
          control={
            <Button variant="outline" size="sm" onClick={() => requestOnboarding("dictation")}>
              Fix dictation setup
            </Button>
          }
        />
      </SettingsGroup>
    </div>
  );

  const renderMeetingsSection = () => (
    <div className="settings-section">
      <NotePublishSettingsSection />
      <SettingsGroup title="Recording">
        <SettingsRow
          settingId="system-audio"
          label="Mac audio"
          description={MEETING_AUDIO_EXPLAINER}
          control={
            <div className="flex shrink-0 flex-wrap gap-2">
              {/* Denied: only System Settings can fix it, so that comes
                  first, and the check becomes "Check again" for the return. */}
              {meetingAudio.action === "open_settings" ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void openPermissionSettings("system_audio")}
                >
                  Open System Settings
                </Button>
              ) : null}
              <Button
                variant={meetingAudio.action === "open_settings" ? "ghost" : "outline"}
                size="sm"
                disabled={
                  systemAudioTestLoading ||
                  (systemAudioCapability === null && !systemAudioCheckFailed) ||
                  systemAudioCapability?.backend === "none"
                }
                onClick={() => void runSystemAudioTest()}
              >
                {systemAudioTestLoading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                {systemAudioCheckFailed ? "Retry" : meetingAudio.action === "allow"
                  ? meetingAudio.actionLabel
                  : meetingAudio.action === "open_settings"
                    ? "Check again"
                    : "Check meeting audio"}
              </Button>
            </div>
          }
        >
          {/* Status first, in the calm voice unless something is wrong:
              "needs your OK" is the normal first-run state, not an error. */}
          <p
            role={systemAudioCheckFailed ? "alert" : "status"}
            className={`flex items-start gap-2 text-sm leading-5 ${
              meetingAudio.tone === "ready"
                ? "text-gold-text"
                : meetingAudio.tone === "problem"
                  ? "text-rust"
                  : "text-muted-foreground"
            }`}
          >
            <span
              aria-hidden="true"
              className={`mt-1.5 ${
                meetingAudio.tone === "ready"
                  ? "neume neume-lit"
                  : meetingAudio.tone === "problem"
                    ? "neume neume-rust"
                    : "neume neume-hollow"
              }`}
            />
            <span>{meetingAudio.sentence}</span>
          </p>
          {/* The built-in route's sentences already say the check is silent;
              a routing app's failure reason does not say to play sound. */}
          {meetingAudio.action === "check" &&
          systemAudioCapability?.backend === "virtual_loopback" &&
          systemAudioCapability.reason ? (
            <p className="text-sm leading-5 text-muted-foreground">
              The check passes once Plainsong hears real sound through that
              device, so play something while it runs.
            </p>
          ) : null}
          {systemAudioTestStatus && systemAudioTestStatus !== meetingAudio.sentence ? (
            <p
              className={`text-sm ${meetingAudio.tone === "ready" ? "text-gold-text" : "text-muted-foreground"}`}
              role="status"
            >
              {systemAudioTestStatus}
            </p>
          ) : null}
        </SettingsRow>
        <SettingsSwitch
          settingId="call-detection"
          label="Offer to record a call it notices"
          description="Looks for a call in Zoom, Teams, Google Meet, Webex, FaceTime, Slack or Discord every few seconds, on this Mac only. Google Meet also needs Accessibility."
          checked={meetingsSettings.callDetectionEnabled}
          onCheckedChange={(checked) => updateMeetings({ callDetectionEnabled: checked })}
        />
        <SettingsSwitch
          settingId="meeting-window"
          label="Show the meeting window"
          description="A small window with the timer, pause and stop, so you never have to switch back to Plainsong."
          checked={settings.ui.showRecordingPopup}
          onCheckedChange={(checked) => updateUi({ showRecordingPopup: checked })}
        />
        <SettingsSwitch
          settingId="meeting-notifications"
          label="Meeting notifications"
          description="When a meeting starts or stops, and when its transcript and notes are ready or fail."
          checked={notificationsSettings.meetingEvents}
          onCheckedChange={(checked) => updateNotifications({ meetingEvents: checked })}
        />
        <SettingsRow
          settingId="setup-meetings"
          label="Set up meetings"
          description="Walks through the other side of the call, speakers and the meeting speech model."
          control={
            <Button variant="outline" size="sm" onClick={() => requestOnboarding("meetings")}>
              Set up meetings
            </Button>
          }
        />
      </SettingsGroup>

      {/* Before access: the same Connect card as the Meetings header (asks
          macOS only on its click, reports the answer, offers System Settings
          when refused). After: where a granted calendar gets narrowed or
          switched back off. */}
      <div id="setting-calendar">
        <CalendarSettingsSection />
      </div>

      <SettingsGroup title="Speakers">
        <SettingsRow
          settingId="speakers"
          label="Tell speakers apart"
          labelId="separate-speakers-label"
          descriptionId="separate-speakers-description"
          description="Splits each transcript by who was talking, using the speaker model below."
          control={
            diarizationAvailable ? (
              <Switch
                aria-labelledby="separate-speakers-label"
                aria-describedby="separate-speakers-description"
                checked={settings.transcription.enableDiarization}
                onCheckedChange={(checked) =>
                  void updateSettings({
                    ...settings,
                    transcription: {
                      ...settings.transcription,
                      enableDiarization: checked,
                    },
                  })
                }
              />
            ) : (
              <Button
                variant="outline"
                size="sm"
                disabled={diarizationDownloading}
                onClick={async () => {
                  setDiarizationDownloading(true);
                  try {
                    const modelId = selectedDiarizationModelId;
                    await downloadDiarizationModel(modelId);
                    // Refresh model list to show installed status
                    const models = await listDiarizationModels();
                    setDiarizationModels(models);
                  } catch (e) {
                    const msg = settingsErrorMessage(
                      e,
                      "Plainsong could not download the model.",
                    );
                    setError(`Download failed: ${msg}`);
                  } finally {
                    setDiarizationDownloading(false);
                  }
                }}
              >
                {diarizationDownloading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Downloading…
                  </>
                ) : (
                  <>
                    <Download className="mr-2 h-4 w-4" />
                    {selectedDiarizationModel?.downloadSize
                      ? `Download speaker model (${selectedDiarizationModel.downloadSize})`
                      : "Download speaker model"}
                  </>
                )}
              </Button>
            )
          }
        />
        {diarizationModels.length > 0 ? (
          <SettingsOptionSelect
            settingId="speaker-model"
            label="Speaker model"
            disabled={diarizationDownloading}
            description="Each model keeps its own remembered voices: a voice remembered with one is not recognized by another."
            value={storedDiarizationModelId}
            onChange={(value) =>
              void updateSettings({
                ...settings,
                transcription: {
                  ...settings.transcription,
                  diarizationModelId: value,
                },
              })
            }
            footnote={(() => {
              if (!storedDiarizationModelOffered) {
                const savedName =
                  speakerModelName(storedDiarizationModelId) ?? "The saved speaker model";
                const runName =
                  diarizationRunModelId === null
                    ? null
                    : (diarizationRunModelId && speakerModelName(diarizationRunModelId)) ||
                      "another speaker model on this Mac";
                return (
                  <p className="text-sm text-muted-foreground">
                    {runName === null
                      ? `${savedName} is no longer offered, and no other speaker model is downloaded. Download one above, or choose one here.`
                      : `${savedName} is no longer offered, so meetings use ${runName}. Choose a model here to replace it.`}
                  </p>
                );
              }
              const selectedModel = diarizationModels.find(
                (m) => m.id === storedDiarizationModelId,
              );
              if (selectedModel) {
                return (
                  <div className="space-y-1 text-sm text-muted-foreground">
                    <p>{selectedModel.description}</p>
                    {!selectedModel.installed && (
                      <p className="text-rust">
                        Not downloaded yet. Use Download speaker
                        model above.
                      </p>
                    )}
                  </div>
                );
              }
              return null;
            })()}
          >
            {storedDiarizationModelOffered ? null : (
              <option value={storedDiarizationModelId} disabled>
                {`${speakerModelName(storedDiarizationModelId) ?? storedDiarizationModelId} (no longer offered)`}
              </option>
            )}
            {diarizationModels.map((model) => (
              <option key={model.id} value={model.id}>
                {speakerModelOptionLabel(model)}
              </option>
            ))}
          </SettingsOptionSelect>
        ) : null}
        <TurnedOffSpeakerModelFile />
      </SettingsGroup>

      <RememberedVoicesSection
        activeModelId={selectedDiarizationModelId}
        runModelId={diarizationRunModelId}
        modelLabels={Object.fromEntries(
          diarizationModels.map((model) => [model.id, model.label]),
        )}
        rememberVoices={meetingsSettings.rememberVoices}
        autoApplyConfidentVoices={
          meetingsSettings.autoApplyConfidentVoices
        }
        onRememberVoicesChange={(checked) =>
          void updateSettings({
            ...settings,
            meetings: {
              ...meetingsSettings,
              rememberVoices: checked,
              // Auto-apply refines remembering, so turning
              // remembering off takes it with it. This mirrors
              // `normalize_loaded_meetings_settings` in
              // settings.rs rather than leaving the file in a
              // state the sidecar would normalize behind us.
              autoApplyConfidentVoices: checked
                ? meetingsSettings.autoApplyConfidentVoices
                : false,
            },
          })
        }
        onAutoApplyChange={(checked) =>
          void updateSettings({
            ...settings,
            meetings: {
              ...meetingsSettings,
              autoApplyConfidentVoices: checked,
            },
          })
        }
      />

      <SettingsGroup title="After a meeting">
        <SettingsSwitch
          settingId="auto-summary"
          label="Summarize every meeting automatically"
          description={
            !settings.transcription.enableAutoAnalysis
              ? "Meetings are summarized only when you ask for it from the meeting itself."
              : isRemoteAnalysisProvider(
                    settings.privacy.meetingsAi.provider,
                  ) && !settings.privacy.remoteProcessingEnabled
                ? `Every finished meeting would go to ${describeAnalysisDestination(settings.privacy.meetingsAi.provider)}, but cloud AI is turned off — so no summary is written.`
                : `Every finished meeting transcript goes to ${describeAnalysisDestination(settings.privacy.meetingsAi.provider)} for a summary and action items, without asking first.`
          }
          checked={settings.transcription.enableAutoAnalysis}
          onCheckedChange={(checked) =>
            void updateSettings({
              ...settings,
              transcription: {
                ...settings.transcription,
                enableAutoAnalysis: checked,
              },
            })
          }
        />
        <SettingsSwitch
          settingId="auto-name"
          label="Name meetings for me"
          description="Sends each finished transcript to the service that writes your summaries and uses its answer as the title. Off, a meeting keeps your name for it or its start time."
          checked={settings.transcription.meetingAutoNameEnabled ?? true}
          onCheckedChange={(checked) =>
            updateTranscription({ meetingAutoNameEnabled: checked })
          }
        />
        <SettingsMore
          label="More meeting options"
          hint="Auto-stop, length limit, titles, instructions"
        >
          <SettingsSwitch
            settingId="stop-on-call-quit"
            label="Stop when the call app quits"
            description="A meeting recorded with a detected call ends when that app quits or its call window closes. The audio is saved as usual."
            checked={meetingsSettings.autoStopWhenCallAppQuits}
            onCheckedChange={(checked) =>
              updateMeetings({ autoStopWhenCallAppQuits: checked })
            }
          />
          <SettingsRow
            settingId="stop-after-silence"
            label={
              <label htmlFor="meeting-auto-stop-silence-minutes">
                Stop after minutes of silence
              </label>
            }
            descriptionId="meeting-auto-stop-silence-description"
            description="Stops and saves a meeting after this long with nothing audible. 0 turns it off; paused time does not count."
            control={
              <div className="w-24 shrink-0">
                <Input
                  id="meeting-auto-stop-silence-minutes"
                  type="number"
                  min={0}
                  max={MEETING_AUTO_STOP_SILENCE_MINUTES_MAX}
                  className="h-9"
                  value={meetingsSettings.autoStopAfterSilenceMinutes}
                  onChange={(e) => {
                    const raw = Number(e.target.value);
                    const next = Number.isFinite(raw)
                      ? Math.min(
                          Math.max(0, Math.round(raw)),
                          MEETING_AUTO_STOP_SILENCE_MINUTES_MAX,
                        )
                      : meetingsSettings.autoStopAfterSilenceMinutes;
                    void updateSettings({
                      ...settings,
                      meetings: {
                        ...meetingsSettings,
                        autoStopAfterSilenceMinutes: next,
                      },
                    });
                  }}
                />
              </div>
            }
          />
          <SettingsRow
            settingId="max-length"
            label={
              <label htmlFor="meeting-max-recording-minutes">
                Longest meeting, in minutes
              </label>
            }
            descriptionId="meeting-max-recording-minutes-description"
            description="Counts recorded time, not pauses. Plainsong warns you before it stops, and the audio is saved and transcribed as usual. 0 means no limit."
            control={
              <div className="w-24 shrink-0">
                <Input
                  id="meeting-max-recording-minutes"
                  aria-describedby="meeting-max-recording-minutes-description"
                  type="number"
                  min={0}
                  max={MEETING_MAX_RECORDING_MINUTES}
                  step={1}
                  className="h-9"
                  value={meetingsSettings.maxRecordingMinutes}
                  onChange={(e) => {
                    const next = resolveMeetingsSettings({
                      meetings: { ...meetingsSettings, maxRecordingMinutes: Number(e.target.value) },
                    });
                    void updateSettings({ ...settings, meetings: next });
                  }}
                />
              </div>
            }
          />
          <SettingsSwitch
            settingId="cloud-speakers"
            label="Keep speaker labels from cloud services"
            description="When Deepgram or Gemini transcribes a meeting, keep their speakers instead of separating voices again on this Mac. Speech models on this Mac return no labels, so this only matters for those two."
            checked={meetingsSettings.preferProviderDiarization}
            onCheckedChange={(checked) =>
              updateMeetings({ preferProviderDiarization: checked })
            }
          />
          <SettingsInput
            settingId="title-model"
            label="AI model for meeting titles"
            description="A title is a few words, so a smaller model is usually enough. Leave it empty to use the summary model."
            placeholder="Same as summaries"
            value={settings.transcription.meetingAutoNameModel ?? ""}
            onBlur={handleSettingsTextBlur}
            onKeyDown={handleSettingsTextKeyDown}
            onChange={(value) =>
              updateTranscription({
                meetingAutoNameModel: value.trim() ? value.trim() : null,
              })
            }
          />
          <SettingsRow
            settingId="summary-instructions"
            label="Your own summary instructions"
            description="Replaces the built-in summary instructions."
          >
            <Textarea
              aria-label="Your own meeting summary instructions"
              placeholder="e.g. Summarize the meeting and list action items..."
              value={settings.transcription.meetingCustomPrompt ?? ""}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
                updateTranscription({ meetingCustomPrompt: e.target.value })
              }
              className="min-h-[88px]"
            />
          </SettingsRow>
        </SettingsMore>
      </SettingsGroup>
    </div>
  );

  const renderSearchAndAiSection = () => (
    <div className="settings-section">
      <SettingsGroup title="AI services">
        {/* Which model writes them is chosen in Models. A second copy of
            those pickers here would be two controls for one pair of keys. */}
        <SettingsRow
          settingId="ai-writers"
          label="Who writes for you"
          description={describeAiWriters(
            settings.privacy.meetingsAi.provider,
            settings.privacy.dictationAi.provider,
          )}
          control={
            <Button variant="outline" size="sm" onClick={() => setActiveTab("models")}>
              Open Models
            </Button>
          }
        />
        {/* The switch itself lives on Privacy & data, and only there. */}
        <SettingsRow
          label={
            <span className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className={
                  settings.privacy.remoteProcessingEnabled
                    ? "neume neume-lit"
                    : "neume neume-hollow"
                }
              />
              {settings.privacy.remoteProcessingEnabled
                ? "Cloud AI is allowed"
                : "Cloud AI is off"}
            </span>
          }
          description={
            settings.privacy.remoteProcessingEnabled
              ? "Any service you pick in Models may receive your transcripts. Turn it off under Privacy & data."
              : "Only models on this Mac may receive meeting transcripts, dictated text, or captured app context. Every cloud service is refused until you allow it under Privacy & data."
          }
          control={
            <Button variant="outline" size="sm" onClick={() => setActiveTab("privacy")}>
              Open Privacy &amp; data
            </Button>
          }
        />
        {AI_LANE_KEYS.some(
          (lane) => settings.privacy[lane].provider === "ollama",
        ) && (
          <SettingsRow
            label={
              <span className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className={
                    ollamaAvailable
                      ? "neume neume-lit"
                      : "neume neume-hollow"
                  }
                />
                {ollamaAvailable === null
                  ? "Looking for Ollama on this Mac…"
                  : ollamaAvailable
                    ? "Ollama is running on this Mac"
                    : "Ollama is not running on this Mac"}
              </span>
            }
            description={
              ollamaModels.length > 0
                ? `Installed models: ${ollamaModels.join(", ")}`
                : "No models installed yet."
            }
          />
        )}
        {/* The prompt library the "/" picker offers in a meeting's chat and
            in "Ask your meetings". Managed here and from the picker's own
            footer -- same dialog, same settings key. */}
        <SettingsRow
          settingId="saved-prompts"
          label="Saved prompts"
          description={`${resolveSavedPrompts(settings.ai?.savedPrompts).filter((prompt) => !prompt.hidden).length} prompts you can pick with "/" in a meeting's chat or in "Ask your meetings". Stored in your settings on this Mac.`}
          control={
            <Button variant="outline" size="sm" onClick={() => setSavedPromptsOpen(true)}>
              Manage prompts
            </Button>
          }
        />
        <SavedPromptManagerDialog
          open={savedPromptsOpen}
          onOpenChange={setSavedPromptsOpen}
          prompts={resolveSavedPrompts(settings.ai?.savedPrompts)}
          onPersist={persistSavedPrompts}
          saveError={savedPromptsSaveError}
        />
      </SettingsGroup>

      <SettingsGroup
        title="API keys"
        settingId="api-keys"
        descriptionId="api-key-service-description"
        description="Keys are kept in the macOS keychain. Picking a service here only edits its key; which service Plainsong uses is chosen in Models."
      >
        <div className="space-y-3 py-3.5">
          <div className="flex items-center gap-2">
            <OptionSelect
              aria-label="API key service"
              aria-describedby="api-key-service-description"
              value={provider}
              onValueChange={(value) => {
                // This only chooses which provider's credential is being
                // viewed/edited below -- it must not rewrite the default
                // analysis provider (settings.privacy.meetingsAi.provider), which
                // has its own selector on the AI tab.
                setProvider(value);
                void refreshModelsForProvider(value);
              }}
              className="flex-1"
            >
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
              <option value="gemini">Google Gemini</option>
              <option value="deepseek">DeepSeek</option>
              <option value="ollama-cloud">Ollama Cloud</option>
              {/* Transcription-only services. They belong here because
                  every cloud ASR route's setup copy says "Settings > Search
                  & AI > API keys", and because the packaged app strips API keys from
                  the sidecar's environment (electron/ipc-bridge.ts's
                  buildSidecarEnv), so the keychain is the only way a key
                  can reach them. They have no model catalogue endpoint;
                  the ASR model is chosen on the Models screen. */}
              <option value="deepgram">Deepgram (transcription)</option>
              <option value="mistral">Mistral (transcription)</option>
              <option value="xai">xAI Grok (transcription)</option>
              <option value="elevenlabs">ElevenLabs (transcription)</option>
              <option value="groq">Groq (transcription)</option>
              <option value="cohere">Cohere (transcription)</option>
            </OptionSelect>
            <Button
              variant="outline"
              size="sm"
              title="Refresh model list"
              aria-label="Save the key and refresh the model list"
              onClick={async () => {
                if (apiKey.trim()) {
                  setSavingApiKey(true);
                  try {
                    await setProviderSecret(provider, apiKey.trim());
                    setApiKey("");
                    setKeyManagerHasApiKey(true);
                    if (provider === settings.privacy.meetingsAi.provider) {
                      setHasApiKey(true);
                    }
                  } catch (e) {
                    toast(
                      `Failed to save key: ${settingsErrorMessage(e, "Plainsong could not store it.")}`,
                      'error',
                    );
                  } finally {
                    setSavingApiKey(false);
                  }
                }
                void refreshModelsForProvider(provider);
              }}
              disabled={modelsLoading || savingApiKey}
            >
              {modelsLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
            </Button>
          </div>
          {!settings.privacy.remoteProcessingEnabled ? (
            <p className="text-sm text-muted-foreground">
              Cloud AI is turned off, so saved keys are not used for
              summaries, answers, or action items.
            </p>
          ) : null}
          {settings.privacy.remoteProcessingEnabled &&
          isRemoteAnalysisProvider(settings.privacy.meetingsAi.provider) &&
          settings.privacy.meetingsAi.provider !== CHATGPT_PLAN_PROVIDER &&
          !hasApiKey ? (
            <p className="text-sm text-rust">
              No key saved for{" "}
              {describeAnalysisDestination(settings.privacy.meetingsAi.provider)},
              the service picked under “Who writes summaries, answers, and
              actions” — summaries and answers will fail until you add one.
            </p>
          ) : null}

          <Label htmlFor="provider-api-key">Key</Label>
          <Input
            id="provider-api-key"
            type="password"
            placeholder={
              keyManagerHasApiKey
                ? "A key is saved — type a new one to replace it"
                : "Paste the key here"
            }
            value={apiKey}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              setApiKey(e.target.value)
            }
            onKeyDown={async (e) => {
              if (e.key === "Enter" && apiKey.trim()) {
                e.preventDefault();
                if (savingApiKey) return;

                setSavingApiKey(true);
                setError(null);
                try {
                  await setProviderSecret(provider, apiKey.trim());
                  setApiKey("");
                  setKeyManagerHasApiKey(true);
                  if (provider === settings.privacy.meetingsAi.provider) {
                    setHasApiKey(true);
                  }
                  await refreshModelsForProvider(provider);
                } catch (e) {
                  setError(
                    settingsErrorMessage(e, "Failed to save API key"),
                  );
                } finally {
                  setSavingApiKey(false);
                }
              }
            }}
          />
          <div className="flex items-center gap-2">
            <Button
              onClick={async () => {
                if (!apiKey.trim()) return;
                setSavingApiKey(true);
                setError(null);
                try {
                  await setProviderSecret(provider, apiKey.trim());
                  setApiKey("");
                  setKeyManagerHasApiKey(true);
                  if (provider === settings.privacy.meetingsAi.provider) {
                    setHasApiKey(true);
                  }
                  await refreshModelsForProvider(provider);
                } catch (e) {
                  setError(
                    settingsErrorMessage(e, "Failed to save API key"),
                  );
                } finally {
                  setSavingApiKey(false);
                }
              }}
              disabled={savingApiKey || !apiKey.trim()}
            >
              {savingApiKey ? "Saving…" : "Save key"}
            </Button>
            <Button
              variant="outline"
              onClick={async () => {
                setSavingApiKey(true);
                setError(null);
                try {
                  await clearProviderSecret(provider);
                  setApiKey("");
                  setKeyManagerHasApiKey(false);
                  if (provider === settings.privacy.meetingsAi.provider) {
                    setHasApiKey(false);
                  }
                } catch (e) {
                  setError(
                    settingsErrorMessage(e, "Failed to clear API key"),
                  );
                } finally {
                  setSavingApiKey(false);
                }
              }}
              disabled={savingApiKey}
            >
              Remove key
            </Button>
            {keyManagerHasApiKey && (
              <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <span aria-hidden="true" className="neume neume-lit" />
                Saved in the keychain
              </span>
            )}
          </div>
        </div>
        <SettingsMore settingId="cloud-check" label="Check cloud setup" hint="Names whatever a cloud summary is missing">
          <div className="space-y-2 py-3">
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={async () => {
                  setError(null);
                  const checks: string[] = [];
                  if (!settings.privacy.remoteProcessingEnabled) {
                    checks.push(
                      "Cloud AI for summaries and answers is off.",
                    );
                  }
                  if (
                    isRemoteAnalysisProvider(
                      settings.privacy.meetingsAi.provider,
                    ) &&
                    settings.privacy.meetingsAi.provider !== CHATGPT_PLAN_PROVIDER
                  ) {
                    const keyPresent = await hasProviderSecret(
                      settings.privacy.meetingsAi.provider,
                    );
                    if (!keyPresent) {
                      checks.push(
                        `No key saved for ${describeAnalysisDestination(settings.privacy.meetingsAi.provider)}.`,
                      );
                    }
                  }
                  if (checks.length === 0) {
                    setCloudReadinessMessage("Everything is in place.");
                  } else {
                    setCloudReadinessMessage(checks.join(" "));
                  }
                }}
              >
                Check
              </Button>
              {!settings.privacy.remoteProcessingEnabled && (
                <Button
                  onClick={async () => {
                    const confirmed = window.confirm(
                      "Allow cloud AI to receive meeting transcripts and dictated text, including captured app context, for summaries, answers, and writing assistance?",
                    );
                    if (!confirmed) {
                      return;
                    }
                    updateSettings(
                      {
                        ...settings,
                        privacy: {
                          ...settings.privacy,
                          remoteProcessingEnabled: true,
                        },
                      },
                      { immediate: true },
                    );
                    setCloudReadinessMessage("Turned on. Check again.");
                  }}
                >
                  Allow it
                </Button>
              )}
            </div>
            {cloudReadinessMessage ? (
              <p className="text-sm text-muted-foreground">
                {cloudReadinessMessage}
              </p>
            ) : null}
          </div>
        </SettingsMore>
      </SettingsGroup>


      <SettingsGroup
        title="Search"
        settingId="search"
        description="How Plainsong looks through past recordings when you search or ask a question."
      >
        <MeaningSearchSection
          transcription={settings.transcription}
          onChange={(patch) =>
            void updateSettings({
              ...settings,
              transcription: { ...settings.transcription, ...patch },
            })
          }
        />
      </SettingsGroup>
    </div>
  );

  const renderPrivacySection = () => (
    <div className="settings-section">
      <SettingsGroup title="Cloud">
        <SettingsRow
          settingId="cloud-ai"
          label="Allow cloud AI processing"
          descriptionId="remote-processing-description"
          description="Lets the AI service chosen in Models receive meeting transcripts and dictated text for summaries, answers, AI cleanup and Power Rewrite. Dictation can also send selected text, nearby app text and the app's name. The service may bill you. Speech models are chosen separately."
          control={
            <Switch
              aria-label="Allow cloud AI processing"
              aria-describedby="remote-processing-description"
              checked={settings.privacy.remoteProcessingEnabled}
              onCheckedChange={(checked) =>
                void updateSettings({
                  ...settings,
                  privacy: {
                    ...settings.privacy,
                    remoteProcessingEnabled: checked,
                  },
                })
              }
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup
        title="macOS permissions"
        settingId="permissions"
        description="What Plainsong is currently allowed to do on this Mac."
      >
        <SettingsSwitch
          settingId="ask-permissions"
          label="Ask macOS for permission when needed"
          description="Requests microphone access before dictation starts, and speech recognition only if you chose Apple Speech."
          checked={settings.transcription.dictationAutoRequestPermissions ?? true}
          onCheckedChange={(checked) =>
            updateTranscription({ dictationAutoRequestPermissions: checked })
          }
        />
        {permissionDiagnostics && (
          <>
              {[
                {
                  label: "Microphone",
                  ready: microphonePermissionReady,
                  action: () => void openPermissionSettings("microphone"),
                  offLabel: "Not allowed yet",
                },
                {
                  label: "Speech recognition",
                  ready: permissionDiagnostics.speechRecognitionReady,
                  action: () => void openPermissionSettings("speech"),
                  // Only Apple Speech reads it, so its absence is not a fault.
                  offLabel: "Not allowed",
                  optional: true,
                  note: "Only Apple Speech needs this permission. It supports meetings on macOS 26 or later. Recognition stays on this Mac, with server fallback off.",
                },
                {
                  label: "Accessibility",
                  ready: permissionDiagnostics.accessibilityReady,
                  action: () =>
                    void openPermissionSettings("accessibility"),
                  offLabel: "Not allowed yet",
                },
                {
                  label: "Typing when paste is blocked",
                  ready: permissionDiagnostics.postEventReady,
                  action: () =>
                    void openPermissionSettings("accessibility"),
                  offLabel: "Not allowed yet",
                  note: "Turned on by the same Accessibility switch. If this stays \"Not allowed yet\", quit and reopen Plainsong.",
                },
              ].map((item) => (
                <div
                  key={item.label}
                  className="flex items-start justify-between gap-6 py-3"
                >
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm font-medium leading-5">{item.label}</p>
                    <p
                      className={`flex items-center gap-1.5 text-sm ${
                        item.ready
                          ? "text-gold-text"
                          : "optional" in item
                            ? "text-muted-foreground"
                            : "text-rust"
                      }`}
                    >
                      <span
                        aria-hidden="true"
                        className={
                          item.ready
                            ? "neume neume-lit"
                            : "optional" in item
                              ? "neume neume-hollow"
                              : "neume neume-rust"
                        }
                      />
                      {item.ready ? "Allowed" : item.offLabel}
                    </p>
                    {(!item.ready || "optional" in item) && "note" in item ? (
                      <p className="text-sm text-muted-foreground">{item.note}</p>
                    ) : null}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                    aria-label={`Open System Settings for ${item.label}`}
                    onClick={item.action}
                  >
                    Open System Settings
                  </Button>
                </div>
              ))}
          </>
        )}
        <div className="space-y-3 py-3.5">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                await refreshAsrRuntimeProbes();
                const [diagnostics, providers] = await Promise.all([
                  getPermissionDiagnostics(),
                  getAsrProviders().catch(() => []),
                ]);
                setPermissionDiagnostics(diagnostics);
                setAsrProviders(providers);
                void reapplyGlobalShortcuts();
              }}
            >
              Check again
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                const diagnostics = await requestDictationPermissions();
                setPermissionDiagnostics(diagnostics);
                setAsrProviders(await getAsrProviders().catch(() => []));
                void reapplyGlobalShortcuts();
              }}
            >
              Ask for the missing ones
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                const diagnostics = await repairCursorInsertPermissions();
                setPermissionDiagnostics(diagnostics);
                void reapplyGlobalShortcuts();
              }}
            >
              Repair text insertion
            </Button>
          </div>
          {permissionDiagnostics?.notes?.length ? (
            <div className="space-y-1 text-sm text-muted-foreground">
              {permissionDiagnostics.notes.map((note) => (
                <p key={note}>{note}</p>
              ))}
            </div>
          ) : null}
        </div>
      </SettingsGroup>

      <SettingsGroup
        title="Keep and delete"

      >
        <SettingsOptionSelect
          settingId="retention"
          label="Auto-delete dictations"
          description="Deletes a whole dictation once it is this old: the text in History and any audio kept for it. The same setting appears in Dictation."
          value={
            settings.transcription.dictationRetentionPreset ??
            "never"
          }
          onChange={(value) =>
            void updateSettings({
              ...settings,
              transcription: {
                ...settings.transcription,
                dictationRetentionPreset: value as "custom" | "immediate" | "24h" | "72h" | "never",
              },
            })
          }
          footnote={
            (settings.transcription.dictationRetentionPreset ??
              "never") === "custom" ? (
              <SettingsInput
                className="pt-2"
                label="Custom retention hours"
                description="How many hours a dictation survives before it is deleted. The clock starts when it was captured."
                type="number"
                min={1}
                value={String(
                  settings.transcription
                    .dictationRetentionCustomHours ?? 24,
                )}
                onBlur={handleSettingsTextBlur}
                onKeyDown={handleSettingsTextKeyDown}
                onChange={(value) => {
                  const nextHours = Math.max(
                    1,
                    Number(value) || 1,
                  );
                  void updateSettings({
                    ...settings,
                    transcription: {
                      ...settings.transcription,
                      dictationRetentionCustomHours: nextHours,
                    },
                  });
                }}
              />
            ) : null
          }
        >
          <option value="immediate">Immediately</option>
          <option value="24h">After 24 hours</option>
          <option value="72h">After 72 hours</option>
          <option value="never">Never</option>
          <option value="custom">Custom</option>
        </SettingsOptionSelect>

        <MeetingAudioStorage
          transcription={settings.transcription}
          onChange={(patch) => updateSettings({
            ...settings,
            transcription: { ...settings.transcription, ...patch },
          }, { immediate: true })}
        />
      </SettingsGroup>

      <SettingsGroup title="Files">
        <SettingsRow
          settingId="export-folder"
          label="Export folder"
          description={
            <>
              <span className="font-medium text-foreground">
                {settings.privacy.exportLocationLabel ?? "Standard export folders"}
              </span>
              {" · "}
              {settings.privacy.exportLocationApproved
                ? "approved through the macOS folder picker."
                : settings.privacy.exportLocationLabel
                  ? "this older location needs to be chosen again."
                  : "exports go only to standard folders Plainsong approved."}
            </>
          }
          control={
            <Button
              type="button"
              variant="outline"
              onClick={async () => {
                setError(null);
                try {
                  const selected = await selectExportLocation();
                  if (!selected) return;
                  const current = latestSettingsRef.current;
                  if (!current) return;
                  updateSettings(
                    {
                      ...current,
                      privacy: {
                        ...current.privacy,
                        exportRoot: null,
                        exportLocationId: selected.id,
                        exportLocationLabel: selected.label,
                        exportLocationApproved: selected.approved,
                      },
                    },
                    { immediate: true },
                  );
                } catch (error) {
                  setError(
                    settingsErrorMessage(error, "Could not approve the export folder"),
                  );
                }
              }}
            >
              Choose export folder
            </Button>
          }
        />
        <SettingsMore
          settingId="backups"
          label="Backups"
          hint="Made only when you ask"
        >
          <div className="pb-2">
            {backupConfigLoading && !backupConfig && (
              <p className="py-3 text-sm text-muted-foreground">
                Loading backup settings…
              </p>
            )}

            {backupConfig && (
              <>
                <p className="py-2 text-sm leading-5 text-muted-foreground">
                  Nothing is backed up or uploaded on its own — a copy is made
                  only when you press a button here. This version cannot
                  restore full backups from or into a vault-encrypted
                  database; settings snapshots restore preferences only.
                </p>
                <div className="settings-rows">
                  <SettingsRow
                    label="Full backup"
                    description={`${latestFullBackup ? `Latest: ${formatDateTime(latestFullBackup.timestamp)} · ${latestFullBackup.itemsCount} items.` : "None yet."} Everything, including recordings and transcripts.`}
                    control={
                      <>
                        <Button
                          size="sm"
                          disabled={backupBusy}
                          onClick={async () => {
                            setBackupBusy(true);
                            setBackupStatus(null);
                            setError(null);
                            try {
                              await saveBackupConfig(backupConfig);
                              const info = await createBackupDefault();
                              setBackupStatus(
                                `Backup created: ${info.id}`,
                              );
                              await refreshBackups();
                            } catch (e) {
                              setError(
                                settingsErrorMessage(e, "Backup failed"),
                              );
                            } finally {
                              setBackupBusy(false);
                            }
                          }}
                        >
                          Back up everything
                        </Button>
                      </>
                    }
                  />
                  <SettingsRow
                    label="Settings snapshot"
                    description={`${latestSettingsSnapshot ? `Latest: ${formatDateTime(latestSettingsSnapshot.timestamp)} · ${latestSettingsSnapshot.itemsCount} items.` : "None yet."} Settings and shortcuts only — no recordings or transcripts.`}
                    control={
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={
                            backupBusy ||
                            !latestSettingsSnapshot ||
                            hasUnsavedChanges
                          }
                          onClick={async () => {
                            if (!latestSettingsSnapshot) return;
                            // Overwrites every preference at once, so it asks.
                            if (
                              !window.confirm(
                                `Replace your current settings with the snapshot from ${formatDateTime(latestSettingsSnapshot.timestamp)}? Recordings and transcripts are not touched.`,
                              )
                            ) {
                              return;
                            }
                            setBackupBusy(true);
                            setBackupStatus(null);
                            setError(null);
                            try {
                              await restoreBackupDefault(
                                latestSettingsSnapshot.id,
                              );
                              const restored = await getSettings();
                              setDraftSettings(restored);
                              setPersistedSettings(restored);
                              setBackupStatus(
                                `Restored settings snapshot ${latestSettingsSnapshot.id}.`,
                              );
                            } catch (e) {
                              setError(
                                settingsErrorMessage(e, "Settings snapshot restore failed"),
                              );
                            } finally {
                              setBackupBusy(false);
                            }
                          }}
                        >
                          Restore latest snapshot
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={backupBusy}
                          onClick={async () => {
                            setBackupBusy(true);
                            setBackupStatus(null);
                            setError(null);
                            try {
                              await saveBackupConfig(backupConfig);
                              const info =
                                await createSettingsBackupDefault();
                              setBackupStatus(
                                `Settings snapshot created: ${info.id}`,
                              );
                              await refreshBackups();
                            } catch (e) {
                              setError(
                                settingsErrorMessage(e, "Settings snapshot failed"),
                              );
                            } finally {
                              setBackupBusy(false);
                            }
                          }}
                        >
                          Snapshot settings
                        </Button>
                      </>
                    }
                  >
                    {hasUnsavedChanges ? (
                      <p className="text-sm text-rust">
                        Save or discard your settings edits before
                        restoring a snapshot.
                      </p>
                    ) : null}
                  </SettingsRow>
                  <SettingsRow
                    label={
                      <label htmlFor="backup-max-count">
                        Backups to keep on this Mac
                      </label>
                    }
                    description="Once there are more than this, the oldest is removed."
                    control={
                      <div className="w-20 shrink-0">
                        <Input
                          id="backup-max-count"
                          type="number"
                          min={1}
                          className="h-9 w-20"
                          value={backupConfig.maxBackups}
                          onChange={(e: ChangeEvent<HTMLInputElement>) =>
                            setBackupConfig({
                              ...backupConfig,
                              maxBackups: Math.max(1, Number(e.target.value) || 7),
                            })
                          }
                        />
                      </div>
                    }
                  />
                  <SettingsRow
                    label="Backup folder"
                    description={
                      backupConfig.backupLocationLabel
                        ? `${backupConfig.backupLocationLabel} · ${backupConfig.backupLocationApproved ? "approved through the macOS folder picker." : "this older folder needs to be chosen again."}`
                        : "Where a backup is written on this Mac. macOS hands Plainsong the folder through its own picker."
                    }
                    control={
                      <Button
                        size="sm"
                        type="button"
                        variant="outline"
                        disabled={backupBusy}
                        onClick={async () => {
                          setBackupBusy(true);
                          setError(null);
                          try {
                            const selected = await selectBackupLocation();
                            if (!selected) return;
                            setBackupConfig({
                              ...backupConfig,
                              backupDir: null,
                              backupLocationId: selected.id,
                              backupLocationLabel: selected.label,
                              backupLocationApproved: selected.approved,
                            });
                          } catch (error) {
                            setError(
                              settingsErrorMessage(error, "Could not approve the backup folder"),
                            );
                          } finally {
                            setBackupBusy(false);
                          }
                        }}
                      >
                        Choose backup folder
                      </Button>
                    }
                  />
                  <SettingsSwitch
                    label="Allow uploading to cloud storage"
                    description="Shows where uploads go and the upload buttons. Uploads still only happen when you press one."
                    checked={backupConfig.cloudSync}
                    onCheckedChange={(checked) =>
                      setBackupConfig({
                        ...backupConfig,
                        cloudSync: checked,
                      })
                    }
                  />
                  {backupConfig.cloudSync ? (
                    <>
                    <SettingsOptionSelect
                      label="Cloud storage service"
                      description="Where an upload goes when you press one of the Sync buttons. Choosing one here uploads nothing on its own."
                      value={backupConfig.cloudProvider ?? ""}
                      onChange={(value) =>
                        setBackupConfig({
                          ...backupConfig,
                          cloudProvider: (value ||
                            null) as BackupConfig["cloudProvider"],
                          cloudLocationId: null,
                          cloudLocationLabel: null,
                          cloudLocationApproved: false,
                        })
                      }
                    >
                      <option value="">Choose one</option>
                      <option value="one_drive">OneDrive</option>
                      <option value="google_drive">
                        Google Drive
                      </option>
                      <option value="proton_drive">
                        Proton Drive
                      </option>
                      <option value="i_cloud">iCloud</option>
                    </SettingsOptionSelect>
                    <SettingsInput
                      label="Cloud folder"
                      description="The folder name Plainsong creates or reuses inside that service. It is created on the first upload."
                      value={backupConfig.cloudFolder}
                      onChange={(value) =>
                        setBackupConfig({
                          ...backupConfig,
                          cloudFolder: value,
                        })
                      }
                      placeholder="PlainsongBackups"
                    />
                    {backupConfig.cloudProvider === "i_cloud" ? (
                      <div className="space-y-2">
                        <Label>iCloud destination</Label>
                        <p className="text-sm text-muted-foreground">
                          {backupConfig.cloudLocationLabel
                            ? `Uploads go to ${backupConfig.cloudLocationLabel}.`
                            : "Nothing can be uploaded until you pick the iCloud folder in the macOS picker below."}
                        </p>
                      </div>
                    ) : (
                      <SettingsInput
                        label="rclone remote name"
                        description="The name you gave this service when you ran rclone config. Plainsong uploads through rclone, so a name that does not match one of your remotes fails the connection test."
                        value={backupConfig.cloudRemoteName ?? ""}
                        onChange={(value) =>
                          setBackupConfig({
                            ...backupConfig,
                            cloudRemoteName: value.trim() ? value : null,
                          })
                        }
                        placeholder="onedrive / gdrive / protondrive"
                      />
                    )}
                      <SettingsRow
                        label="Cloud destination"
                        description={
                          backupConfig.cloudLocationApproved
                            ? `Approved: ${backupConfig.cloudLocationLabel}`
                            : "Uploads stay blocked until this destination is confirmed."
                        }
                        control={
                          <Button
                            size="sm"
                            type="button"
                            variant="outline"
                            disabled={backupBusy || !backupConfig.cloudProvider}
                            onClick={async () => {
                              if (!backupConfig.cloudProvider) return;
                              setBackupBusy(true);
                              setError(null);
                              try {
                                const selected = await selectCloudBackupLocation({
                                  provider: backupConfig.cloudProvider,
                                  remoteName: backupConfig.cloudRemoteName,
                                  folder: backupConfig.cloudFolder,
                                });
                                if (!selected) return;
                                setBackupConfig({
                                  ...backupConfig,
                                  cloudLocationId: selected.id,
                                  cloudLocationLabel: selected.label,
                                  cloudLocationApproved: selected.approved,
                                  icloudPath: null,
                                });
                              } catch (error) {
                                setError(
                                  settingsErrorMessage(error, "Could not approve the cloud destination"),
                                );
                              } finally {
                                setBackupBusy(false);
                              }
                            }}
                          >
                            {backupConfig.cloudProvider === "i_cloud"
                              ? "Choose and approve cloud folder"
                              : "Confirm cloud destination"}
                          </Button>
                        }
                      >
                        {backupConfig.cloudProvider !== "i_cloud" ? (
                          <p className="text-sm text-muted-foreground">
                            OneDrive, Google Drive and Proton Drive need
                            rclone: run{" "}
                            <code className="rounded bg-muted px-1">
                              rclone config
                            </code>{" "}
                            in Terminal and create the remote first.
                          </p>
                        ) : null}
                      </SettingsRow>
                      <SettingsRow
                        label="Upload"
                        description="Sends the latest backup or snapshot to the destination above."
                        control={
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={
                                backupBusy ||
                                !latestSettingsSnapshot ||
                                !backupConfig.cloudSync
                              }
                              onClick={async () => {
                                if (!latestSettingsSnapshot) return;
                                setBackupBusy(true);
                                setBackupStatus(null);
                                setError(null);
                                try {
                                  await saveBackupConfig(backupConfig);
                                  await syncBackupToCloud(
                                    latestSettingsSnapshot.id,
                                  );
                                  setBackupStatus(
                                    `Synced settings snapshot ${latestSettingsSnapshot.id} to cloud.`,
                                  );
                                } catch (e) {
                                  setError(
                                    settingsErrorMessage(e, "Settings snapshot sync failed"),
                                  );
                                } finally {
                                  setBackupBusy(false);
                                }
                              }}
                            >
                              Upload latest snapshot
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={
                                backupBusy ||
                                !latestFullBackup ||
                                !backupConfig.cloudSync
                              }
                              onClick={async () => {
                                if (!latestFullBackup) return;
                                setBackupBusy(true);
                                setBackupStatus(null);
                                setError(null);
                                try {
                                  await saveBackupConfig(backupConfig);
                                  await syncBackupToCloud(latestFullBackup.id);
                                  setBackupStatus(
                                    `Synced full backup ${latestFullBackup.id} to cloud.`,
                                  );
                                } catch (e) {
                                  setError(
                                    settingsErrorMessage(e, "Cloud sync failed"),
                                  );
                                } finally {
                                  setBackupBusy(false);
                                }
                              }}
                            >
                              Upload latest backup
                            </Button>
                          </>
                        }
                      />
                      <SettingsRow
                        label="Check the cloud setup"
                        description="Tests the connection, or lists what still stands between you and a working upload."
                        control={
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={backupBusy || !backupConfig.cloudSync}
                              onClick={async () => {
                                setBackupBusy(true);
                                setBackupStatus(null);
                                setError(null);
                                try {
                                  await saveBackupConfig(backupConfig);
                                  await verifyBackupCloudConnection();
                                  setBackupStatus(
                                    "Connected.",
                                  );
                                } catch (e) {
                                  setError(
                                    settingsErrorMessage(e, "Cloud verification failed"),
                                  );
                                } finally {
                                  setBackupBusy(false);
                                }
                              }}
                            >
                              Test the connection
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={backupBusy || !backupConfig.cloudSync}
                              onClick={async () => {
                                setBackupBusy(true);
                                setBackupStatus(null);
                                setError(null);
                                try {
                                  await saveBackupConfig(backupConfig);
                                  const report = await getBackupSetupReport();
                                  setBackupSetupReport(report);
                                  setBackupStatus(
                                    report.ready
                                      ? "Everything checks out."
                                      : "Some checks need attention.",
                                  );
                                } catch (e) {
                                  setError(
                                    settingsErrorMessage(e, "Setup checks failed"),
                                  );
                                } finally {
                                  setBackupBusy(false);
                                }
                              }}
                            >
                              Run setup checks
                            </Button>
                          </>
                        }
                      >
                        {backupSetupReport && (
                          <div className="space-y-2">
                            <div className="flex items-center justify-between">
                              <div>
                                <p className="section-heading">
                                  Cloud setup checks
                                </p>
                                <p className="text-sm text-muted-foreground">
                                  What still stands between you and a working
                                  upload.
                                </p>
                              </div>
                              <span
                                className={`text-sm font-medium ${
                                  backupSetupReport.ready
                                    ? "text-gold-text"
                                    : "text-rust"
                                }`}
                              >
                                {backupSetupReport.ready
                                  ? "Ready"
                                  : "Needs action"}
                              </span>
                            </div>
                            <div className="space-y-2">
                              {backupSetupReport.checks.map((check) => (
                                <div key={check.id}>
                                  <p className="flex items-center gap-2 text-sm font-medium">
                                    <span
                                      aria-hidden="true"
                                      className={
                                        check.status === "pass"
                                          ? "neume neume-lit"
                                          : "neume neume-rust"
                                      }
                                    />
                                    {check.label}
                                  </p>
                                  <p className="pl-5 text-sm text-muted-foreground">
                                    {check.message}
                                  </p>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </SettingsRow>
                    </>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-3 pt-3">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={backupBusy}
                    onClick={async () => {
                      setBackupBusy(true);
                      setBackupStatus(null);
                      setError(null);
                      try {
                        await saveBackupConfig(backupConfig);
                        setBackupStatus(
                          "Backup settings saved.",
                        );
                      } catch (e) {
                        setError(
                          settingsErrorMessage(e, "Failed to save backup config"),
                        );
                      } finally {
                        setBackupBusy(false);
                      }
                    }}
                  >
                    Save backup settings
                  </Button>
                  {backupStatus ? (
                    <p role="status" className="text-sm text-muted-foreground">
                      {backupStatus}
                    </p>
                  ) : null}
                </div>
              </>
            )}
          </div>
        </SettingsMore>
        {/* The vault-initialized bit only says a migration once ran.
            Capture writes a plain WAV either way, so report the count of
            files that are actually encrypted and say plainly that new
            recordings are not. */}
        <SettingsMore
          settingId="encryption"
          label="Encryption"
          hint={`Recordings on disk: ${recordingEncryptionSummary.chip.toLowerCase()}`}
        >
          <div className="space-y-3 py-3">
            <p className="text-sm leading-5 text-muted-foreground">
              {recordingEncryptionSummary.description}
            </p>
            <p
              id="vault-password-description"
              className="text-sm leading-5 text-muted-foreground"
            >
              The vault encrypts recordings already saved on this Mac. Enter its
              password to unlock it, or to encrypt what is on disk now. New
              recordings are written unencrypted either way, and there is no
              recovery if you lose the password.
            </p>
            <Label htmlFor="vault-password">Password</Label>
            <Input
              id="vault-password"
              aria-describedby="vault-password-description"
              type="password"
              placeholder="Vault password"
              value={vaultPassword}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setVaultPassword(e.target.value)
              }
            />
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={!vaultPassword.trim()}
                onClick={async () => {
                  setError(null);
                  try {
                    await unlockVault(vaultPassword.trim());
                    setVaultPassword("");
                    setSecurityStatus(
                      await getSecurityStatus(),
                    );
                  } catch (e) {
                    setError(
                      settingsErrorMessage(e, "Failed to unlock vault"),
                    );
                  }
                }}
              >
                Unlock vault
              </Button>
              <Button
                variant="outline"
                onClick={async () => {
                  setError(null);
                  try {
                    await lockVault();
                    setSecurityStatus(
                      await getSecurityStatus(),
                    );
                  } catch (e) {
                    setError(
                      settingsErrorMessage(e, "Failed to lock vault"),
                    );
                  }
                }}
              >
                Lock vault
              </Button>
              <Button
                disabled={!vaultPassword.trim()}
                onClick={async () => {
                  setError(null);
                  try {
                    await migrateToEncryptedStorage(
                      vaultPassword.trim(),
                    );
                    setVaultPassword("");
                    setSecurityStatus(
                      await getSecurityStatus(),
                    );
                  } catch (e) {
                    setError(
                      settingsErrorMessage(e, "Failed to migrate to encrypted storage"),
                    );
                  }
                }}
              >
                Encrypt what is on disk now
              </Button>
            </div>
            {securityStatus ? (
              <div className="mt-2 space-y-1 text-sm text-muted-foreground">
                {[
                  {
                    label: "Vault set up",
                    on: securityStatus.vaultInitialized,
                  },
                  {
                    label: "Vault unlocked",
                    on: securityStatus.vaultUnlocked,
                  },
                  {
                    label: "Database encrypted",
                    on: securityStatus.databaseEncrypted,
                  },
                ].map((row) => (
                  <p
                    key={row.label}
                    className="flex items-center gap-2"
                  >
                    <span
                      aria-hidden="true"
                      className={
                        row.on
                          ? "neume neume-lit"
                          : "neume neume-hollow"
                      }
                    />
                    {row.label}:{" "}
                    <span className="font-medium text-foreground">
                      {row.on ? "yes" : "no"}
                    </span>
                  </p>
                ))}
              </div>
            ) : null}
          </div>
        </SettingsMore>
      </SettingsGroup>

      <SettingsGroup title="Start over">
        <SettingsRow
          settingId="reset"
          label="Reset Plainsong"
          description="Deletes every recording, transcript, project and saved API key, and puts every setting back to a new install. Downloaded speech models are kept. Setup runs again next time."
          control={
            <Button
              variant="destructive"
              disabled={resettingApp}
              onClick={() => {
                setResetPhrase("");
                setShowResetDialog(true);
              }}
            >
              {resettingApp ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Reset everything on this device
            </Button>
          }
        />
        <Dialog
          open={showResetDialog}
          onOpenChange={setShowResetDialog}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                Reset everything on this device?
              </DialogTitle>
              <DialogDescription>
                Type{" "}
                <span className="font-semibold">RESET</span> to
                permanently delete your recordings, transcripts,
                projects, logs, and saved API keys. This cannot be
                undone.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="reset-phrase">Confirmation</Label>
              <Input
                id="reset-phrase"
                value={resetPhrase}
                onChange={(event) =>
                  setResetPhrase(event.target.value)
                }
                placeholder="Type RESET"
                autoFocus
              />
              <p className="text-sm text-muted-foreground">
                Upper or lower case both work.
              </p>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setShowResetDialog(false);
                  setResetPhrase("");
                }}
                disabled={resettingApp}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={
                  resettingApp ||
                  resetPhrase.trim().toUpperCase() !== "RESET"
                }
                onClick={async () => {
                  await performReset();
                }}
              >
                {resettingApp ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                Confirm reset
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </SettingsGroup>
    </div>
  );

  const renderAdvancedSection = () => (
    <div className="settings-section">
      <div id="setting-speech-diagnostics">
        <AsrProviderManager />
      </div>

      <SettingsGroup
        title="Speech detection"
        settingId="speech-detection"
        description="How Plainsong treats quiet stretches and decides you are speaking."
      >
        <SettingsSwitch
          label="Skip silence"
          description="Skips digital silence before transcription while keeping quiet speech."
          checked={settings.transcription.silenceSkipEnabled}
          onCheckedChange={(checked) =>
            updateTranscription({ silenceSkipEnabled: checked })
          }
        />
        {/* The VAD backend drives dictation auto-stop-on-silence and
            hands-free auto-start, so show the picker whenever either of
            those features is in use. */}
            {(settings.transcription.dictationHandsFreeEnabled ||
              (settings.transcription.dictationSilenceTimeoutSeconds ?? 0) >
                0) && (
              <SettingsRow
                label="How Plainsong hears you start talking"
                labelId="vad-backend-label"
                description={
                  sileroVadAvailable
                    ? "Loudness works well in a quiet room. The voice detection model holds up better in a noisy one."
                    : "Loudness works well in a quiet room. A small voice detection model holds up better in a noisy one; it is a one-time 2 MB download."
                }
                control={
                  <div
                    role="group"
                    aria-labelledby="vad-backend-label"
                    className="inline-flex gap-0.5 rounded-lg border border-border/80 p-0.5"
                  >
                    <Button
                      variant={
                        (settings.transcription.dictationVadBackend ??
                          "energy_threshold") === "energy_threshold"
                          ? "active"
                          : "ghost"
                      }
                      size="sm"
                      className="h-8 px-2.5"
                      aria-pressed={
                        (settings.transcription.dictationVadBackend ??
                          "energy_threshold") === "energy_threshold"
                      }
                      onClick={() =>
                        void updateSettings({
                          ...settings,
                          transcription: {
                            ...settings.transcription,
                            dictationVadBackend: "energy_threshold",
                          },
                        })
                      }
                    >
                      Loudness
                    </Button>
                    {sileroVadAvailable ? (
                      <Button
                        variant={
                          settings.transcription.dictationVadBackend === "silero"
                            ? "active"
                            : "ghost"
                        }
                        size="sm"
                        className="h-8 px-2.5"
                        aria-pressed={
                          settings.transcription.dictationVadBackend === "silero"
                        }
                        onClick={() =>
                          void updateSettings({
                            ...settings,
                            transcription: {
                              ...settings.transcription,
                              dictationVadBackend: "silero",
                            },
                          })
                        }
                      >
                        Voice detection model
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 px-2.5"
                        disabled={sileroVadDownloading}
                        onClick={async () => {
                          setSileroVadDownloading(true);
                          try {
                            await downloadSileroVadModel();
                            setSileroVadAvailable(true);
                            const current = latestSettingsRef.current;
                            if (!current) return;
                            void updateSettings({
                              ...current,
                              transcription: {
                                ...current.transcription,
                                dictationVadBackend: "silero",
                              },
                            });
                          } catch (e) {
                            const msg = settingsErrorMessage(
                              e,
                              "Plainsong could not download the model.",
                            );
                            setError(`Download failed: ${msg}`);
                          } finally {
                            setSileroVadDownloading(false);
                          }
                        }}
                      >
                        {sileroVadDownloading ? (
                          <>
                            <Loader2 aria-hidden="true" className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                            Downloading…
                          </>
                        ) : (
                          <>
                            <Download aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
                            Voice detection model, 2 MB
                          </>
                        )}
                      </Button>
                    )}
                  </div>
                }
              />
            )}
      </SettingsGroup>

      <LocalToolsSection
        enabled={settings.automation?.localToolsEnabled ?? false}
        onEnabledChange={(checked) =>
          void updateSettings({
            ...settings,
            automation: {
              ...settings.automation,
              localToolsEnabled: checked,
            },
          })
        }
      />

      <SupportBundlePanel />
    </div>
  );

  const renderActiveSection = () => {
    switch (activeTab) {
      case "general":
        return renderGeneralSection();
      case "dictation":
        return renderDictationSection();
      case "meetings":
        return renderMeetingsSection();
      case "models":
        return (
          <ModelsScreen
            settings={settings}
            onPatchSettings={patchSettings}
            aiModelsForProvider={getCachedModelsForProvider}
            aiModelsLoading={modelsLoading}
            onAiProviderChange={(lane, providerName) =>
              void updateAnalysisProvider(lane, providerName)
            }
            onAiModelsRefresh={(providerName) => void refreshModelsForProvider(providerName)}
            onAiModelChange={updateAnalysisModel}
            onOpenKeySettings={() => setActiveTab("ai")}
            onOpenDiagnostics={() => setActiveTab("advanced")}
          />
        );
      case "shortcuts":
        return renderShortcutsSection();
      case "ai":
        return renderSearchAndAiSection();
      case "privacy":
        return renderPrivacySection();
      case "advanced":
        return renderAdvancedSection();
    }
  };

  return (
    <div className="flex h-full min-h-0 bg-background">
      {/* The section list stays put while a long section scrolls. */}
      <nav
        aria-label="Settings"
        className="flex w-52 shrink-0 flex-col border-r border-border/60 px-3 pb-4 pt-6 lg:w-56"
      >
        <div className="px-2">
          <h1 className="font-serif text-2xl font-semibold tracking-tight">
            Settings
          </h1>
          <p className="mt-1 text-[13px] leading-5 text-muted-foreground">
            How Plainsong listens, writes, and what it keeps.
          </p>
        </div>
        <div className="relative mt-5">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            aria-label="Search settings"
            placeholder="Search"
            value={settingsQuery}
            onChange={(event) => setSettingsQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setSettingsQuery("");
              } else if (event.key === "Enter" && searchResults[0]) {
                event.preventDefault();
                openSearchResult(searchResults[0]);
              }
            }}
            className="h-8 pl-8 text-sm"
          />
        </div>
        <div
          role="tablist"
          aria-label="Settings sections"
          aria-orientation="vertical"
          className="mt-3 flex flex-col gap-0.5"
        >
          {SETTINGS_SECTIONS.map((section) => {
            const selected = !searching && activeTab === section.id;
            return (
              <button
                key={section.id}
                ref={(element) => {
                  tabButtonRefs.current[section.id] = element;
                }}
                type="button"
                role="tab"
                id={`settings-tab-${section.id}`}
                aria-selected={selected}
                aria-controls="settings-tab-panel"
                tabIndex={activeTab === section.id ? 0 : -1}
                onClick={() => {
                  setSettingsQuery("");
                  setActiveTab(section.id);
                }}
                onKeyDown={handleTabKeyDown}
                className={`flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  selected
                    ? "bg-muted font-medium text-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                }`}
              >
                <section.icon
                  aria-hidden="true"
                  className={`h-4 w-4 shrink-0 ${selected ? "text-gold-text" : ""}`}
                />
                {section.label}
              </button>
            );
          })}
        </div>
        <div className="mt-auto space-y-2 px-2 pt-4">
          <p className="flex items-baseline gap-2 text-[13px] leading-5 text-muted-foreground">
            <span
              aria-hidden="true"
              className={`neume shrink-0 ${
                dictationReadinessChip.tone === "neutral"
                  ? "neume-hollow"
                  : dictationReadinessChip.tone
                    ? "neume-lit"
                    : "neume-rust"
              }`}
            />
            <span className="min-w-0">
            <span>{dictationReadinessChip.label}</span>
            <span aria-hidden="true"> · </span>
            <span
              className={`whitespace-nowrap ${
                dictationReadinessChip.tone === true
                  ? "text-gold-text"
                  : dictationReadinessChip.tone === false
                    ? "text-rust"
                    : ""
              }`}
            >
              {dictationReadinessChip.status}
            </span>
            </span>
          </p>
          <p role="status" className="text-[13px] text-muted-foreground">
            {saveStateLabel}
          </p>
        </div>
      </nav>

      <div ref={contentScrollRef} className="@container min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div className="mx-auto max-w-[46rem] px-6 pb-16 pt-7 @lg:px-10">
          {settingsSaveError && (
            <div role="alert" className="mb-6 flex flex-wrap items-center gap-3 rounded-lg border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle aria-hidden="true" className="h-4 w-4 shrink-0" />
              <p className="min-w-0 flex-1">{settingsSaveError}</p>
              {hasUnsavedChanges && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isSaving}
                  onClick={() => {
                    const current = latestSettingsRef.current;
                    if (current) {
                      setSettingsSaveError(null);
                      queueSettingsSave(current, 0);
                      void flushPendingSettingsSave();
                    }
                  }}
                >
                  Retry saving
                </Button>
              )}
            </div>
          )}
          {error && (
            <div role="alert" className="mb-6 flex items-center gap-2 rounded-lg border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle aria-hidden="true" className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          {searching ? (
            <section aria-label="Search results">
              <h2 className="font-serif text-2xl font-semibold tracking-tight">
                Search
              </h2>
              <p className="mt-1 text-sm text-muted-foreground" role="status">
                {searchResults.length === 0
                  ? `Nothing in Settings matches “${settingsQuery.trim()}”.`
                  : `${searchResults.length} ${searchResults.length === 1 ? "setting matches" : "settings match"} “${settingsQuery.trim()}”.`}
              </p>
              {searchResults.length > 0 ? (
                <ul className="settings-rows mt-5">
                  {searchResults.map((entry) => (
                    <li key={entry.id}>
                      <button
                        type="button"
                        onClick={() => openSearchResult(entry)}
                        className="flex w-full items-center justify-between gap-4 rounded-md px-2 py-3 text-left text-sm hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <span className="font-medium">{entry.label}</span>
                        <span className="shrink-0 text-muted-foreground">
                          {settingsSectionLabel(entry.section)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : (
            <section
              id="settings-tab-panel"
              role="tabpanel"
              aria-labelledby={`settings-tab-${activeTab}`}
            >
              {/* Keyed on the section so each switch replays a short fade;
                  the reduced-motion variant drops it. */}
              <div
                key={activeTab}
                className="animate-in fade-in-0 duration-150 motion-reduce:animate-none"
              >
                <h2 className="font-serif text-2xl font-semibold tracking-tight">
                  {activeSection.label}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {activeSection.summary}
                </p>
                <div className="mt-7">{renderActiveSection()}</div>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
