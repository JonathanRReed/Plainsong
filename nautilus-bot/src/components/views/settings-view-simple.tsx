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
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTheme } from "@/components/theme-provider";
import {
  createBackupDefault,
  clearProviderSecret,
  getBackupConfig,
  getPermissionDiagnostics,
  getBackupSetupReport,
  getOllamaStatus,
  getSecurityStatus,
  getSettings,
  hasProviderSecret,
  lockVault,
  listBackups,
  listOllamaModels,
  listOllamaCloudModels,
  listOpenAiModels,
  listAnthropicModels,
  listGeminiModels,
  listDeepSeekModels,
  listDownloadedModels,
  downloadWhisperModel,
  migrateToEncryptedStorage,
  openPermissionSettings,
  saveSettings,
  saveBackupConfig,
  setProviderSecret,
  syncBackupToCloud,
  unlockVault,
  verifyBackupCloudConnection,
} from "@/lib/tauri";
import type { BackupConfig, BackupInfo, CloudSetupReport, SecurityStatus, LicenseInfo, DownloadedModel } from "@/lib/tauri";
import type { PermissionDiagnostics } from "@/lib/tauri";
import { validateLicense, deactivateLicense, isDiarizationModelAvailable, downloadDiarizationModel } from "@/lib/tauri";
import { isFeatureAllowed } from "@/hooks/use-license-features";
import type { Settings } from "@/types/settings";
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
  Star,
  ExternalLink,
  Loader2,
  XCircle,
  Download,
  RefreshCw,
} from "lucide-react";
import { UpdateStatusWidget, BetaChannelToggle } from "@/components/update";

type TabId = "asr" | "general" | "security" | "storage" | "ai" | "license" | "updates";
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

const SETTINGS_SAVE_DEBOUNCE_MS = 350;

function markSettingsPerf(markName: string) {
  if (!import.meta.env.DEV || typeof performance === "undefined") {
    return;
  }
  performance.mark(markName);
  console.debug(`[perf] ${markName}`);
}

export function SettingsView() {
  const { theme, setTheme } = useTheme();
  const [activeTab, setActiveTab] = useState<TabId>("general");
  const [draftSettings, setDraftSettings] = useState<Settings | null>(null);
  const [persistedSettings, setPersistedSettings] = useState<Settings | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState("openai");
  const [apiKey, setApiKey] = useState("");
  const [hasApiKey, setHasApiKey] = useState(false);
  const [savingApiKey, setSavingApiKey] = useState(false);
  const [backupConfig, setBackupConfig] = useState<BackupConfig | null>(null);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupStatus, setBackupStatus] = useState<string | null>(null);
  const [backupSetupReport, setBackupSetupReport] = useState<CloudSetupReport | null>(null);
  const [permissionDiagnostics, setPermissionDiagnostics] = useState<PermissionDiagnostics | null>(null);
  const [securityStatus, setSecurityStatus] = useState<SecurityStatus | null>(null);
  const [vaultPassword, setVaultPassword] = useState("");
  const [cloudReadinessMessage, setCloudReadinessMessage] = useState<string | null>(null);
  const [ollamaAvailable, setOllamaAvailable] = useState<boolean | null>(null);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [ollamaCloudModels, setOllamaCloudModels] = useState<string[]>([]);
  const [diarizationAvailable, setDiarizationAvailable] = useState(false);
  const [diarizationDownloading, setDiarizationDownloading] = useState(false);
  const [openaiModels, setOpenaiModels] = useState<string[]>([]);
  const [anthropicModels, setAnthropicModels] = useState<string[]>([]);
  const [geminiModels, setGeminiModels] = useState<string[]>([]);
  const [deepseekModels, setDeepseekModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [downloadedModels, setDownloadedModels] = useState<DownloadedModel[]>([]);
  const [downloadingModel, setDownloadingModel] = useState<string | null>(null);
  const [hasLoadedSecurityTab, setHasLoadedSecurityTab] = useState(false);
  const [hasLoadedStorageTab, setHasLoadedStorageTab] = useState(false);
  const [licenseInfo, setLicenseInfo] = useState<LicenseInfo | null>(null);
  const mountedRef = useRef(true);
  const saveSchedulerRef = useRef<SettingsSaveScheduler>({
    nextVersion: 0,
    latestAppliedVersion: 0,
    pending: null,
    timer: null,
    flushing: false,
  });

  const settings = draftSettings;

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
        : current
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
              setError(e instanceof Error ? e.message : "Failed to save settings");
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
    [applySecurityStatusFromSettings]
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
    [flushPendingSettingsSave]
  );

  useEffect(() => {
    mountedRef.current = true;
    markSettingsPerf("settings-initial-load-start");

    const load = async () => {
      try {
        const [loaded, loadedBackupConfig, loadedModels] = await Promise.all([
          getSettings(),
          getBackupConfig(),
          listDownloadedModels().catch(() => []),
        ]);
        if (mountedRef.current) {
          setDraftSettings(loaded);
          setPersistedSettings(loaded);
          setBackupConfig(loadedBackupConfig);
          setDownloadedModels(loadedModels);
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

  const handleDownloadModel = useCallback(async (modelName: string) => {
    setDownloadingModel(modelName);
    try {
      await downloadWhisperModel(modelName);
      const models = await listDownloadedModels();
      setDownloadedModels(models);
    } catch (e) {
      setError(e instanceof Error ? e.message : `Failed to download ${modelName}`);
    } finally {
      setDownloadingModel(null);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    hasProviderSecret(provider)
      .then((value) => {
        if (mounted) {
          setHasApiKey(value);
        }
      })
      .catch((err) => {
        // Log but don't reset — a keychain error in dev/unsigned builds should not
        // wipe the "Stored securely" indicator from a successful save earlier.
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
    if (activeTab !== "security" || hasLoadedSecurityTab) {
      return;
    }

    let mounted = true;
    markSettingsPerf("settings-security-load-start");
    const loadSecurity = async () => {
      try {
        const [permissions, security] = await Promise.all([
          getPermissionDiagnostics(),
          getSecurityStatus(),
        ]);
        if (mounted) {
          setPermissionDiagnostics(permissions);
          setSecurityStatus(security);
          setHasLoadedSecurityTab(true);
          markSettingsPerf("settings-security-load-complete");
        }
      } catch (e) {
        if (mounted) {
          setError(e instanceof Error ? e.message : "Failed to load security details");
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
        const loadedBackups = await listBackups();
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
    if (activeTab !== "license" || licenseInfo !== null) return;
    void validateLicense().then(setLicenseInfo).catch(() => {
      setLicenseInfo({ key: "", instanceId: "", tier: "none", valid: false, lsStatus: "", activationsLimit: 5, activationsUsage: 0, lastValidatedAt: "", trialDaysRemaining: 30, nagRequired: false, trialActive: true });
    });
  }, [activeTab, licenseInfo]);

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
          const models = await listOpenAiModels();
          setOpenaiModels(models);
          break;
        }
        case "anthropic": {
          const models = await listAnthropicModels();
          setAnthropicModels(models);
          break;
        }
        case "gemini": {
          const models = await listGeminiModels();
          setGeminiModels(models);
          break;
        }
        case "deepseek": {
          const models = await listDeepSeekModels();
          setDeepseekModels(models);
          break;
        }
        case "ollama-cloud": {
          const models = await listOllamaCloudModels();
          setOllamaCloudModels(models);
          break;
        }
        case "ollama": {
          const [available, models] = await Promise.all([
            getOllamaStatus(),
            listOllamaModels(),
          ]);
          setOllamaAvailable(available);
          setOllamaModels(models);
          break;
        }
      }
    } catch (e) {
      console.error(`Failed to refresh models for ${providerName}:`, e);
    } finally {
      setModelsLoading(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    isDiarizationModelAvailable().then((avail) => {
      if (mounted) setDiarizationAvailable(avail);
    });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (activeTab !== "ai") {
      return;
    }
    let mounted = true;
    setModelsLoading(true);

    const loadModels = async () => {
      try {
        const [ollamaAvail, ollamaList, ollamaCloudList, openaiList, anthropicList, geminiList, deepseekList] = await Promise.all([
          getOllamaStatus(),
          listOllamaModels().catch((e) => { console.error("Ollama error:", e); return []; }),
          listOllamaCloudModels().catch((e) => { console.error("Ollama Cloud error:", e); return []; }),
          listOpenAiModels().catch((e) => { console.error("OpenAI error:", e); return []; }),
          listAnthropicModels().catch((e) => { console.error("Anthropic error:", e); return []; }),
          listGeminiModels().catch((e) => { console.error("Gemini error:", e); return []; }),
          listDeepSeekModels().catch((e) => { console.error("DeepSeek error:", e); return []; }),
        ]);

        if (mounted) {
          setOllamaAvailable(ollamaAvail);
          setOllamaModels(ollamaList);
          setOllamaCloudModels(ollamaCloudList);
          setOpenaiModels(openaiList);
          setAnthropicModels(anthropicList);
          setGeminiModels(geminiList);
          setDeepseekModels(deepseekList);
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
    (next: Settings, options?: { immediate?: boolean; debounceMs?: number }) => {
      setDraftSettings(next);
      setError(null);

      if (options?.immediate) {
        queueSettingsSave(next, 0);
        void flushPendingSettingsSave();
        return;
      }
      queueSettingsSave(next, options?.debounceMs ?? SETTINGS_SAVE_DEBOUNCE_MS);
    },
    [flushPendingSettingsSave, queueSettingsSave]
  );

  const refreshBackups = useCallback(async () => {
    const data = await listBackups();
    setBackups(data);
    setHasLoadedStorageTab(true);
  }, []);

  const hasUnsavedChanges = useMemo(() => {
    if (!draftSettings || !persistedSettings) {
      return false;
    }
    return JSON.stringify(draftSettings) !== JSON.stringify(persistedSettings);
  }, [draftSettings, persistedSettings]);

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
    [flushPendingSettingsSave]
  );

  const tabList = useMemo(
    () => [
      { id: "asr" as TabId, label: "ASR Models", icon: Mic },
      { id: "general" as TabId, label: "General", icon: Monitor },
      { id: "security" as TabId, label: "Security", icon: Shield },
      { id: "storage" as TabId, label: "Storage", icon: Database },
      { id: "ai" as TabId, label: "AI & Keys", icon: Key },
      { id: "updates" as TabId, label: "Updates", icon: RefreshCw },
      { id: "license" as TabId, label: "License", icon: Shield },
    ],
    []
  );

  if (!settings) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 mr-2 animate-spin" />
        Loading settings...
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="p-6 border-b">
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-muted-foreground">Configure Nautilus preferences</p>
      </div>

      <div className="flex-1 overflow-auto">
        <div className="p-6 max-w-5xl space-y-6">
          {error && (
            <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" />
              {error}
            </div>
          )}

          <div className="grid w-full grid-cols-6 bg-muted p-1 rounded-md">
            {tabList.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center justify-center gap-2 px-3 py-1.5 text-sm font-medium rounded-sm transition-all ${activeTab === tab.id
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
                  }`}
              >
                <tab.icon className="h-4 w-4" />
                {tab.label}
              </button>
            ))}
          </div>

          {activeTab === "asr" && <AsrProviderManager />}

          {activeTab === "general" && (
            <Card>
              <CardHeader>
                <CardTitle>Application Preferences</CardTitle>
                <CardDescription>Core interface and control defaults</CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="space-y-2">
                  <Label>Theme</Label>
                  <div className="flex gap-2">
                    <Button
                      variant={theme === "light" ? "default" : "outline"}
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
                      variant={theme === "system" ? "default" : "outline"}
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
                    <Label>Voice activity detection</Label>
                    <p className="text-sm text-muted-foreground">Auto-stop after silence timeout</p>
                  </div>
                  <Switch
                    checked={settings.audio.voiceActivityDetection}
                    onCheckedChange={(checked) =>
                      void updateSettings({
                        ...settings,
                        audio: { ...settings.audio, voiceActivityDetection: checked },
                      })
                    }
                  />
                </div>

                {settings.audio.voiceActivityDetection && (
                  <div className="space-y-2">
                    <Label>Silence timeout (seconds)</Label>
                    <Input
                      type="number"
                      min={1}
                      max={60}
                      value={settings.audio.silenceTimeoutSeconds}
                      onBlur={handleSettingsTextBlur}
                      onKeyDown={handleSettingsTextKeyDown}
                      onChange={(e: ChangeEvent<HTMLInputElement>) =>
                        void updateSettings({
                          ...settings,
                          audio: {
                            ...settings.audio,
                            silenceTimeoutSeconds: Math.max(1, Math.min(60, Number(e.target.value) || 3)),
                          },
                        })
                      }
                    />
                    <p className="text-sm text-muted-foreground">Stop recording after this many seconds of silence</p>
                  </div>
                )}

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Noise suppression</Label>
                    <p className="text-sm text-muted-foreground">Reduce background noise during recording</p>
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

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Auto gain control</Label>
                    <p className="text-sm text-muted-foreground">Automatically adjust microphone levels</p>
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

                <div className="h-px bg-border" />

                <div className="space-y-2">
                  <Label>Transcription language</Label>
                  <select
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    value={settings.transcription.language ?? ""}
                    onChange={(e) =>
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
                  <p className="text-sm text-muted-foreground">Force a specific language or leave on auto-detect</p>
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Automatic speaker naming</Label>
                    <p className="text-sm text-muted-foreground">
                      Run diarization and label speakers after transcription
                    </p>
                  </div>
                  {diarizationAvailable ? (
                    <Switch
                      checked={settings.transcription.enableDiarization}
                      onCheckedChange={(checked) =>
                        void updateSettings({
                          ...settings,
                          transcription: { ...settings.transcription, enableDiarization: checked },
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
                          // Auto-enable once downloaded
                          updateSettings({
                            ...settings,
                            transcription: { ...settings.transcription, enableDiarization: true },
                          });
                        } catch (e) {
                          const msg = e instanceof Error ? e.message : String(e); // Capture full error
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

                <div className="space-y-2">
                  <Label>Default local ASR model</Label>
                  <select
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    value={settings.transcription.selectedModelId}
                    onChange={(e) =>
                      void updateSettings({
                        ...settings,
                        transcription: {
                          ...settings.transcription,
                          selectedModelId: e.target.value,
                        },
                      })
                    }
                  >
                    <optgroup label="Fast (Edge-friendly)">
                      <option value="tiny">Whisper tiny — 39M params, fastest</option>
                      <option value="tiny.en">Whisper tiny.en — English only</option>
                      <option value="base">Whisper base — 74M params</option>
                      <option value="base.en">Whisper base.en — English only</option>
                    </optgroup>
                    <optgroup label="Balanced">
                      <option value="small">Whisper small — 244M params</option>
                      <option value="small.en">Whisper small.en — English only</option>
                      <option value="medium">Whisper medium — 769M params</option>
                      <option value="medium.en">Whisper medium.en — English only</option>
                    </optgroup>
                    <optgroup label="Best Accuracy">
                      <option value="large-v3">Whisper large-v3 — 1.5B params, 99+ languages</option>
                      <option value="large-v3-turbo">Whisper large-v3-turbo — Fast + accurate</option>
                    </optgroup>
                    <optgroup label="Alternative Models">
                      <option value="parakeet-tdt-0.6b-v3">Parakeet TDT 0.6B v3 — Ultra low-latency</option>
                      <option value="canary-qwen-2.5b">Canary Qwen 2.5B — Max English accuracy</option>
                      <option value="distil-large-v3">Distil-Whisper Large V3 — 6x faster</option>
                    </optgroup>
                  </select>
                  <p className="text-xs text-muted-foreground">
                    English-only models are faster. Use large-v3 for multilingual transcription.
                  </p>
                </div>

                <div className="space-y-3">
                  <Label className="text-sm text-muted-foreground">Quick download — Top 5 ASR models</Label>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {[
                      { id: "large-v3-turbo", name: "Whisper Large V3 Turbo", desc: "Fast + accurate", size: "1.6 GB" },
                      { id: "large-v3", name: "Whisper Large V3", desc: "99+ languages", size: "2.9 GB" },
                      { id: "base.en", name: "Whisper Base EN", desc: "Fast English", size: "142 MB" },
                      { id: "small.en", name: "Whisper Small EN", desc: "Balanced English", size: "466 MB" },
                      { id: "medium.en", name: "Whisper Medium EN", desc: "Best English", size: "1.5 GB" },
                    ].map((model) => {
                      const isDownloaded = downloadedModels.some(
                        (d) => d.name.toLowerCase().includes(model.id.toLowerCase()) ||
                          d.name.toLowerCase().includes(model.id.replace(".en", "-en").toLowerCase())
                      );
                      const isDownloading = downloadingModel === model.id;

                      return (
                        <div key={model.id} className="flex items-center justify-between p-2 rounded border bg-muted/30">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">{model.name}</p>
                            <p className="text-xs text-muted-foreground">{model.desc} · {model.size}</p>
                          </div>
                          {isDownloaded ? (
                            <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0 ml-2" />
                          ) : isDownloading ? (
                            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground shrink-0 ml-2" />
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="shrink-0 ml-2 h-7 px-2"
                              onClick={() => void handleDownloadModel(model.id)}
                            >
                              <Download className="h-3 w-3" />
                            </Button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Downloaded models: {downloadedModels.length} · Use ASR Models tab for all providers
                  </p>
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Allow Whisper fallback</Label>
                    <p className="text-sm text-muted-foreground">
                      If selected provider fails, fallback to Whisper instead of hard failing
                    </p>
                  </div>
                  <Switch
                    checked={settings.transcription.allowWhisperFallback}
                    onCheckedChange={(checked) =>
                      void updateSettings({
                        ...settings,
                        transcription: {
                          ...settings.transcription,
                          allowWhisperFallback: checked,
                        },
                      })
                    }
                  />
                </div>

                <div className="h-px bg-border" />

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Show dictation popup</Label>
                    <p className="text-sm text-muted-foreground">
                      Floating status while hotkey dictation runs
                    </p>
                  </div>
                  <Switch
                    checked={settings.ui.showDictationPopup}
                    onCheckedChange={(checked) =>
                      void updateSettings({
                        ...settings,
                        ui: { ...settings.ui, showDictationPopup: checked },
                      })
                    }
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Show recording popup</Label>
                    <p className="text-sm text-muted-foreground">
                      Floating status while meeting recording is active
                    </p>
                  </div>
                  <Switch
                    checked={settings.ui.showRecordingPopup}
                    onCheckedChange={(checked) =>
                      void updateSettings({
                        ...settings,
                        ui: { ...settings.ui, showRecordingPopup: checked },
                      })
                    }
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Always on top</Label>
                    <p className="text-sm text-muted-foreground">Keep window above other applications</p>
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

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Show in Dock</Label>
                    <p className="text-sm text-muted-foreground">Display app icon in macOS Dock</p>
                  </div>
                  <Switch
                    checked={settings.ui.showInDock}
                    onCheckedChange={(checked) =>
                      void updateSettings({
                        ...settings,
                        ui: { ...settings.ui, showInDock: checked },
                      })
                    }
                  />
                </div>

                <div className="h-px bg-border" />

                <div className="space-y-3">
                  <Label>Keyboard shortcuts</Label>
                  <p className="text-sm text-muted-foreground">Global hotkeys for quick access</p>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div className="flex items-center justify-between p-2 rounded border">
                      <span className="text-muted-foreground">Dictation</span>
                      <kbd className="px-2 py-1 bg-muted rounded text-xs font-mono">
                        {settings.shortcuts.toggleDictation}
                      </kbd>
                    </div>
                    <div className="flex items-center justify-between p-2 rounded border">
                      <span className="text-muted-foreground">Recording</span>
                      <kbd className="px-2 py-1 bg-muted rounded text-xs font-mono">
                        {settings.shortcuts.toggleRecording}
                      </kbd>
                    </div>
                    <div className="flex items-center justify-between p-2 rounded border">
                      <span className="text-muted-foreground">Quick export</span>
                      <kbd className="px-2 py-1 bg-muted rounded text-xs font-mono">
                        {settings.shortcuts.quickExport}
                      </kbd>
                    </div>
                    <div className="flex items-center justify-between p-2 rounded border">
                      <span className="text-muted-foreground">Search</span>
                      <kbd className="px-2 py-1 bg-muted rounded text-xs font-mono">
                        {settings.shortcuts.focusSearch}
                      </kbd>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Shortcuts can be customized in the app configuration file
                  </p>
                </div>

                <div className="h-px bg-border" />

                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <Label>Permission diagnostics</Label>
                      <p className="text-sm text-muted-foreground">
                        Validate microphone, accessibility, and automation permissions
                      </p>
                    </div>
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
                  </div>
                  {permissionDiagnostics && (
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-sm">
                      <div className="p-2 rounded border">
                        <p className="font-medium">Microphone</p>
                        <p className={permissionDiagnostics.microphoneReady ? "text-green-500" : "text-amber-500"}>
                          {permissionDiagnostics.microphoneReady ? "Ready" : "Not ready"}
                        </p>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="mt-1 px-0"
                          onClick={() => void openPermissionSettings("microphone")}
                        >
                          Open settings
                        </Button>
                      </div>
                      <div className="p-2 rounded border">
                        <p className="font-medium">Accessibility</p>
                        <p className={permissionDiagnostics.accessibilityReady ? "text-green-500" : "text-amber-500"}>
                          {permissionDiagnostics.accessibilityReady ? "Ready" : "Needs grant"}
                        </p>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="mt-1 px-0"
                          onClick={() => void openPermissionSettings("accessibility")}
                        >
                          Open settings
                        </Button>
                      </div>
                      <div className="p-2 rounded border">
                        <p className="font-medium">Automation</p>
                        <p className={permissionDiagnostics.automationReady ? "text-green-500" : "text-amber-500"}>
                          {permissionDiagnostics.automationReady ? "Ready" : "Needs grant"}
                        </p>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="mt-1 px-0"
                          onClick={() => void openPermissionSettings("automation")}
                        >
                          Open settings
                        </Button>
                      </div>
                    </div>
                  )}
                  {permissionDiagnostics?.notes?.length ? (
                    <div className="text-xs text-muted-foreground space-y-1">
                      {permissionDiagnostics.notes.map((note) => (
                        <p key={note}>{note}</p>
                      ))}
                    </div>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          )}

          {activeTab === "security" && (
            <Card>
              <CardHeader>
                <CardTitle>Security and Privacy</CardTitle>
                <CardDescription>Local-first defaults with explicit remote opt-in</CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label className="flex items-center gap-2">
                      <Lock className="h-4 w-4" />
                      Encrypt recordings at rest
                    </Label>
                    <p className="text-sm text-muted-foreground">Enable encrypted storage policy</p>
                  </div>
                  <Switch
                    checked={settings.privacy.encryptRecordings}
                    onCheckedChange={(checked) =>
                      void updateSettings({
                        ...settings,
                        privacy: { ...settings.privacy, encryptRecordings: checked },
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
                        privacy: { ...settings.privacy, remoteProcessingEnabled: checked },
                      })
                    }
                  />
                </div>

                <div className="space-y-2">
                  <Label>Default analysis provider</Label>
                  <select
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    value={settings.privacy.llmProvider}
                    onChange={(e) =>
                      void updateSettings({
                        ...settings,
                        privacy: { ...settings.privacy, llmProvider: e.target.value },
                      })
                    }
                  >
                    <option value="ollama">Ollama (Local)</option>
                    <option value="openai">OpenAI</option>
                    <option value="anthropic">Anthropic</option>
                    <option value="gemini">Google Gemini</option>
                    <option value="deepseek">DeepSeek</option>
                    <option value="ollama-cloud">Ollama Cloud</option>
                  </select>
                  {!settings.privacy.remoteProcessingEnabled && settings.privacy.llmProvider !== "ollama" ? (
                    <p className="text-sm text-amber-600">
                      Remote provider is selected, but remote processing is disabled. Analysis commands will be blocked until policy is enabled.
                    </p>
                  ) : null}
                </div>

                <div className="space-y-2">
                  <Label>Export root (absolute path)</Label>
                  <Input
                    placeholder="/Users/you/Documents/Nautilus"
                    value={settings.privacy.exportRoot ?? ""}
                    onBlur={handleSettingsTextBlur}
                    onKeyDown={handleSettingsTextKeyDown}
                    onChange={(e: ChangeEvent<HTMLInputElement>) =>
                      void updateSettings({
                        ...settings,
                        privacy: {
                          ...settings.privacy,
                          exportRoot: e.target.value.trim() ? e.target.value.trim() : null,
                        },
                      })
                    }
                  />
                  <p className="text-sm text-muted-foreground">
                    When set, exports are restricted to this root.
                  </p>
                </div>

                <div className="h-px bg-border" />

                <div className="space-y-2">
                  <Label>Vault password</Label>
                  <Input
                    type="password"
                    placeholder="Enter vault password"
                    value={vaultPassword}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setVaultPassword(e.target.value)}
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
                          setSecurityStatus(await getSecurityStatus());
                        } catch (e) {
                          setError(e instanceof Error ? e.message : "Failed to unlock vault");
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
                          setSecurityStatus(await getSecurityStatus());
                        } catch (e) {
                          setError(e instanceof Error ? e.message : "Failed to lock vault");
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
                          await migrateToEncryptedStorage(vaultPassword.trim());
                          setVaultPassword("");
                          setSecurityStatus(await getSecurityStatus());
                        } catch (e) {
                          setError(
                            e instanceof Error
                              ? e.message
                              : "Failed to migrate to encrypted storage"
                          );
                        }
                      }}
                    >
                      Migrate to Encrypted Storage
                    </Button>
                  </div>
                  {securityStatus ? (
                    <div className="text-sm text-muted-foreground space-y-1">
                      <p>Vault initialized: {securityStatus.vaultInitialized ? "yes" : "no"}</p>
                      <p>Vault unlocked: {securityStatus.vaultUnlocked ? "yes" : "no"}</p>
                      <p>Database encrypted: {securityStatus.databaseEncrypted ? "yes" : "no"}</p>
                    </div>
                  ) : null}
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label className="flex items-center gap-2">
                      Cloud sync
                      {!isFeatureAllowed(licenseInfo, "cloudSync") && (
                        <span className="text-xs text-amber-600">⭐ Friends Club</span>
                      )}
                    </Label>
                    <p className="text-sm text-muted-foreground">Enable external backup sync integrations</p>
                  </div>
                  <Switch
                    checked={settings.privacy.cloudSync}
                    disabled={!isFeatureAllowed(licenseInfo, "cloudSync")}
                    onCheckedChange={(checked) =>
                      void updateSettings({
                        ...settings,
                        privacy: { ...settings.privacy, cloudSync: checked },
                      })
                    }
                  />
                </div>
              </CardContent>
            </Card>
          )}

          {activeTab === "storage" && (
            <Card>
              <CardHeader>
                <CardTitle>Storage and Retention</CardTitle>
                <CardDescription>Data lifecycle, backups, and cloud sync controls</CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="space-y-2">
                  <Label>Auto-delete recordings after days</Label>
                  <Input
                    type="number"
                    min={0}
                    value={settings.privacy.autoDeleteDays}
                    onBlur={handleSettingsTextBlur}
                    onKeyDown={handleSettingsTextKeyDown}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => {
                      const nextDays = Math.max(0, Number(e.target.value) || 0);
                      void updateSettings({
                        ...settings,
                        privacy: { ...settings.privacy, autoDeleteDays: nextDays },
                      });
                    }}
                  />
                  <p className="text-sm text-muted-foreground">Set to 0 to keep all recordings indefinitely.</p>
                </div>

                <div className="h-px bg-border" />

                <div className="space-y-3">
                  <Label>Export defaults</Label>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label className="text-sm text-muted-foreground">Default format</Label>
                      <select
                        className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                        value={settings.export.defaultFormat}
                        onChange={(e) =>
                          void updateSettings({
                            ...settings,
                            export: { ...settings.export, defaultFormat: e.target.value },
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
                      <Label className="text-sm text-muted-foreground">Export directory</Label>
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
                              exportDirectory: e.target.value.trim() || null,
                            },
                          })
                        }
                      />
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Include timestamps in exports</Label>
                    <p className="text-sm text-muted-foreground">Add time markers to exported transcripts</p>
                  </div>
                  <Switch
                    checked={settings.export.includeTimestamps}
                    onCheckedChange={(checked) =>
                      void updateSettings({
                        ...settings,
                        export: { ...settings.export, includeTimestamps: checked },
                      })
                    }
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Include speaker names</Label>
                    <p className="text-sm text-muted-foreground">Label speakers in exported transcripts</p>
                  </div>
                  <Switch
                    checked={settings.export.includeSpeakers}
                    onCheckedChange={(checked) =>
                      void updateSettings({
                        ...settings,
                        export: { ...settings.export, includeSpeakers: checked },
                      })
                    }
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Open file after export</Label>
                    <p className="text-sm text-muted-foreground">Automatically open exported files</p>
                  </div>
                  <Switch
                    checked={settings.export.openAfterExport}
                    onCheckedChange={(checked) =>
                      void updateSettings({
                        ...settings,
                        export: { ...settings.export, openAfterExport: checked },
                      })
                    }
                  />
                </div>

                {backupConfig && (
                  <>
                    <div className="h-px bg-border" />

                    <div className="flex items-center justify-between">
                      <div className="space-y-0.5">
                        <Label>Automatic backups</Label>
                        <p className="text-sm text-muted-foreground">Create local backups on schedule</p>
                      </div>
                      <Switch
                        checked={backupConfig.enabled}
                        onCheckedChange={(checked) =>
                          setBackupConfig({ ...backupConfig, enabled: checked })
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
                          onChange={(e: ChangeEvent<HTMLInputElement>) =>
                            setBackupConfig({
                              ...backupConfig,
                              intervalHours: Math.max(1, Number(e.target.value) || 24),
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
                          onChange={(e: ChangeEvent<HTMLInputElement>) =>
                            setBackupConfig({
                              ...backupConfig,
                              maxBackups: Math.max(1, Number(e.target.value) || 7),
                            })
                          }
                        />
                      </div>
                    </div>

                    <div className="h-px bg-border" />

                    <div className="flex items-center justify-between">
                      <div className="space-y-0.5">
                        <Label>Cloud backup sync</Label>
                        <p className="text-sm text-muted-foreground">
                          OneDrive, Google Drive, Proton Drive (via rclone), or iCloud
                        </p>
                      </div>
                      <Switch
                        checked={backupConfig.cloudSync}
                        onCheckedChange={(checked) =>
                          setBackupConfig({ ...backupConfig, cloudSync: checked })
                        }
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label>Provider</Label>
                        <select
                          value={backupConfig.cloudProvider ?? ""}
                          onChange={(e) =>
                            setBackupConfig({
                              ...backupConfig,
                              cloudProvider: (e.target.value || null) as BackupConfig["cloudProvider"],
                            })
                          }
                          className="w-full p-2 border rounded-md bg-background"
                        >
                          <option value="">Select provider</option>
                          <option value="one_drive">OneDrive</option>
                          <option value="google_drive">Google Drive</option>
                          <option value="proton_drive">Proton Drive</option>
                          <option value="i_cloud">iCloud</option>
                        </select>
                      </div>

                      <div className="space-y-2">
                        <Label>Cloud folder</Label>
                        <Input
                          value={backupConfig.cloudFolder}
                          onChange={(e: ChangeEvent<HTMLInputElement>) =>
                            setBackupConfig({ ...backupConfig, cloudFolder: e.target.value })
                          }
                          placeholder="NautilusBackups"
                        />
                      </div>
                    </div>

                    {backupConfig.cloudProvider === "i_cloud" ? (
                      <div className="space-y-2">
                        <Label>iCloud path (optional override)</Label>
                        <Input
                          value={backupConfig.icloudPath ?? ""}
                          onChange={(e: ChangeEvent<HTMLInputElement>) =>
                            setBackupConfig({
                              ...backupConfig,
                              icloudPath: e.target.value.trim() ? e.target.value : null,
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
                          onChange={(e: ChangeEvent<HTMLInputElement>) =>
                            setBackupConfig({
                              ...backupConfig,
                              cloudRemoteName: e.target.value.trim() ? e.target.value : null,
                            })
                          }
                          placeholder="onedrive / gdrive / protondrive"
                        />
                      </div>
                    )}

                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        disabled={backupBusy}
                        onClick={async () => {
                          setBackupBusy(true);
                          setBackupStatus(null);
                          setError(null);
                          try {
                            await saveBackupConfig(backupConfig);
                            setBackupStatus("Backup configuration saved.");
                          } catch (e) {
                            setError(e instanceof Error ? e.message : "Failed to save backup config");
                          } finally {
                            setBackupBusy(false);
                          }
                        }}
                      >
                        Save Backup Config
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
                            setBackupStatus("Cloud connection verified.");
                          } catch (e) {
                            setError(e instanceof Error ? e.message : "Cloud verification failed");
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
                                : "Cloud setup checks found issues."
                            );
                          } catch (e) {
                            setError(e instanceof Error ? e.message : "Setup checks failed");
                          } finally {
                            setBackupBusy(false);
                          }
                        }}
                      >
                        Run Setup Checks
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
                            setBackupStatus(`Backup created: ${info.id}`);
                            await refreshBackups();
                          } catch (e) {
                            setError(e instanceof Error ? e.message : "Backup failed");
                          } finally {
                            setBackupBusy(false);
                          }
                        }}
                      >
                        Create Backup Now
                      </Button>
                      <Button
                        variant="outline"
                        disabled={backupBusy || backups.length === 0 || !backupConfig.cloudSync}
                        onClick={async () => {
                          const latest = backups[0];
                          if (!latest) return;
                          setBackupBusy(true);
                          setBackupStatus(null);
                          setError(null);
                          try {
                            await saveBackupConfig(backupConfig);
                            await syncBackupToCloud(latest.id);
                            setBackupStatus(`Synced backup ${latest.id} to cloud.`);
                          } catch (e) {
                            setError(e instanceof Error ? e.message : "Cloud sync failed");
                          } finally {
                            setBackupBusy(false);
                          }
                        }}
                      >
                        Sync Latest Backup
                      </Button>
                    </div>

                    {backupStatus && <p className="text-sm text-muted-foreground">{backupStatus}</p>}
                    {backupSetupReport && (
                      <div className="rounded-lg border p-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <Label className="text-sm">Cloud setup readiness</Label>
                          <span
                            className={`text-xs font-medium ${backupSetupReport.ready ? "text-emerald-600" : "text-amber-600"
                              }`}
                          >
                            {backupSetupReport.ready ? "Ready" : "Needs action"}
                          </span>
                        </div>
                        <div className="space-y-2">
                          {backupSetupReport.checks.map((check) => (
                            <div key={check.id} className="rounded border p-2">
                              <div className="flex items-center justify-between gap-2">
                                <div className="flex items-center gap-2">
                                  {check.status === "pass" ? (
                                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                                  ) : (
                                    <XCircle className="h-4 w-4 text-amber-600" />
                                  )}
                                  <p className="text-sm font-medium">{check.label}</p>
                                </div>
                                <span className="text-xs uppercase tracking-wide text-muted-foreground">
                                  {check.status}
                                </span>
                              </div>
                              <p className="pl-6 text-xs text-muted-foreground">{check.message}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {backupConfig.cloudProvider !== "i_cloud" && (
                      <p className="text-xs text-muted-foreground">
                        For OneDrive, Google Drive, and Proton Drive, run `rclone config` first and create the remote.
                      </p>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          )}

          {activeTab === "ai" && (
            <Card>
              <CardHeader>
                <CardTitle>AI Provider & Credentials</CardTitle>
                <CardDescription>Choose your default brain provider and manage cloud keys</CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="space-y-2">
                  <Label>Default analysis provider</Label>
                  <select
                    value={settings.privacy.llmProvider}
                    onChange={(event) =>
                      void updateSettings({
                        ...settings,
                        privacy: { ...settings.privacy, llmProvider: event.target.value },
                      })
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
                  {!settings.privacy.remoteProcessingEnabled && settings.privacy.llmProvider !== "ollama" ? (
                    <p className="text-xs text-amber-600">
                      Remote provider selected but remote processing is disabled.
                    </p>
                  ) : null}
                </div>

                <div className="space-y-2">
                  <Label className="flex items-center gap-2">
                    Analysis model
                    {modelsLoading && <Loader2 className="h-3 w-3 animate-spin" />}
                  </Label>

                  {settings.privacy.llmProvider === "ollama" ? (
                    ollamaModels.length > 0 ? (
                      <select
                        value={settings.privacy.llmModelId ?? ollamaModels[0] ?? ""}
                        onChange={(e) =>
                          void updateSettings({
                            ...settings,
                            privacy: { ...settings.privacy, llmModelId: e.target.value || null },
                          })
                        }
                        className="w-full p-2 border rounded-md bg-background"
                      >
                        {ollamaModels.map((model) => (
                          <option key={model} value={model}>{model}</option>
                        ))}
                      </select>
                    ) : (
                      <div className="p-3 rounded border bg-muted/30 text-sm">
                        <p className="text-muted-foreground">No Ollama models found. Run <code className="bg-muted px-1 rounded">ollama pull llama3.2</code> to download a model.</p>
                      </div>
                    )
                  ) : settings.privacy.llmProvider === "openai" ? (
                    openaiModels.length > 0 ? (
                      <select
                        value={settings.privacy.llmModelId ?? openaiModels[0]}
                        onChange={(e) =>
                          void updateSettings({
                            ...settings,
                            privacy: { ...settings.privacy, llmModelId: e.target.value || null },
                          })
                        }
                        className="w-full p-2 border rounded-md bg-background"
                      >
                        {openaiModels
                          .filter(m => m.includes("gpt") || m.includes("o1") || m.includes("o3") || m.includes("o4"))
                          .sort()
                          .map((model) => (
                            <option key={model} value={model}>{model}</option>
                          ))}
                      </select>
                    ) : (
                      <div className="p-3 rounded border bg-amber-50 dark:bg-amber-950/20 text-sm">
                        <p className="text-amber-700 dark:text-amber-400">Enter your OpenAI API key above to fetch available models.</p>
                      </div>
                    )
                  ) : settings.privacy.llmProvider === "anthropic" ? (
                    anthropicModels.length > 0 ? (
                      <select
                        value={settings.privacy.llmModelId ?? anthropicModels[0]}
                        onChange={(e) =>
                          void updateSettings({
                            ...settings,
                            privacy: { ...settings.privacy, llmModelId: e.target.value || null },
                          })
                        }
                        className="w-full p-2 border rounded-md bg-background"
                      >
                        {anthropicModels.map((model) => (
                          <option key={model} value={model}>{model}</option>
                        ))}
                      </select>
                    ) : (
                      <div className="p-3 rounded border bg-amber-50 dark:bg-amber-950/20 text-sm">
                        <p className="text-amber-700 dark:text-amber-400">Enter your Anthropic API key above to fetch available models.</p>
                      </div>
                    )
                  ) : settings.privacy.llmProvider === "gemini" ? (
                    geminiModels.length > 0 ? (
                      <select
                        value={settings.privacy.llmModelId ?? geminiModels[0].replace("models/", "")}
                        onChange={(e) =>
                          void updateSettings({
                            ...settings,
                            privacy: { ...settings.privacy, llmModelId: e.target.value || null },
                          })
                        }
                        className="w-full p-2 border rounded-md bg-background"
                      >
                        {geminiModels
                          .map(m => m.replace("models/", ""))
                          .filter(m => m.includes("gemini"))
                          .map((model) => (
                            <option key={model} value={model}>{model}</option>
                          ))}
                      </select>
                    ) : (
                      <div className="p-3 rounded border bg-amber-50 dark:bg-amber-950/20 text-sm">
                        <p className="text-amber-700 dark:text-amber-400">Enter your Google AI API key above to fetch available models.</p>
                      </div>
                    )
                  ) : settings.privacy.llmProvider === "deepseek" ? (
                    deepseekModels.length > 0 ? (
                      <select
                        value={settings.privacy.llmModelId ?? deepseekModels[0]}
                        onChange={(e) =>
                          void updateSettings({
                            ...settings,
                            privacy: { ...settings.privacy, llmModelId: e.target.value || null },
                          })
                        }
                        className="w-full p-2 border rounded-md bg-background"
                      >
                        {deepseekModels.map((model) => (
                          <option key={model} value={model}>{model}</option>
                        ))}
                      </select>
                    ) : (
                      <div className="p-3 rounded border bg-amber-50 dark:bg-amber-950/20 text-sm">
                        <p className="text-amber-700 dark:text-amber-400">Enter your DeepSeek API key above to fetch available models.</p>
                      </div>
                    )
                  ) : settings.privacy.llmProvider === "ollama-cloud" ? (
                    ollamaCloudModels.length > 0 ? (
                      <select
                        value={settings.privacy.llmModelId ?? ollamaCloudModels[0]}
                        onChange={(e) =>
                          void updateSettings({
                            ...settings,
                            privacy: { ...settings.privacy, llmModelId: e.target.value || null },
                          })
                        }
                        className="w-full p-2 border rounded-md bg-background"
                      >
                        {ollamaCloudModels.map((model) => (
                          <option key={model} value={model}>{model}</option>
                        ))}
                      </select>
                    ) : (
                      <div className="p-3 rounded border bg-amber-50 dark:bg-amber-950/20 text-sm">
                        <p className="text-amber-700 dark:text-amber-400">Enter your Ollama Cloud API key above to fetch available models.</p>
                      </div>
                    )
                  ) : (
                    <div className="p-3 rounded border bg-muted/30 text-sm">
                      <p className="text-muted-foreground">Select a provider to see available models.</p>
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {settings.privacy.llmProvider === "ollama" && ollamaModels.length === 0
                      ? "Download models via Ollama CLI or pull button below."
                      : settings.privacy.llmProvider !== "ollama" &&
                        ["openai", "anthropic", "gemini", "deepseek", "ollama-cloud"].includes(settings.privacy.llmProvider) &&
                        !hasApiKey && settings.privacy.llmProvider === provider
                        ? "Add your API key above to fetch available models."
                        : "Models fetched from provider API."}
                  </p>
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Remote processing policy</Label>
                    <p className="text-xs text-muted-foreground">
                      Controls whether transcript text can be sent to cloud LLMs.
                    </p>
                  </div>
                  <Switch
                    checked={settings.privacy.remoteProcessingEnabled}
                    onCheckedChange={(checked) =>
                      void updateSettings({
                        ...settings,
                        privacy: { ...settings.privacy, remoteProcessingEnabled: checked },
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
                      Models: {ollamaModels.length > 0 ? ollamaModels.join(", ") : "No local models detected"}
                    </p>
                  </div>
                )}

                <div className="h-px bg-border" />

                <div className="space-y-2">
                  <Label>Credential provider</Label>
                  <div className="flex gap-2 items-center">
                    <select
                      value={provider}
                      onChange={(e) => {
                        const next = e.target.value;
                        setProvider(next);
                        // Persist provider selection to settings so it survives restarts
                        if (settings) {
                          updateSettings({
                            ...settings,
                            privacy: { ...settings.privacy, llmProvider: next },
                          });
                        }
                        // Immediately refresh model list for the newly selected provider
                        void refreshModelsForProvider(next);
                      }}
                      className="flex-1 p-2 border rounded-md bg-background"
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
                        console.log(`[DEBUG] Refresh clicked. Key len: ${apiKey.length}. Provider: ${provider}`);
                        if (apiKey.trim()) {
                          // If user typed a key but didn't save, save it now!
                          setSavingApiKey(true);
                          try {
                            await setProviderSecret(provider, apiKey.trim());
                            setApiKey("");
                            setHasApiKey(true);
                          } catch (e) {
                            console.error("Failed to save key on refresh", e);
                          } finally {
                            setSavingApiKey(false);
                          }
                        }
                        void refreshModelsForProvider(provider);
                      }}
                      disabled={modelsLoading || savingApiKey}
                    >
                      {modelsLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                    </Button>
                  </div>
                  {!settings.privacy.remoteProcessingEnabled ? (
                    <p className="text-xs text-amber-600">
                      Remote processing is disabled. Stored cloud keys will not be used until policy is enabled.
                    </p>
                  ) : null}
                  {settings.privacy.llmProvider === provider && settings.privacy.remoteProcessingEnabled && !hasApiKey ? (
                    <p className="text-xs text-amber-600">
                      Selected analysis provider has no stored key. Analysis requests will fail with a credential error.
                    </p>
                  ) : null}
                </div>

                <div className="space-y-2">
                  <Label>API key</Label>
                  <Input
                    type="password"
                    placeholder={hasApiKey ? "Key already stored (enter to replace)" : "Enter API key"}
                    value={apiKey}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => setApiKey(e.target.value)}
                    onKeyDown={async (e) => {
                      if (e.key === "Enter" && apiKey.trim()) {
                        console.log(`[DEBUG] Enter pressed. Saving key.`);
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
                          setError(e instanceof Error ? e.message : "Failed to save API key");
                        } finally {
                          setSavingApiKey(false);
                        }
                      }
                    }}
                  />
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    onClick={async () => {
                      if (!apiKey.trim()) return;
                      console.log(`[DEBUG] Save Key clicked. Saving key.`);
                      setSavingApiKey(true);
                      setError(null);
                      try {
                        await setProviderSecret(provider, apiKey.trim());
                        setApiKey("");
                        setHasApiKey(true);
                        // Refresh models for this provider after saving key
                        await refreshModelsForProvider(provider);
                      } catch (e) {
                        setError(e instanceof Error ? e.message : "Failed to save API key");
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
                        setError(e instanceof Error ? e.message : "Failed to clear API key");
                      } finally {
                        setSavingApiKey(false);
                      }
                    }}
                    disabled={savingApiKey}
                  >
                    Clear Key
                  </Button>
                  {hasApiKey && <span className="text-sm text-muted-foreground">Stored securely</span>}
                </div>

                <div className="h-px bg-border" />

                <div className="space-y-2">
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
                        const keyPresent = await hasProviderSecret(provider);
                        if (!keyPresent) {
                          checks.push(`No API key stored for ${provider}.`);
                        }
                        if (checks.length === 0) {
                          setCloudReadinessMessage("Cloud readiness checks passed.");
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
                            "Enable remote processing? This allows transcript text to be sent to cloud providers."
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
                            { immediate: true }
                          );
                          setCloudReadinessMessage("Remote processing enabled. Run readiness check again.");
                        }}
                      >
                        Enable Remote Processing (Opt-in)
                      </Button>
                    )}
                  </div>
                  {cloudReadinessMessage ? (
                    <p className="text-xs text-muted-foreground">{cloudReadinessMessage}</p>
                  ) : null}
                </div>
              </CardContent>
            </Card>
          )}

          {activeTab === "updates" && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <RefreshCw className="h-5 w-5 text-blue-600" />
                  Updates
                </CardTitle>
                <CardDescription>Check for and install app updates</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <UpdateStatusWidget />
                <BetaChannelToggle />
              </CardContent>
            </Card>
          )}

          {activeTab === "license" && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Shield className="h-5 w-5 text-emerald-600" />
                  License
                </CardTitle>
                <CardDescription>Lemon Squeezy license · 1 user · up to {licenseInfo?.tier === "friends_club" ? 10 : 5} computers</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {licenseInfo === null ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Checking license…
                  </div>
                ) : licenseInfo.valid ? (
                  <>
                    <div className={`rounded-lg border p-4 space-y-3 ${licenseInfo.tier === "friends_club"
                      ? "border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800"
                      : "border-emerald-200 bg-emerald-50 dark:bg-emerald-950/20 dark:border-emerald-800"
                      }`}>
                      <div className="flex items-center gap-2">
                        {licenseInfo.tier === "friends_club" ? (
                          <Star className="h-5 w-5 text-amber-500" />
                        ) : (
                          <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                        )}
                        <span className={`font-semibold ${licenseInfo.tier === "friends_club"
                          ? "text-amber-700 dark:text-amber-400"
                          : "text-emerald-700 dark:text-emerald-400"
                          }`}>
                          {licenseInfo.tier === "friends_club" ? "Friends Club ⭐" : "Basic"}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-sm">
                        <span className="text-muted-foreground">Key</span>
                        <span className="font-mono text-xs truncate">{licenseInfo.key.slice(0, 8)}···</span>
                        <span className="text-muted-foreground">Devices</span>
                        <span>{licenseInfo.activationsUsage} of {licenseInfo.activationsLimit} used</span>
                        {licenseInfo.lastValidatedAt && (
                          <>
                            <span className="text-muted-foreground">Last validated</span>
                            <span>{new Date(licenseInfo.lastValidatedAt).toLocaleDateString()}</span>
                          </>
                        )}
                        <span className="text-muted-foreground">Plan</span>
                        <span>Lifetime</span>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => { setLicenseInfo(null); }}
                      >
                        Re-check
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-destructive hover:bg-destructive/10"
                        onClick={() => {
                          if (!window.confirm("Deactivate Nautilus on this computer? You can reactivate later.")) return;
                          void deactivateLicense().then(() => { setLicenseInfo(null); void validateLicense().then(setLicenseInfo); });
                        }}
                      >
                        Deactivate this device
                      </Button>
                    </div>
                  </>
                ) : licenseInfo.trialDaysRemaining > 0 ? (
                  <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-2">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <XCircle className="h-4 w-4 text-muted-foreground" />
                      <span>Free trial · {licenseInfo.trialDaysRemaining} days remaining</span>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5"
                      onClick={() => window.open("https://nautilusbot.lemonsqueezy.com/buy/basic", "_blank", "noopener,noreferrer")}
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      Buy a license — $8 lifetime
                    </Button>
                  </div>
                ) : (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800 p-4 space-y-3">
                    <p className="text-sm text-amber-700 dark:text-amber-400 font-medium">Trial expired</p>
                    <p className="text-xs text-muted-foreground">Enter a license key in Settings → License, or buy one below.</p>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => window.open("https://nautilusbot.lemonsqueezy.com/buy/basic", "_blank", "noopener,noreferrer")}
                      >
                        <ExternalLink className="mr-1 h-3.5 w-3.5" />
                        Buy Basic
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-amber-300/60 text-amber-700 dark:text-amber-400"
                        onClick={() => window.open("https://nautilusbot.lemonsqueezy.com/buy/friends-club", "_blank", "noopener,noreferrer")}
                      >
                        <ExternalLink className="mr-1 h-3.5 w-3.5" />
                        Friends Club ⭐
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {isSaving && (
            <div className="text-sm text-muted-foreground">Saving settings...</div>
          )}
          {!isSaving && hasUnsavedChanges && (
            <div className="text-sm text-muted-foreground">Changes queued for save...</div>
          )}
        </div>
      </div>
    </div>
  );
}
