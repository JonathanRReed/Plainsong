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
  migrateToEncryptedStorage,
  openPermissionSettings,
  saveSettings,
  saveBackupConfig,
  setProviderSecret,
  syncBackupToCloud,
  unlockVault,
  verifyBackupCloudConnection,
} from "@/lib/tauri";
import type { BackupConfig, BackupInfo, CloudSetupReport, SecurityStatus } from "@/lib/tauri";
import type { PermissionDiagnostics } from "@/lib/tauri";
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
  XCircle,
  Loader2,
} from "lucide-react";

type TabId = "asr" | "general" | "security" | "storage" | "ai";
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
  const [hasLoadedSecurityTab, setHasLoadedSecurityTab] = useState(false);
  const [hasLoadedStorageTab, setHasLoadedStorageTab] = useState(false);
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
        const [loaded, loadedBackupConfig] = await Promise.all([
          getSettings(),
          getBackupConfig(),
        ]);
        if (mountedRef.current) {
          setDraftSettings(loaded);
          setPersistedSettings(loaded);
          setBackupConfig(loadedBackupConfig);
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
    let mounted = true;
    hasProviderSecret(provider)
      .then((value) => {
        if (mounted) {
          setHasApiKey(value);
        }
      })
      .catch(() => {
        if (mounted) {
          setHasApiKey(false);
        }
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
    if (!settings) return;
    const llmProvider = settings.privacy.llmProvider;
    if (llmProvider === "openai" || llmProvider === "anthropic" || llmProvider === "gemini" || llmProvider === "ollama-cloud") {
      setProvider(llmProvider);
    }
  }, [settings?.privacy.llmProvider]);

  useEffect(() => {
    if (activeTab !== "ai") {
      return;
    }
    let mounted = true;
    const loadOllama = async () => {
      try {
        const [available, models] = await Promise.all([
          getOllamaStatus(),
          listOllamaModels().catch(() => []),
        ]);
        if (mounted) {
          setOllamaAvailable(available);
          setOllamaModels(models);
        }
      } catch {
        if (mounted) {
          setOllamaAvailable(false);
          setOllamaModels([]);
        }
      }
    };
    void loadOllama();
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

          <div className="grid w-full grid-cols-5 bg-muted p-1 rounded-md">
            {tabList.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center justify-center gap-2 px-3 py-1.5 text-sm font-medium rounded-sm transition-all ${
                  activeTab === tab.id
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

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Automatic speaker naming</Label>
                    <p className="text-sm text-muted-foreground">
                      Run diarization and label speakers after transcription
                    </p>
                  </div>
                  <Switch
                    checked={settings.transcription.enableDiarization}
                    onCheckedChange={(checked) =>
                      void updateSettings({
                        ...settings,
                        transcription: { ...settings.transcription, enableDiarization: checked },
                      })
                    }
                  />
                </div>

                <div className="space-y-2">
                  <Label>Default local model</Label>
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
                    <option value="base.en">Whisper base.en</option>
                    <option value="large-v3">Whisper large-v3</option>
                    <option value="large-v3-turbo">Whisper large-v3-turbo</option>
                  </select>
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
                    <Label>Cloud sync</Label>
                    <p className="text-sm text-muted-foreground">Enable external backup sync integrations</p>
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
                            className={`text-xs font-medium ${
                              backupSetupReport.ready ? "text-emerald-600" : "text-amber-600"
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
                  <select
                    value={provider}
                    onChange={(e) => setProvider(e.target.value)}
                    className="w-full p-2 border rounded-md bg-background"
                  >
                    <option value="openai">OpenAI</option>
                    <option value="anthropic">Anthropic</option>
                    <option value="gemini">Google Gemini</option>
                    <option value="ollama-cloud">Ollama Cloud</option>
                  </select>
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
                  />
                </div>

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
