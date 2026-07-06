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
import { invoke } from "@/lib/electron";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
  isDiarizationModelAvailable,
  listDiarizationModels,
} from "@/lib/backend/asr";
import {
  listAudioInputDevices,
  type AudioInputDeviceInfo,
  type AudioInputDeviceInventory,
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
import type { DiarizationModelOption } from "@/lib/backend/asr";
import type { Settings } from "@/types/settings";
import { normalizeThemeScheme } from "@/lib/theme-schemes";
import { formatShortcutForDisplay, normalizeShortcut } from "@/lib/shortcuts";
import { ONBOARDING_STORAGE_KEY, requestOnboarding } from "@/lib/onboarding";
import { requestMainView } from "@/lib/navigation";
import {
  AlertCircle,
  CheckCircle2,
  Cloud,
  Database,
  Key,
  Lock,
  Mic,
  Monitor,
  Shield,
  Sun,
  Moon,
  Loader2,
  XCircle,
  Download,
  RefreshCw,
} from "lucide-react";
import { UpdateStatusWidget, BetaChannelToggle } from "@/components/update";
import { useToast } from "@/components/toast";

type TabId =
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
  | "toggleRecording"
  | "toggleDictation"
  | "openWindow"
  | "quickExport"
  | "focusSearch";

const SHORTCUT_FIELD_CONFIG: Array<{ key: ShortcutFieldKey; label: string }> = [
  { key: "toggleDictation", label: "Dictation" },
  { key: "toggleRecording", label: "Recording" },
  { key: "openWindow", label: "Open window" },
  { key: "quickExport", label: "Quick export" },
  { key: "focusSearch", label: "Search" },
];

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
    id: "asr" as TabId,
    label: "Transcription",
    title: "Capture and transcription",
    eyebrow: "Capture Stack",
    summary:
      "Choose microphones, tune dictation and meeting routes, and make capture behavior feel deterministic before you start speaking.",
    railSummary: "Microphones, ASR routes, and dictation behavior",
    icon: Mic,
  },
  {
    id: "general" as TabId,
    label: "General",
    title: "Workspace",
    eyebrow: "Desktop",
    summary:
      "Shape the Plainsong shell, keyboard shortcuts, overlays, and launch behavior without hunting through unrelated controls.",
    railSummary: "Appearance, shortcuts, and window behavior",
    icon: Monitor,
  },
  {
    id: "security" as TabId,
    label: "Privacy & Security",
    title: "Privacy and security",
    eyebrow: "Trust",
    summary:
      "Keep Plainsong local-first, verify permissions, and manage vault access with clear status instead of warning-heavy clutter.",
    railSummary: "Permissions, vault access, and remote policy",
    icon: Shield,
  },
  {
    id: "storage" as TabId,
    label: "Storage",
    title: "Retention and recovery",
    eyebrow: "Archive",
    summary:
      "Control export paths, retention, profile snapshots, and recovery workflows from one calmer storage workspace.",
    railSummary: "Exports, retention, backups, and reset tools",
    icon: Database,
  },
  {
    id: "ai" as TabId,
    label: "AI & Keys",
    title: "AI and memory",
    eyebrow: "Intelligence",
    summary:
      "Set the analysis provider, model, credentials, and transcript-backed memory tools without mixing them into system settings.",
    railSummary: "Providers, credentials, and memory search",
    icon: Key,
  },
  {
    id: "updates" as TabId,
    label: "Updates",
    title: "Release management",
    eyebrow: "Lifecycle",
    summary:
      "Check install status, choose update channels, and keep this machine current with minimal ceremony.",
    railSummary: "Version status and update channels",
    icon: RefreshCw,
  },
] as const;

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

function resolveDictationReadinessChip(
  settings: Settings | null,
  permissionDiagnostics: PermissionDiagnostics | null,
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
  const insertionMode = settings?.transcription.dictationInsertionMode ?? "auto";
  const cursorInsertionReady =
    insertionMode === "clipboard_only"
      ? true
      : permissionDiagnostics.cursorInsertionReady ??
        permissionDiagnostics.accessibilityReady ??
        true;

  if (!microphoneReady) {
    return {
      label: "Mic",
      status: "Needs setup",
      tone: false,
    };
  }

  if (usesAppleSpeech && !permissionDiagnostics.speechRecognitionReady) {
    return {
      label: "Speech",
      status: "Needs setup",
      tone: false,
    };
  }

  if (!cursorInsertionReady) {
    return {
      label: "Insert",
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
  const useDesktopSettingsRail = false;
  const [draftSettings, setDraftSettings] = useState<Settings | null>(null);
  const [persistedSettings, setPersistedSettings] = useState<Settings | null>(
    null,
  );
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState("openai");
  const [apiKey, setApiKey] = useState("");
  const [hasApiKey, setHasApiKey] = useState(false);
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
  const [diarizationModels, setDiarizationModels] = useState<
    DiarizationModelOption[]
  >([]);
  const [selectedDiarizationModel, setSelectedDiarizationModel] =
    useState("ecapa_tdnn_speaker");
  const [micTestActive, setMicTestActive] = useState(false);
  const [micTestLevel, setMicTestLevel] = useState(0);
  const [micTestRecording, setMicTestRecording] = useState(false);
  const [micTestPlaybackUrl, setMicTestPlaybackUrl] = useState<string | null>(
    null,
  );
  const [audioDeviceInventory, setAudioDeviceInventory] =
    useState<AudioInputDeviceInventory | null>(null);
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

  const settings = draftSettings;
  const { toast } = useToast();
  const latestProfileSnapshot = useMemo(
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
    () => resolveDictationReadinessChip(settings, permissionDiagnostics),
    [settings, permissionDiagnostics],
  );
  const dictationShortcutBehavior = resolveDictationHotkeyBehavior(settings);
  const dictationHoldToTalkActive =
    nativeShortcutAvailable && settings?.transcription.dictationPushToTalk;
  const dictationShortcutBehaviorHint = settings?.transcription
    .dictationHandsFreeEnabled
    ? "Dictation starts automatically when you speak, no shortcut press needed — pause speaking (or press the shortcut) to stop"
    : dictationHoldToTalkActive
      ? "Hold shortcut to record, release to stop"
      : "Press shortcut once to start, then press again to stop";

  const applySecurityStatusFromSettings = useCallback((next: Settings) => {
    setSecurityStatus((current) =>
      current
        ? {
            ...current,
            vaultInitialized: next.privacy.vaultInitialized,
            recordingsEncrypted: next.privacy.encryptRecordings,
            llmProvider: next.privacy.llmProvider,
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

      let mainKey = "";
      if (key === " ") {
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
        hasProviderSecret(settings.privacy.llmProvider),
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
  }, [settings?.privacy.llmProvider]);

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
        const permissions = await withSettingsSectionTimeout(
          "Permission status",
          getPermissionDiagnostics(),
        );
        if (mounted) {
          setPermissionDiagnostics(permissions);
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
    return () => {
      mounted = false;
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
    return () => {
      mounted = false;
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

  useEffect(() => {
    if (!settings) return;
    const llmProvider = settings.privacy.llmProvider;
    if (
      llmProvider === "openai" ||
      llmProvider === "anthropic" ||
      llmProvider === "gemini" ||
      llmProvider === "deepseek" ||
      llmProvider === "ollama-cloud"
    ) {
      setProvider(llmProvider);
    }
  }, [settings?.privacy.llmProvider]);

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
      const [avail, models] = await Promise.all([
        withSettingsSectionTimeout(
          "Diarization availability",
          isDiarizationModelAvailable(),
        ),
        withSettingsSectionTimeout(
          "Diarization models",
          listDiarizationModels().catch(() => [] as DiarizationModelOption[]),
        ).catch(() => [] as DiarizationModelOption[]),
      ]);
      if (!mounted) return;
      setDiarizationAvailable(avail);
      setDiarizationModels(models);
    };
    load();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (activeTab !== "ai") {
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
    (modelId: string | null) => {
      if (!settings) {
        return;
      }

      void updateSettings({
        ...settings,
        privacy: {
          ...settings.privacy,
          llmModelId: modelId,
        },
      });
    },
    [settings, updateSettings],
  );

  const updateAnalysisProvider = useCallback(
    async (providerName: string) => {
      if (!settings) {
        return;
      }

      const cachedModels = getCachedModelsForProvider(providerName);
      const initialModelId = coerceProviderModelId(
        settings.privacy.llmModelId,
        cachedModels,
      );
      const initialSettings = {
        ...settings,
        privacy: {
          ...settings.privacy,
          llmProvider: providerName,
          llmModelId: initialModelId,
        },
      };

      void updateSettings(initialSettings, { immediate: true });

      const refreshedModels = await refreshModelsForProvider(providerName);
      const refreshedModelId = coerceProviderModelId(
        initialModelId,
        refreshedModels,
      );

      if (refreshedModelId !== initialModelId) {
        void updateSettings(
          {
            ...initialSettings,
            privacy: {
              ...initialSettings.privacy,
              llmModelId: refreshedModelId,
            },
          },
          { immediate: true },
        );
      }
    },
    [
      getCachedModelsForProvider,
      refreshModelsForProvider,
      settings,
      updateSettings,
    ],
  );

  useEffect(() => {
    if (!settings || activeTab !== "ai") {
      return;
    }

    const cachedModels = getCachedModelsForProvider(
      settings.privacy.llmProvider,
    );
    if (cachedModels.length === 0) {
      return;
    }

    const nextModelId = coerceProviderModelId(
      settings.privacy.llmModelId,
      cachedModels,
    );
    if (nextModelId === settings.privacy.llmModelId) {
      return;
    }

    void updateSettings(
      {
        ...settings,
        privacy: {
          ...settings.privacy,
          llmModelId: nextModelId,
        },
      },
      { immediate: true },
    );
  }, [activeTab, getCachedModelsForProvider, settings, updateSettings]);

  const applyColorScheme = useCallback((scheme: string) => {
    const root = document.documentElement;
    if (scheme === "default") {
      root.removeAttribute("data-theme");
      return;
    }
    root.setAttribute("data-theme", scheme);
  }, []);

  useEffect(() => {
    if (!settings) {
      return;
    }
    const nextScheme = normalizeThemeScheme(settings.ui.colorScheme);
    applyColorScheme(nextScheme);
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
  }, [applyColorScheme, settings, updateSettings]);

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
  const saveStateLabel = isSaving
    ? "Saving"
    : hasUnsavedChanges
      ? "Pending"
      : "Synced";
  const activeTabConfig =
    SETTINGS_TABS.find((tab) => tab.id === activeTab) ?? SETTINGS_TABS[0];
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
  }, [refreshAudioDevices]);

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
  // partitionUniqueShortcutRegistrations precedence: the field listed first
  // in SHORTCUT_FIELD_CONFIG keeps a clashing shortcut, later fields are
  // reported as conflicting. Recomputed on every render so a freshly-typed
  // shortcut is flagged immediately, without waiting on a save round-trip.
  // The backend's get_shortcut_conflicts result (fetched once above) is
  // merged in as a fallback so a conflict the server already knows about
  // (e.g. detected at startup) still shows even before settings finish
  // loading into this form. Must run before the `if (!settings)` early
  // return below to keep hook call order stable across renders.
  const localShortcutConflictsByField = useMemo(() => {
    const byField = new Map<ShortcutFieldKey, ShortcutConflict>();
    if (!settings) {
      return byField;
    }

    const owners = new Map<string, { key: ShortcutFieldKey; label: string }>();

    for (const { key, label } of SHORTCUT_FIELD_CONFIG) {
      const raw = settings.shortcuts[key];
      if (!raw) {
        continue;
      }
      const normalized = normalizeShortcut(raw);
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
                <p className="mt-3 text-xs leading-5 text-muted-foreground">
                  Open Plainsong as the desktop app to use settings that require the local runtime.
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
        Loading settings...
      </div>
    );
  }

  const renderShortcutsSection = () => (
    <div className="rounded-[24px] border border-border/70 bg-background/75 p-5 shadow-sm">
      <div className="space-y-1">
        <Label>Global keyboard shortcuts</Label>
        <p className="text-sm text-muted-foreground">
          Click a field and press your desired shortcut combination.
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
                    onFocus={() => {
                      setCapturingShortcut(key);
                    }}
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
                <div className="flex items-start gap-2 rounded-xl border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    This conflicts with {conflict.conflictsWith} — only one
                    will work.
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Changes save immediately and new bindings apply instantly. If two
        shortcuts share the same keys, only one is registered — the other
        is flagged above.
      </p>
    </div>
  );

  const renderSharedDictationControls = (options?: {
    includeCoreControls?: boolean;
    includeHotkeyBehavior?: boolean;
    includeMeetingAutoName?: boolean;
    includeAudioTuning?: boolean;
    includePermissions?: boolean;
    includeCloudSync?: boolean;
    includeKeyManager?: boolean;
    includeMemory?: boolean;
  }) => {
    const {
      includeCoreControls = true,
      includeHotkeyBehavior = true,
      includeMeetingAutoName = false,
      includeAudioTuning = false,
      includePermissions = false,
      includeCloudSync = false,
      includeKeyManager = false,
      includeMemory = false,
    } = options ?? {};

    return (
      <div className="space-y-5">
        {includeHotkeyBehavior && (
          <div className="space-y-2">
            <Label>Hotkey behavior</Label>
            <p className="text-sm text-muted-foreground">
              {dictationShortcutBehaviorHint}
            </p>
            <select
              aria-label="Hotkey behavior"
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
              <option value="toggle">Toggle (press to start, press again to stop)</option>
              {nativeShortcutAvailable && (
                <option value="hold_to_talk">
                  Hold-to-talk (hold to record, release to stop)
                </option>
              )}
              <option value="hands_free">
                Hands-free (starts automatically when you speak, no shortcut needed)
              </option>
            </select>
          </div>
        )}

        {includeCoreControls && (
          <>
            <div className="flex items-center justify-between gap-4 rounded-2xl border border-border/60 bg-background/75 p-4">
              <div className="space-y-0.5">
                <Label>Smart Format</Label>
                <p className="text-sm text-muted-foreground">
                  Use the default LLM to format and correct dictation before
                  pasting.
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

            <div className="flex items-center justify-between gap-4 rounded-2xl border border-border/60 bg-background/75 p-4">
              <div className="space-y-0.5">
                <Label>Command mode</Label>
                <p className="text-sm text-muted-foreground">
                  Enable corrections like &quot;command undo that&quot; and
                  spoken transforms like &quot;command uppercase
                  selection&quot;.
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
              <Label>Command prefix</Label>
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
              <p className="text-xs text-muted-foreground">
                Use the wake word that starts correction and transform commands.
              </p>
            </div>

            <div className="flex items-center justify-between gap-4 rounded-2xl border border-border/60 bg-background/75 p-4">
              <div className="space-y-0.5">
                <Label>Snippets</Label>
                <p className="text-sm text-muted-foreground">
                  Expand saved text shortcuts after dictionary normalization.
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

            <div className="flex items-center justify-between gap-4 rounded-2xl border border-border/60 bg-background/75 p-4">
              <div className="space-y-0.5">
                <Label>Auto-learn corrections</Label>
                <p className="text-sm text-muted-foreground">
                  Learn safe word and short-phrase fixes from confirmed
                  dictation edits.
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

            <div className="rounded-2xl border border-border/60 bg-background/75 p-4">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="space-y-0.5">
                  <Label>Advanced dictation controls</Label>
                  <p className="text-sm text-muted-foreground">
                    Manage dictionary rules, snippets, routing, insertion,
                    context, live preview, and custom dictation modes from
                    Dictation Controls.
                  </p>
                </div>
                <Button
                  variant="secondary"
                  onClick={() => requestMainView("dictation")}
                >
                  Open Dictation Controls
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Custom Dictation Prompt</Label>
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
              <p className="text-xs text-muted-foreground">
                Overrides the default Smart Format prompt. The active app name
                is still provided as context.
              </p>
            </div>

            <div className="space-y-2">
              <Label>Custom Meeting Summary Prompt</Label>
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
              <p className="text-xs text-muted-foreground">
                Overrides the default Plainsong-style meeting summary prompt.
              </p>
            </div>

            {includeMeetingAutoName && (
              <>
                <div className="flex items-center justify-between gap-4 rounded-2xl border border-border/60 bg-background/75 p-4">
                  <div className="space-y-0.5">
                    <Label>Auto-name meetings</Label>
                    <p className="text-sm text-muted-foreground">
                      Generate a title after transcription completes for
                      meetings.
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
                  <Label>Meeting auto-name model override (optional)</Label>
                  <Input
                    placeholder="Leave empty to use summary model"
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

            <div className="flex items-center justify-between gap-4 rounded-2xl border border-border/60 bg-background/75 p-4">
              <div className="space-y-0.5">
                <Label>Copy dictation text to clipboard</Label>
                <p className="text-sm text-muted-foreground">
                  Keep the latest dictation text available for manual paste.
                </p>
              </div>
              <Switch
                checked={
                  settings.transcription.dictationCopyToClipboard ?? true
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
            <div className="flex items-center justify-between gap-4 rounded-2xl border border-border/60 bg-background/75 p-4">
              <div className="space-y-0.5">
                <Label>Automatic silence skip</Label>
                <p className="text-sm text-muted-foreground">
                  Remove silent segments before transcription.
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

            <div className="flex items-center justify-between gap-4 rounded-2xl border border-border/60 bg-background/75 p-4">
              <div className="space-y-0.5">
                <Label>Voice activity detection</Label>
                <p className="text-sm text-muted-foreground">
                  Auto-stop after silence timeout.
                </p>
              </div>
              <Switch
                checked={settings.audio.voiceActivityDetection}
                onCheckedChange={(checked) =>
                  void updateSettings({
                    ...settings,
                    audio: {
                      ...settings.audio,
                      voiceActivityDetection: checked,
                    },
                  })
                }
              />
            </div>

            {settings.audio.voiceActivityDetection && (
              <div className="space-y-3 rounded-2xl border border-border/60 bg-background/75 p-4">
                <div className="flex items-center justify-between">
                  <Label>Silence timeout</Label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={1}
                      max={30}
                      step={1}
                      className="w-16 rounded-md border bg-background px-2 py-1 text-center text-sm"
                      value={Math.round(
                        settings.audio.silenceTimeoutSeconds / 60,
                      )}
                      onBlur={handleSettingsTextBlur}
                      onKeyDown={handleSettingsTextKeyDown}
                      onChange={(e: ChangeEvent<HTMLInputElement>) => {
                        const minutes = Math.max(
                          1,
                          Math.min(30, parseInt(e.target.value, 10) || 5),
                        );
                        void updateSettings({
                          ...settings,
                          audio: {
                            ...settings.audio,
                            silenceTimeoutSeconds: minutes * 60,
                          },
                        });
                      }}
                    />
                    <span className="text-sm text-muted-foreground">min</span>
                  </div>
                </div>
                <input
                  type="range"
                  min={1}
                  max={30}
                  step={1}
                  className="w-full"
                  value={Math.round(settings.audio.silenceTimeoutSeconds / 60)}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    const minutes = parseInt(e.target.value, 10);
                    void updateSettings({
                      ...settings,
                      audio: {
                        ...settings.audio,
                        silenceTimeoutSeconds: minutes * 60,
                      },
                    });
                  }}
                />
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>1 min</span>
                  <span>5 min</span>
                  <span>15 min</span>
                  <span>30 min</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {[1, 2, 5, 10, 15, 30].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                        Math.round(
                          settings.audio.silenceTimeoutSeconds / 60,
                        ) === preset
                          ? "border-rust/40 bg-rust/8 text-rust"
                          : "border-border bg-muted hover:bg-muted/80"
                      }`}
                      onClick={() =>
                        void updateSettings({
                          ...settings,
                          audio: {
                            ...settings.audio,
                            silenceTimeoutSeconds: preset * 60,
                          },
                        })
                      }
                    >
                      {preset}m
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-center justify-between gap-4 rounded-2xl border border-border/60 bg-background/75 p-4">
              <div className="space-y-0.5">
                <Label>Noise suppression</Label>
                <p className="text-sm text-muted-foreground">
                  Reduce background noise.
                </p>
              </div>
              <Switch
                checked={settings.audio.noiseSuppression}
                onCheckedChange={(checked) =>
                  void updateSettings({
                    ...settings,
                    audio: { ...settings.audio, noiseSuppression: checked },
                  })
                }
              />
            </div>

            <div className="flex items-center justify-between gap-4 rounded-2xl border border-border/60 bg-background/75 p-4">
              <div className="space-y-0.5">
                <Label>Auto gain control</Label>
                <p className="text-sm text-muted-foreground">
                  Automatically adjust microphone levels.
                </p>
              </div>
              <Switch
                checked={settings.audio.autoGainControl}
                onCheckedChange={(checked) =>
                  void updateSettings({
                    ...settings,
                    audio: { ...settings.audio, autoGainControl: checked },
                  })
                }
              />
            </div>

            {!settings.audio.autoGainControl && (
              <div className="space-y-2 rounded-2xl border border-border/60 bg-background/75 p-4">
                <Label>
                  Manual gain ({settings.audio.manualGainDb > 0 ? "+" : ""}
                  {settings.audio.manualGainDb.toFixed(1)} dB)
                </Label>
                <input
                  type="range"
                  min={-20}
                  max={20}
                  step={0.5}
                  value={settings.audio.manualGainDb}
                  className="w-full"
                  onChange={(e: ChangeEvent<HTMLInputElement>) =>
                    void updateSettings({
                      ...settings,
                      audio: {
                        ...settings.audio,
                        manualGainDb: Number(e.target.value),
                      },
                    })
                  }
                />
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>-20 dB</span>
                  <span>0 dB</span>
                  <span>+20 dB</span>
                </div>
              </div>
            )}

            <div className="rounded-2xl border border-border/60 bg-background/75 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">Microphone test</p>
                  <p className="text-xs text-muted-foreground">
                    Check your mic level and hear the gain effect.
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

              {micTestActive && (
                <>
                  <div className="mt-4 space-y-1">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
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
                      className="text-xs"
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
            <div className="flex items-center justify-between gap-4 rounded-2xl border border-border/60 bg-background/75 p-4">
              <div className="space-y-0.5">
                <Label>Auto-request dictation permissions</Label>
                <p className="text-sm text-muted-foreground">
                  Prompt for speech and microphone permissions before dictation
                  instead of failing silently.
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

            <div className="space-y-3 rounded-2xl border border-border/60 bg-background/75 p-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <Label>Permission diagnostics</Label>
                  <p className="text-sm text-muted-foreground">
                    Validate microphone, speech recognition, accessibility, and
                    automation permissions.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={async () => {
                      const diagnostics = await getPermissionDiagnostics();
                      setPermissionDiagnostics(diagnostics);
                    }}
                  >
                    Refresh
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={async () => {
                      const diagnostics = await requestDictationPermissions();
                      setPermissionDiagnostics(diagnostics);
                    }}
                  >
                    Request now
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={async () => {
                      const diagnostics = await repairCursorInsertPermissions();
                      setPermissionDiagnostics(diagnostics);
                    }}
                  >
                    Repair insert
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
                      offLabel: "Needs grant",
                    },
                    {
                      label: "Speech recognition",
                      ready: permissionDiagnostics.speechRecognitionReady,
                      action: () => void openPermissionSettings("speech"),
                      offLabel: "Needs grant",
                    },
                    {
                      label: "Accessibility",
                      ready: permissionDiagnostics.accessibilityReady,
                      action: () =>
                        void openPermissionSettings("accessibility"),
                      offLabel: "Needs grant",
                    },
                    {
                      label: "Keyboard events",
                      ready: permissionDiagnostics.postEventReady,
                      action: () =>
                        void openPermissionSettings("accessibility"),
                      offLabel: "Fallback unavailable",
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
                        {item.ready ? "Ready" : item.offLabel}
                      </p>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="mt-1 h-auto px-0 text-xs font-normal text-muted-foreground hover:text-foreground"
                        onClick={item.action}
                      >
                        Open settings
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              {permissionDiagnostics?.notes?.length ? (
                <div className="space-y-1 text-xs text-muted-foreground">
                  {permissionDiagnostics.notes.map((note) => (
                    <p key={note}>{note}</p>
                  ))}
                </div>
              ) : null}
            </div>
          </>
        )}

        {includeCloudSync && (
          <div className="flex items-center justify-between gap-4 rounded-2xl border border-border/60 bg-background/75 p-4">
            <div className="space-y-0.5">
              <Label>Cloud sync</Label>
              <p className="text-sm text-muted-foreground">
                Enable external backup sync integrations.
              </p>
            </div>
            <Switch
              checked={settings.privacy.cloudSync}
              onCheckedChange={(checked) =>
                void updateSettings({
                  ...settings,
                  privacy: { ...settings.privacy, cloudSync: checked },
                })
              }
            />
          </div>
        )}

        {includeKeyManager && (
          <>
            <div className="space-y-2 rounded-2xl border border-border/60 bg-background/75 p-4">
              <Label>Credential provider</Label>
              <div className="flex items-center gap-2">
                <select
                  value={provider}
                  onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                    const next = e.target.value;
                    setProvider(next);
                    updateSettings({
                      ...settings,
                      privacy: { ...settings.privacy, llmProvider: next },
                    });
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
                        setHasApiKey(true);
                      } catch (e) {
                        toast(
                          `Failed to save key: ${e instanceof Error ? e.message : 'Unknown error'}`,
                          'error',
                        );
                      } finally {
                        setSavingApiKey(false);
                      }
                    }
                    void refreshModelsForProvider(settings.privacy.llmProvider);
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
                <p className="text-xs text-rust">
                  Remote processing is disabled. Stored cloud keys stay inactive
                  until policy is enabled.
                </p>
              ) : null}
              {settings.privacy.remoteProcessingEnabled && !hasApiKey ? (
                <p className="text-xs text-rust">
                  Selected analysis provider has no stored key. Analysis
                  requests will fail with a credential error.
                </p>
              ) : null}
            </div>

            <div className="space-y-2 rounded-2xl border border-border/60 bg-background/75 p-4">
              <Label>API key</Label>
              <Input
                type="password"
                placeholder={
                  hasApiKey
                    ? "Key already stored (enter to replace)"
                    : "Enter API key"
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
                      setHasApiKey(true);
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
                      setHasApiKey(true);
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
                  {savingApiKey ? "Saving..." : "Save Key"}
                </Button>
                <Button
                  variant="outline"
                  onClick={async () => {
                    setSavingApiKey(true);
                    setError(null);
                    try {
                      await clearProviderSecret(provider);
                      setApiKey("");
                      setHasApiKey(false);
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
                  Clear Key
                </Button>
                {hasApiKey && (
                  <span className="text-sm text-muted-foreground">
                    Stored securely
                  </span>
                )}
              </div>
            </div>

            <div className="space-y-2 rounded-2xl border border-border/60 bg-background/75 p-4">
              <Label>Guided cloud onboarding</Label>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={async () => {
                    setError(null);
                    const checks: string[] = [];
                    if (!settings.privacy.remoteProcessingEnabled) {
                      checks.push("Remote processing is disabled.");
                    }
                    const keyPresent = await hasProviderSecret(
                      settings.privacy.llmProvider,
                    );
                    if (!keyPresent) {
                      checks.push(
                        `No API key stored for ${settings.privacy.llmProvider}.`,
                      );
                    }
                    if (checks.length === 0) {
                      setCloudReadinessMessage(
                        "Cloud readiness checks passed.",
                      );
                    } else {
                      setCloudReadinessMessage(checks.join(" "));
                    }
                  }}
                >
                  Run Readiness Check
                </Button>
                {!settings.privacy.remoteProcessingEnabled && (
                  <Button
                    onClick={async () => {
                      const confirmed = window.confirm(
                        "Enable remote processing? This allows transcript text to be sent to cloud providers.",
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
                      setCloudReadinessMessage(
                        "Remote processing enabled. Run readiness check again.",
                      );
                    }}
                  >
                    Enable Remote Processing (Opt-in)
                  </Button>
                )}
              </div>
              {cloudReadinessMessage ? (
                <p className="text-xs text-muted-foreground">
                  {cloudReadinessMessage}
                </p>
              ) : null}
            </div>
          </>
        )}

        {includeMemory && (
          <div className="space-y-4 rounded-2xl border border-border/60 bg-background/75 p-4">
            <div className="space-y-1">
              <Label className="flex items-center gap-2">
                <Database className="h-4 w-4 text-muted-foreground" />
                Memory Search
              </Label>
              <p className="text-sm text-muted-foreground">
                How Memory searches your transcripts when you ask a question.
              </p>
            </div>

            <div className="grid gap-3 lg:grid-cols-3">
              <div className="rounded-2xl border border-border/60 bg-muted/20 p-3">
                <p className="text-sm font-medium">Memory workspace</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Review transcript-backed context and search results.
                </p>
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-3"
                  onClick={() => requestMainView("dashboard")}
                >
                  Open Memory
                </Button>
              </div>
              <div className="rounded-2xl border border-border/60 bg-muted/20 p-3">
                <p className="text-sm font-medium">Relationship memory</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Inspect people, entities, and transcript connections.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => requestMainView("dashboard")}
                >
                  Open Relationship Memory
                </Button>
              </div>
              <div className="rounded-2xl border border-border/60 bg-muted/20 p-3">
                <p className="text-sm font-medium">
                  Grounded meeting follow-up drafts
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Open Meetings to draft transcript-backed follow-up emails and
                  notes.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => requestMainView("recordings")}
                >
                  Open Meetings
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Search mode</Label>
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
                  Full-text search (built-in, no setup needed)
                </option>
                <option value="ollama_embeddings">
                  Ollama Embeddings (semantic search, requires Ollama)
                </option>
              </select>
            </div>

            {settings.transcription.memorySearchMode ===
              "ollama_embeddings" && (
              <>
                <div className="space-y-2">
                  <Label>Embedding model</Label>
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
                  <p className="text-xs text-muted-foreground">
                    Ollama embedding model name. Run{" "}
                    <code className="rounded bg-muted px-1">
                      ollama pull nomic-embed-text
                    </code>{" "}
                    first.
                  </p>
                </div>

                <div className="flex items-center justify-between rounded-2xl border border-border/60 bg-muted/20 p-3">
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">Re-index embeddings</p>
                    <p className="text-xs text-muted-foreground">
                      Generate embeddings for all existing transcripts. Required
                      after changing models.
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
                    Re-index
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
              <p className="rubric mb-1.5">SETTINGS</p>
              <h1 className="font-serif text-2xl font-semibold tracking-tight sm:text-3xl">
                Settings
              </h1>
              <p className="mt-1 text-sm text-muted-foreground sm:text-base">
                Tune transcription, AI, privacy, storage, and app behavior
              </p>
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              <div className="rounded-full border border-border/70 bg-background px-3 py-1.5 text-muted-foreground">
                Save state{" "}
                <span className="ml-1 font-medium text-foreground">
                  {saveStateLabel}
                </span>
              </div>
              <div className="rounded-full border border-border/70 bg-background px-3 py-1.5 text-muted-foreground">
                AI policy{" "}
                <span className="ml-1 font-medium text-foreground">
                  {settings.privacy.remoteProcessingEnabled
                    ? "Remote allowed"
                    : "Local-first"}
                </span>
              </div>
              <div className="rounded-full border border-border/70 bg-background px-3 py-1.5 text-muted-foreground">
                Primary mic{" "}
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
          <div className="min-w-0">
            {useDesktopSettingsRail && (
              <aside className="h-fit self-start overflow-hidden rounded-[24px] border border-border bg-card text-card-foreground shadow-sm xl:sticky xl:top-6">
                <div className="border-b border-border px-5 py-5">
                  <h2 className="font-serif text-xl font-semibold tracking-tight">
                    Overview
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">
                    Manage capture, privacy, AI, storage, and device status.
                  </p>
                </div>

                <div className="space-y-4 px-4 py-4 sm:px-5 sm:py-5">
                  <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4 lg:grid-cols-2">
                    <div
                      className={`rounded-2xl border p-3 ${readyChipTone(dictationReadinessChip.tone)}`}
                    >
                      <p className="text-current/70">
                        {dictationReadinessChip.label}
                      </p>
                      <p className="mt-1 font-medium">
                        {dictationReadinessChip.status}
                      </p>
                    </div>
                    <div
                      className={`rounded-2xl border p-3 ${readyChipTone(diarizationAvailable)}`}
                    >
                      <p className="text-current/70">Speakers</p>
                      <p className="mt-1 font-medium">
                        {diarizationAvailable ? "Installed" : "Optional"}
                      </p>
                    </div>
                    <div className="rounded-2xl border border-border bg-muted/30 p-3">
                      <p className="text-muted-foreground">Routing</p>
                      <p className="mt-1 font-medium text-foreground">
                        {settings.transcription.useSharedAsrSelection
                          ? "Shared"
                          : "Split"}
                      </p>
                    </div>
                    <div className="rounded-2xl border border-border bg-muted/30 p-3">
                      <p className="text-muted-foreground">Sync</p>
                      <p className="mt-1 font-medium text-foreground">
                        {saveStateLabel}
                      </p>
                    </div>
                  </div>

                  <div className="rounded-[20px] border border-border bg-muted/20 p-2">
                    <div className="grid grid-cols-1 gap-2">
                      {SETTINGS_TABS.map((tab) => (
                        <button
                          key={tab.id}
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
                            <p className="mt-1 text-xs leading-5 text-current/70">
                              {tab.railSummary}
                            </p>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-2xl border border-border bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
                    <p className="font-medium text-foreground">
                      Current section
                    </p>
                    <p className="mt-1 leading-5">{activeTabConfig.summary}</p>
                  </div>
                </div>
              </aside>
            )}

            <div className="min-w-0 space-y-4 sm:space-y-5">
              {!useDesktopSettingsRail && (
                <div className="space-y-3">
                  <div className="rounded-[20px] border border-border bg-card px-4 py-4 shadow-sm sm:px-5">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0 max-w-3xl">
                        <p className="rubric-muted mb-1.5">
                          {activeTabConfig.eyebrow}
                        </p>
                        <h2 className="font-serif text-xl font-semibold tracking-tight text-foreground">
                          {activeTabConfig.title}
                        </h2>
                        <p className="mt-2 text-sm leading-6 text-muted-foreground">
                          {activeTabConfig.summary}
                        </p>
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-xs lg:w-[280px]">
                        <div
                          className={`rounded-2xl border p-3 ${readyChipTone(dictationReadinessChip.tone)}`}
                        >
                          <p className="text-current/70">
                            {dictationReadinessChip.label}
                          </p>
                          <p className="mt-1 font-medium">
                            {dictationReadinessChip.status}
                          </p>
                        </div>
                        <div
                          className={`rounded-2xl border p-3 ${readyChipTone(diarizationAvailable)}`}
                        >
                          <p className="text-current/70">Speakers</p>
                          <p className="mt-1 font-medium">
                            {diarizationAvailable ? "Installed" : "Optional"}
                          </p>
                        </div>
                        <div className="rounded-2xl border border-border bg-muted/30 p-3">
                          <p className="text-muted-foreground">Routing</p>
                          <p className="mt-1 font-medium text-foreground">
                            {settings.transcription.useSharedAsrSelection
                              ? "Shared"
                              : "Split"}
                          </p>
                        </div>
                        <div className="rounded-2xl border border-border bg-muted/30 p-3">
                          <p className="text-muted-foreground">Sync</p>
                          <p className="mt-1 font-medium text-foreground">
                            {saveStateLabel}
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>

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
                            <p className="mt-1 text-xs leading-5 text-current/70">
                              {tab.railSummary}
                            </p>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
              {error && (
                <div className="flex items-center gap-2 rounded-2xl border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive">
                  <AlertCircle className="h-4 w-4" />
                  {error}
                </div>
              )}

              <section className="overflow-hidden rounded-[24px] border border-border bg-card shadow-sm">
                <div className="border-b border-border/60 px-4 py-5 sm:px-6 sm:py-6">
                  <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
                    {!useDesktopSettingsRail && (
                      <div className="max-w-3xl">
                        <p className="rubric mb-1.5">
                          {activeTabConfig.eyebrow}
                        </p>
                        <h2 className="font-serif text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
                          {activeTabConfig.title}
                        </h2>
                        <p className="mt-3 text-sm leading-6 text-muted-foreground sm:text-base">
                          {activeTabConfig.summary}
                        </p>
                      </div>
                    )}
                    {useDesktopSettingsRail && (
                      <div className="max-w-3xl">
                        <p className="rubric mb-1.5">
                          {activeTabConfig.eyebrow}
                        </p>
                        <h2 className="font-serif text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
                          {activeTabConfig.title}
                        </h2>
                        <p className="mt-3 text-sm leading-6 text-muted-foreground sm:text-base">
                          {activeTabConfig.summary}
                        </p>
                      </div>
                    )}
                    <div className="hidden flex-wrap gap-2 text-xs xl:flex">
                      <div className="rounded-full border border-border/70 bg-background px-3 py-1.5 text-muted-foreground">
                        Primary mic{" "}
                        <span className="ml-1 font-medium text-foreground">
                          {settings.audio.preferredInputDevice?.deviceName ??
                            "System default"}
                        </span>
                      </div>
                      <div className="rounded-full border border-border/70 bg-background px-3 py-1.5 text-muted-foreground">
                        Dictation mode{" "}
                        <span className="ml-1 font-medium text-foreground">
                          {dictationShortcutBehavior.replace(/_/g, " ")}
                        </span>
                      </div>
                      <div className="rounded-full border border-border/70 bg-background px-3 py-1.5 text-muted-foreground">
                        Routes{" "}
                        <span className="ml-1 font-medium text-foreground">
                          {settings.transcription.useSharedAsrSelection
                            ? "Shared"
                            : "Split"}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="space-y-6 px-4 py-5 sm:px-6 sm:py-6">
                  {activeTab === "asr" && (
                    <div className="space-y-5">
                      <div className="border-b border-border/60 pb-4">
                        <h3 className="font-serif text-lg font-semibold text-foreground">
                          Transcription
                        </h3>
                        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
                          Choose how Plainsong transcribes dictation and
                          meetings, then tune language, audio, and speaker
                          labeling.
                        </p>
                      </div>
                      <div className="space-y-5">
                        <div className="space-y-3">
                          <AsrProviderManager />
                        </div>

                        <div className="rounded-[24px] border border-border bg-muted/20 p-5 text-foreground">
                          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                            <div>
                              <p className="rubric mb-1.5">
                                Capture routing
                              </p>
                              <h3 className="font-serif text-xl font-semibold text-foreground">
                                Microphone routing
                              </h3>
                              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                                Pick one app-wide microphone, then override
                                dictation or meetings when you need a dedicated
                                input chain.
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
                                <p className="rubric-muted">
                                  App-wide default
                                </p>
                                <p className="mt-1 text-sm text-muted-foreground">
                                  Used whenever a mode-specific override is off.
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
                                  <p className="rubric-muted">
                                    Dictation override
                                  </p>
                                  <p className="mt-1 text-sm text-muted-foreground">
                                    Use a dedicated input just for hotkey
                                    dictation.
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
                                  Follow app-wide microphone
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
                                  <p className="rubric-muted">
                                    Meeting override
                                  </p>
                                  <p className="mt-1 text-sm text-muted-foreground">
                                    Use a separate microphone for mic-only
                                    meetings and mixed capture.
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
                                  Follow app-wide microphone
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
                                    <span className="rounded-full border border-gold/30 bg-gold/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.18em] text-gold-text">
                                      Default
                                    </span>
                                  ) : null}
                                </div>
                                {device.isBluetoothLike ? (
                                  <p className="mt-3 text-xs leading-5 text-rust">
                                    Bluetooth headset mics can lower playback
                                    quality while dictating. Built-in or USB
                                    mics usually sound cleaner.
                                  </p>
                                ) : (
                                  <p className="mt-3 text-xs leading-5 text-muted-foreground">
                                    Stable local input for dictation, meetings,
                                    and mic tests.
                                  </p>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>

                        <div className="h-px bg-border" />

                        <div className="flex items-center justify-between">
                          <div className="space-y-0.5">
                            <Label>Automatic speaker naming</Label>
                            <p className="text-sm text-muted-foreground">
                              Run diarization and label speakers after
                              transcription
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
                                  Downloading Model...
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

                        {settings.transcription.enableDiarization && (
                          <div className="space-y-2">
                            <Label>Diarization model</Label>
                            {diarizationModels.length > 0 ? (
                              <div className="space-y-2">
                                {diarizationModels.map((model) => (
                                  <div
                                    key={model.id}
                                    className={`rounded-md border p-3 cursor-pointer transition-colors ${selectedDiarizationModel === model.id ? "border-rust/40 bg-rust/8" : "border-border bg-muted/20 hover:bg-muted/40"}`}
                                    onClick={() =>
                                      setSelectedDiarizationModel(model.id)
                                    }
                                  >
                                    <div className="flex items-center justify-between">
                                      <div className="flex items-center gap-2">
                                        <input
                                          type="radio"
                                          name="diarization-model"
                                          value={model.id}
                                          checked={
                                            selectedDiarizationModel ===
                                            model.id
                                          }
                                          onChange={() =>
                                            setSelectedDiarizationModel(
                                              model.id,
                                            )
                                          }
                                          className="accent-rust"
                                        />
                                        <div>
                                          <p className="text-sm font-medium">
                                            {model.label}
                                          </p>
                                          <p className="text-xs text-muted-foreground">
                                            {model.description}
                                          </p>
                                        </div>
                                      </div>
                                      {model.installed ? (
                                        <span className="inline-flex items-center gap-1 rounded-full bg-gold/10 px-2 py-0.5 text-[10px] font-medium text-gold-text shrink-0">
                                          <CheckCircle2 className="h-3 w-3" />{" "}
                                          Installed
                                        </span>
                                      ) : (
                                        <Button
                                          variant="outline"
                                          size="sm"
                                          className="shrink-0 text-xs h-7"
                                          disabled={diarizationDownloading}
                                          onClick={async (e) => {
                                            e.stopPropagation();
                                            setDiarizationDownloading(true);
                                            try {
                                              await downloadDiarizationModel(
                                                model.id,
                                              );
                                              setDiarizationModels((prev) =>
                                                prev.map((m) =>
                                                  m.id === model.id
                                                    ? { ...m, installed: true }
                                                    : m,
                                                ),
                                              );
                                              if (
                                                model.id ===
                                                "ecapa_tdnn_speaker"
                                              )
                                                setDiarizationAvailable(true);
                                            } catch (e) {
                                              const msg =
                                                e instanceof Error
                                                  ? e.message
                                                  : String(e);
                                              setError(
                                                `Download failed: ${msg}`,
                                              );
                                            } finally {
                                              setDiarizationDownloading(false);
                                            }
                                          }}
                                        >
                                          <Download className="h-3 w-3 mr-1" />
                                          Download
                                        </Button>
                                      )}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            ) : diarizationAvailable ? (
                              <div className="rounded-md border border-border bg-muted/30 p-3">
                                <div className="flex items-center justify-between">
                                  <div>
                                    <p className="text-sm font-medium">
                                      ECAPA-TDNN 512
                                    </p>
                                    <p className="text-xs text-muted-foreground">
                                      Wespeaker ECAPA-TDNN (speaker embedding)
                                    </p>
                                  </div>
                                  <span className="inline-flex items-center gap-1 rounded-full bg-gold/10 px-2 py-0.5 text-[10px] font-medium text-gold-text">
                                    <CheckCircle2 className="h-3 w-3" />{" "}
                                    Installed
                                  </span>
                                </div>
                              </div>
                            ) : null}
                          </div>
                        )}

                        {settings.transcription.enableDiarization && (
                          <div className="space-y-2">
                            <Label>Speaker naming method</Label>
                            <select
                              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                              value={settings.transcription.speakerNamingMethod}
                              onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                                void updateSettings({
                                  ...settings,
                                  transcription: {
                                    ...settings.transcription,
                                    speakerNamingMethod: e.target.value as
                                      | "auto"
                                      | "numbered"
                                      | "manual",
                                  },
                                })
                              }
                            >
                              <option value="auto">
                                Auto-detect from speech (recommended)
                              </option>
                              <option value="numbered">
                                Numbered (Speaker 1, Speaker 2, ...)
                              </option>
                              <option value="manual">
                                Manual only (set names yourself)
                              </option>
                            </select>
                          </div>
                        )}

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
                          <div className="rounded-md border border-border bg-muted/20 p-3">
                            <div className="space-y-1">
                              <p className="text-sm font-medium">
                                Dictation active language set
                              </p>
                              <p className="text-xs text-muted-foreground">
                                Applies when Transcription language stays on
                                auto-detect. Keep one language selected to lock
                                dictation to it, or choose several to keep
                                auto-detect inside a narrower set.
                              </p>
                            </div>
                            <div className="mt-3 flex flex-wrap gap-2">
                              {DICTATION_ACTIVE_LANGUAGE_OPTIONS.map(
                                (option) => {
                                  const activeLanguages =
                                    normalizeActiveLanguageSet(
                                      settings.transcription
                                        .dictationActiveLanguages,
                                    );
                                  const selected = activeLanguages.includes(
                                    option.value,
                                  );
                                  return (
                                    <button
                                      key={option.value}
                                      type="button"
                                      aria-pressed={selected}
                                      aria-label={`Toggle ${option.label} in dictation active languages`}
                                      className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                                        selected
                                          ? "border-foreground bg-foreground text-background"
                                          : "border-border bg-background text-muted-foreground hover:text-foreground"
                                      }`}
                                      onClick={() => {
                                        const nextActiveLanguages = selected
                                          ? activeLanguages.filter(
                                              (language) =>
                                                language !== option.value,
                                            )
                                          : [...activeLanguages, option.value];
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
                            <p className="mt-3 text-xs text-muted-foreground">
                              {normalizeActiveLanguageSet(
                                settings.transcription.dictationActiveLanguages,
                              ).length === 0
                                ? "No dictation language set saved yet. Auto-detect stays fully open."
                                : normalizeActiveLanguageSet(
                                      settings.transcription
                                        .dictationActiveLanguages,
                                    ).length === 1
                                  ? `Dictation will lock to ${
                                      DICTATION_ACTIVE_LANGUAGE_OPTIONS.find(
                                        (option) =>
                                          option.value ===
                                          normalizeActiveLanguageSet(
                                            settings.transcription
                                              .dictationActiveLanguages,
                                          )[0],
                                      )?.label ??
                                      normalizeActiveLanguageSet(
                                        settings.transcription
                                          .dictationActiveLanguages,
                                      )[0]
                                    } when the language select stays on auto-detect.`
                                  : `Dictation auto-detect will stay inside ${normalizeActiveLanguageSet(
                                      settings.transcription
                                        .dictationActiveLanguages,
                                    )
                                      .map(
                                        (language) =>
                                          DICTATION_ACTIVE_LANGUAGE_OPTIONS.find(
                                            (option) =>
                                              option.value === language,
                                          )?.label ?? language,
                                      )
                                      .join(", ")}.`}
                            </p>
                          </div>
                        </div>

                        <div className="space-y-5 border-t pt-4">
                          <p className="rubric">
                            Power user
                          </p>
                          {renderSharedDictationControls({
                            includeMeetingAutoName: true,
                            includeAudioTuning: true,
                          })}
                        </div>
                      </div>
                    </div>
                  )}

                  {activeTab === "general" && (
                    <Card>
                      <CardHeader>
                        <CardTitle>General</CardTitle>
                        <CardDescription>
                          Appearance, shortcuts, overlays, and everyday app
                          behavior
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-5">
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
                              Keep hotkeys, overlays, and background capture
                              available when you close the main window
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
                            <Label>Overlay windows</Label>
                            <p className="text-sm text-muted-foreground">
                              Keep the floating dictation and meeting recorder
                              controls visible while you work.
                            </p>
                          </div>

                          <div className="flex items-center justify-between">
                            <div className="space-y-0.5">
                              <Label>Show dictation mini window</Label>
                              <p className="text-sm text-muted-foreground">
                                Show the floating recorder shell during global
                                dictation.
                              </p>
                            </div>
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
                            <div className="space-y-0.5">
                              <Label>Show meeting mini window</Label>
                              <p className="text-sm text-muted-foreground">
                                Show the floating recorder shell during meeting
                                capture and processing.
                              </p>
                            </div>
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
                          <p className="rubric">
                            Power user
                          </p>
                          <div className="rounded-2xl border border-border/60 bg-background/70 p-4">
                            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                              <div>
                                <p className="text-sm font-medium text-foreground">
                                  Dictation defaults live in Transcription
                                </p>
                                <p className="text-sm text-muted-foreground">
                                  Keep the recording shell clean here and
                                  manage Smart Format, prompts, routing, and
                                  audio behavior from the dedicated
                                  Transcription workspace.
                                </p>
                              </div>
                              <Button
                                variant="secondary"
                                onClick={() => setActiveTab("asr")}
                              >
                                Open Transcription
                              </Button>
                            </div>
                          </div>

                          {renderShortcutsSection()}
                        </div>
                      </CardContent>
                    </Card>
                  )}

                  {activeTab === "security" && (
                    <Card>
                      <CardHeader>
                        <CardTitle>Privacy & Security</CardTitle>
                        <CardDescription>
                          Local-first defaults with explicit remote opt-in
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-5">
                        <div className="flex items-center justify-between">
                          <div className="space-y-0.5">
                            <Label className="flex items-center gap-2">
                              <Lock className="h-4 w-4" />
                              Encrypt recordings at rest
                            </Label>
                            <p className="text-sm text-muted-foreground">
                              Enable encrypted storage policy
                            </p>
                          </div>
                          <Switch
                            checked={settings.privacy.encryptRecordings}
                            onCheckedChange={(checked) =>
                              void updateSettings({
                                ...settings,
                                privacy: {
                                  ...settings.privacy,
                                  encryptRecordings: checked,
                                },
                              })
                            }
                          />
                        </div>

                        <div className="flex items-center justify-between">
                          <div className="space-y-0.5">
                            <Label className="flex items-center gap-2">
                              <Cloud className="h-4 w-4" />
                              Remote processing
                            </Label>
                            <p className="text-sm text-muted-foreground">
                              Allow cloud providers for analysis
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
                          <p className="rubric">
                            Power user
                          </p>
                            {renderSharedDictationControls({
                              includeCoreControls: false,
                              includePermissions: true,
                            })}

                            <div className="space-y-2">
                              <Label>Vault password</Label>
                              <Input
                                type="password"
                                placeholder="Enter vault password"
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
                                  Unlock Vault
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
                                  Lock Vault
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
                                <div className="text-sm text-muted-foreground space-y-1 mt-2 p-3 bg-muted/20 border rounded-md">
                                  <p>
                                    Vault initialized:{" "}
                                    <span className="font-medium">
                                      {securityStatus.vaultInitialized
                                        ? "yes"
                                        : "no"}
                                    </span>
                                  </p>
                                  <p>
                                    Vault unlocked:{" "}
                                    <span className="font-medium">
                                      {securityStatus.vaultUnlocked
                                        ? "yes"
                                        : "no"}
                                    </span>
                                  </p>
                                  <p>
                                    Database encrypted:{" "}
                                    <span className="font-medium">
                                      {securityStatus.databaseEncrypted
                                        ? "yes"
                                        : "no"}
                                    </span>
                                  </p>
                                </div>
                              ) : null}
                            </div>

                            {renderSharedDictationControls({
                              includeCoreControls: false,
                              includeCloudSync: true,
                            })}
                          </div>
                      </CardContent>
                    </Card>
                  )}

                  {activeTab === "storage" && (
                    <Card>
                      <CardHeader>
                        <CardTitle>Storage</CardTitle>
                        <CardDescription>
                          Retention, backups, export paths, and cleanup tools
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-5">
                        <div className="space-y-3">
                          <Label>Export defaults</Label>
                          <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-2">
                              <Label className="text-sm text-muted-foreground">
                                Default format
                              </Label>
                              <select
                                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                                value={settings.export.defaultFormat}
                                onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                                  void updateSettings({
                                    ...settings,
                                    export: {
                                      ...settings.export,
                                      defaultFormat: e.target.value,
                                    },
                                  })
                                }
                              >
                                <option value="markdown">Markdown</option>
                                <option value="json">JSON</option>
                                <option value="text">Plain Text</option>
                                <option value="pdf">PDF</option>
                              </select>
                            </div>
                            <div className="space-y-2">
                              <Label className="text-sm text-muted-foreground">
                                Export directory
                              </Label>
                              <Input
                                placeholder="Same as recording location"
                                value={settings.export.exportDirectory ?? ""}
                                onBlur={handleSettingsTextBlur}
                                onKeyDown={handleSettingsTextKeyDown}
                                onChange={(e: ChangeEvent<HTMLInputElement>) =>
                                  void updateSettings({
                                    ...settings,
                                    export: {
                                      ...settings.export,
                                      exportDirectory:
                                        e.target.value.trim() || null,
                                    },
                                  })
                                }
                              />
                            </div>
                          </div>
                        </div>

                        <div className="space-y-2">
                          <Label>Export root limit (absolute path)</Label>
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
                          <p className="text-xs text-muted-foreground">
                            When set, exports are strictly restricted to this
                            root directory or its subdirectories.
                          </p>
                        </div>

                        <div className="flex items-center justify-between">
                          <div className="space-y-0.5">
                            <Label>Include timestamps in exports</Label>
                            <p className="text-sm text-muted-foreground">
                              Add time markers to exported transcripts
                            </p>
                          </div>
                          <Switch
                            checked={settings.export.includeTimestamps}
                            onCheckedChange={(checked) =>
                              void updateSettings({
                                ...settings,
                                export: {
                                  ...settings.export,
                                  includeTimestamps: checked,
                                },
                              })
                            }
                          />
                        </div>

                        <div className="flex items-center justify-between">
                          <div className="space-y-0.5">
                            <Label>Include speaker names</Label>
                            <p className="text-sm text-muted-foreground">
                              Label speakers in exported transcripts
                            </p>
                          </div>
                          <Switch
                            checked={settings.export.includeSpeakers}
                            onCheckedChange={(checked) =>
                              void updateSettings({
                                ...settings,
                                export: {
                                  ...settings.export,
                                  includeSpeakers: checked,
                                },
                              })
                            }
                          />
                        </div>

                        <div className="flex items-center justify-between">
                          <div className="space-y-0.5">
                            <Label>Open file after export</Label>
                            <p className="text-sm text-muted-foreground">
                              Automatically open exported files
                            </p>
                          </div>
                          <Switch
                            checked={settings.export.openAfterExport}
                            onCheckedChange={(checked) =>
                              void updateSettings({
                                ...settings,
                                export: {
                                  ...settings.export,
                                  openAfterExport: checked,
                                },
                              })
                            }
                          />
                        </div>

                        <div className="h-px bg-border" />

                        <div className="space-y-2">
                          <Label>Auto-delete recordings after days</Label>
                          <Input
                            type="number"
                            min={0}
                            value={settings.privacy.autoDeleteDays}
                            onBlur={handleSettingsTextBlur}
                            onKeyDown={handleSettingsTextKeyDown}
                            onChange={(e: ChangeEvent<HTMLInputElement>) => {
                              const nextDays = Math.max(
                                0,
                                Number(e.target.value) || 0,
                              );
                              void updateSettings({
                                ...settings,
                                privacy: {
                                  ...settings.privacy,
                                  autoDeleteDays: nextDays,
                                },
                              });
                            }}
                          />
                          <p className="text-xs text-muted-foreground">
                            Set to 0 to keep all recordings indefinitely.
                          </p>
                        </div>

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
                          <Label>Meeting audio storage</Label>
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
                            <option value="always">Always keep audio</option>
                            <option value="transcript_only">
                              Transcript only (delete audio after transcription)
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
                          <Label>Meeting retention delete mode</Label>
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
                            <option value="audio_only">
                              Delete audio only
                            </option>
                            <option value="audio_and_transcript">
                              Delete audio and transcript
                            </option>
                          </select>
                        </div>

                        <div className="rounded-lg border p-4 space-y-3">
                          <div className="space-y-1">
                            <Label>Guided setup</Label>
                            <p className="text-sm text-muted-foreground">
                              Guided setup now lives in the dedicated Setup
                              center so normal users always have one obvious
                              place to fix permissions, models, and meetings.
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
                              Reset App Data
                            </Label>
                            <p className="text-sm text-muted-foreground">
                              Deletes recordings, transcripts, projects, audit
                              history, benchmark history, and saved cloud keys.
                              Downloaded local ASR model assets are kept.
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
                            Reset Everything On This Device
                          </Button>
                          <p className="text-xs text-muted-foreground">
                            After reset, onboarding runs again on next launch.
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
                                confirm permanent deletion of recordings,
                                transcripts, projects, logs, and saved provider
                                keys.
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
                              <p className="text-xs text-muted-foreground">
                                Confirmation is case-insensitive.
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
                                Confirm Reset
                              </Button>
                            </DialogFooter>
                          </DialogContent>
                        </Dialog>

                        {backupConfigLoading && !backupConfig && (
                          <div className="pt-4 border-t">
                            <div className="rounded-2xl border border-border/60 bg-background/70 p-4 text-sm text-muted-foreground">
                              Loading backup controls...
                            </div>
                          </div>
                        )}

                        {backupConfig && (
                          <div className="pt-4 border-t space-y-5">
                            <p className="rubric">
                              Power user
                            </p>
                            <div className="rounded-2xl border border-border/60 bg-background/70 p-4">
                              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                                <div>
                                  <p className="text-sm font-medium text-foreground">
                                    Retention stays separate from dictation
                                    behavior
                                  </p>
                                  <p className="text-sm text-muted-foreground">
                                    Storage now focuses on exports, retention,
                                    backups, and recovery. Adjust dictation
                                    prompts, routing, and capture behavior from
                                    Transcription.
                                  </p>
                                </div>
                                <Button
                                  variant="secondary"
                                  onClick={() => setActiveTab("asr")}
                                >
                                  Open Transcription
                                </Button>
                              </div>
                            </div>

                            <div className="flex items-center justify-between">
                              <div className="space-y-0.5">
                                <Label>Automatic backups</Label>
                                <p className="text-sm text-muted-foreground">
                                  Create local backups on schedule
                                </p>
                              </div>
                              <Switch
                                checked={backupConfig.enabled}
                                onCheckedChange={(checked) =>
                                  setBackupConfig({
                                    ...backupConfig,
                                    enabled: checked,
                                  })
                                }
                              />
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                              <div className="space-y-2">
                                <Label>Backup interval (hours)</Label>
                                <Input
                                  type="number"
                                  min={1}
                                  value={backupConfig.intervalHours}
                                  onChange={(
                                    e: ChangeEvent<HTMLInputElement>,
                                  ) =>
                                    setBackupConfig({
                                      ...backupConfig,
                                      intervalHours: Math.max(
                                        1,
                                        Number(e.target.value) || 24,
                                      ),
                                    })
                                  }
                                />
                              </div>
                              <div className="space-y-2">
                                <Label>Max backups</Label>
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
                              </div>
                            </div>

                            <div className="flex items-center justify-between">
                              <div className="space-y-0.5">
                                <Label>Personal profile sync</Label>
                                <p className="text-sm text-muted-foreground">
                                  Sync settings, shortcuts, dictation flows,
                                  dictionary, snippets, and preferences via
                                  cloud storage
                                </p>
                              </div>
                              <Switch
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
                                <Label>Provider</Label>
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
                                  <option value="">Select provider</option>
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

                            <div className="rounded-lg border p-3 bg-muted/10 space-y-2">
                              <div className="flex items-start justify-between gap-4">
                                <div>
                                  <Label className="text-sm">
                                    Personal Profile Sync
                                  </Label>
                                  <p className="text-sm text-muted-foreground">
                                    Profile snapshots save your personal setup
                                    without copying recordings or transcripts.
                                  </p>
                                </div>
                                <span className="text-xs uppercase tracking-wide text-muted-foreground">
                                  Settings only
                                </span>
                              </div>
                              <div className="grid gap-2 md:grid-cols-2">
                                <div className="rounded border bg-background p-3">
                                  <p className="text-xs font-medium text-muted-foreground">
                                    Latest profile snapshot
                                  </p>
                                  <p className="mt-1 text-sm">
                                    {latestProfileSnapshot
                                      ? new Date(
                                          latestProfileSnapshot.timestamp,
                                        ).toLocaleString()
                                      : "No profile snapshot yet"}
                                  </p>
                                  <p className="mt-1 text-xs text-muted-foreground">
                                    {latestProfileSnapshot
                                      ? `${latestProfileSnapshot.itemsCount} items · ${latestProfileSnapshot.id}`
                                      : "Create one before syncing to another device."}
                                  </p>
                                </div>
                                <div className="rounded border bg-background p-3">
                                  <p className="text-xs font-medium text-muted-foreground">
                                    Latest full backup
                                  </p>
                                  <p className="mt-1 text-sm">
                                    {latestFullBackup
                                      ? new Date(
                                          latestFullBackup.timestamp,
                                        ).toLocaleString()
                                      : "No full backup yet"}
                                  </p>
                                  <p className="mt-1 text-xs text-muted-foreground">
                                    {latestFullBackup
                                      ? `${latestFullBackup.itemsCount} items · ${latestFullBackup.id}`
                                      : "Use this when you want recovery for recordings and transcripts too."}
                                  </p>
                                </div>
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
                                      "Backup configuration saved.",
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
                                Save Sync Config
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
                                      "Cloud connection verified.",
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
                                Verify Cloud Connection
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
                                        ? "Cloud setup checks passed."
                                        : "Cloud setup checks found issues.",
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
                                Run Setup Checks
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
                                      `Profile snapshot created: ${info.id}`,
                                    );
                                    await refreshBackups();
                                  } catch (e) {
                                    setError(
                                      e instanceof Error
                                        ? e.message
                                        : "Profile snapshot failed",
                                    );
                                  } finally {
                                    setBackupBusy(false);
                                  }
                                }}
                              >
                                Create Profile Snapshot
                              </Button>
                              <Button
                                variant="outline"
                                disabled={
                                  backupBusy ||
                                  !latestProfileSnapshot ||
                                  !backupConfig.cloudSync
                                }
                                onClick={async () => {
                                  if (!latestProfileSnapshot) return;
                                  setBackupBusy(true);
                                  setBackupStatus(null);
                                  setError(null);
                                  try {
                                    await saveBackupConfig(backupConfig);
                                    await syncBackupToCloud(
                                      latestProfileSnapshot.id,
                                    );
                                    setBackupStatus(
                                      `Synced profile snapshot ${latestProfileSnapshot.id} to cloud.`,
                                    );
                                  } catch (e) {
                                    setError(
                                      e instanceof Error
                                        ? e.message
                                        : "Profile sync failed",
                                    );
                                  } finally {
                                    setBackupBusy(false);
                                  }
                                }}
                              >
                                Sync Latest Profile Snapshot
                              </Button>
                              <Button
                                variant="outline"
                                disabled={
                                  backupBusy ||
                                  !latestProfileSnapshot ||
                                  hasUnsavedChanges
                                }
                                onClick={async () => {
                                  if (!latestProfileSnapshot) return;
                                  setBackupBusy(true);
                                  setBackupStatus(null);
                                  setError(null);
                                  try {
                                    await restoreBackupDefault(
                                      latestProfileSnapshot.id,
                                    );
                                    const restored = await getSettings();
                                    setDraftSettings(restored);
                                    setPersistedSettings(restored);
                                    setBackupStatus(
                                      `Restored profile snapshot ${latestProfileSnapshot.id}.`,
                                    );
                                  } catch (e) {
                                    setError(
                                      e instanceof Error
                                        ? e.message
                                        : "Profile restore failed",
                                    );
                                  } finally {
                                    setBackupBusy(false);
                                  }
                                }}
                              >
                                Restore Latest Profile Snapshot
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
                                Create Full Backup
                              </Button>
                              <Button
                                variant="outline"
                                disabled={
                                  backupBusy ||
                                  backups.length === 0 ||
                                  !backupConfig.cloudSync
                                }
                                onClick={async () => {
                                  const latest = backups[0];
                                  if (!latest) return;
                                  setBackupBusy(true);
                                  setBackupStatus(null);
                                  setError(null);
                                  try {
                                    await saveBackupConfig(backupConfig);
                                    await syncBackupToCloud(latest.id);
                                    setBackupStatus(
                                      `Synced backup ${latest.id} to cloud.`,
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
                                Sync Latest Full Backup
                              </Button>
                            </div>

                            {backupStatus && (
                              <p className="text-sm text-muted-foreground">
                                {backupStatus}
                              </p>
                            )}
                            {hasUnsavedChanges ? (
                              <p className="text-xs text-rust">
                                Save or discard local settings edits before
                                restoring a profile snapshot.
                              </p>
                            ) : null}
                            {backupSetupReport && (
                              <div className="rounded-lg border p-3 space-y-2 bg-muted/10">
                                <div className="flex items-center justify-between">
                                  <Label className="text-sm">
                                    Cloud setup readiness
                                  </Label>
                                  <span
                                    className={`text-xs font-medium ${
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
                                    <div
                                      key={check.id}
                                      className="rounded border p-2 bg-background"
                                    >
                                      <div className="flex items-center justify-between gap-2">
                                        <div className="flex items-center gap-2">
                                          {check.status === "pass" ? (
                                            <CheckCircle2 className="h-4 w-4 text-gold-text" />
                                          ) : (
                                            <XCircle className="h-4 w-4 text-rust" />
                                          )}
                                          <p className="text-sm font-medium">
                                            {check.label}
                                          </p>
                                        </div>
                                        <span className="text-xs uppercase tracking-wide text-muted-foreground">
                                          {check.status}
                                        </span>
                                      </div>
                                      <p className="pl-6 text-xs text-muted-foreground">
                                        {check.message}
                                      </p>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                            {backupConfig.cloudProvider !== "i_cloud" && (
                              <p className="text-xs text-muted-foreground">
                                For OneDrive, Google Drive, and Proton Drive,
                                run `rclone config` first and create the remote.
                              </p>
                            )}
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  )}

                  {activeTab === "ai" && (
                    <Card>
                      <CardHeader>
                        <CardTitle>AI & Keys</CardTitle>
                        <CardDescription>
                          Choose the default analysis provider, model, and API
                          credentials
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-5">
                        <div className="space-y-2">
                          <Label>Default analysis provider</Label>
                          <select
                            value={settings.privacy.llmProvider}
                            onChange={(event) =>
                              void updateAnalysisProvider(event.target.value)
                            }
                            className="w-full p-2 border rounded-md bg-background"
                          >
                            <option value="ollama">Ollama (Local)</option>
                            <option value="openai">OpenAI</option>
                            <option value="anthropic">Anthropic</option>
                            <option value="gemini">Google Gemini</option>
                            <option value="deepseek">DeepSeek</option>
                            <option value="ollama-cloud">Ollama Cloud</option>
                          </select>
                          <p className="text-xs text-muted-foreground">
                            Used by summarize, Q&A, and action-item extraction.
                          </p>
                          {!settings.privacy.remoteProcessingEnabled &&
                          settings.privacy.llmProvider !== "ollama" ? (
                            <p className="text-xs text-rust">
                              Remote provider selected but remote processing is
                              disabled.
                            </p>
                          ) : null}
                        </div>

                        <div className="space-y-2">
                          <Label className="flex items-center gap-2">
                            Analysis model
                            {modelsLoading && (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            )}
                          </Label>

                          {settings.privacy.llmProvider === "ollama" ? (
                            ollamaModels.length > 0 ? (
                              <select
                                value={
                                  settings.privacy.llmModelId ??
                                  ollamaModels[0] ??
                                  ""
                                }
                                onChange={(
                                  event: ChangeEvent<HTMLSelectElement>,
                                ) =>
                                  updateAnalysisModel(event.target.value || null)
                                }
                                className="w-full p-2 border rounded-md bg-background"
                              >
                                {ollamaModels.map((model) => (
                                  <option key={model} value={model}>
                                    {model}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <div className="p-3 rounded border bg-muted/30 text-sm">
                                <p className="text-muted-foreground">
                                  No Ollama models found. Run{" "}
                                  <code className="bg-muted px-1 rounded">
                                    ollama pull llama3.2
                                  </code>{" "}
                                  to download a model.
                                </p>
                              </div>
                            )
                          ) : settings.privacy.llmProvider === "openai" ? (
                            openaiModels.length > 0 ? (
                              <select
                                value={
                                  settings.privacy.llmModelId ?? openaiModels[0]
                                }
                                onChange={(
                                  event: ChangeEvent<HTMLSelectElement>,
                                ) =>
                                  updateAnalysisModel(event.target.value || null)
                                }
                                className="w-full p-2 border rounded-md bg-background"
                              >
                                {openaiModels
                                  .filter(
                                    (m) =>
                                      m.includes("gpt") ||
                                      m.includes("o1") ||
                                      m.includes("o3") ||
                                      m.includes("o4"),
                                  )
                                  .sort()
                                  .map((model) => (
                                    <option key={model} value={model}>
                                      {model}
                                    </option>
                                  ))}
                              </select>
                            ) : (
                              <div className="p-3 rounded border border-rust/30 bg-rust/10 text-sm">
                                <p className="text-rust">
                                  Enter your OpenAI API key in advanced settings
                                  to fetch models.
                                </p>
                              </div>
                            )
                          ) : settings.privacy.llmProvider === "anthropic" ? (
                            anthropicModels.length > 0 ? (
                              <select
                                value={
                                  settings.privacy.llmModelId ??
                                  anthropicModels[0]
                                }
                                onChange={(
                                  event: ChangeEvent<HTMLSelectElement>,
                                ) =>
                                  updateAnalysisModel(event.target.value || null)
                                }
                                className="w-full p-2 border rounded-md bg-background"
                              >
                                {anthropicModels.map((model) => (
                                  <option key={model} value={model}>
                                    {model}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <div className="p-3 rounded border border-rust/30 bg-rust/10 text-sm">
                                <p className="text-rust">
                                  Enter your Anthropic API key in advanced
                                  settings to fetch models.
                                </p>
                              </div>
                            )
                          ) : settings.privacy.llmProvider === "gemini" ? (
                            geminiModels.length > 0 ? (
                              <select
                                value={
                                  settings.privacy.llmModelId ??
                                  geminiModels[0]
                                }
                                onChange={(
                                  event: ChangeEvent<HTMLSelectElement>,
                                ) =>
                                  updateAnalysisModel(event.target.value || null)
                                }
                                className="w-full p-2 border rounded-md bg-background"
                              >
                              {geminiModels
                                  .filter((m) => m.includes("gemini"))
                                  .map((model) => (
                                    <option key={model} value={model}>
                                      {model}
                                    </option>
                                  ))}
                              </select>
                            ) : (
                              <div className="p-3 rounded border border-rust/30 bg-rust/10 text-sm">
                                <p className="text-rust">
                                  Enter your Google AI API key in advanced
                                  settings to fetch models.
                                </p>
                              </div>
                            )
                          ) : settings.privacy.llmProvider === "deepseek" ? (
                            deepseekModels.length > 0 ? (
                              <select
                                value={
                                  settings.privacy.llmModelId ??
                                  deepseekModels[0]
                                }
                                onChange={(
                                  event: ChangeEvent<HTMLSelectElement>,
                                ) =>
                                  updateAnalysisModel(event.target.value || null)
                                }
                                className="w-full p-2 border rounded-md bg-background"
                              >
                                {deepseekModels.map((model) => (
                                  <option key={model} value={model}>
                                    {model}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <div className="p-3 rounded border border-rust/30 bg-rust/10 text-sm">
                                <p className="text-rust">
                                  Enter your DeepSeek API key in advanced
                                  settings to fetch models.
                                </p>
                              </div>
                            )
                          ) : settings.privacy.llmProvider ===
                            "ollama-cloud" ? (
                            ollamaCloudModels.length > 0 ? (
                              <select
                                value={
                                  settings.privacy.llmModelId ??
                                  ollamaCloudModels[0]
                                }
                                onChange={(
                                  event: ChangeEvent<HTMLSelectElement>,
                                ) =>
                                  updateAnalysisModel(event.target.value || null)
                                }
                                className="w-full p-2 border rounded-md bg-background"
                              >
                                {ollamaCloudModels.map((model) => (
                                  <option key={model} value={model}>
                                    {model}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <div className="p-3 rounded border border-rust/30 bg-rust/10 text-sm">
                                <p className="text-rust">
                                  Enter your Ollama Cloud API key in advanced
                                  settings to fetch models.
                                </p>
                              </div>
                            )
                          ) : (
                            <div className="p-3 rounded border bg-muted/30 text-sm">
                              <p className="text-muted-foreground">
                                Select a provider to see available models.
                              </p>
                            </div>
                          )}
                          <p className="text-xs text-muted-foreground">
                            {settings.privacy.llmProvider === "ollama" &&
                            ollamaModels.length === 0
                              ? "Download models via Ollama CLI or pull button below."
                              : settings.privacy.llmProvider !== "ollama" &&
                                  [
                                    "openai",
                                    "anthropic",
                                    "gemini",
                                    "deepseek",
                                    "ollama-cloud",
                                  ].includes(settings.privacy.llmProvider) &&
                                  !hasApiKey &&
                                  true
                                ? "Add your API key below to fetch available models."
                                : "Models fetched from provider API."}
                          </p>
                        </div>

                        <div className="flex items-center justify-between">
                          <div className="space-y-0.5">
                            <Label>Remote processing policy</Label>
                            <p className="text-xs text-muted-foreground">
                              Controls whether transcript text can be sent to
                              cloud LLMs.
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

                        {settings.privacy.llmProvider === "ollama" && (
                          <div className="rounded-lg border p-3 space-y-2">
                            <p className="text-sm font-medium">Local Ollama</p>
                            <p className="text-xs text-muted-foreground">
                              Status:{" "}
                              {ollamaAvailable === null
                                ? "Checking..."
                                : ollamaAvailable
                                  ? "Available"
                                  : "Not reachable"}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              Models:{" "}
                              {ollamaModels.length > 0
                                ? ollamaModels.join(", ")
                                : "No local models detected"}
                            </p>
                          </div>
                        )}

                        <div className="pt-4 border-t space-y-5">
                          <p className="rubric">
                            Power user
                          </p>
                            <div className="rounded-2xl border border-border/60 bg-background/70 p-4">
                              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                                <div>
                                  <p className="text-sm font-medium text-foreground">
                                    Transcription behavior is managed in one
                                    place
                                  </p>
                                  <p className="text-sm text-muted-foreground">
                                    AI settings now focus on analysis providers,
                                    credentials, and memory search. Hotkey
                                    behavior, Smart Format, and capture defaults
                                    stay in Transcription.
                                  </p>
                                </div>
                                <Button
                                  variant="secondary"
                                  onClick={() => setActiveTab("asr")}
                                >
                                  Open Transcription
                                </Button>
                              </div>
                            </div>

                            {renderSharedDictationControls({
                              includeCoreControls: false,
                              includeKeyManager: true,
                              includeMemory: true,
                            })}
                          </div>
                      </CardContent>
                    </Card>
                  )}

                  {activeTab === "updates" && (
                    <Card>
                      <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                          <RefreshCw className="h-5 w-5 text-muted-foreground" />
                          Updates
                        </CardTitle>
                        <CardDescription>
                          Check for and install app updates
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-6">
                        <UpdateStatusWidget />
                        <BetaChannelToggle />
                      </CardContent>
                    </Card>
                  )}

                  {isSaving && (
                    <div className="text-sm text-muted-foreground">
                      Saving settings...
                    </div>
                  )}
                  {!isSaving && hasUnsavedChanges && (
                    <div className="text-sm text-muted-foreground">
                      Changes queued for save...
                    </div>
                  )}
                </div>
              </section>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
