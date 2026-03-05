import { useState, useEffect, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";
import { normalizeDownloadStatus } from "@/lib/download-status";
import { getProviderSelectionStatus } from "@/lib/asr-provider-selection";
import {
  refreshAsrRuntimeProbes,
  repairLocalModelCache,
  getSettings,
  saveSettings,
} from "@/lib/tauri";
import { invoke } from "@tauri-apps/api/core";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type {
  AsrBenchmarkEntry,
  PlatformOptimizationSettings,
  AsrProviderInfo,
  AsrProviderType,
  BenchmarkResult,
} from "@/types";
import {
  Download,
  Check,
  AlertCircle,
  Cpu,
  Globe,
  Clock,
  BarChart3,
  FileAudio,
  Zap,
  CloudLightning,
  Moon,
  Mic
} from "lucide-react";

interface AsrProviderManagerProps {
  className?: string;
}

export function AsrProviderManager({
  className,
}: AsrProviderManagerProps) {
  const [providers, setProviders] = useState<AsrProviderInfo[]>([]);
  const [defaultProvider, setDefaultProvider] = useState<AsrProviderType>("whisper");
  const [isLoading, setIsLoading] = useState(false);
  const [benchmarkResults, setBenchmarkResults] = useState<BenchmarkResult[]>([]);
  const [benchmarkHistory, setBenchmarkHistory] = useState<AsrBenchmarkEntry[]>([]);
  const [benchmarkFileName, setBenchmarkFileName] = useState<string | null>(null);
  const [isBenchmarking, setIsBenchmarking] = useState(false);
  const [providerErrors, setProviderErrors] = useState<Record<string, string>>({});
  const [downloadProgress, setDownloadProgress] = useState<Record<string, number>>({});
  const [repairingCache, setRepairingCache] = useState(false);
  const [repairSummary, setRepairSummary] = useState<string | null>(null);
  const [platformSettings, setPlatformSettings] = useState<PlatformOptimizationSettings | null>(null);
  const [platformSaveBusy, setPlatformSaveBusy] = useState(false);
  const [platformSaveError, setPlatformSaveError] = useState<string | null>(null);
  const benchmarkFileInputRef = useRef<HTMLInputElement | null>(null);

  const manualEngineOptions = [
    { value: "provider_default", label: "Provider default" },
    { value: "macos_mlx_sidecar", label: "macOS MLX sidecar" },
    { value: "macos_apple_speech", label: "macOS Apple Speech" },
    { value: "windows_foundry_local", label: "Windows Foundry Local" },
    { value: "windows_sdk_dictation", label: "Windows SDK dictation" },
  ] as const;

  const defaultPlatformSettings = (): PlatformOptimizationSettings => ({
    mode: "auto",
    fallbackPolicy: "local_only",
    macos: {
      appleNativeEnabled: false,
      mlxEnabled: true,
    },
    windows: {
      foundryEnabled: false,
      windowsSdkDictationEnabled: false,
    },
    manualEnginePriority: [],
  });

  const normalizeManualEnginePriority = (priority: string[]): string[] => {
    const validIds = new Set<string>(manualEngineOptions.map((option) => option.value));
    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const id of priority) {
      if (!validIds.has(id) || seen.has(id)) continue;
      seen.add(id);
      normalized.push(id);
    }
    return normalized;
  };

  const withNormalizedManualPriority = (
    settings: PlatformOptimizationSettings
  ): PlatformOptimizationSettings => ({
    ...settings,
    manualEnginePriority: normalizeManualEnginePriority(settings.manualEnginePriority ?? []),
  });

  const withExclusiveNativeEngine = (
    settings: PlatformOptimizationSettings,
    engineId: "macos_apple_speech" | "windows_sdk_dictation"
  ): PlatformOptimizationSettings => ({
    ...settings,
    mode: "manual",
    fallbackPolicy: "fail_fast",
    manualEnginePriority: [engineId],
  });

  const activeExclusiveNativeEngineId = platformSettings
    ? platformSettings.macos.appleNativeEnabled
      ? "macos_apple_speech"
      : platformSettings.windows.windowsSdkDictationEnabled
        ? "windows_sdk_dictation"
        : null
    : null;

  const activeExclusiveNativeEngineLabel =
    activeExclusiveNativeEngineId === "macos_apple_speech"
      ? "macOS Apple Speech"
      : activeExclusiveNativeEngineId === "windows_sdk_dictation"
        ? "Windows SDK dictation"
        : null;

  const readyEngineIds = useMemo(() => {
    const ids = new Set<string>();
    for (const provider of providers) {
      for (const engineId of provider.engineDiagnostics?.availableEngines ?? []) {
        ids.add(engineId);
      }
    }
    return ids;
  }, [providers]);
  const appleNativeEngineReady = readyEngineIds.has("macos_apple_speech");
  const windowsSdkEngineReady = readyEngineIds.has("windows_sdk_dictation");

  useEffect(() => {
    if (!platformSettings || providers.length === 0) return;

    let next = platformSettings;
    let changed = false;

    if (next.macos.appleNativeEnabled && !appleNativeEngineReady) {
      const nextPriority = next.manualEnginePriority.filter((engine) => engine !== "macos_apple_speech");
      next = {
        ...next,
        macos: {
          ...next.macos,
          appleNativeEnabled: false,
        },
        mode: nextPriority.length === 0 ? "auto" : next.mode,
        fallbackPolicy: nextPriority.length === 0 ? "local_only" : next.fallbackPolicy,
        manualEnginePriority: nextPriority,
      };
      changed = true;
    }

    if (next.windows.windowsSdkDictationEnabled && !windowsSdkEngineReady) {
      const nextPriority = next.manualEnginePriority.filter(
        (engine) => engine !== "windows_sdk_dictation"
      );
      next = {
        ...next,
        windows: {
          ...next.windows,
          windowsSdkDictationEnabled: false,
        },
        mode: nextPriority.length === 0 ? "auto" : next.mode,
        fallbackPolicy: nextPriority.length === 0 ? "local_only" : next.fallbackPolicy,
        manualEnginePriority: nextPriority,
      };
      changed = true;
    }

    if (changed) {
      void persistPlatformSettings(next);
    }
  }, [
    appleNativeEngineReady,
    windowsSdkEngineReady,
    platformSettings,
    providers.length,
  ]);

  useEffect(() => {
    loadProviders();
    loadDefaultProvider();
    loadBenchmarkHistory();
    loadPlatformSettings();

    // Listen for download progress events
    import("@tauri-apps/api/event").then(({ listen }) => {
      const unlisten = listen<[AsrProviderType, number]>("asr-download-progress", (event) => {
        const [providerType, progress] = event.payload;
        setDownloadProgress((prev) => ({ ...prev, [providerType]: progress }));
      });
      return unlisten;
    }).then(() => {
      // Cleanup if component unmounts - simpler to just let it leak in this top-level component 
      // or store unlisten function in a ref if strictly needed. 
      // For now, this is acceptable for a main view component.
    });
  }, []);

  const loadPlatformSettings = async () => {
    try {
      const settings = await getSettings();
      setPlatformSettings(
        withNormalizedManualPriority(
          settings.transcription.platformOptimization ?? defaultPlatformSettings()
        )
      );
    } catch (error) {
      console.error("Failed to load platform optimization settings:", error);
      setPlatformSettings(defaultPlatformSettings());
    }
  };

  const persistPlatformSettings = async (next: PlatformOptimizationSettings) => {
    const normalizedNext = withNormalizedManualPriority(next);
    setPlatformSaveBusy(true);
    setPlatformSaveError(null);
    try {
      const settings = await getSettings();
      await saveSettings({
        ...settings,
        transcription: {
          ...settings.transcription,
          platformOptimization: normalizedNext,
        },
      });
      setPlatformSettings(normalizedNext);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPlatformSaveError(message);
    } finally {
      setPlatformSaveBusy(false);
    }
  };

  const loadProviders = async () => {
    try {
      const data = await invoke<AsrProviderInfo[]>("get_asr_providers");
      // Model options are already included in provider info - no need for extra API calls
      setProviders(data);
    } catch (error) {
      console.error("Failed to load ASR providers:", error);
    }
  };

  const loadDefaultProvider = async () => {
    try {
      const provider = await invoke<AsrProviderType>("get_default_asr_provider");
      setDefaultProvider(provider);
    } catch (error) {
      console.error("Failed to load default provider:", error);
    }
  };

  const handleSetDefault = async (providerType: AsrProviderType) => {
    const selected = providers.find((provider) => provider.providerType === providerType);
    if (!selected?.inferenceEnabled) {
      console.warn(`${providerType} is not enabled for inference in this build`);
      return;
    }

    try {
      await invoke("set_default_asr_provider", { providerType });
      setDefaultProvider(providerType);
      setProviderErrors((previous) => {
        const next = { ...previous };
        delete next[providerType];
        return next;
      });
    } catch (error) {
      console.error("Failed to set default provider:", error);
      const message = error instanceof Error ? error.message : String(error);
      setProviderErrors((previous) => ({
        ...previous,
        [providerType]: message.replace(/^Error invoking command '[^']+':\s*/i, ""),
      }));
    }
  };

  const handleDownload = async (providerType: AsrProviderType) => {
    setIsLoading(true);
    setDownloadProgress((prev) => ({ ...prev, [providerType]: 0 }));
    setProviderErrors((prev) => {
      const next = { ...prev };
      delete next[providerType];
      return next;
    });

    try {
      await invoke("download_asr_models", { providerType });
      await loadProviders();
    } catch (error) {
      console.error("Failed to download models:", error);
      const message = error instanceof Error ? error.message : String(error);
      setProviderErrors((prev) => ({
        ...prev,
        [providerType]: message,
      }));
    } finally {
      // Clear progress on completion (success or failure)
      setDownloadProgress((prev) => {
        const next = { ...prev };
        delete next[providerType];
        return next;
      });
      setIsLoading(false);
    }
  };

  const handleModelChange = async (providerType: AsrProviderType, modelId: string) => {
    try {
      await invoke("set_asr_provider_model", { providerType, modelId });
      setProviders((prev) =>
        prev.map((provider) =>
          provider.providerType === providerType
            ? {
              ...provider,
              selectedModelId: modelId,
            }
            : provider
        )
      );
      await loadProviders();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setProviderErrors((previous) => ({
        ...previous,
        [providerType]: message,
      }));
    }
  };

  const runBenchmark = async () => {
    const selectedFile = benchmarkFileInputRef.current?.files?.[0];
    if (!selectedFile) {
      console.warn("No benchmark audio file selected");
      return;
    }
    const isWav = selectedFile.name.toLowerCase().endsWith(".wav");
    if (!isWav) {
      console.warn("Benchmark requires WAV audio");
      return;
    }

    setIsBenchmarking(true);
    try {
      const fileBytes = new Uint8Array(await selectedFile.arrayBuffer());
      const results = await invoke<BenchmarkResult[]>("benchmark_asr_providers_bytes", {
        audioBytes: Array.from(fileBytes),
      });
      setBenchmarkResults(results);
      await loadBenchmarkHistory();
    } catch (error) {
      console.error("Benchmark failed:", error);
    } finally {
      setIsBenchmarking(false);
    }
  };

  const loadBenchmarkHistory = async () => {
    try {
      const history = await invoke<AsrBenchmarkEntry[]>("list_asr_benchmarks", { limit: 20 });
      setBenchmarkHistory(history);
    } catch (error) {
      console.error("Failed to load benchmark history:", error);
    }
  };

  const getProviderIcon = (type: AsrProviderType) => {
    switch (type) {
      case "whisper":
        return <Globe className="h-5 w-5" />;
      case "distil_whisper":
        return <Zap className="h-5 w-5" />;
      case "moonshine":
        return <Moon className="h-5 w-5" />;
      case "voxtral":
        return <Mic className="h-5 w-5" />;
      case "openai_cloud":
      case "elevenlabs_scribe":
        return <CloudLightning className="h-5 w-5" />;
      default:
        return <Cpu className="h-5 w-5" />;
    }
  };

  const getDownloadStatusBadge = (provider: AsrProviderInfo) => {
    const normalizedStatus = normalizeDownloadStatus(provider.downloadStatus);
    const activeProgress = downloadProgress[provider.providerType];

    // Show progress bar if we have active progress and not yet fully downloaded/updated
    if (activeProgress !== undefined && normalizedStatus.kind !== "downloaded") {
      return (
        <div className="flex items-center gap-2">
          <Progress value={activeProgress} className="w-20 h-2" />
          <span className="text-xs text-muted-foreground">{activeProgress.toFixed(0)}%</span>
        </div>
      );
    }

    switch (normalizedStatus.kind) {
      case "downloaded":
        return (
          <Badge variant="default" className="bg-green-600">
            <Check className="h-3 w-3 mr-1" />
            Ready
          </Badge>
        );
      case "not_downloaded":
        return (
          <Badge variant="secondary">
            <Download className="h-3 w-3 mr-1" />
            Download Required
          </Badge>
        );
      case "downloading": {
        // Fallback if backend says downloading but we missed events?
        const progress = normalizedStatus.progress ?? 0;
        return (
          <div className="flex items-center gap-2">
            <Progress value={progress} className="w-20 h-2" />
            <span className="text-xs text-muted-foreground">{progress.toFixed(0)}%</span>
          </div>
        );
      }
      case "error":
        return (
          <Badge variant="destructive">
            <AlertCircle className="h-3 w-3 mr-1" />
            Error
          </Badge>
        );
      default:
        return null;
    }
  };

  const isNotDownloaded = (status: AsrProviderInfo["downloadStatus"]): boolean => {
    return normalizeDownloadStatus(status).kind === "not_downloaded";
  };

  const providerSetupCommand = (providerType: AsrProviderType): string => {
    switch (providerType) {
      case "parakeet":
        return "Use the Download button to fetch encoder.onnx + tokens.txt (no Python needed)";
      case "canary":
        return "Use the Download button to fetch the Whisper Large V3 Turbo model (no Python needed)";
      case "distil_whisper":
        return "Use the Download button to fetch the Distil-Whisper Large v3.5 model (no Python needed)";
      case "moonshine":
        return "Use the Download button to fetch the Moonshine ONNX model (no Python needed)";
      case "voxtral":
        return "Choose Voxtral local/cloud mode. Local mode requires Python (torch, transformers, librosa, soundfile) plus downloaded model assets. Cloud mode requires MISTRAL_API_KEY.";
      case "elevenlabs_scribe":
        return "Add an ElevenLabs API key in Settings → API Keys";
      case "openai_cloud":
        return "Add an OpenAI API key in Settings → API Keys";
      default:
        return "Use the Download button to fetch the model (no Python needed)";
    }
  };

  const copySetupCommand = async (providerType: AsrProviderType) => {
    try {
      await navigator.clipboard.writeText(providerSetupCommand(providerType));
    } catch (error) {
      console.error("Failed to copy setup command:", error);
    }
  };

  const handleRepairLocalCache = async () => {
    setRepairingCache(true);
    setRepairSummary(null);
    try {
      const report = await repairLocalModelCache();
      await refreshAsrRuntimeProbes();
      await loadProviders();
      const removed = report.removedPaths.length;
      if (removed > 0) {
        setRepairSummary(`Removed ${removed} invalid artifact${removed === 1 ? "" : "s"}.`);
      } else {
        setRepairSummary("No invalid artifacts found.");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRepairSummary(`Repair failed: ${message}`);
    } finally {
      setRepairingCache(false);
    }
  };

  return (
    <div className={cn("space-y-6", className)}>
      <Tabs defaultValue="providers" className="space-y-4">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="providers">Providers</TabsTrigger>
          <TabsTrigger value="benchmark">Benchmark</TabsTrigger>
        </TabsList>

        <TabsContent value="providers" className="space-y-4">
          {platformSettings ? (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Platform Optimization (Advanced)</CardTitle>
                <CardDescription>
                  Optional macOS/Windows runtime optimizations. Apple/Windows native toggles enforce an
                  exclusive engine route.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="space-y-1 text-sm">
                    <span className="text-muted-foreground">Mode</span>
                    <select
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                      value={platformSettings.mode}
                      disabled={platformSaveBusy}
                      onChange={(event) => {
                        const next: PlatformOptimizationSettings = {
                          ...platformSettings,
                          mode: event.target.value as "auto" | "manual",
                        };
                        void persistPlatformSettings(next);
                      }}
                    >
                      <option value="auto">Auto</option>
                      <option value="manual">Manual</option>
                    </select>
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="text-muted-foreground">Fallback policy</span>
                    <select
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                      value={platformSettings.fallbackPolicy}
                      disabled={platformSaveBusy}
                      onChange={(event) => {
                        const next: PlatformOptimizationSettings = {
                          ...platformSettings,
                          fallbackPolicy: event.target.value as
                            | "local_only"
                            | "allow_cloud"
                            | "fail_fast",
                        };
                        void persistPlatformSettings(next);
                      }}
                    >
                      <option value="local_only">Local only</option>
                      <option value="allow_cloud">Allow cloud</option>
                      <option value="fail_fast">Fail fast</option>
                    </select>
                  </label>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <label className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                    <span>macOS Apple Speech engine</span>
                    <input
                      type="checkbox"
                      checked={platformSettings.macos.appleNativeEnabled}
                      disabled={
                        platformSaveBusy || (!platformSettings.macos.appleNativeEnabled && !appleNativeEngineReady)
                      }
                      onChange={(event) => {
                        let next: PlatformOptimizationSettings = {
                          ...platformSettings,
                          macos: {
                            ...platformSettings.macos,
                            appleNativeEnabled: event.target.checked,
                          },
                        };
                        if (event.target.checked) {
                          if (!appleNativeEngineReady) {
                            setPlatformSaveError(
                              "macOS Apple Speech native transcription is not available in this build yet."
                            );
                            return;
                          }
                          next = withExclusiveNativeEngine(next, "macos_apple_speech");
                        } else {
                          const nextPriority = next.manualEnginePriority.filter(
                            (engine) => engine !== "macos_apple_speech"
                          );
                          next = {
                            ...next,
                            mode: nextPriority.length === 0 ? "auto" : next.mode,
                            fallbackPolicy: nextPriority.length === 0 ? "local_only" : next.fallbackPolicy,
                            manualEnginePriority: nextPriority,
                          };
                        }
                        void persistPlatformSettings(next);
                      }}
                    />
                  </label>
                  <label className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                    <span>macOS MLX sidecar optimization</span>
                    <input
                      type="checkbox"
                      checked={platformSettings.macos.mlxEnabled}
                      disabled={platformSaveBusy}
                      onChange={(event) => {
                        const next: PlatformOptimizationSettings = {
                          ...platformSettings,
                          macos: {
                            ...platformSettings.macos,
                            mlxEnabled: event.target.checked,
                          },
                        };
                        void persistPlatformSettings(next);
                      }}
                    />
                  </label>
                  <label className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                    <span>Windows Foundry Local</span>
                    <input
                      type="checkbox"
                      checked={platformSettings.windows.foundryEnabled}
                      disabled={platformSaveBusy}
                      onChange={(event) => {
                        const next: PlatformOptimizationSettings = {
                          ...platformSettings,
                          windows: {
                            ...platformSettings.windows,
                            foundryEnabled: event.target.checked,
                          },
                        };
                        void persistPlatformSettings(next);
                      }}
                    />
                  </label>
                  <label className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                    <span>Windows SDK dictation engine</span>
                    <input
                      type="checkbox"
                      checked={platformSettings.windows.windowsSdkDictationEnabled}
                      disabled={
                        platformSaveBusy ||
                        (!platformSettings.windows.windowsSdkDictationEnabled && !windowsSdkEngineReady)
                      }
                      onChange={(event) => {
                        let next: PlatformOptimizationSettings = {
                          ...platformSettings,
                          windows: {
                            ...platformSettings.windows,
                            windowsSdkDictationEnabled: event.target.checked,
                          },
                        };
                        if (event.target.checked) {
                          if (!windowsSdkEngineReady) {
                            setPlatformSaveError(
                              "Windows SDK dictation native transcription is not available in this build yet."
                            );
                            return;
                          }
                          next = withExclusiveNativeEngine(next, "windows_sdk_dictation");
                        } else {
                          const nextPriority = next.manualEnginePriority.filter(
                            (engine) => engine !== "windows_sdk_dictation"
                          );
                          next = {
                            ...next,
                            mode: nextPriority.length === 0 ? "auto" : next.mode,
                            fallbackPolicy: nextPriority.length === 0 ? "local_only" : next.fallbackPolicy,
                            manualEnginePriority: nextPriority,
                          };
                        }
                        void persistPlatformSettings(next);
                      }}
                    />
                  </label>
                </div>
                {platformSettings.macos.appleNativeEnabled && !appleNativeEngineReady ? (
                  <p className="text-xs text-amber-300">
                    macOS Apple Speech native path is unavailable in this build and has been disabled.
                  </p>
                ) : null}
                {platformSettings.windows.windowsSdkDictationEnabled && !windowsSdkEngineReady ? (
                  <p className="text-xs text-amber-300">
                    Windows SDK dictation native path is unavailable in this build and has been disabled.
                  </p>
                ) : null}

                {platformSettings.mode === "manual" ? (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">
                      Manual engine priority (top to bottom)
                    </p>
                    {platformSettings.manualEnginePriority.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        No override engines configured yet.
                      </p>
                    ) : null}
                    {platformSettings.manualEnginePriority.map((engineId, index) => (
                      <div key={`${engineId}-${index}`} className="flex flex-wrap items-center gap-2">
                        <select
                          className="min-w-[220px] flex-1 rounded-md border bg-background px-3 py-2 text-sm"
                          value={engineId}
                          disabled={platformSaveBusy}
                          onChange={(event) => {
                            const nextPriority = [...platformSettings.manualEnginePriority];
                            nextPriority[index] = event.target.value;
                            const next: PlatformOptimizationSettings = {
                              ...platformSettings,
                              manualEnginePriority: nextPriority,
                            };
                            void persistPlatformSettings(next);
                          }}
                        >
                          {manualEngineOptions
                            .filter(
                              (option) =>
                                option.value === engineId ||
                                !platformSettings.manualEnginePriority.includes(option.value)
                            )
                            .map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                        </select>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={platformSaveBusy || index === 0}
                          onClick={() => {
                            if (index === 0) return;
                            const nextPriority = [...platformSettings.manualEnginePriority];
                            [nextPriority[index - 1], nextPriority[index]] = [
                              nextPriority[index],
                              nextPriority[index - 1],
                            ];
                            void persistPlatformSettings({
                              ...platformSettings,
                              manualEnginePriority: nextPriority,
                            });
                          }}
                        >
                          Up
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={
                            platformSaveBusy || index === platformSettings.manualEnginePriority.length - 1
                          }
                          onClick={() => {
                            if (index === platformSettings.manualEnginePriority.length - 1) return;
                            const nextPriority = [...platformSettings.manualEnginePriority];
                            [nextPriority[index], nextPriority[index + 1]] = [
                              nextPriority[index + 1],
                              nextPriority[index],
                            ];
                            void persistPlatformSettings({
                              ...platformSettings,
                              manualEnginePriority: nextPriority,
                            });
                          }}
                        >
                          Down
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={platformSaveBusy}
                          onClick={() => {
                            const nextPriority = platformSettings.manualEnginePriority.filter(
                              (_value, currentIndex) => currentIndex !== index
                            );
                            void persistPlatformSettings({
                              ...platformSettings,
                              manualEnginePriority: nextPriority,
                            });
                          }}
                        >
                          Remove
                        </Button>
                      </div>
                    ))}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        platformSaveBusy ||
                        platformSettings.manualEnginePriority.length >= manualEngineOptions.length
                      }
                      onClick={() => {
                        const nextOption = manualEngineOptions.find(
                          (option) => !platformSettings.manualEnginePriority.includes(option.value)
                        );
                        if (!nextOption) return;
                        void persistPlatformSettings({
                          ...platformSettings,
                          manualEnginePriority: [
                            ...platformSettings.manualEnginePriority,
                            nextOption.value,
                          ],
                        });
                      }}
                    >
                      Add engine
                    </Button>
                    <p className="text-[11px] text-muted-foreground">
                      Apple/Windows native engine toggles enforce an exclusive manual engine route.
                    </p>
                  </div>
                ) : null}

                {platformSaveError ? (
                  <p className="text-xs text-destructive">{platformSaveError}</p>
                ) : null}
                {activeExclusiveNativeEngineLabel ? (
                  <p className="text-xs text-amber-300">
                    Exclusive route active: {activeExclusiveNativeEngineLabel}. Default provider selection is
                    temporarily overridden.
                  </p>
                ) : null}
              </CardContent>
            </Card>
          ) : null}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Local Model Cache Repair</CardTitle>
              <CardDescription>
                Deletes only invalid local ASR artifacts, then re-checks runtime probes.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex items-center gap-3">
              <Button
                size="sm"
                variant="outline"
                onClick={handleRepairLocalCache}
                disabled={repairingCache}
              >
                {repairingCache ? "Repairing..." : "Repair local cache"}
              </Button>
              {repairSummary ? (
                <p className="text-xs text-muted-foreground">{repairSummary}</p>
              ) : null}
            </CardContent>
          </Card>
          <div className="grid gap-4">
            {providers.length === 0 ? (
              <Card>
                <CardContent className="p-6 text-center">
                  <p className="text-muted-foreground">Loading providers...</p>
                  <p className="text-xs text-muted-foreground mt-2">
                    This may take up to 15 seconds on first load
                  </p>
                </CardContent>
              </Card>
            ) : (
              providers.map((provider) => {
                const selection = getProviderSelectionStatus(provider);
                const runtimeIssue =
                  selection.reason === "runtime_unavailable"
                    ? provider.runtimeMessage ?? "Runtime setup required."
                    : null;
                const providerError = providerErrors[provider.providerType];
                const modelOptions = provider.modelOptions ?? [];
                const selectedModelId = provider.selectedModelId || modelOptions[0]?.id || "";
                const providerSelectionOverridden = Boolean(activeExclusiveNativeEngineId);
                return (
                  <Card
                    key={provider.providerType}
                    className={cn(
                      "transition-all",
                      !providerSelectionOverridden &&
                        defaultProvider === provider.providerType &&
                        "border-trusted ring-1 ring-trusted"
                    )}
                  >
                    <CardHeader className="pb-3">
                      <div className="flex items-start justify-between">
                        <div className="flex items-center gap-3">
                          <div className="h-10 w-10 rounded-lg bg-trusted/10 flex items-center justify-center text-trusted">
                            {getProviderIcon(provider.providerType)}
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <CardTitle className="text-lg">{provider.name}</CardTitle>
                              {providerSelectionOverridden ? (
                                <Badge variant="secondary" className="text-xs">
                                  Overridden
                                </Badge>
                              ) : defaultProvider === provider.providerType ? (
                                <Badge variant="outline" className="text-xs">
                                  Default
                                </Badge>
                              ) : null}
                            </div>
                            <CardDescription className="line-clamp-2 mt-1">
                              {provider.description}
                            </CardDescription>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {getDownloadStatusBadge(provider)}
                        </div>
                      </div>
                    </CardHeader>

                    <CardContent className="space-y-4">
                      {provider.modelInfo && (
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                          <div className="p-2 bg-muted rounded-lg">
                            <div className="text-muted-foreground text-xs">Size</div>
                            <div className="font-medium">{provider.modelInfo.sizeMb} MB</div>
                          </div>
                          <div className="p-2 bg-muted rounded-lg">
                            <div className="text-muted-foreground text-xs">Parameters</div>
                            <div className="font-medium">{provider.modelInfo.parameters}</div>
                          </div>
                          <div className="p-2 bg-muted rounded-lg">
                            <div className="text-muted-foreground text-xs">WER</div>
                            <div className="font-medium">
                              {provider.modelInfo.wordErrorRate?.toFixed(2) || "N/A"}%
                            </div>
                          </div>
                          <div className="p-2 bg-muted rounded-lg">
                            <div className="text-muted-foreground text-xs">Speed</div>
                            <div className="font-medium">
                              {provider.modelInfo.realTimeFactor?.toFixed(0) || "N/A"}x RTF
                            </div>
                          </div>
                        </div>
                      )}

                      {provider.modelInfo?.languages && provider.modelInfo.languages.length > 0 && (
                        <div>
                          <div className="text-sm text-muted-foreground mb-2">
                            Supported Languages ({provider.modelInfo.languages.length})
                          </div>
                          <ScrollArea className="h-16">
                            <div className="flex flex-wrap gap-1">
                              {provider.modelInfo.languages.slice(0, 10).map((lang) => (
                                <Badge key={lang} variant="secondary" className="text-xs">
                                  {lang.toUpperCase()}
                                </Badge>
                              ))}
                              {provider.modelInfo.languages.length > 10 && (
                                <Badge variant="secondary" className="text-xs">
                                  +{provider.modelInfo.languages.length - 10} more
                                </Badge>
                              )}
                            </div>
                          </ScrollArea>
                        </div>
                      )}

                      <div className="space-y-2">
                        <p className="text-xs text-muted-foreground">
                          {providerSelectionOverridden
                            ? "Model (inactive while native override is enabled)"
                            : "Model"}
                        </p>
                        {modelOptions.length > 1 ? (
                          <select
                            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                            value={selectedModelId}
                            disabled={providerSelectionOverridden}
                            onChange={(event) => {
                              void handleModelChange(provider.providerType, event.target.value);
                            }}
                          >
                            {modelOptions.map((option) => (
                              <option key={option.id} value={option.id}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
                            {(modelOptions[0]?.label ?? selectedModelId) || "Default model"}
                          </div>
                        )}
                      </div>

                      {provider.engineDiagnostics ? (
                        <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs space-y-1">
                          <p className="text-muted-foreground">
                            Active engine:{" "}
                            <span className="font-mono">
                              {provider.engineDiagnostics.activeEngine ?? "provider_default"}
                            </span>
                          </p>
                          <p className="text-muted-foreground">
                            Ready engines:{" "}
                            <span className="font-mono">
                              {provider.engineDiagnostics.availableEngines.length > 0
                                ? provider.engineDiagnostics.availableEngines.join(", ")
                                : "none"}
                            </span>
                          </p>
                          {provider.engineDiagnostics.notes.slice(0, 2).map((note, index) => (
                            <p key={`${provider.providerType}-engine-note-${index}`} className="text-muted-foreground">
                              {note}
                            </p>
                          ))}
                        </div>
                      ) : null}

                      <div className="flex items-center justify-between pt-2">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="text-xs">
                            {provider.modelInfo?.license || "Unknown"}
                          </Badge>
                          {selection.reason === "runtime_unavailable" && (
                            <Badge variant="secondary" className="text-xs">
                              {provider.runtimeStatus === "missing_runtime"
                                ? "Runtime setup required"
                                : provider.runtimeStatus === "missing_model"
                                  ? "Model files missing"
                                  : "Runtime error"}
                            </Badge>
                          )}
                          {!provider.inferenceEnabled && (
                            <Badge variant="secondary" className="text-xs">
                              Not enabled
                            </Badge>
                          )}
                          {provider.modelInfo?.sourceUrl && (
                            <a
                              href={provider.modelInfo.sourceUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-trusted hover:underline"
                            >
                              Learn more
                            </a>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          {selection.selectable ? (
                            <>
                              <Button
                                variant={defaultProvider === provider.providerType ? "default" : "outline"}
                                size="sm"
                                disabled={Boolean(activeExclusiveNativeEngineId)}
                                onClick={() => handleSetDefault(provider.providerType)}
                              >
                                {activeExclusiveNativeEngineId
                                  ? "Overridden"
                                  : defaultProvider === provider.providerType
                                    ? "Default"
                                    : "Set Default"}
                              </Button>
                              {selection.reason === "download_required" &&
                              isNotDownloaded(provider.downloadStatus) ? (
                                <Button
                                  size="sm"
                                  onClick={() => handleDownload(provider.providerType)}
                                  disabled={isLoading}
                                >
                                  <Download className="h-4 w-4 mr-2" />
                                  Download
                                </Button>
                              ) : null}
                              {selection.reason === "runtime_unavailable" ? (
                                <>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => void copySetupCommand(provider.providerType)}
                                  >
                                    Copy setup info
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={async () => {
                                      try {
                                        await refreshAsrRuntimeProbes();
                                      } catch (error) {
                                        console.warn("Failed to refresh runtime probes:", error);
                                      }
                                      await loadProviders();
                                    }}
                                  >
                                    Re-check runtime
                                  </Button>
                                  {defaultProvider === provider.providerType &&
                                  provider.providerType !== "whisper" ? (
                                    <Button
                                      size="sm"
                                      variant="secondary"
                                      onClick={() => handleSetDefault("whisper")}
                                    >
                                      Switch to Whisper
                                    </Button>
                                  ) : null}
                                </>
                              ) : null}
                            </>
                          ) : selection.reason === "runtime_unavailable" ? (
                            <>
                              <Button size="sm" variant="outline" disabled>
                                Runtime setup required
                              </Button>
                            </>
                          ) : selection.reason === "not_enabled" ? (
                            <Button size="sm" variant="outline" disabled>
                              Not enabled
                            </Button>
                          ) : null}
                        </div>
                      </div>
                      {(runtimeIssue || providerError) && (
                        <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                          <p>{providerError ?? runtimeIssue}</p>
                          {selection.reason === "runtime_unavailable" && (
                            <>
                              {provider.runtimeDetails?.missingFiles?.length ? (
                                <p className="text-amber-100">
                                  Missing:{" "}
                                  <span className="font-mono">
                                    {provider.runtimeDetails.missingFiles.join(", ")}
                                  </span>
                                </p>
                              ) : null}
                              <p className="text-amber-100">
                                How to enable:{" "}
                                <span className="font-mono">
                                  {provider.runtimeDetails?.setupAction ??
                                    providerSetupCommand(provider.providerType)}
                                </span>
                              </p>
                              {provider.runtimeDetails?.pythonPath ? (
                                <p className="text-amber-100">
                                  Detected Python: <span className="font-mono">{provider.runtimeDetails.pythonPath}</span>
                                </p>
                              ) : null}
                            </>
                          )}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })
            )}
          </div>
        </TabsContent>

        <TabsContent value="benchmark" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <BarChart3 className="h-5 w-5" />
                Performance Benchmark
              </CardTitle>
              <CardDescription>
                Compare transcription speed and accuracy across all available providers
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-center p-8 border-2 border-dashed rounded-lg">
                <div className="text-center">
                  <FileAudio className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                  <p className="text-sm text-muted-foreground mb-4">
                    Upload a WAV test audio file to benchmark all available providers
                  </p>
                  <input
                    ref={benchmarkFileInputRef}
                    type="file"
                    accept=".wav,audio/wav"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.target.files?.[0] ?? null;
                      setBenchmarkFileName(file?.name ?? null);
                    }}
                  />
                  <div className="flex flex-col items-center gap-2">
                    <Button variant="outline" onClick={() => benchmarkFileInputRef.current?.click()}>
                      Choose WAV File
                    </Button>
                    {benchmarkFileName ? (
                      <p className="text-xs text-muted-foreground">{benchmarkFileName}</p>
                    ) : null}
                  </div>
                  <Button className="mt-3" onClick={runBenchmark} disabled={isBenchmarking || !benchmarkFileName}>
                    <Clock className="h-4 w-4 mr-2" />
                    {isBenchmarking ? "Running..." : "Run Benchmark"}
                  </Button>
                </div>
              </div>

              {benchmarkResults.length > 0 && (
                <div className="space-y-2">
                  {benchmarkResults.map((result) => (
                    <div
                      key={`${result.providerType}-${result.modelId}`}
                      className="flex items-center justify-between p-3 border rounded-lg"
                    >
                      <div>
                        <p className="font-medium">{result.providerName}</p>
                        <p className="text-sm text-muted-foreground">
                          {result.modelId} · {result.runtimeStatus} · Confidence:{" "}
                          {(result.confidence * 100).toFixed(1)}%
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Transcript: {result.nonEmptyTranscript ? "non-empty" : "empty"}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="font-mono font-medium">
                          {(result.processingTimeMs / 1000).toFixed(2)}s
                        </p>
                        <p className="text-xs text-muted-foreground">Processing time</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {benchmarkHistory.length > 0 && (
                <div className="space-y-2 pt-2">
                  <p className="text-xs font-medium text-muted-foreground">Recent benchmark history</p>
                  {benchmarkHistory.map((entry) => (
                    <div key={entry.id} className="flex items-center justify-between rounded-lg border p-2 text-xs">
                      <div>
                        <p className="font-medium">{entry.providerName}</p>
                        <p className="text-muted-foreground">
                          {entry.modelId} · {entry.runtimeStatus}
                        </p>
                      </div>
                      <div className="text-right">
                        <p>{(entry.processingTimeMs / 1000).toFixed(2)}s</p>
                        <p className="text-muted-foreground">
                          {(entry.confidence * 100).toFixed(1)}% ·{" "}
                          {entry.nonEmptyTranscript ? "non-empty" : "empty"}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Provider Status</CardTitle>
              <CardDescription>
                Production availability for ASR providers in this build
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4 text-sm">
                <div className="p-3 bg-muted/50 rounded-lg">
                  <p className="font-medium mb-1">🌍 Whisper (Enabled)</p>
                  <p className="text-muted-foreground">
                    Production local transcription provider. Supports model selection including
                    turbo variants.
                  </p>
                </div>
                <div className="p-3 bg-muted/50 rounded-lg">
                  <p className="font-medium mb-1">⚡ Parakeet (Enabled when runtime ready)</p>
                  <p className="text-muted-foreground">
                    Uses a local NeMo runtime bridge. Provider becomes selectable only when model
                    files and runtime health checks are both ready.
                  </p>
                </div>
                <div className="p-3 bg-muted/50 rounded-lg">
                  <p className="font-medium mb-1">🏎️ Distil Whisper (Enabled)</p>
                  <p className="text-muted-foreground">
                    Native local Distil runtime using model artifacts from distil-large-v3.5.
                  </p>
                </div>
                <div className="p-3 bg-muted/50 rounded-lg">
                  <p className="font-medium mb-1">🏆 Canary (Enabled when runtime ready)</p>
                  <p className="text-muted-foreground">
                    Uses local model artifacts plus a Python runtime bridge; selectable when both
                    download and runtime health checks pass.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
