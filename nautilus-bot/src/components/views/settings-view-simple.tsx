import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import { AsrProviderManager } from "@/components/asr-provider-manager";
import { ModelsScreen } from "@/components/models/models-screen";
import {
  AI_LANE_KEYS,
  describeAnalysisDestination,
  isRemoteAnalysisProvider,
  type AiLaneKey,
} from "@/components/models/ai-lanes";
import { invoke, listen } from "@/lib/electron";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
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
  saveSettings,
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
import {
  downloadDiarizationModel,
  downloadSileroVadModel,
  getAsrProviders,
  isDiarizationModelAvailable,
  refreshAsrRuntimeProbes,
  isSileroVadModelDownloaded,
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
import { formatShortcutForDisplay, normalizeShortcut } from "@/lib/shortcuts";
import {
  normalizeShortcutAccelerator,
  SHORTCUT_FIELD_PRECEDENCE,
} from "../../../electron/shortcut-registration";
import { ONBOARDING_STORAGE_KEY, requestOnboarding } from "@/lib/onboarding";
import { requestMainView } from "@/lib/navigation";
import {
  AlertCircle,
  Cloud,
  Database,
  Key,
  Layers,
  Lock,
  Mic,
  Monitor,
  Shield,
  Sun,
  Moon,
  Loader2,
  Download,
  RefreshCw,
} from "lucide-react";
import { UpdateStatusWidget, BetaChannelToggle } from "@/components/update";
import { useToast } from "@/components/toast";

type TabId =
  | "models"
  | "asr"
  | "general"
  | "security"
  | "storage"
  | "ai"
  | "updates";
type QueuedSettingsSave = {
  version: number;
  settings: Settings;
};

type SettingsSaveScheduler = {
  nextVersion: number;
  latestAppliedVersion: number;
  pending: QueuedSettingsSave | null;
  timer: ReturnType<typeof setTimeout> | null;
  flushing: boolean;
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

function coerceProviderModelId(
  currentModelId: string | null | undefined,
  availableModels: string[],
): string | null {
  if (availableModels.length === 0) {
    return currentModelId ?? null;
  }
  if (currentModelId && availableModels.includes(currentModelId)) {
    return currentModelId;
  }
  return availableModels[0] ?? null;
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

const SETTINGS_TABS = [
  {
    id: "models" as TabId,
    label: "Models",
    summary: "Which engine hears you, and which AI tidies the text",
    icon: Layers,
  },
  {
    id: "asr" as TabId,
    label: "Transcription",
    summary: "Microphones, dictation behavior, and engine diagnostics",
    icon: Mic,
  },
  {
    id: "general" as TabId,
    label: "General",
    summary: "Appearance, shortcuts, and window behavior",
    icon: Monitor,
  },
  {
    id: "security" as TabId,
    label: "Privacy & Security",
    summary: "Permissions, vault, and cloud access",
    icon: Shield,
  },
  {
    id: "storage" as TabId,
    label: "Storage",
    summary: "Exports, retention, backups, and reset tools",
    icon: Database,
  },
  {
    id: "ai" as TabId,
    label: "AI & Keys",
    summary: "AI services, API keys, and memory search",
    icon: Key,
  },
  {
    id: "updates" as TabId,
    label: "Updates",
    summary: "Version status and update channels",
    icon: RefreshCw,
  },
] as const;

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

function resolveDictationReadinessChip(
  settings: Settings | null,
  permissionDiagnostics: PermissionDiagnostics | null,
  providers: AsrProviderInfo[] = [],
): ReadinessChipState {
  if (!permissionDiagnostics) {
    return {
      label: "Dictation",
      status: "Checking",
      tone: "neutral",
    };
  }

  const microphoneReady =
    permissionDiagnostics.microphonePermissionReady ??
    permissionDiagnostics.microphoneReady ??
    false;
  const useSharedSelection =
    settings?.transcription.useSharedAsrSelection ?? true;
  const dictationProvider = useSharedSelection
    ? settings?.transcription.defaultProvider
    : settings?.transcription.dictationProvider ??
      settings?.transcription.defaultProvider;
  const usesAppleSpeech = dictationProvider === "macos_apple_speech";
  const appleSpeechReadiness = providers.find(
    (provider) => provider.providerType === "macos_apple_speech",
  )?.platformReadiness;
  const insertionMode = settings?.transcription.dictationInsertionMode ?? "auto";
  const cursorInsertionReady =
    insertionMode === "clipboard_only"
      ? true
      : permissionDiagnostics.cursorInsertionReady ??
        permissionDiagnostics.accessibilityReady ??
        true;

  if (!microphoneReady) {
    return {
      label: "Microphone",
      status: "Needs setup",
      tone: false,
    };
  }

  if (usesAppleSpeech && appleSpeechReadiness && !appleSpeechReadiness.ready) {
    return {
      label: "Apple Speech",
      status:
        appleSpeechReadiness.status === "authorization_denied"
          ? "Permission denied"
          : appleSpeechReadiness.status === "authorization_not_determined"
            ? "Permission required"
            : appleSpeechReadiness.status === "unsupported_locale"
              ? "Locale unsupported"
              : appleSpeechReadiness.status === "helper_missing"
                ? "Helper missing"
                : appleSpeechReadiness.status === "on_device_unavailable"
                  ? "On-device unavailable"
                  : "Needs setup",
      tone: false,
    };
  }

  if (usesAppleSpeech && !permissionDiagnostics.speechRecognitionReady) {
    return {
      label: "Speech recognition",
      status: "Needs setup",
      tone: false,
    };
  }

  if (!cursorInsertionReady) {
    return {
      label: "Text insertion",
      status: "Needs setup",
      tone: false,
    };
  }

  return {
    label: "Dictation",
    status: "Ready",
    tone: true,
  };
}

export function SettingsView() {
  const { theme, setTheme } = useTheme();
  const [activeTab, setActiveTab] = useState<TabId>("general");
  const [draftSettings, setDraftSettings] = useState<Settings | null>(null);
  const [persistedSettings, setPersistedSettings] = useState<Settings | null>(
    null,
  );
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  const [asrProviders, setAsrProviders] = useState<AsrProviderInfo[]>([]);
  const [nativeShortcutAvailable, setNativeShortcutAvailable] =
    useState(false);
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
  const [diarizationAvailable, setDiarizationAvailable] = useState(false);
  const [diarizationDownloading, setDiarizationDownloading] = useState(false);
  const [sileroVadAvailable, setSileroVadAvailable] = useState(false);
  const [sileroVadDownloading, setSileroVadDownloading] = useState(false);
  const [micTestActive, setMicTestActive] = useState(false);
  const [micTestError, setMicTestError] = useState<string | null>(null);
  const [micTestLevel, setMicTestLevel] = useState(0);
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
  const micTestContextRef = useRef<AudioContext | null>(null);
  const micTestAnimFrameRef = useRef<number | null>(null);
  const micTestStreamRef = useRef<MediaStream | null>(null);
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
  const saveSchedulerRef = useRef<SettingsSaveScheduler>({
    nextVersion: 0,
    latestAppliedVersion: 0,
    pending: null,
    timer: null,
    flushing: false,
  });
  // Tracks the last settings snapshot known to be on disk, so the
  // settings-changed listener below can tell which draft sections still
  // have unsaved local edits (and must not be clobbered by another writer's
  // broadcast) versus which sections are safe to refresh from it.
  const persistedSettingsRef = useRef<Settings | null>(null);

  const settings = draftSettings;
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
    () => resolveDictationReadinessChip(settings, permissionDiagnostics, asrProviders),
    [asrProviders, settings, permissionDiagnostics],
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

          try {
            await saveSettings(queued.settings);
            if (queued.version >= scheduler.latestAppliedVersion) {
              scheduler.latestAppliedVersion = queued.version;
              if (mountedRef.current) {
                setPersistedSettings(queued.settings);
                applySecurityStatusFromSettings(queued.settings);
              }
            }
          } catch (e) {
            if (mountedRef.current) {
              setError(
                e instanceof Error ? e.message : "Failed to save settings",
              );
            }
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
    (next: Settings, debounceMs = SETTINGS_SAVE_DEBOUNCE_MS) => {
      const scheduler = saveSchedulerRef.current;
      scheduler.nextVersion += 1;
      scheduler.pending = {
        version: scheduler.nextVersion,
        settings: next,
      };

      if (scheduler.timer) {
        clearTimeout(scheduler.timer);
      }
      scheduler.timer = setTimeout(() => {
        void flushPendingSettingsSave();
      }, debounceMs);
      markSettingsPerf("settings-save-queued");
    },
    [flushPendingSettingsSave],
  );

  const performReset = useCallback(async () => {
    setResettingApp(true);
    setError(null);
    try {
      const result = await resetAppState();
      localStorage.removeItem(ONBOARDING_STORAGE_KEY);
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
        err instanceof Error
          ? err.message
          : "Failed to reset application state";
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
      if (!settings) {
        return;
      }

      const next: Settings = {
        ...settings,
        shortcuts: {
          ...settings.shortcuts,
          [field]: nextShortcut,
          toggleDictationAlternates: [],
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

  useEffect(() => {
    mountedRef.current = true;
    markSettingsPerf("settings-initial-load-start");

    const load = async () => {
      try {
        const loaded = await getSettings();
        if (mountedRef.current) {
          setDraftSettings(loaded);
          setPersistedSettings(loaded);
          markSettingsPerf("settings-initial-load-complete");
        }
      } catch (e) {
        if (mountedRef.current) {
          setError(e instanceof Error ? e.message : "Failed to load settings");
        }
      }
    };

    void load();
    return () => {
      mountedRef.current = false;
      void flushPendingSettingsSave(true);
    };
  }, [flushPendingSettingsSave]);

  useEffect(() => {
    persistedSettingsRef.current = persistedSettings;
  }, [persistedSettings]);

  // Other writers (theme toggle, beta-channel switch, ASR route picker,
  // dictation view, first-run wizard) each save a whole Settings object of
  // their own. Without this, this view's debounced whole-object save could
  // silently revert whatever they just changed (and vice versa). The sidecar
  // broadcasts the full settings after every save; refresh any section that
  // has no unsaved local edit (i.e. still matches the last snapshot we knew
  // was on disk) rather than clobbering it.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void listen<Settings>("settings-changed", (event) => {
      if (!mountedRef.current) {
        return;
      }
      const incoming = event.payload;
      const lastKnownPersisted = persistedSettingsRef.current;

      const mergeKeepingPendingEdits = (prev: Settings): Settings => {
        if (!lastKnownPersisted) {
          // No baseline to diff pending edits against yet -- leave the draft
          // alone rather than risk discarding an in-progress edit.
          return prev;
        }
        const merged = { ...prev } as Record<string, unknown>;
        const prevRecord = prev as unknown as Record<string, unknown>;
        const lastPersistedRecord = lastKnownPersisted as unknown as Record<
          string,
          unknown
        >;
        const incomingRecord = incoming as unknown as Record<string, unknown>;
        for (const key of Object.keys(incomingRecord)) {
          const hasNoPendingEdit =
            JSON.stringify(prevRecord[key]) ===
            JSON.stringify(lastPersistedRecord[key]);
          if (hasNoPendingEdit) {
            merged[key] = incomingRecord[key];
          }
        }
        return merged as unknown as Settings;
      };

      setDraftSettings((prevDraft) =>
        prevDraft ? mergeKeepingPendingEdits(prevDraft) : incoming,
      );
      // A save may already be queued (debounced) with a snapshot taken
      // before this broadcast arrived; merge it the same way so the flush
      // that eventually fires doesn't re-clobber the sections we just
      // refreshed with stale data from that snapshot.
      const scheduler = saveSchedulerRef.current;
      if (scheduler.pending) {
        scheduler.pending = {
          version: scheduler.pending.version,
          settings: mergeKeepingPendingEdits(scheduler.pending.settings),
        };
      }
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
    markSettingsPerf(`settings-tab-open:${activeTab}`);
  }, [activeTab]);

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
            e instanceof Error ? e.message : "Failed to load permission status",
          );
        }
      }
    };

    void loadPermissionDiagnostics();
    return () => {
      mounted = false;
    };
  }, [permissionDiagnostics]);

  useEffect(() => {
    let mounted = true;
    getDictationShortcutCapabilityStatus()
      .then((status: DictationShortcutCapabilityStatus) => {
        if (mounted) {
          setNativeShortcutAvailable(status.nativeShortcutAvailable);
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
          setShortcutConflicts(status.conflicts);
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
          setShortcutConflicts(event.payload.conflicts);
        }
      },
    );
    return () => {
      mounted = false;
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    if (activeTab !== "security" || hasLoadedSecurityTab) {
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
            e instanceof Error ? e.message : "Failed to load security details",
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
    if (activeTab !== "storage" || hasLoadedStorageTab) {
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
          setError(e instanceof Error ? e.message : "Failed to load backups");
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
    if (isRemoteAnalysisProvider(meetingsProvider)) {
      setProvider(meetingsProvider);
    }
  }, [settings?.privacy.meetingsAi.provider]);

  // Function to refresh models for a specific provider
  const refreshModelsForProvider = useCallback(async (providerName: string) => {
    setModelsLoading(true);
    try {
      switch (providerName) {
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
  }, []);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      const avail = await withSettingsSectionTimeout(
        "Diarization availability",
        isDiarizationModelAvailable(),
      );
      if (!mounted) return;
      setDiarizationAvailable(avail);
    };
    load();
    return () => {
      mounted = false;
    };
  }, []);

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

  // Both tabs that can change an AI lane need the provider model lists: the
  // Models screen renders the two lane pickers, and AI & Keys still names the
  // destination of an automatic summary.
  useEffect(() => {
    if (activeTab !== "ai" && activeTab !== "models") {
      return;
    }
    let mounted = true;
    setModelsLoading(true);

    const loadModels = async () => {
      try {
        const [
          ollamaAvail,
          ollamaList,
          ollamaCloudList,
          openaiList,
          anthropicList,
          geminiList,
          deepseekList,
        ] = await Promise.all([
          getOllamaStatus(),
          listOllamaModels().catch((e) => {
            console.error("Ollama error:", e);
            return [];
          }),
          listOllamaCloudModels().catch((e) => {
            console.error("Ollama Cloud error:", e);
            return [];
          }),
          listOpenAiModels().catch((e) => {
            console.error("OpenAI error:", e);
            return [];
          }),
          listAnthropicModels().catch((e) => {
            console.error("Anthropic error:", e);
            return [];
          }),
          listGeminiModels().catch((e) => {
            console.error("Gemini error:", e);
            return [];
          }),
          listDeepSeekModels().catch((e) => {
            console.error("DeepSeek error:", e);
            return [];
          }),
        ]);

        if (mounted) {
          setOllamaAvailable(ollamaAvail);
          setOllamaModels(normalizeProviderModelList(ollamaList));
          setOllamaCloudModels(normalizeProviderModelList(ollamaCloudList));
          setOpenaiModels(normalizeProviderModelList(openaiList));
          setAnthropicModels(normalizeProviderModelList(anthropicList));
          setGeminiModels(normalizeProviderModelList(geminiList));
          setDeepseekModels(normalizeProviderModelList(deepseekList));
          setModelsLoading(false);
        }
      } catch (error) {
        console.error("Failed to load models:", error);
        if (mounted) {
          setOllamaAvailable(false);
          setOllamaModels([]);
          setOllamaCloudModels([]);
          setOpenaiModels([]);
          setAnthropicModels([]);
          setGeminiModels([]);
          setDeepseekModels([]);
          setModelsLoading(false);
        }
      }
    };

    void loadModels();
    return () => {
      mounted = false;
    };
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
      latestSettingsRef.current = next;
      setDraftSettings(next);
      setError(null);

      if (options?.immediate) {
        queueSettingsSave(next, 0);
        void flushPendingSettingsSave();
        return;
      }
      queueSettingsSave(next, options?.debounceMs ?? SETTINGS_SAVE_DEBOUNCE_MS);
    },
    [flushPendingSettingsSave, queueSettingsSave],
  );

  // Change one field of the newest settings, for writes the user did not ask
  // for (a background correction, not an edit). `updateSettings` takes a whole
  // Settings object and hands it to the scheduler, where it *replaces* any
  // save still waiting out its debounce -- so a whole-object write from an
  // effect does not merely lose a race with a concurrent edit, it deletes that
  // edit's save outright and the edit never reaches disk at all. Folding the
  // one field into the queued write instead, and letting that write's own
  // timer carry both, is the same discipline the settings-changed listener
  // above uses on the same queue.
  const patchSettings = useCallback(
    (applyPatch: (previous: Settings) => Settings) => {
      const current = latestSettingsRef.current;
      if (!current) {
        return;
      }

      const scheduler = saveSchedulerRef.current;
      if (scheduler.pending) {
        scheduler.pending = {
          version: scheduler.pending.version,
          settings: applyPatch(scheduler.pending.settings),
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

      const cachedModels = getCachedModelsForProvider(providerName);
      const initialModelId = coerceProviderModelId(
        settings.privacy[lane].modelId,
        cachedModels,
      );
      const initialSettings = {
        ...settings,
        privacy: {
          ...settings.privacy,
          [lane]: { provider: providerName, modelId: initialModelId },
        },
      };

      void updateSettings(initialSettings, { immediate: true });

      const refreshedModels = await refreshModelsForProvider(providerName);
      const refreshedModelId = coerceProviderModelId(
        initialModelId,
        refreshedModels,
      );

      if (refreshedModelId !== initialModelId) {
        // Patch, do not rebuild from `initialSettings`. That snapshot predates
        // the `await` above, and `queueSettingsSave` keeps a single pending
        // slot that it REPLACES rather than merges — so a whole-object write
        // from here would not merely lose a race with anything the user changed
        // while the model list was loading, it would delete that queued save
        // before it was ever attempted. Same defect the auto-pin effect had.
        patchSettings((previous) => ({
          ...previous,
          privacy: {
            ...previous.privacy,
            [lane]: { ...previous.privacy[lane], modelId: refreshedModelId },
          },
        }));
      }
    },
    [
      getCachedModelsForProvider,
      patchSettings,
      refreshModelsForProvider,
      settings,
      updateSettings,
    ],
  );

  // Pin each lane to a model the provider actually offers, so the picker's
  // displayed value is the value that gets used. Nobody asked for this write,
  // so it changes the one lane's `modelId` and nothing else — see
  // `patchSettings`.
  useEffect(() => {
    if (!settings || (activeTab !== "ai" && activeTab !== "models")) {
      return;
    }

    for (const lane of AI_LANE_KEYS) {
      const current = latestSettingsRef.current;
      if (!current) {
        return;
      }

      const cachedModels = getCachedModelsForProvider(
        current.privacy[lane].provider,
      );
      if (cachedModels.length === 0) {
        continue;
      }

      const nextModelId = coerceProviderModelId(
        current.privacy[lane].modelId,
        cachedModels,
      );
      if (nextModelId === current.privacy[lane].modelId) {
        continue;
      }

      patchSettings((previous) => ({
        ...previous,
        privacy: {
          ...previous.privacy,
          [lane]: { ...previous.privacy[lane], modelId: nextModelId },
        },
      }));
      // One lane per pass: the draft is about to change, and correcting the
      // other lane from the pre-write snapshot would undo what we just did.
      // The re-run this write triggers picks the other lane up.
      return;
    }
  }, [activeTab, getCachedModelsForProvider, patchSettings, settings]);

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
    } catch (systemAudioError) {
      console.warn("Failed to inspect system audio:", systemAudioError);
      setSystemAudioCapability(null);
    }
  }, []);

  const runSystemAudioTest = useCallback(async () => {
    setSystemAudioTestLoading(true);
    setSystemAudioTestStatus("Waiting for macOS, then listening for sound…");
    try {
      const result = await testSystemAudioCapture();
      setSystemAudioCapability(result.capability);
      setSystemAudioTestStatus(
        result.capability.ready
          ? result.verificationMethod === "external_audio"
            ? `Heard real audio through ${result.capability.routeDevice ?? "the current device"}.`
            : `Heard the ${Math.round(result.expectedToneHz)} Hz test tone through ${result.capability.routeDevice ?? "the current device"}.`
          : result.capability.actionableReason ??
              "Nothing came through. Check the device and macOS privacy settings.",
      );
    } catch (systemAudioError) {
      setSystemAudioTestStatus(
        systemAudioError instanceof Error
          ? systemAudioError.message
          : String(systemAudioError),
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
  const readyChipTone = (state: boolean | "neutral") =>
    state === "neutral"
      ? "border-border bg-muted/30 text-muted-foreground"
      : state
      ? "border-gold/30 bg-gold/10 text-gold-text"
      : "border-rust/30 bg-rust/10 text-rust";

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
      if (micTestAnimFrameRef.current !== null)
        cancelAnimationFrame(micTestAnimFrameRef.current);
      micTestStreamRef.current?.getTracks().forEach((t) => t.stop());
      micTestContextRef.current?.close().catch(() => {});
      if (micTestPlaybackUrl) URL.revokeObjectURL(micTestPlaybackUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void refreshAudioDevices();
    void refreshSystemAudioCapability();
  }, [refreshAudioDevices, refreshSystemAudioCapability]);

  const stopMicTest = useCallback(() => {
    if (micTestAnimFrameRef.current !== null) {
      cancelAnimationFrame(micTestAnimFrameRef.current);
      micTestAnimFrameRef.current = null;
    }
    if (micTestStreamRef.current) {
      micTestStreamRef.current.getTracks().forEach((t) => t.stop());
      micTestStreamRef.current = null;
    }
    if (micTestContextRef.current) {
      micTestContextRef.current.close().catch(() => {});
      micTestContextRef.current = null;
    }
    setMicTestActive(false);
    setMicTestLevel(0);
    setMicTestRecording(false);
  }, []);

  const startMicTest = useCallback(async () => {
    setMicTestError(null);
    try {
      const preferredDeviceId = settings?.audio.dictationInputOverrideEnabled
        ? settings.audio.dictationInputDevice?.deviceId
        : settings?.audio.preferredInputDevice?.deviceId;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: preferredDeviceId
          ? { deviceId: { ideal: preferredDeviceId } }
          : true,
        video: false,
      });
      micTestStreamRef.current = stream;
      const ctx = new AudioContext();
      micTestContextRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      const tick = () => {
        analyser.getFloatTimeDomainData(buf);
        const rms = Math.sqrt(
          buf.reduce((sum, v) => sum + v * v, 0) / buf.length,
        );
        const db = 20 * Math.log10(Math.max(rms, 1e-6));
        const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
        setMicTestLevel(Math.round(pct));
        micTestAnimFrameRef.current = requestAnimationFrame(tick);
      };
      tick();
      setMicTestActive(true);
    } catch (err) {
      console.error("Mic test failed:", err);
      // Mic failure is exactly what this test exists to diagnose — name it.
      setMicTestError(
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "Microphone access was denied. Allow it in System Settings → Privacy & Security → Microphone, then try again."
          : "Microphone unavailable — check that the device is connected and not in use by another app.",
      );
    }
  }, [
    settings?.audio.dictationInputDevice?.deviceId,
    settings?.audio.dictationInputOverrideEnabled,
    settings?.audio.preferredInputDevice?.deviceId,
  ]);

  const recordMicTest = useCallback(async () => {
    if (!micTestStreamRef.current) return;
    if (micTestPlaybackUrl) {
      URL.revokeObjectURL(micTestPlaybackUrl);
      setMicTestPlaybackUrl(null);
    }
    micTestChunksRef.current = [];
    const recorder = new MediaRecorder(micTestStreamRef.current);
    micTestRecorderRef.current = recorder;
    recorder.ondataavailable = (e) => micTestChunksRef.current.push(e.data);
    recorder.onstop = () => {
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
  }, [micTestPlaybackUrl]);

  // Instant, local mirror of electron/shortcut-registration.ts's
  // partitionUniqueShortcutRegistrations: it iterates the shared
  // SHORTCUT_FIELD_PRECEDENCE (imported from the electron module, so the two
  // layers cannot drift) and uses the same accelerator normalization, so the
  // field electron actually keeps registered is the one reported as the
  // winner here. Recomputed on every render so a freshly-typed shortcut is
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

    const owners = new Map<string, { key: ShortcutFieldKey; label: string }>();

    for (const { key, label } of SHORTCUT_FIELD_PRECEDENCE) {
      const raw = settings.shortcuts[key];
      if (!raw) {
        continue;
      }
      const normalized = normalizeShortcutAccelerator(raw);
      if (!normalized) {
        continue;
      }
      const owner = owners.get(normalized);
      if (owner) {
        byField.set(key, {
          field: key,
          label,
          shortcut: raw,
          conflictsWith: owner.label,
          conflictsWithField: owner.key,
        });
        continue;
      }
      owners.set(normalized, { key, label });
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
    if (error) {
      return (
        <div className="flex h-full items-center justify-center px-6">
          <div className="max-w-md rounded-2xl border border-destructive/25 bg-destructive/10 p-5 text-sm text-destructive">
            <div className="flex items-start gap-3">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-medium">Settings could not load</p>
                <p className="mt-1 leading-6 text-destructive/85">
                  {error}
                </p>
                <p className="mt-3 text-sm leading-5 text-muted-foreground">
                  Most settings need the Plainsong desktop app — open that
                  rather than a browser window.
                </p>
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

  const renderShortcutsSection = () => (
    <div className="border-t pt-4">
      <div className="space-y-1">
        <p className="section-heading">Keyboard shortcuts</p>
        <p className="text-sm text-muted-foreground">
          Click a field and press the keys you want. They work anywhere on the
          Mac, not just in Plainsong.
        </p>
      </div>
      <div className="mt-4 grid gap-3">
        {SHORTCUT_FIELD_CONFIG.map(({ key, label }) => {
          const currentVal = settings.shortcuts[key]
            ? formatShortcutForDisplay(settings.shortcuts[key])
            : "None";
          const isCapturing = capturingShortcut === key;
          const conflict = shortcutConflictsByField.get(key);
          return (
            <div
              key={key}
              className="flex flex-col gap-2 rounded-2xl border border-border/60 bg-muted/20 px-3 py-3"
            >
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <span className="text-sm text-muted-foreground">{label}</span>
                <div className="flex items-center gap-2">
                  <Input
                    value={isCapturing ? "Listening..." : currentVal}
                    readOnly
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
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-9 px-3"
                    onClick={() => {
                      const next: Settings = {
                        ...settings,
                        shortcuts: { ...settings.shortcuts, [key]: "" },
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
                <div className="flex items-start gap-2 rounded-xl border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive">
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
      </div>
      <p className="mt-3 text-sm text-muted-foreground">
        Shortcuts save and take effect as soon as you press them.
      </p>
    </div>
  );

  const renderSharedDictationControls = (options?: {
    includeCoreControls?: boolean;
    includeHotkeyBehavior?: boolean;
    includeMeetingAutoName?: boolean;
    includeAudioTuning?: boolean;
    includePermissions?: boolean;
    includeKeyManager?: boolean;
    includeMemory?: boolean;
  }) => {
    const {
      includeCoreControls = true,
      includeHotkeyBehavior = true,
      includeMeetingAutoName = false,
      includeAudioTuning = false,
      includePermissions = false,
      includeKeyManager = false,
      includeMemory = false,
    } = options ?? {};

    return (
      <div className="space-y-5">
        {includeHotkeyBehavior && (
          <div className="space-y-2">
            <Label>How the dictation shortcut works</Label>
            <p className="text-sm text-muted-foreground">
              {dictationShortcutBehaviorHint}
            </p>
            <select
              aria-label="How the dictation shortcut works"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              value={dictationShortcutBehavior}
              onChange={(event) => {
                if (!settings) {
                  return;
                }
                const behavior = event.target.value as DictationHotkeyBehavior;
                updateSettings({
                  ...settings,
                  transcription: {
                    ...settings.transcription,
                    dictationPushToTalk: behavior === "hold_to_talk",
                    dictationHandsFreeEnabled: behavior === "hands_free",
                  },
                });
              }}
            >
              <option value="toggle">
                Press to start, press again to stop
              </option>
              {nativeShortcutAvailable && (
                <option value="hold_to_talk">
                  Hold to record, release to stop
                </option>
              )}
              <option value="hands_free">
                Start on its own when you speak
              </option>
            </select>
          </div>
        )}

        {includeCoreControls && (
          <>
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label>Smart Format</Label>
                <p className="text-sm text-muted-foreground">
                  Tidy up punctuation, grammar, and layout before the text is
                  pasted, using the AI service set in AI &amp; Keys.
                </p>
              </div>
              <Switch
                checked={settings.transcription.dictationAiFormatting}
                onCheckedChange={(checked) =>
                  void updateSettings({
                    ...settings,
                    transcription: {
                      ...settings.transcription,
                      dictationAiFormatting: checked,
                    },
                  })
                }
              />
            </div>

            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label>Spoken commands</Label>
                <p className="text-sm text-muted-foreground">
                  Say things like &quot;command undo that&quot; or &quot;command
                  uppercase selection&quot; and Plainsong acts on them instead
                  of typing them.
                </p>
              </div>
              <Switch
                checked={
                  settings.transcription.dictationCommandModeEnabled ?? true
                }
                onCheckedChange={(checked) =>
                  void updateSettings({
                    ...settings,
                    transcription: {
                      ...settings.transcription,
                      dictationCommandModeEnabled: checked,
                    },
                  })
                }
              />
            </div>

            <div className="space-y-2">
              <Label>The word that starts a spoken command</Label>
              <Input
                value={
                  settings.transcription.dictationCommandPrefix ?? "command"
                }
                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                  void updateSettings({
                    ...settings,
                    transcription: {
                      ...settings.transcription,
                      dictationCommandPrefix: e.target.value,
                    },
                  })
                }
              />
            </div>

            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label>Snippets</Label>
                <p className="text-sm text-muted-foreground">
                  Replace saved abbreviations with the full text you set for
                  them.
                </p>
              </div>
              <Switch
                checked={
                  settings.transcription.dictationSnippetsEnabled ?? true
                }
                onCheckedChange={(checked) =>
                  void updateSettings({
                    ...settings,
                    transcription: {
                      ...settings.transcription,
                      dictationSnippetsEnabled: checked,
                    },
                  })
                }
              />
            </div>

            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label>Learn from your corrections</Label>
                <p className="text-sm text-muted-foreground">
                  When you fix a word or short phrase after dictating, remember
                  it for next time.
                </p>
              </div>
              <Switch
                checked={
                  settings.transcription.dictationAutoLearnCorrections ?? true
                }
                onCheckedChange={(checked) =>
                  void updateSettings({
                    ...settings,
                    transcription: {
                      ...settings.transcription,
                      dictationAutoLearnCorrections: checked,
                    },
                  })
                }
              />
            </div>

            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <p className="text-sm text-muted-foreground">
                Word list, snippets, where text gets inserted, and your own
                dictation modes live in Dictation.
              </p>
              <Button
                variant="secondary"
                onClick={() => requestMainView("dictation")}
              >
                Open Dictation
              </Button>
            </div>

            <div className="space-y-2">
              <Label>Your own Smart Format instructions</Label>
              <Textarea
                placeholder="e.g. Format as an email, fix grammar, make it sound professional..."
                value={settings.transcription.dictationCustomPrompt ?? ""}
                onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
                  void updateSettings({
                    ...settings,
                    transcription: {
                      ...settings.transcription,
                      dictationCustomPrompt: e.target.value,
                    },
                  })
                }
                className="min-h-[96px]"
              />
              <p className="text-sm text-muted-foreground">
                Replaces the built-in instructions. Plainsong still tells it
                which app you are typing into.
              </p>
            </div>

            <div className="space-y-2">
              <Label>Your own meeting summary instructions</Label>
              <Textarea
                placeholder="e.g. Summarize the meeting and list action items..."
                value={settings.transcription.meetingCustomPrompt ?? ""}
                onChange={(e: ChangeEvent<HTMLTextAreaElement>) =>
                  void updateSettings({
                    ...settings,
                    transcription: {
                      ...settings.transcription,
                      meetingCustomPrompt: e.target.value,
                    },
                  })
                }
                className="min-h-[96px]"
              />
              <p className="text-sm text-muted-foreground">
                Replaces the built-in summary instructions.
              </p>
            </div>

            {includeMeetingAutoName && (
              <>
                <div className="flex items-center justify-between gap-4">
                  <div className="space-y-0.5">
                    <Label>Name meetings for me</Label>
                    <p className="text-sm text-muted-foreground">
                      Give each meeting a title once its transcript is done.
                    </p>
                  </div>
                  <Switch
                    checked={
                      settings.transcription.meetingAutoNameEnabled ?? true
                    }
                    onCheckedChange={(checked) =>
                      void updateSettings({
                        ...settings,
                        transcription: {
                          ...settings.transcription,
                          meetingAutoNameEnabled: checked,
                        },
                      })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label>Model used for those titles</Label>
                  <Input
                    placeholder="Leave empty to use the summary model"
                    value={settings.transcription.meetingAutoNameModel ?? ""}
                    onBlur={handleSettingsTextBlur}
                    onKeyDown={handleSettingsTextKeyDown}
                    onChange={(e: ChangeEvent<HTMLInputElement>) =>
                      void updateSettings({
                        ...settings,
                        transcription: {
                          ...settings.transcription,
                          meetingAutoNameModel: e.target.value.trim()
                            ? e.target.value.trim()
                            : null,
                        },
                      })
                    }
                  />
                </div>
              </>
            )}

            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label>Also copy dictated text to the clipboard</Label>
                <p className="text-sm text-muted-foreground">
                  So you can paste it again yourself.
                </p>
              </div>
              <Switch
                checked={
                  settings.transcription.dictationCopyToClipboard ?? false
                }
                onCheckedChange={(checked) =>
                  void updateSettings({
                    ...settings,
                    transcription: {
                      ...settings.transcription,
                      dictationCopyToClipboard: checked,
                    },
                  })
                }
              />
            </div>
          </>
        )}

        {includeAudioTuning && (
          <>
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label>Skip silence</Label>
                <p className="text-sm text-muted-foreground">
                  Leave the quiet stretches out of what gets transcribed.
                </p>
              </div>
              <Switch
                checked={settings.transcription.silenceSkipEnabled}
                onCheckedChange={(checked) =>
                  void updateSettings({
                    ...settings,
                    transcription: {
                      ...settings.transcription,
                      silenceSkipEnabled: checked,
                    },
                  })
                }
              />
            </div>

            {/* The VAD backend drives dictation auto-stop-on-silence and
                hands-free auto-start (not the recording silence-timeout
                toggle above), so show the picker whenever either of those
                features is in use. */}
            {(settings.transcription.dictationHandsFreeEnabled ||
              (settings.transcription.dictationSilenceTimeoutSeconds ?? 0) >
                0) && (
              <div className="space-y-3 border-t pt-4">
                <div className="space-y-0.5">
                  <Label>How Plainsong decides you are speaking</Label>
                  <p className="text-sm text-muted-foreground">
                    Loudness is the default — nothing to download, and it works
                    well in a quiet room. Silero is a small speech-detection
                    model that holds up better in a noisy one; it needs a
                    one-time 2 MB download.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
                      (settings.transcription.dictationVadBackend ??
                        "energy_threshold") === "energy_threshold"
                        ? "border-rust/40 bg-rust/8 text-rust"
                        : "border-border bg-muted hover:bg-muted/80"
                    }`}
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
                  </button>
                  {sileroVadAvailable ? (
                    <button
                      type="button"
                      className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
                        settings.transcription.dictationVadBackend ===
                        "silero"
                          ? "border-rust/40 bg-rust/8 text-rust"
                          : "border-border bg-muted hover:bg-muted/80"
                      }`}
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
                      Silero
                    </button>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={sileroVadDownloading}
                      onClick={async () => {
                        setSileroVadDownloading(true);
                        try {
                          await downloadSileroVadModel();
                          setSileroVadAvailable(true);
                          void updateSettings({
                            ...settings,
                            transcription: {
                              ...settings.transcription,
                              dictationVadBackend: "silero",
                            },
                          });
                        } catch (e) {
                          const msg =
                            e instanceof Error ? e.message : String(e);
                          setError(`Download failed: ${msg}`);
                        } finally {
                          setSileroVadDownloading(false);
                        }
                      }}
                    >
                      {sileroVadDownloading ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Downloading…
                        </>
                      ) : (
                        <>
                          <Download className="mr-2 h-4 w-4" />
                          Download Silero (2 MB)
                        </>
                      )}
                    </Button>
                  )}
                </div>
              </div>
            )}

            <div className="border-t pt-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="section-heading">Microphone test</p>
                  <p className="text-sm text-muted-foreground">
                    Hear yourself back and check the level.
                  </p>
                </div>
                <Button
                  variant={micTestActive ? "destructive" : "outline"}
                  size="sm"
                  onClick={() =>
                    micTestActive ? stopMicTest() : void startMicTest()
                  }
                >
                  <Mic className="mr-1.5 h-3.5 w-3.5" />
                  {micTestActive ? "Stop" : "Start"}
                </Button>
              </div>

              {micTestError && !micTestActive && (
                <p className="mt-3 rounded-md bg-rust/10 p-2 text-sm text-rust">
                  {micTestError}
                </p>
              )}

              {micTestActive && (
                <>
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
          </>
        )}

        {includePermissions && (
          <>
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label>Ask macOS for permission when needed</Label>
                <p className="text-sm text-muted-foreground">
                  Requests microphone access before dictation starts, and
                  speech recognition only if you have chosen Apple Speech.
                </p>
              </div>
              <Switch
                checked={
                  settings.transcription.dictationAutoRequestPermissions ?? true
                }
                onCheckedChange={(checked) =>
                  void updateSettings({
                    ...settings,
                    transcription: {
                      ...settings.transcription,
                      dictationAutoRequestPermissions: checked,
                    },
                  })
                }
              />
            </div>

            <div className="space-y-3 border-t pt-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <p className="section-heading">macOS permissions</p>
                  <p className="text-sm text-muted-foreground">
                    What Plainsong is currently allowed to do on this Mac.
                  </p>
                </div>
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
              </div>
              {permissionDiagnostics && (
                <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
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
                      offLabel: "Not allowed yet",
                    },
                    {
                      label: "Accessibility",
                      ready: permissionDiagnostics.accessibilityReady,
                      action: () =>
                        void openPermissionSettings("accessibility"),
                      offLabel: "Not allowed yet",
                    },
                    {
                      label: "Typing into other apps",
                      ready: permissionDiagnostics.postEventReady,
                      action: () =>
                        void openPermissionSettings("accessibility"),
                      offLabel: "Not allowed yet",
                    },
                  ].map((item) => (
                    <div
                      key={item.label}
                      className="rounded-2xl border border-border/60 bg-muted/20 p-3 text-sm"
                    >
                      <p className="font-medium">{item.label}</p>
                      <p
                        className={`flex items-center gap-1.5 ${
                          item.ready ? "text-gold-text" : "text-rust"
                        }`}
                      >
                        <span
                          aria-hidden="true"
                          className={
                            item.ready
                              ? "neume neume-lit"
                              : "neume neume-rust"
                          }
                        />
                        {item.ready ? "Allowed" : item.offLabel}
                      </p>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="mt-1 h-auto px-0 text-sm font-normal text-muted-foreground hover:text-foreground"
                        onClick={item.action}
                      >
                        Open System Settings
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              {permissionDiagnostics?.notes?.length ? (
                <div className="space-y-1 text-sm text-muted-foreground">
                  {permissionDiagnostics.notes.map((note) => (
                    <p key={note}>{note}</p>
                  ))}
                </div>
              ) : null}
            </div>
          </>
        )}

        {includeKeyManager && (
          <>
            <div className="space-y-2 border-t pt-4">
              <p className="section-heading">API keys</p>
              <p className="text-sm text-muted-foreground">
                Keys are held in the macOS keychain. Pick a service to add,
                replace, or remove its key.
              </p>
              <div className="flex items-center gap-2">
                <select
                  value={provider}
                  onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                    // This only chooses which provider's credential is being
                    // viewed/edited below -- it must not rewrite the default
                    // analysis provider (settings.privacy.meetingsAi.provider), which
                    // has its own selector on the AI tab.
                    const next = e.target.value;
                    setProvider(next);
                    void refreshModelsForProvider(next);
                  }}
                  className="flex-1 rounded-md border bg-background p-2"
                >
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="gemini">Google Gemini</option>
                  <option value="deepseek">DeepSeek</option>
                  <option value="ollama-cloud">Ollama Cloud</option>
                </select>
                <Button
                  variant="outline"
                  size="sm"
                  title="Refresh model list"
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
                          `Failed to save key: ${e instanceof Error ? e.message : 'Unknown error'}`,
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
                <p className="text-sm text-rust">
                  Cloud AI is turned off, so saved keys are not used for
                  summaries, answers, or action items.
                </p>
              ) : null}
              {settings.privacy.remoteProcessingEnabled &&
              isRemoteAnalysisProvider(settings.privacy.meetingsAi.provider) &&
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
                        e instanceof Error
                          ? e.message
                          : "Failed to save API key",
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
                        e instanceof Error
                          ? e.message
                          : "Failed to save API key",
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
                        e instanceof Error
                          ? e.message
                          : "Failed to clear API key",
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

            <div className="space-y-2 border-t pt-4">
              <p className="section-heading">Is the cloud set up?</p>
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
                    const keyPresent = await hasProviderSecret(
                      settings.privacy.meetingsAi.provider,
                    );
                    if (!keyPresent) {
                      checks.push(
                        `No key saved for ${describeAnalysisDestination(settings.privacy.meetingsAi.provider)}.`,
                      );
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
                        "Allow transcript text to be sent to a cloud AI for summaries and answers?",
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
          </>
        )}

        {includeMemory && (
          <div className="space-y-4 border-t pt-4">
            <div className="space-y-1">
              <p className="flex items-center gap-2 section-heading">
                <Database className="h-4 w-4 text-muted-foreground" />
                Searching your transcripts
              </p>
              <p className="text-sm text-muted-foreground">
                How Plainsong looks through past recordings when you ask it a
                question.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => requestMainView("dashboard")}
              >
                Open Memory
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => requestMainView("recordings")}
              >
                Open Meetings
              </Button>
            </div>

            <div className="space-y-2">
              <Label>Method</Label>
              <select
                value={settings.transcription.memorySearchMode}
                onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                  void updateSettings({
                    ...settings,
                    transcription: {
                      ...settings.transcription,
                      memorySearchMode: e.target.value as
                        | "fts"
                        | "ollama_embeddings",
                    },
                  })
                }
                className="w-full rounded-md border bg-background p-2"
              >
                <option value="fts">
                  Match the words you type — built in, nothing to set up
                </option>
                <option value="ollama_embeddings">
                  Match the meaning as well — needs Ollama on this Mac
                </option>
              </select>
            </div>

            {settings.transcription.memorySearchMode ===
              "ollama_embeddings" && (
              <>
                <div className="space-y-2">
                  <Label>Ollama model used for meaning matching</Label>
                  <Input
                    value={settings.transcription.embeddingModel}
                    onChange={(e: ChangeEvent<HTMLInputElement>) =>
                      void updateSettings({
                        ...settings,
                        transcription: {
                          ...settings.transcription,
                          embeddingModel: e.target.value,
                        },
                      })
                    }
                    placeholder="nomic-embed-text"
                    className="font-mono text-sm"
                  />
                  <p className="text-sm text-muted-foreground">
                    Install it first with{" "}
                    <code className="rounded bg-muted px-1">
                      ollama pull nomic-embed-text
                    </code>{" "}
                    in Terminal.
                  </p>
                </div>

                <div className="flex items-center justify-between gap-4">
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">Rebuild the index</p>
                    <p className="text-sm text-muted-foreground">
                      Re-reads every transcript you already have. Needed after
                      changing the model above.
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      void (async () => {
                        try {
                          const { reindexEmbeddings } =
                            await import("@/lib/backend");
                          const result = await reindexEmbeddings();
                          toast(
                            `Indexed ${result.segments} segments from ${result.recordings} recordings${result.errors > 0 ? ` (${result.errors} errors)` : ""}`,
                            result.errors > 0 ? "error" : "success",
                          );
                        } catch (err) {
                          toast(
                            err instanceof Error ? err.message : String(err),
                            "error",
                          );
                        }
                      })();
                    }}
                  >
                    <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                    Rebuild
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="border-b border-border/60 bg-background/85 backdrop-blur">
        <div className="mx-auto flex max-w-[1680px] flex-col gap-4 px-4 py-5 sm:px-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              {/* The eyebrow names the *area*, never the page. An eyebrow
                  reading SETTINGS directly above an h1 reading Settings is the
                  same word twice in two registers, which is the redundancy the
                  rubric budget exists to prevent — the same reason Home is
                  WORKSPACE and Projects is LIBRARY rather than HOME and
                  PROJECTS. */}
              <p className="rubric mb-1.5">PREFERENCES</p>
              <h1 className="font-serif text-2xl font-semibold tracking-tight sm:text-3xl">
                Settings
              </h1>
              <p className="mt-1 text-sm text-muted-foreground sm:text-base">
                How Plainsong listens, writes, and what it keeps.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 text-sm">
              <div className="rounded-full border border-border/70 bg-background px-3 py-1.5 font-medium text-foreground">
                {saveStateLabel}
              </div>
              <div className="rounded-full border border-border/70 bg-background px-3 py-1.5 text-muted-foreground">
                Summaries{" "}
                <span className="ml-1 font-medium text-foreground">
                  {settings.privacy.remoteProcessingEnabled
                    ? "In the cloud"
                    : "On this Mac only"}
                </span>
              </div>
              <div className="rounded-full border border-border/70 bg-background px-3 py-1.5 text-muted-foreground">
                Microphone{" "}
                <span className="ml-1 font-medium text-foreground">
                  {settings.audio.preferredInputDevice?.deviceName ??
                    "System default"}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto overflow-x-hidden">
        <div className="mx-auto max-w-[1680px] p-4 sm:p-6">
          <div className="min-w-0 space-y-4 sm:space-y-5">
            <div className="rounded-[20px] border border-border bg-card p-2 shadow-sm">
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
                {SETTINGS_TABS.map((tab) => (
                  <button
                    key={`compact-${tab.id}`}
                    onClick={() => setActiveTab(tab.id)}
                    className={`group flex w-full items-start gap-3 rounded-2xl border px-4 py-3 text-left transition-all ${
                      activeTab === tab.id
                        ? "border-border bg-background text-foreground"
                        : "border-transparent bg-transparent text-muted-foreground hover:border-border hover:bg-background/70 hover:text-foreground"
                    }`}
                  >
                    <div
                      className={`mt-0.5 rounded-xl p-2 ${activeTab === tab.id ? "bg-muted text-foreground" : "bg-muted/40 text-muted-foreground group-hover:text-foreground"}`}
                    >
                      <tab.icon className="h-4 w-4" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{tab.label}</p>
                      <p className="mt-1 text-sm leading-5 text-current/70">
                        {tab.summary}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            </div>
            {error && (
              <div className="flex items-center gap-2 rounded-2xl border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive">
                <AlertCircle className="h-4 w-4" />
                {error}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 px-1">
              <span
                className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium ${readyChipTone(dictationReadinessChip.tone)}`}
              >
                <span>{dictationReadinessChip.label}</span>
                <span aria-hidden="true">·</span>
                <span>{dictationReadinessChip.status}</span>
              </span>
            </div>

            <section className="overflow-hidden rounded-[24px] border border-border bg-card shadow-sm">
              <div className="space-y-6 px-4 py-5 sm:px-6 sm:py-6">
                {activeTab === "models" && (
                  <ModelsScreen
                    settings={settings}
                    onPatchSettings={patchSettings}
                    aiModelsForProvider={getCachedModelsForProvider}
                    aiModelsLoading={modelsLoading}
                    onAiProviderChange={(lane, providerName) =>
                      void updateAnalysisProvider(lane, providerName)
                    }
                    onAiModelChange={updateAnalysisModel}
                    onOpenKeySettings={() => setActiveTab("ai")}
                    onOpenDiagnostics={() => setActiveTab("asr")}
                  />
                )}

                {activeTab === "asr" && (
                  <div className="space-y-5">
                    <div className="space-y-3">
                      <AsrProviderManager />
                    </div>

                    <div className="border-t pt-5 text-foreground">
                      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                        <div>
                          <p className="section-heading">Microphones</p>
                          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
                            Pick one microphone for the whole app, then give
                            dictation or meetings their own if you need to.
                          </p>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void refreshAudioDevices()}
                        >
                          <RefreshCw className="mr-2 h-4 w-4" />
                          Refresh devices
                        </Button>
                      </div>

                      <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                        <div className="space-y-3 rounded-2xl border border-border bg-background p-4">
                          <div>
                            <p className="section-heading">Whole app</p>
                            <p className="mt-1 text-sm text-muted-foreground">
                              Used unless one of the overrides below is on.
                            </p>
                          </div>
                          <select
                            aria-label="App-wide microphone"
                            className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground"
                            value={appWideDeviceId}
                            onChange={(event) => {
                              const nextDevice =
                                resolveAudioDevicePreference(
                                  event.target.value || null,
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
                          </select>
                        </div>

                        <div className="space-y-3 rounded-2xl border border-border bg-background p-4">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="section-heading">
                                Dictation only
                              </p>
                              <p className="mt-1 text-sm text-muted-foreground">
                                Use a different microphone when you dictate
                                with the shortcut.
                              </p>
                            </div>
                            <Switch
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
                          </div>
                          <select
                            aria-label="Dictation microphone override"
                            disabled={
                              !(
                                settings.audio
                                  .dictationInputOverrideEnabled ?? false
                              )
                            }
                            className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground disabled:opacity-50"
                            value={dictationDeviceId}
                            onChange={(event) => {
                              const nextDevice =
                                resolveAudioDevicePreference(
                                  event.target.value || null,
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
                          </select>
                        </div>

                        <div className="space-y-3 rounded-2xl border border-border bg-background p-4 md:col-span-2 xl:col-span-1">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="section-heading">
                                Meetings only
                              </p>
                              <p className="mt-1 text-sm text-muted-foreground">
                                Use a different microphone when you record a
                                meeting.
                              </p>
                            </div>
                            <Switch
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
                          </div>
                          <select
                            aria-label="Meeting microphone override"
                            disabled={
                              !(
                                settings.audio
                                  .meetingInputOverrideEnabled ?? false
                              )
                            }
                            className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground disabled:opacity-50"
                            value={meetingDeviceId}
                            onChange={(event) => {
                              const nextDevice =
                                resolveAudioDevicePreference(
                                  event.target.value || null,
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
                          </select>
                        </div>
                      </div>

                      <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                        {currentAudioDevices.map((device) => (
                          <div
                            key={`card-${device.deviceId}`}
                            className="rounded-2xl border border-border/60 bg-foreground/[0.03] p-4"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <p className="text-sm font-medium text-foreground">
                                  {device.deviceName}
                                </p>
                                <p className="mt-1 text-xs text-muted-foreground">
                                  {deviceTransportLabel(device)}
                                  {device.channelCount
                                    ? ` - ${device.channelCount} ch`
                                    : ""}
                                  {device.sampleRate
                                    ? ` - ${device.sampleRate} Hz`
                                    : ""}
                                </p>
                              </div>
                              {device.isDefault ? (
                                <span className="rounded-full border border-gold/30 bg-gold/10 px-2 py-0.5 text-xs font-medium uppercase tracking-[0.18em] text-gold-text">
                                  Default
                                </span>
                              ) : null}
                            </div>
                            {device.isBluetoothLike ? (
                              <p className="mt-3 text-sm leading-5 text-rust">
                                Bluetooth headset mics can dull your audio
                                while you dictate. Built-in or USB mics
                                usually sound cleaner.
                              </p>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="border-t pt-5 text-foreground">
                      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                        <div className="max-w-2xl">
                          <p className="section-heading">
                            Recording what your Mac plays
                          </p>
                          {systemAudioCapability === null ? (
                            <p className="mt-1 text-sm leading-6 text-muted-foreground">
                              Checking how this Mac can capture its own
                              audio…
                            </p>
                          ) : systemAudioCapability.ready ? (
                            <p className="mt-1 text-sm leading-6 text-gold-text">
                              Verified through {systemAudioCapability.backend === "core_audio_process_tap" ? "macOS itself" : "a loopback device"}
                              {systemAudioCapability.routeDevice ? ` on ${systemAudioCapability.routeDevice}` : ""}
                              {systemAudioCapability.nativeSampleRate && systemAudioCapability.nativeChannels
                                ? ` · ${systemAudioCapability.nativeSampleRate} Hz / ${systemAudioCapability.nativeChannels} ch`
                                : ""}
                              .
                            </p>
                          ) : systemAudioCapability.backend !== "none" ? (
                            <p className="mt-1 text-sm leading-6 text-rust">
                              There is a way to capture it, but Plainsong
                              has not yet confirmed macOS permission and
                              real sound coming through. Run the test.
                            </p>
                          ) : (
                            <p className="mt-1 text-sm leading-6 text-rust">
                              Nothing on this Mac can capture it yet.
                              Devices that both play and record are skipped,
                              because using one could pick up your
                              microphone as well.
                            </p>
                          )}
                          {systemAudioCapability?.actionableReason ? (
                            <p className="mt-2 text-sm leading-5 text-muted-foreground">
                              {systemAudioCapability.actionableReason}
                            </p>
                          ) : null}
                          <p className="mt-2 text-sm leading-5 text-muted-foreground">
                            The test asks macOS for permission the first
                            time, then checks that real sound arrived — not
                            just that a connection opened. Through macOS it
                            plays a brief quiet tone; through a loopback
                            device, play something audible while it runs.
                          </p>
                        </div>
                        <div className="flex shrink-0 flex-wrap gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={
                              systemAudioTestLoading ||
                              systemAudioCapability === null ||
                              systemAudioCapability.backend === "none"
                            }
                            onClick={() => void runSystemAudioTest()}
                          >
                            {systemAudioTestLoading ? (
                              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            ) : null}
                            Run the test
                          </Button>
                          {systemAudioCapability?.reason === "permission_denied" ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => void openPermissionSettings("system_audio")}
                            >
                              Open privacy settings
                            </Button>
                          ) : null}
                        </div>
                      </div>
                      {systemAudioTestStatus ? (
                        <p
                          className={`mt-3 text-sm ${systemAudioCapability?.ready ? "text-gold-text" : "text-muted-foreground"}`}
                          role="status"
                        >
                          {systemAudioTestStatus}
                        </p>
                      ) : null}
                    </div>

                    <div className="h-px bg-border" />

                    <div className="flex items-center justify-between">
                      <div className="space-y-0.5">
                        <Label>Separate speakers</Label>
                        <p className="text-sm text-muted-foreground">
                          Once a recording is transcribed, split the text up by
                          who was talking.
                        </p>
                      </div>
                      {diarizationAvailable ? (
                        <Switch
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
                              await downloadDiarizationModel();
                              setDiarizationAvailable(true);
                              updateSettings({
                                ...settings,
                                transcription: {
                                  ...settings.transcription,
                                  enableDiarization: true,
                                },
                              });
                            } catch (e) {
                              const msg =
                                e instanceof Error ? e.message : String(e);
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
                              Download Model (~25MB)
                            </>
                          )}
                        </Button>
                      )}
                    </div>

                    <div className="space-y-2">
                      <Label>Transcription language</Label>
                      <select
                        className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                        value={settings.transcription.language ?? ""}
                        onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                          void updateSettings({
                            ...settings,
                            transcription: {
                              ...settings.transcription,
                              language: e.target.value || null,
                            },
                          })
                        }
                      >
                        <option value="">Auto-detect</option>
                        <option value="en">English</option>
                        <option value="es">Spanish</option>
                        <option value="fr">French</option>
                        <option value="de">German</option>
                        <option value="it">Italian</option>
                        <option value="pt">Portuguese</option>
                        <option value="ja">Japanese</option>
                        <option value="ko">Korean</option>
                        <option value="zh">Chinese</option>
                        <option value="ru">Russian</option>
                        <option value="ar">Arabic</option>
                        <option value="hi">Hindi</option>
                      </select>
                      <div className="border-t pt-4">
                        <p className="section-heading">
                          Languages you dictate in
                        </p>
                        <p className="mt-1 text-sm text-muted-foreground">
                          Only matters while the setting above is on
                          auto-detect. Pick one language to always use it,
                          or a few to narrow what auto-detect chooses from.
                        </p>
                        <div className="mt-3 flex flex-wrap gap-2">
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
                      </div>
                    </div>

                    <div className="space-y-5 border-t pt-4">
                      <p className="section-heading">Advanced</p>
                      {renderSharedDictationControls({
                        includeMeetingAutoName: true,
                        includeAudioTuning: true,
                      })}
                    </div>
                  </div>
                )}

                {activeTab === "general" && (
                  <div className="space-y-5">
                    <div className="space-y-2">
                      <Label>Theme</Label>
                      <div className="flex gap-2">
                        <Button
                          variant={
                            theme === "light" ? "default" : "outline"
                          }
                          size="sm"
                          onClick={() => setTheme("light")}
                          className="flex items-center gap-2"
                        >
                          <Sun className="h-4 w-4" />
                          Light
                        </Button>
                        <Button
                          variant={theme === "dark" ? "default" : "outline"}
                          size="sm"
                          onClick={() => setTheme("dark")}
                          className="flex items-center gap-2"
                        >
                          <Moon className="h-4 w-4" />
                          Dark
                        </Button>
                        <Button
                          variant={
                            theme === "system" ? "default" : "outline"
                          }
                          size="sm"
                          onClick={() => setTheme("system")}
                          className="flex items-center gap-2"
                        >
                          <Monitor className="h-4 w-4" />
                          System
                        </Button>
                      </div>
                    </div>

                    <div className="flex items-center justify-between">
                      <div className="space-y-0.5">
                        <Label>Keep running after close</Label>
                        <p className="text-sm text-muted-foreground">
                          Closing the window leaves Plainsong running in the
                          menu bar, so shortcuts and recording keep working.
                        </p>
                      </div>
                      <Switch
                        checked={settings.ui.minimizeToTray}
                        onCheckedChange={(checked) => {
                          void updateSettings({
                            ...settings,
                            ui: { ...settings.ui, minimizeToTray: checked },
                          });
                          void invoke("app:set_minimize_to_tray", {
                            enabled: checked,
                          }).catch(() => {});
                        }}
                      />
                    </div>

                    <div className="flex items-center justify-between">
                      <div className="space-y-0.5">
                        <Label>Always on top</Label>
                        <p className="text-sm text-muted-foreground">
                          Keep the window above other applications
                        </p>
                      </div>
                      <Switch
                        checked={settings.ui.alwaysOnTop}
                        onCheckedChange={(checked) =>
                          void updateSettings({
                            ...settings,
                            ui: { ...settings.ui, alwaysOnTop: checked },
                          })
                        }
                      />
                    </div>

                    <div className="pt-4 border-t space-y-4">
                      <div className="space-y-1">
                        <p className="section-heading">Mini windows</p>
                        <p className="text-sm text-muted-foreground">
                          Small floating windows that stay on screen while
                          Plainsong is recording or working.
                        </p>
                      </div>

                      <div className="flex items-center justify-between">
                        <Label>While dictating</Label>
                        <Switch
                          checked={settings.ui.showDictationPopup}
                          onCheckedChange={(checked) =>
                            void updateSettings({
                              ...settings,
                              ui: {
                                ...settings.ui,
                                showDictationPopup: checked,
                              },
                            })
                          }
                        />
                      </div>

                      <div className="flex items-center justify-between">
                        <Label>While recording a meeting</Label>
                        <Switch
                          checked={settings.ui.showRecordingPopup}
                          onCheckedChange={(checked) =>
                            void updateSettings({
                              ...settings,
                              ui: {
                                ...settings.ui,
                                showRecordingPopup: checked,
                              },
                            })
                          }
                        />
                      </div>
                    </div>

                    <div className="pt-4 border-t space-y-5">
                      <p className="section-heading">Advanced</p>
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                        <p className="text-sm text-muted-foreground">
                          Smart Format, prompts, and audio behavior are set in
                          Transcription.
                        </p>
                        <Button
                          variant="secondary"
                          onClick={() => setActiveTab("asr")}
                        >
                          Open Transcription
                        </Button>
                      </div>

                      {renderShortcutsSection()}
                    </div>
                  </div>
                )}

                {activeTab === "security" && (
                  <div className="space-y-5">
                    {/* The vault-initialized bit only says a migration
                        once ran. Capture writes a plain WAV either way, so
                        report the count of files that are actually
                        encrypted and say plainly that new recordings are
                        not. */}
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-0.5">
                        <Label className="flex items-center gap-2">
                          <Lock className="h-4 w-4" />
                          Recordings on disk
                        </Label>
                        <p className="text-sm text-muted-foreground">
                          {recordingEncryptionSummary.description}
                        </p>
                      </div>
                      <span
                        className={`shrink-0 rounded-full border px-2.5 py-1 text-sm ${
                          recordingEncryptionSummary.allEncrypted
                            ? "border-gold/30 bg-gold/10 text-gold-text"
                            : "border-rust/40 bg-rust/8 text-rust"
                        }`}
                      >
                        {recordingEncryptionSummary.chip}
                      </span>
                    </div>

                    <div className="border-t pt-4">
                      <p className="section-heading">Apple Speech</p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Optional, and only ever used for dictation — never for
                        meetings, and never swapped in for the engine you
                        chose. Plainsong requires Apple's on-device
                        recognition and turns off its fall back to Apple's
                        servers.
                      </p>
                    </div>

                    <div className="flex items-center justify-between">
                      <div className="space-y-0.5">
                        <Label className="flex items-center gap-2">
                          <Cloud className="h-4 w-4" />
                          Use cloud AI for summaries and answers
                        </Label>
                        <p className="text-sm text-muted-foreground">
                          Required before summaries, Q&amp;A, and action items
                          can use anything other than Ollama on this Mac. Speech
                          engines have their own setting.
                        </p>
                      </div>
                      <Switch
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
                    </div>

                    <div className="pt-4 border-t space-y-5">
                      <p className="section-heading">Advanced</p>
                        {renderSharedDictationControls({
                          includeCoreControls: false,
                          includeHotkeyBehavior: false,
                          includePermissions: true,
                        })}

                        <div className="space-y-2">
                          <p className="section-heading">Vault</p>
                          <p className="text-sm text-muted-foreground">
                            The vault encrypts recordings already saved on this
                            Mac. Enter its password to unlock it, or to encrypt
                            what is on disk now.
                          </p>
                          <Label htmlFor="vault-password">Password</Label>
                          <Input
                            id="vault-password"
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
                                    e instanceof Error
                                      ? e.message
                                      : "Failed to unlock vault",
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
                                    e instanceof Error
                                      ? e.message
                                      : "Failed to lock vault",
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
                                    e instanceof Error
                                      ? e.message
                                      : "Failed to migrate to encrypted storage",
                                  );
                                }
                              }}
                            >
                              Migrate to Encrypted Storage
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
                      </div>
                  </div>
                )}

                {activeTab === "storage" && (
                  <div className="space-y-5">
                    <div className="space-y-2">
                      <Label>Only allow exports into this folder</Label>
                      <Input
                        placeholder="/Users/you/Documents/Plainsong"
                        value={settings.privacy.exportRoot ?? ""}
                        onBlur={handleSettingsTextBlur}
                        onKeyDown={handleSettingsTextKeyDown}
                        onChange={(e: ChangeEvent<HTMLInputElement>) =>
                          void updateSettings({
                            ...settings,
                            privacy: {
                              ...settings.privacy,
                              exportRoot: e.target.value.trim()
                                ? e.target.value.trim()
                                : null,
                            },
                          })
                        }
                      />
                      <p className="text-sm text-muted-foreground">
                        Leave empty to export anywhere. With a full path here,
                        exports can only land in it or a folder inside it.
                      </p>
                    </div>

                    <div className="h-px bg-border" />

                    <div className="space-y-2">
                      <Label>Auto-delete dictation recordings</Label>
                      <select
                        className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                        value={
                          settings.transcription.dictationRetentionPreset ??
                          "never"
                        }
                        onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                          void updateSettings({
                            ...settings,
                            transcription: {
                              ...settings.transcription,
                              dictationRetentionPreset: e.target.value as "custom" | "immediate" | "24h" | "72h" | "never",
                            },
                          })
                        }
                      >
                        <option value="immediate">Immediately</option>
                        <option value="24h">After 24 hours</option>
                        <option value="72h">After 72 hours</option>
                        <option value="never">Never</option>
                        <option value="custom">Custom</option>
                      </select>
                      {(settings.transcription.dictationRetentionPreset ??
                        "never") === "custom" && (
                        <div className="space-y-2">
                          <Label>Custom retention hours</Label>
                          <Input
                            type="number"
                            min={1}
                            value={
                              settings.transcription
                                .dictationRetentionCustomHours ?? 24
                            }
                            onBlur={handleSettingsTextBlur}
                            onKeyDown={handleSettingsTextKeyDown}
                            onChange={(
                              e: ChangeEvent<HTMLInputElement>,
                            ) => {
                              const nextHours = Math.max(
                                1,
                                Number(e.target.value) || 1,
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
                        </div>
                      )}
                    </div>

                    <div className="space-y-2">
                      <Label>Meeting audio</Label>
                      <select
                        className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                        value={
                          settings.transcription.meetingAudioStorageMode ??
                          "always"
                        }
                        onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                          void updateSettings({
                            ...settings,
                            transcription: {
                              ...settings.transcription,
                              meetingAudioStorageMode: e.target.value as "always" | "transcript_only",
                            },
                          })
                        }
                      >
                        <option value="always">Keep it</option>
                        <option value="transcript_only">
                          Delete it once the transcript is ready
                        </option>
                      </select>
                    </div>

                    <div className="space-y-2">
                      <Label>Auto-delete meeting data</Label>
                      <select
                        className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                        value={
                          settings.transcription.meetingRetentionPreset ??
                          "never"
                        }
                        onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                          void updateSettings({
                            ...settings,
                            transcription: {
                              ...settings.transcription,
                              meetingRetentionPreset: e.target.value as "custom" | "never" | "1m" | "2m" | "3m",
                            },
                          })
                        }
                      >
                        <option value="1m">After 1 month</option>
                        <option value="2m">After 2 months</option>
                        <option value="3m">After 3 months</option>
                        <option value="never">Never</option>
                        <option value="custom">Custom</option>
                      </select>
                      {(settings.transcription.meetingRetentionPreset ??
                        "never") === "custom" && (
                        <div className="space-y-2">
                          <Label>Custom retention months</Label>
                          <Input
                            type="number"
                            min={1}
                            value={
                              settings.transcription
                                .meetingRetentionCustomMonths ?? 1
                            }
                            onBlur={handleSettingsTextBlur}
                            onKeyDown={handleSettingsTextKeyDown}
                            onChange={(
                              e: ChangeEvent<HTMLInputElement>,
                            ) => {
                              const nextMonths = Math.max(
                                1,
                                Number(e.target.value) || 1,
                              );
                              void updateSettings({
                                ...settings,
                                transcription: {
                                  ...settings.transcription,
                                  meetingRetentionCustomMonths: nextMonths,
                                },
                              });
                            }}
                          />
                        </div>
                      )}
                    </div>

                    <div className="space-y-2">
                      <Label>When a meeting is auto-deleted, remove</Label>
                      <select
                        className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                        value={
                          settings.transcription
                            .meetingRetentionDeleteMode ?? "audio_only"
                        }
                        onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                          void updateSettings({
                            ...settings,
                            transcription: {
                              ...settings.transcription,
                              meetingRetentionDeleteMode: e.target.value as "audio_only" | "audio_and_transcript",
                            },
                          })
                        }
                      >
                        <option value="audio_only">The audio only</option>
                        <option value="audio_and_transcript">
                          The audio and the transcript
                        </option>
                      </select>
                    </div>

                    <div className="border-t pt-4 space-y-3">
                      <div className="space-y-1">
                        <p className="section-heading">Setup</p>
                        <p className="text-sm text-muted-foreground">
                          Walk through permissions, models, and meeting
                          capture again.
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="secondary"
                          onClick={() => requestMainView("setup")}
                        >
                          Open Setup
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => requestOnboarding("full")}
                        >
                          Rerun onboarding
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => requestOnboarding("dictation")}
                        >
                          Fix dictation setup
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => requestOnboarding("meetings")}
                        >
                          Set up meetings
                        </Button>
                      </div>
                    </div>

                    <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 space-y-3">
                      <div className="space-y-1">
                        <Label className="text-destructive">
                          Reset app data
                        </Label>
                        <p className="text-sm text-muted-foreground">
                          Deletes every recording, transcript, project, and
                          saved API key on this Mac. Speech models you have
                          downloaded are kept.
                        </p>
                      </div>
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
                      <p className="text-sm text-muted-foreground">
                        Setup runs again the next time you open Plainsong.
                      </p>
                    </div>

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

                    {backupConfigLoading && !backupConfig && (
                      <div className="pt-4 border-t text-sm text-muted-foreground">
                        Loading backup controls…
                      </div>
                    )}

                    {backupConfig && (
                      <div className="pt-4 border-t space-y-5">
                        <div className="space-y-1">
                          <p className="section-heading">Backups</p>
                          <p className="text-sm text-muted-foreground">
                            Nothing is backed up or uploaded on its own — a
                            copy is made only when you press one of the
                            buttons below.
                          </p>
                        </div>

                        <div className="max-w-sm space-y-2">
                          <Label>Backups to keep on this Mac</Label>
                          <Input
                            type="number"
                            min={1}
                            value={backupConfig.maxBackups}
                            onChange={(
                              e: ChangeEvent<HTMLInputElement>,
                            ) =>
                              setBackupConfig({
                                ...backupConfig,
                                maxBackups: Math.max(
                                  1,
                                  Number(e.target.value) || 7,
                                ),
                              })
                            }
                          />
                          <p className="text-sm text-muted-foreground">
                            Once there are more than this, the oldest backup
                            is removed.
                          </p>
                        </div>

                        <div className="flex items-center justify-between gap-4">
                          <div className="space-y-0.5">
                            <Label>Allow uploading to cloud storage</Label>
                            <p className="text-sm text-muted-foreground">
                              Turns on the Sync buttons below. Uploads still
                              only happen when you press one.
                            </p>
                          </div>
                          <Switch
                            aria-label="Enable manual cloud sync"
                            checked={backupConfig.cloudSync}
                            onCheckedChange={(checked) =>
                              setBackupConfig({
                                ...backupConfig,
                                cloudSync: checked,
                              })
                            }
                          />
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-2">
                            <Label>Cloud storage service</Label>
                            <select
                              value={backupConfig.cloudProvider ?? ""}
                              onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                                setBackupConfig({
                                  ...backupConfig,
                                  cloudProvider: (e.target.value ||
                                    null) as BackupConfig["cloudProvider"],
                                })
                              }
                              className="w-full p-2 border rounded-md bg-background"
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
                            </select>
                          </div>

                          <div className="space-y-2">
                            <Label>Cloud folder</Label>
                            <Input
                              value={backupConfig.cloudFolder}
                              onChange={(
                                e: ChangeEvent<HTMLInputElement>,
                              ) =>
                                setBackupConfig({
                                  ...backupConfig,
                                  cloudFolder: e.target.value,
                                })
                              }
                              placeholder="PlainsongBackups"
                            />
                          </div>
                        </div>

                        {backupConfig.cloudProvider === "i_cloud" ? (
                          <div className="space-y-2">
                            <Label>iCloud path (optional override)</Label>
                            <Input
                              value={backupConfig.icloudPath ?? ""}
                              onChange={(
                                e: ChangeEvent<HTMLInputElement>,
                              ) =>
                                setBackupConfig({
                                  ...backupConfig,
                                  icloudPath: e.target.value.trim()
                                    ? e.target.value
                                    : null,
                                })
                              }
                              placeholder="/Users/you/Library/Mobile Documents/com~apple~CloudDocs"
                            />
                          </div>
                        ) : (
                          <div className="space-y-2">
                            <Label>rclone remote name</Label>
                            <Input
                              value={backupConfig.cloudRemoteName ?? ""}
                              onChange={(
                                e: ChangeEvent<HTMLInputElement>,
                              ) =>
                                setBackupConfig({
                                  ...backupConfig,
                                  cloudRemoteName: e.target.value.trim()
                                    ? e.target.value
                                    : null,
                                })
                              }
                              placeholder="onedrive / gdrive / protondrive"
                            />
                          </div>
                        )}

                        <div className="grid gap-3 border-t pt-4 md:grid-cols-2">
                          <div>
                            <p className="text-sm font-medium">
                              Latest settings snapshot
                            </p>
                            <p className="mt-1 text-sm text-muted-foreground">
                              {latestSettingsSnapshot
                                ? new Date(
                                    latestSettingsSnapshot.timestamp,
                                  ).toLocaleString()
                                : "None yet."}{" "}
                              Settings and shortcuts only — no recordings or
                              transcripts.
                            </p>
                            {latestSettingsSnapshot ? (
                              <p className="mt-1 font-mono text-xs text-muted-foreground">
                                {latestSettingsSnapshot.itemsCount} items ·{" "}
                                {latestSettingsSnapshot.id}
                              </p>
                            ) : null}
                          </div>
                          <div>
                            <p className="text-sm font-medium">
                              Latest full backup
                            </p>
                            <p className="mt-1 text-sm text-muted-foreground">
                              {latestFullBackup
                                ? new Date(
                                    latestFullBackup.timestamp,
                                  ).toLocaleString()
                                : "None yet."}{" "}
                              Everything, including recordings and
                              transcripts.
                            </p>
                            {latestFullBackup ? (
                              <p className="mt-1 font-mono text-xs text-muted-foreground">
                                {latestFullBackup.itemsCount} items ·{" "}
                                {latestFullBackup.id}
                              </p>
                            ) : null}
                          </div>
                        </div>

                        <div className="flex flex-wrap gap-2 mt-4">
                          <Button
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
                                  e instanceof Error
                                    ? e.message
                                    : "Failed to save backup config",
                                );
                              } finally {
                                setBackupBusy(false);
                              }
                            }}
                          >
                            Save these settings
                          </Button>
                          <Button
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
                                  e instanceof Error
                                    ? e.message
                                    : "Cloud verification failed",
                                );
                              } finally {
                                setBackupBusy(false);
                              }
                            }}
                          >
                            Test the connection
                          </Button>
                          <Button
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
                                  e instanceof Error
                                    ? e.message
                                    : "Setup checks failed",
                                );
                              } finally {
                                setBackupBusy(false);
                              }
                            }}
                          >
                            Run setup checks
                          </Button>
                          <Button
                            variant="secondary"
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
                                  e instanceof Error
                                    ? e.message
                                    : "Settings snapshot failed",
                                );
                              } finally {
                                setBackupBusy(false);
                              }
                            }}
                          >
                            Snapshot settings
                          </Button>
                          <Button
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
                                  e instanceof Error
                                    ? e.message
                                    : "Settings snapshot sync failed",
                                );
                              } finally {
                                setBackupBusy(false);
                              }
                            }}
                          >
                            Upload latest snapshot
                          </Button>
                          <Button
                            variant="outline"
                            disabled={
                              backupBusy ||
                              !latestSettingsSnapshot ||
                              hasUnsavedChanges
                            }
                            onClick={async () => {
                              if (!latestSettingsSnapshot) return;
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
                                  e instanceof Error
                                    ? e.message
                                    : "Settings snapshot restore failed",
                                );
                              } finally {
                                setBackupBusy(false);
                              }
                            }}
                          >
                            Restore latest snapshot
                          </Button>
                          <Button
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
                                  e instanceof Error
                                    ? e.message
                                    : "Backup failed",
                                );
                              } finally {
                                setBackupBusy(false);
                              }
                            }}
                          >
                            Back up everything
                          </Button>
                          <Button
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
                                  e instanceof Error
                                    ? e.message
                                    : "Cloud sync failed",
                                );
                              } finally {
                                setBackupBusy(false);
                              }
                            }}
                          >
                            Upload latest backup
                          </Button>
                        </div>

                        {backupStatus && (
                          <p className="text-sm text-muted-foreground">
                            {backupStatus}
                          </p>
                        )}
                        {hasUnsavedChanges ? (
                          <p className="text-sm text-rust">
                            Save or discard your settings edits before
                            restoring a snapshot.
                          </p>
                        ) : null}
                        {backupSetupReport && (
                          <div className="space-y-2 border-t pt-4">
                            <div className="flex items-center justify-between">
                              <p className="section-heading">
                                Cloud setup checks
                              </p>
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
                        {backupConfig.cloudProvider !== "i_cloud" && (
                          <p className="text-sm text-muted-foreground">
                            OneDrive, Google Drive, and Proton Drive need
                            rclone: run{" "}
                            <code className="rounded bg-muted px-1">
                              rclone config
                            </code>{" "}
                            in Terminal and create the remote first.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {activeTab === "ai" && (
                  <div className="space-y-5">
                    {/* This is on by default and was previously only in
                        the settings schema: every finished meeting was
                        handed to the analysis provider with nothing in the
                        UI saying so. */}
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-0.5">
                        <Label>Summarize every meeting automatically</Label>
                        <p className="text-sm text-muted-foreground">
                          {!settings.transcription.enableAutoAnalysis
                            ? "Meetings are summarized only when you ask for it from the meeting itself."
                            : isRemoteAnalysisProvider(
                                  settings.privacy.meetingsAi.provider,
                                ) && !settings.privacy.remoteProcessingEnabled
                              ? `Every finished meeting would go to ${describeAnalysisDestination(settings.privacy.meetingsAi.provider)}, but cloud AI is turned off — so no summary is written.`
                              : `Every finished meeting transcript goes to ${describeAnalysisDestination(settings.privacy.meetingsAi.provider)} for a summary and action items, without asking first.`}
                        </p>
                      </div>
                      <Switch
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
                    </div>

                    {/* Which model writes them is chosen in Models, with the
                        speech engines and the presets that set all four lanes
                        at once. A second copy of those two pickers here would
                        be two controls for one pair of settings keys. */}
                    <div className="flex flex-col gap-3 rounded-md border border-border/60 bg-muted/20 p-4 lg:flex-row lg:items-center lg:justify-between">
                      <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
                        {`Summaries are written by ${describeAnalysisDestination(settings.privacy.meetingsAi.provider)}, and dictation cleanup by ${describeAnalysisDestination(settings.privacy.dictationAi.provider)}. Both are chosen in Models.`}
                      </p>
                      <Button
                        variant="secondary"
                        onClick={() => setActiveTab("models")}
                      >
                        Open Models
                      </Button>
                    </div>

                    <div className="flex items-center justify-between">
                      <div className="space-y-0.5">
                        <Label>Use cloud AI for summaries and answers</Label>
                        <p className="text-sm text-muted-foreground">
                          Required before any service other than Ollama on this
                          Mac can write them.
                        </p>
                      </div>
                      <Switch
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
                    </div>

                    {/* Either lane on Ollama makes the local daemon's state
                        worth reporting. */}
                    {AI_LANE_KEYS.some(
                      (lane) => settings.privacy[lane].provider === "ollama",
                    ) && (
                      <div className="border-t pt-4">
                        <p className="flex items-center gap-2 text-sm font-medium">
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
                        </p>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {ollamaModels.length > 0
                            ? `Installed models: ${ollamaModels.join(", ")}`
                            : "No models installed yet."}
                        </p>
                      </div>
                    )}

                    <div className="pt-4 border-t space-y-5">
                      <p className="section-heading">Advanced</p>
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                          <p className="text-sm text-muted-foreground">
                            Smart Format, shortcut behavior, and capture
                            defaults are set in Transcription.
                          </p>
                          <Button
                            variant="secondary"
                            onClick={() => setActiveTab("asr")}
                          >
                            Open Transcription
                          </Button>
                        </div>

                        {renderSharedDictationControls({
                          includeCoreControls: false,
                          includeHotkeyBehavior: false,
                          includeKeyManager: true,
                          includeMemory: true,
                        })}
                      </div>
                  </div>
                )}

                {activeTab === "updates" && (
                  <div className="space-y-6">
                    <UpdateStatusWidget />
                    <BetaChannelToggle />
                  </div>
                )}

              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
