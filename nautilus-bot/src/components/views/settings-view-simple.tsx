import { useEffect, useMemo, useState, type ChangeEvent } from "react";
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
  getBackupSetupReport,
  getSettings,
  hasProviderSecret,
  listBackups,
  saveSettings,
  saveBackupConfig,
  setProviderSecret,
  syncBackupToCloud,
  verifyBackupCloudConnection,
} from "@/lib/tauri";
import type { BackupConfig, BackupInfo, CloudSetupReport } from "@/lib/tauri";
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

export function SettingsView() {
  const { theme, setTheme } = useTheme();
  const [activeTab, setActiveTab] = useState<TabId>("general");
  const [settings, setSettings] = useState<Settings | null>(null);
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

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        const loaded = await getSettings();
        const loadedBackupConfig = await getBackupConfig();
        const loadedBackups = await listBackups();
        if (mounted) {
          setSettings(loaded);
          setBackupConfig(loadedBackupConfig);
          setBackups(loadedBackups);
        }
      } catch (e) {
        if (mounted) {
          setError(e instanceof Error ? e.message : "Failed to load settings");
        }
      }
    };
    load();
    return () => {
      mounted = false;
    };
  }, []);

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

  const updateSettings = async (next: Settings) => {
    setSettings(next);
    setIsSaving(true);
    setError(null);
    try {
      await saveSettings(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save settings");
    } finally {
      setIsSaving(false);
    }
  };

  const refreshBackups = async () => {
    const data = await listBackups();
    setBackups(data);
  };

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
                      Allow cloud providers for transcription/analysis
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
                <CardTitle>Provider Credentials</CardTitle>
                <CardDescription>Secrets are stored in OS secure credential storage</CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="space-y-2">
                  <Label>Provider</Label>
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
              </CardContent>
            </Card>
          )}

          {isSaving && (
            <div className="text-sm text-muted-foreground">Saving settings...</div>
          )}
        </div>
      </div>
    </div>
  );
}
