import { describeCloudDictationVocabularyNote } from "@/lib/dictation-ui-message";
import { useState, useEffect, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";
import { normalizeDownloadStatus } from "@/lib/download-status";
import { formatModelSize, getAsrModelCapability } from "@/lib/asr-capabilities";
import { getProviderSelectionStatus } from "@/lib/asr-provider-selection";
import { describeAppleSpeechEngine } from "@/lib/asr-route-catalog";
import {
  mergeSelectionStateUpdate,
  selectionStateFromSettings,
} from "@/lib/asr-route-selection";
import {
  refreshAsrRuntimeProbes,
  repairLocalModelCache,
  getAsrProviderInventory,
} from "@/lib/backend/asr";
import {
  getSettings,
  saveSettings,
  getPermissionDiagnostics,
  openPermissionSettings,
  cancelAppleSpeechLanguageInstall,
  installAppleSpeechLanguage,
  openInstalledPlainsongApp,
  requestAppleSpeechPermission,
  repairCursorInsertPermissions,
  type PermissionDiagnostics,
} from "@/lib/backend/settings";
import { invoke, listen } from "@/lib/electron";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import type {
  AppleSpeechLanguageInstallProgress,
  AsrBenchmarkEntry,
  PlatformOptimizationSettings,
  AsrProviderInfo,
  AsrProviderInventory,
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
  Mic,
} from "lucide-react";

interface AsrProviderManagerProps {
  className?: string;
}

export function AsrProviderManager({ className }: AsrProviderManagerProps) {
  const [meetingRoutePolicy, setMeetingRoutePolicy] = useState<
    "prefer_local" | "best_available"
  >("prefer_local");
  const [inventory, setInventory] = useState<AsrProviderInventory[]>([]);
  const [providers, setProviders] = useState<AsrProviderInfo[]>([]);
  const [defaultProvider, setDefaultProvider] =
    useState<AsrProviderType>("whisper");
  const [defaultModelId, setDefaultModelId] = useState("distil-large-v3.5");
  const [useSharedAsrSelection, setUseSharedAsrSelection] = useState(true);
  const [dictationProvider, setDictationProvider] =
    useState<AsrProviderType>("distil_whisper");
  const [dictationModelId, setDictationModelId] = useState("distil-large-v3.5");
  const [meetingProvider, setMeetingProvider] =
    useState<AsrProviderType>("distil_whisper");
  const [meetingModelId, setMeetingModelId] = useState("distil-large-v3.5");
  const [isLoading, setIsLoading] = useState(false);
  const [benchmarkResults, setBenchmarkResults] = useState<BenchmarkResult[]>(
    [],
  );
  const [benchmarkHistory, setBenchmarkHistory] = useState<AsrBenchmarkEntry[]>(
    [],
  );
  const [benchmarkFileName, setBenchmarkFileName] = useState<string | null>(
    null,
  );
  const [isBenchmarking, setIsBenchmarking] = useState(false);
  const [benchmarkError, setBenchmarkError] = useState<string | null>(null);
  const [providerErrors, setProviderErrors] = useState<Record<string, string>>(
    {},
  );
  const [downloadProgress, setDownloadProgress] = useState<
    Record<string, number>
  >({});
  const [repairingCache, setRepairingCache] = useState(false);
  const [repairSummary, setRepairSummary] = useState<string | null>(null);
  const [platformSettings, setPlatformSettings] =
    useState<PlatformOptimizationSettings | null>(null);
  const [platformSaveBusy, setPlatformSaveBusy] = useState(false);
  const [platformSaveError, setPlatformSaveError] = useState<string | null>(
    null,
  );
  const [showAdvancedTools, setShowAdvancedTools] = useState(false);
  const [permissionActionBusy, setPermissionActionBusy] = useState(false);
  const [languageInstallBusy, setLanguageInstallBusy] = useState(false);
  const [languageInstallCancelling, setLanguageInstallCancelling] =
    useState(false);
  const [languageInstallProgress, setLanguageInstallProgress] =
    useState<AppleSpeechLanguageInstallProgress | null>(null);
  const [languageInstallError, setLanguageInstallError] = useState<
    string | null
  >(null);
  const [permissionDiagnostics, setPermissionDiagnostics] =
    useState<PermissionDiagnostics | null>(null);
  const benchmarkFileInputRef = useRef<HTMLInputElement | null>(null);
  const autoPromptedNativePermissionRef = useRef<string | null>(null);

  const manualEngineOptions = [
    { value: "provider_default", label: "Provider default" },
    { value: "windows_foundry_local", label: "Windows Foundry Local" },
  ] as const;

  type SelectionProvider = AsrProviderInfo | AsrProviderInventory;

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
    const validIds = new Set<string>(
      manualEngineOptions.map((option) => option.value),
    );
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
    settings: PlatformOptimizationSettings,
  ): PlatformOptimizationSettings => ({
    ...settings,
    manualEnginePriority: normalizeManualEnginePriority(
      settings.manualEnginePriority ?? [],
    ),
  });

  const withoutNativeRouteOverrides = (
    settings: PlatformOptimizationSettings,
  ): PlatformOptimizationSettings => {
    const nextPriority = settings.manualEnginePriority.filter(
      (engine) =>
        engine !== "macos_apple_speech" && engine !== "windows_sdk_dictation",
    );

    return {
      ...settings,
      mode:
        settings.mode === "manual" && nextPriority.length === 0
          ? "auto"
          : settings.mode,
      fallbackPolicy:
        nextPriority.length === 0 ? "local_only" : settings.fallbackPolicy,
      macos: {
        ...settings.macos,
        appleNativeEnabled: false,
      },
      windows: {
        ...settings.windows,
        windowsSdkDictationEnabled: false,
      },
      manualEnginePriority: nextPriority,
    };
  };

  const readyEngineIds = useMemo(() => {
    const ids = new Set<string>();
    for (const provider of providers) {
      for (const engineId of provider.engineDiagnostics?.availableEngines ??
        []) {
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
      const nextPriority = next.manualEnginePriority.filter(
        (engine) => engine !== "macos_apple_speech",
      );
      next = {
        ...next,
        macos: {
          ...next.macos,
          appleNativeEnabled: false,
        },
        mode: nextPriority.length === 0 ? "auto" : next.mode,
        fallbackPolicy:
          nextPriority.length === 0 ? "local_only" : next.fallbackPolicy,
        manualEnginePriority: nextPriority,
      };
      changed = true;
    }

    if (next.windows.windowsSdkDictationEnabled && !windowsSdkEngineReady) {
      const nextPriority = next.manualEnginePriority.filter(
        (engine) => engine !== "windows_sdk_dictation",
      );
      next = {
        ...next,
        windows: {
          ...next.windows,
          windowsSdkDictationEnabled: false,
        },
        mode: nextPriority.length === 0 ? "auto" : next.mode,
        fallbackPolicy:
          nextPriority.length === 0 ? "local_only" : next.fallbackPolicy,
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
    let disposed = false;
    let unlistenDownloadProgress: (() => void) | undefined;

    const bootstrap = async () => {
      const loadedInventory = await loadInventory();
      if (disposed) {
        return;
      }
      await loadSelectionSettings(loadedInventory);
      if (disposed) {
        return;
      }
      await loadBenchmarkHistory();
      if (disposed) {
        return;
      }
      await loadPlatformSettings();
      if (disposed) {
        return;
      }
      await refreshPermissionDiagnostics();
    };

    void bootstrap();

    // Listen for download progress events
    void listen<[AsrProviderType, number]>("asr-download-progress", (event) => {
      const [providerType, progress] = event.payload;
      setDownloadProgress((prev) => ({ ...prev, [providerType]: progress }));
    })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          unlistenDownloadProgress = unlisten;
        }
      })
      .catch((error) => {
        console.warn("Failed to subscribe to ASR download progress:", error);
      });

    return () => {
      disposed = true;
      unlistenDownloadProgress?.();
    };
  }, []);

  useEffect(() => {
    if (!showAdvancedTools || providers.length > 0) {
      return;
    }

    void loadProviders();
  }, [providers.length, showAdvancedTools]);

  const refreshPermissionDiagnostics = async () => {
    try {
      const diagnostics = await getPermissionDiagnostics();
      setPermissionDiagnostics(diagnostics);
      return diagnostics;
    } catch (error) {
      console.error("Failed to load permission diagnostics:", error);
      return null;
    }
  };

  const refreshAppleNativeReadiness = async () => {
    const diagnostics = await refreshPermissionDiagnostics();
    const loadedInventory = await loadInventory();
    await loadSelectionSettings(loadedInventory);
    return diagnostics;
  };

  const loadPlatformSettings = async () => {
    try {
      const settings = await getSettings();
      const normalized = withNormalizedManualPriority(
        withoutNativeRouteOverrides(
          settings.transcription.platformOptimization ??
            defaultPlatformSettings(),
        ),
      );
      setPlatformSettings(normalized);

      if (
        JSON.stringify(normalized) !==
        JSON.stringify(
          settings.transcription.platformOptimization ??
            defaultPlatformSettings(),
        )
      ) {
        await saveSettings({
          ...settings,
          transcription: {
            ...settings.transcription,
            platformOptimization: normalized,
          },
        });
      }
    } catch (error) {
      console.error("Failed to load platform optimization settings:", error);
      setPlatformSettings(defaultPlatformSettings());
    }
  };

  const persistPlatformSettings = async (
    next: PlatformOptimizationSettings,
  ) => {
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

  const toInventory = (
    providerList: AsrProviderInfo[],
  ): AsrProviderInventory[] =>
    providerList.map((provider) => ({
      providerType: provider.providerType,
      name: provider.name,
      description: provider.description,
      isAvailable: provider.isAvailable,
      inferenceEnabled: provider.inferenceEnabled,
      selectedModelId: provider.selectedModelId,
      modelOptions: provider.modelOptions,
      downloadStatus: provider.downloadStatus,
      platformReadiness: provider.platformReadiness,
    }));

  const loadInventory = async () => {
    try {
      setIsLoading(true);
      const data = await getAsrProviderInventory();
      setInventory(data);
      return data;
    } catch (error) {
      console.error("Failed to load ASR inventory:", error);
      setInventory([]);
      return [];
    } finally {
      setIsLoading(false);
    }
  };

  const loadProviders = async () => {
    try {
      const data = await invoke<AsrProviderInfo[]>("get_asr_providers");
      setInventory(toInventory(data));
      setProviders(data);
      return data;
    } catch (error) {
      console.error("Failed to load ASR providers:", error);
      return [];
    }
  };

  const loadSelectionSettings = async (
    providerListOverride?: SelectionProvider[],
  ) => {
    try {
      const providerList = providerListOverride ?? inventory;
      const settings = await getSettings();
      const selection = selectionStateFromSettings(
        providerList,
        settings.transcription,
      );

      setDefaultProvider(selection.defaultProvider);
      setDefaultModelId(selection.defaultModelId);
      setUseSharedAsrSelection(selection.useSharedAsrSelection);
      setDictationProvider(selection.dictationProvider);
      setDictationModelId(selection.dictationModelId);
      setMeetingProvider(selection.meetingProvider);
      setMeetingModelId(selection.meetingModelId);
      setMeetingRoutePolicy(selection.meetingRoutePolicy);
    } catch (error) {
      console.error("Failed to load ASR selection settings:", error);
    }
  };

  const persistSelectionSettings = async (updates: {
    useSharedAsrSelection?: boolean;
    defaultProvider?: AsrProviderType;
    selectedModelId?: string;
    dictationProvider?: AsrProviderType;
    dictationModelId?: string;
    meetingProvider?: AsrProviderType;
    meetingModelId?: string;
    meetingRoutePolicy?: "prefer_local" | "best_available";
  }) => {
    const settings = await getSettings();
    const selection = mergeSelectionStateUpdate(
      selectionProviders,
      {
        defaultProvider,
        defaultModelId,
        useSharedAsrSelection,
        dictationProvider,
        dictationModelId,
        meetingProvider,
        meetingModelId,
        meetingRoutePolicy,
      },
      {
        defaultProvider: updates.defaultProvider,
        defaultModelId: updates.selectedModelId,
        useSharedAsrSelection: updates.useSharedAsrSelection,
        dictationProvider: updates.dictationProvider,
        dictationModelId: updates.dictationModelId,
        meetingProvider: updates.meetingProvider,
        meetingModelId: updates.meetingModelId,
        meetingRoutePolicy: updates.meetingRoutePolicy,
      },
    );

    await saveSettings({
      ...settings,
      transcription: {
        ...settings.transcription,
        useSharedAsrSelection: selection.useSharedAsrSelection,
        defaultProvider: selection.defaultProvider,
        selectedModelId: selection.defaultModelId,
        dictationProvider: selection.dictationProvider,
        dictationModelId: selection.dictationModelId,
        meetingProvider: selection.meetingProvider,
        meetingModelId: selection.meetingModelId,
        meetingRoutePolicy: selection.meetingRoutePolicy,
      },
    });

    setUseSharedAsrSelection(selection.useSharedAsrSelection);
    setDefaultProvider(selection.defaultProvider);
    setDefaultModelId(selection.defaultModelId);
    setDictationProvider(selection.dictationProvider);
    setDictationModelId(selection.dictationModelId);
    setMeetingProvider(selection.meetingProvider);
    setMeetingModelId(selection.meetingModelId);
    setMeetingRoutePolicy(selection.meetingRoutePolicy);
    await loadInventory();
  };

  const selectionProviders = inventory.length > 0 ? inventory : providers;

  const providerByType = (providerType: AsrProviderType) =>
    providers.find((provider) => provider.providerType === providerType);

  const selectionProviderByType = (providerType: AsrProviderType) =>
    selectionProviders.find(
      (provider) => provider.providerType === providerType,
    );

  const providerDisplayName = (providerType: AsrProviderType) => {
    const provider = providerByType(providerType);
    return provider ? provider.name : providerType;
  };

  const inventoryReadiness = (provider: SelectionProvider) => {
    const status = normalizeDownloadStatus(provider.downloadStatus);
    if (provider.providerType === "macos_apple_speech" && provider.platformReadiness) {
      return provider.platformReadiness.ready
        ? { tone: "success" as const, label: "Ready on-device" }
        : {
            tone: "warning" as const,
            label:
              provider.platformReadiness.status === "authorization_not_determined"
                ? "Permission required"
                : provider.platformReadiness.status === "authorization_denied"
                  ? "Permission denied"
                  : provider.platformReadiness.status === "unsupported_locale"
                    ? "Locale unsupported"
                    : provider.platformReadiness.status === "helper_missing"
                      ? "Helper missing"
                      : provider.platformReadiness.status === "on_device_unavailable"
                        ? "On-device unavailable"
                        : "Needs setup",
          };
    }
    if (!provider.inferenceEnabled) {
      return {
        tone: "muted" as const,
        label: "Unavailable in this build",
      };
    }
    if (status.kind === "not_downloaded") {
      return {
        tone: "warning" as const,
        label: "Needs download",
      };
    }
    if (!provider.isAvailable) {
      return {
        tone: "warning" as const,
        label: "Needs setup",
      };
    }
    return {
      tone: "success" as const,
      label: "Ready",
    };
  };

  const handleSetDefault = async (providerType: AsrProviderType) => {
    const selected = providers.find(
      (provider) => provider.providerType === providerType,
    );
    if (!selected?.inferenceEnabled) {
      console.warn(
        `${providerType} is not enabled for inference in this build`,
      );
      return;
    }

    try {
      await invoke("set_default_asr_provider", { providerType });
      setDefaultProvider(providerType);
      setDefaultModelId(selected?.selectedModelId ?? providerType);
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
        [providerType]: message.replace(
          /^Error invoking command '[^']+':\s*/i,
          "",
        ),
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
      await refreshAsrRuntimeProbes();
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

  const handleModelChange = async (
    providerType: AsrProviderType,
    modelId: string,
  ) => {
    try {
      await invoke("set_asr_provider_model", { providerType, modelId });
      setProviders((prev) =>
        prev.map((provider) =>
          provider.providerType === providerType
            ? {
                ...provider,
                selectedModelId: modelId,
              }
            : provider,
        ),
      );
      if (defaultProvider === providerType) {
        setDefaultModelId(modelId);
      }
      if (dictationProvider === providerType) {
        setDictationModelId(modelId);
      }
      if (meetingProvider === providerType) {
        setMeetingModelId(modelId);
      }
      const updatedProviders = await loadProviders();
      await loadSelectionSettings(updatedProviders);
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
      setBenchmarkError("Choose a WAV file before running the benchmark.");
      return;
    }
    const isWav = selectedFile.name.toLowerCase().endsWith(".wav");
    if (!isWav) {
      setBenchmarkError("Benchmark requires a WAV audio file.");
      return;
    }

    setBenchmarkError(null);
    setIsBenchmarking(true);
    try {
      const fileBytes = new Uint8Array(await selectedFile.arrayBuffer());
      const results = await invoke<BenchmarkResult[]>(
        "benchmark_asr_providers_bytes",
        {
          audioBytes: Array.from(fileBytes),
        },
      );
      setBenchmarkResults(results);
      await loadBenchmarkHistory();
    } catch (error) {
      console.error("Benchmark failed:", error);
      const message = error instanceof Error ? error.message : String(error);
      setBenchmarkError(message || "Benchmark failed.");
    } finally {
      setIsBenchmarking(false);
    }
  };

  const loadBenchmarkHistory = async () => {
    try {
      const history = await invoke<AsrBenchmarkEntry[]>("list_asr_benchmarks", {
        limit: 20,
      });
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
      case "macos_apple_speech":
        return <Mic className="h-5 w-5" />;
      case "moonshine":
        return <Moon className="h-5 w-5" />;
      case "windows_sdk_dictation":
        return <Mic className="h-5 w-5" />;
      case "openai_cloud":
      case "elevenlabs_scribe":
      case "cohere_transcribe":
        return <CloudLightning className="h-5 w-5" />;
      default:
        return <Cpu className="h-5 w-5" />;
    }
  };

  const getDownloadStatusBadge = (provider: AsrProviderInfo) => {
    const normalizedStatus = normalizeDownloadStatus(provider.downloadStatus);
    const activeProgress = downloadProgress[provider.providerType];

    // Determine if this is a large download (>500 MiB) to show a wider bar.
    const cap = getAsrModelCapability(
      provider.providerType,
      provider.selectedModelId,
    );
    const isLargeDownload = cap !== null && cap.sizeMib > 500;
    const progressWidth = isLargeDownload ? "w-32" : "w-20";

    // Show progress bar if we have active progress and not yet fully downloaded/updated
    if (
      activeProgress !== undefined &&
      normalizedStatus.kind !== "downloaded"
    ) {
      return (
        <div className="flex items-center gap-2">
          <Progress value={activeProgress} className={`${progressWidth} h-2`} />
          <span className="text-xs text-muted-foreground">
            {activeProgress.toFixed(0)}%
          </span>
        </div>
      );
    }

    switch (normalizedStatus.kind) {
      case "downloaded":
        return (
          <Badge variant="default" className="bg-gold">
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
            <Progress value={progress} className={`${progressWidth} h-2`} />
            <span className="text-xs text-muted-foreground">
              {progress.toFixed(0)}%
            </span>
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

  const isNotDownloaded = (
    status: AsrProviderInfo["downloadStatus"],
  ): boolean => {
    return normalizeDownloadStatus(status).kind === "not_downloaded";
  };

  const providerSetupCommand = (providerType: AsrProviderType): string => {
    switch (providerType) {
      case "parakeet":
        return "Use the Download button to fetch the selected Parakeet model. TDT 0.6B v3 is the recommended multilingual default; CTC, larger, and legacy variants are available on demand.";
      case "whisper_candle":
        return "Use the Download button to fetch Whisper Large V3 Turbo for the native Candle runtime. This path is experimental and best used for dictation.";
      case "distil_whisper":
        return "Use the Download button to fetch the Distil-Whisper Large v3.5 model (no Python needed)";
      case "macos_apple_speech":
        return "Grant Plainsong Speech Recognition access in macOS System Settings > Privacy & Security > Speech Recognition";
      case "moonshine":
        return "Use the Download button to fetch the selected Moonshine bundle. Tiny is the smallest edge model; Base is the default stable option.";
      case "qwen3_asr":
        return "Use the Download button to fetch the Qwen3-ASR 0.6B model (~1.9 GiB, 7 files). Experimental: English is verified in Plainsong; 30 languages including Chinese, Japanese and Korean are listed upstream; it runs slower than real time on the CPU.";
      case "windows_sdk_dictation":
        return "Use a Windows x86_64 build with Windows speech recognition components available, or pick another ASR provider";
      case "elevenlabs_scribe":
        return "Add an ElevenLabs API key in Settings → API Keys";
      case "openai_cloud":
        return "Add an OpenAI API key in Settings → API Keys";
      case "cohere_transcribe":
        return "Add a Cohere API key in Settings → API Keys";
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
        setRepairSummary(
          `Removed ${removed} invalid artifact${removed === 1 ? "" : "s"}.`,
        );
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

  const renderRouteStatus = (label: string, providerType: AsrProviderType) => {
    const provider = providerByType(providerType);
    const lightweightProvider = selectionProviderByType(providerType);
    if (!provider && !lightweightProvider) return null;
    const routeLabel = providerDisplayName(providerType);
    if (!provider && lightweightProvider) {
      return (
        <p className="text-xs text-muted-foreground">
          {label}: {routeLabel} is{" "}
          {inventoryReadiness(lightweightProvider).label.toLowerCase()}.
        </p>
      );
    }
    if (!provider) {
      return null;
    }
    if (
      providerType === "macos_apple_speech" &&
      permissionDiagnostics?.speechRecognitionReady
    ) {
      return (
        <p className="text-xs text-muted-foreground">
          {label}: {routeLabel} is ready.
        </p>
      );
    }
    const selection = getProviderSelectionStatus(provider);
    if (selection.reason === null) {
      return (
        <p className="text-xs text-muted-foreground">
          {label}: {routeLabel} is ready.
        </p>
      );
    }
    const canRequestSpeechPermission = providerType === "macos_apple_speech";
    return (
      <div className="space-y-2">
        <p className="text-xs text-rust">
          {label}:{" "}
          {provider.runtimeMessage ?? `${routeLabel} is not ready yet.`}{" "}
          {provider.runtimeDetails.setupAction ??
            "Choose another provider if you need to keep working."}
        </p>
        {canRequestSpeechPermission ? (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={permissionActionBusy}
              onClick={async () => {
                setPermissionActionBusy(true);
                try {
                  await requestAppleSpeechPermission();
                  await refreshPermissionDiagnostics();
                  await loadProviders();
                  await loadSelectionSettings();
                } catch (error) {
                  console.error(
                    "Failed to request dictation permissions:",
                    error,
                  );
                } finally {
                  setPermissionActionBusy(false);
                }
              }}
            >
              Request permission
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={permissionActionBusy}
              onClick={async () => {
                try {
                  await openPermissionSettings("speech");
                } catch (error) {
                  console.error(
                    "Failed to open speech permission settings:",
                    error,
                  );
                }
              }}
            >
              Open Speech Settings
            </Button>
          </div>
        ) : null}
      </div>
    );
  };

  const appleSpeechReadiness =
    selectionProviderByType("macos_apple_speech")?.platformReadiness ??
    providerByType("macos_apple_speech")?.platformReadiness ??
    null;

  // The language install is the only download this route ever starts, so the
  // action is offered only when macOS actually has something to fetch:
  // SpeechAnalyzer is usable, it covers this language, and the assets are not
  // already on disk.
  const appleSpeechLanguageInstallable = Boolean(
    appleSpeechReadiness?.speechAnalyzerAvailable &&
      appleSpeechReadiness?.speechAnalyzerLocaleSupported &&
      !appleSpeechReadiness?.speechAnalyzerAssetsInstalled,
  );

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void (async () => {
      const next = await listen<AppleSpeechLanguageInstallProgress>(
        "apple-speech-language-install-progress",
        (event) => {
          if (!disposed) {
            setLanguageInstallProgress({ ...event.payload });
          }
        },
      );
      if (disposed) {
        next();
        return;
      }
      unlisten = next;
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  /**
   * Stops the running install.
   *
   * macOS owns the download and it can run for minutes; without this the only
   * way out of "Installing language…" was to quit. The install call itself
   * returns with a `cancelled` error, so the button state is cleared by the
   * same `finally` as every other ending.
   */
  const cancelAppleSpeechLanguageAssets = async () => {
    setLanguageInstallCancelling(true);
    try {
      await cancelAppleSpeechLanguageInstall();
    } catch (error) {
      setLanguageInstallError(
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const installAppleSpeechLanguageAssets = async () => {
    setLanguageInstallBusy(true);
    setLanguageInstallCancelling(false);
    setLanguageInstallError(null);
    setLanguageInstallProgress(null);
    try {
      const result = await installAppleSpeechLanguage(
        appleSpeechReadiness?.locale ?? undefined,
      );
      if (result.notes.length > 0) {
        setLanguageInstallError(result.notes.join(" "));
      }
      await refreshAppleNativeReadiness();
    } catch (error) {
      setLanguageInstallError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setLanguageInstallBusy(false);
      setLanguageInstallCancelling(false);
      setLanguageInstallProgress(null);
    }
  };
  const selectedRouteUsesAppleNative = useSharedAsrSelection
    ? defaultProvider === "macos_apple_speech"
    : dictationProvider === "macos_apple_speech" ||
      meetingProvider === "macos_apple_speech";

  const appleNativeUsedForDictation = useSharedAsrSelection
    ? defaultProvider === "macos_apple_speech"
    : dictationProvider === "macos_apple_speech";

  useEffect(() => {
    if (!selectedRouteUsesAppleNative || permissionActionBusy) {
      return;
    }

    if (permissionDiagnostics?.speechRecognitionReady) {
      autoPromptedNativePermissionRef.current = null;
      return;
    }

    if (
      appleSpeechReadiness &&
      appleSpeechReadiness.status !== "authorization_not_determined"
    ) {
      return;
    }

    const promptKey = useSharedAsrSelection
      ? "shared"
      : `${dictationProvider}:${meetingProvider}`;
    if (autoPromptedNativePermissionRef.current === promptKey) {
      return;
    }

    autoPromptedNativePermissionRef.current = promptKey;
    setPermissionActionBusy(true);
    void (async () => {
      try {
        await requestAppleSpeechPermission();
        await refreshAppleNativeReadiness();
      } catch (error) {
        console.error(
          "Failed to auto-request Apple native permissions:",
          error,
        );
      } finally {
        setPermissionActionBusy(false);
      }
    })();
  }, [
    appleSpeechReadiness,
    defaultProvider,
    dictationProvider,
    meetingProvider,
    permissionActionBusy,
    permissionDiagnostics?.speechRecognitionReady,
    selectedRouteUsesAppleNative,
    useSharedAsrSelection,
  ]);

  const appleNativePermissionRows = [
    {
      key: "speech",
      label: "Speech Recognition",
      ready: permissionDiagnostics?.speechRecognitionReady ?? false,
      action: "Open Speech Settings",
      onClick: () => void openPermissionSettings("speech"),
      // macOS named this permission in the era when speech recognition meant
      // sending audio to Apple. It does not mean that here: Plainsong runs
      // both Apple engines with server recognition off, so granting it lets
      // macOS transcribe on this Mac and nothing else. Saying only "required
      // for transcription" left the reader to assume the older meaning.
      detail:
        "macOS asks for this before it will transcribe. It records your consent to on-device processing; it is not permission to use a server, and Plainsong keeps Apple's server fallback off.",
    },
    {
      key: "accessibility",
      label: "Accessibility",
      ready: permissionDiagnostics?.accessibilityReady ?? false,
      action: "Open Accessibility",
      onClick: () => void openPermissionSettings("accessibility"),
      detail: appleNativeUsedForDictation
        ? "Preferred direct path so Plainsong can insert text directly into the focused field."
        : "Needed when you later use Apple Speech for dictation insertion.",
    },
    {
      key: "keyboardEvents",
      label: "Keyboard Events",
      ready: permissionDiagnostics?.postEventReady ?? false,
      action: "Open Accessibility",
      onClick: () => void openPermissionSettings("accessibility"),
      detail: appleNativeUsedForDictation
        ? "Fallback native Cmd+V path when direct Accessibility insertion cannot be used."
        : "Optional fallback for native Cmd+V insertion when you later use Apple Speech dictation.",
    },
  ];

  const appleNativeTranscriptionReady =
    appleSpeechReadiness?.ready ??
    !!permissionDiagnostics?.speechRecognitionReady;
  const appleNativeAccessibilityReady =
    !!permissionDiagnostics?.accessibilityReady;
  const appleNativeAccessibilityTrusted =
    permissionDiagnostics?.accessibilityTrusted ??
    appleNativeAccessibilityReady;
  const postEventReady = !!permissionDiagnostics?.postEventReady;
  const appleNativeCursorInsertionReady =
    !!permissionDiagnostics?.cursorInsertionReady;
  const preferredInsertStrategy =
    permissionDiagnostics?.preferredInsertStrategy ?? null;
  const lastCursorInsertStatus = permissionDiagnostics?.lastCursorInsertStatus;
  const lastCursorInsertFailure = lastCursorInsertStatus?.copiedOnly
    ? (lastCursorInsertStatus.message ??
      "Plainsong copied the dictation result, but macOS blocked the final paste.")
    : null;
  const needsInsertRepair =
    !permissionDiagnostics?.runningFromDiskImage &&
    (!!lastCursorInsertFailure || !appleNativeAccessibilityTrusted) &&
    (!appleNativeCursorInsertionReady ||
      /grant accessibility|not enabled for nautilus|re-enable nautilus|this app copy/i.test(
        lastCursorInsertFailure ?? "",
      ));
  const permissionBadgeLabel = (key: string, ready: boolean) => {
    if (ready) return "Ready";
    if (key === "speech") return "Needs grant";
    if (key === "keyboardEvents") {
      return appleNativeAccessibilityTrusted
        ? "Optional"
        : appleNativeUsedForDictation
          ? "Fallback off"
          : "Optional";
    }
    if (
      key === "accessibility" &&
      appleNativeCursorInsertionReady &&
      postEventReady
    ) {
      return "Direct text unverified";
    }
    return appleNativeUsedForDictation ? "Needed for insert" : "Optional";
  };
  const visibleAppleNativeNotes =
    permissionDiagnostics?.notes?.filter((note) => {
      if (
        appleNativeAccessibilityTrusted &&
        note.includes("System Events automation fallback is disabled")
      ) {
        return false;
      }
      return true;
    }) ?? [];

  const renderAppleNativeSetupCard = () => {
    if (!selectedRouteUsesAppleNative) {
      return null;
    }

    const routeSummary = appleNativeUsedForDictation
      ? "Apple Speech is selected for on-device dictation. It is not used for meetings."
      : "Apple Speech is dictation-only. Choose it in the Dictation lane after readiness is confirmed.";

    const overallReady = appleNativeTranscriptionReady;

    return (
      <div className="rounded-lg border border-border bg-muted/10 p-4 space-y-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Badge
              variant={overallReady ? "default" : "secondary"}
              className={overallReady ? "bg-gold" : ""}
            >
              {overallReady ? "Ready for transcription" : "Setup required"}
            </Badge>
            <span className="text-sm font-medium">Apple Speech setup</span>
          </div>
          <p className="text-sm text-muted-foreground">
            {routeSummary} Audio is sent only to Apple's on-device recognizer;
            Apple server fallback is disabled. For cursor insertion, Plainsong
            first tries direct Accessibility text insertion and can fall back to
            a native Cmd+V keyboard path when macOS allows it for this app copy.
          </p>
          {appleSpeechReadiness ? (
            <div className="rounded-md border bg-background/60 p-3">
              <p className="text-sm font-medium">
                {appleSpeechReadiness.message}
              </p>
              {appleSpeechReadiness.setupAction ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {appleSpeechReadiness.setupAction}
                </p>
              ) : null}
              <p className="mt-1 text-sm text-muted-foreground">
                {describeAppleSpeechEngine(appleSpeechReadiness)}
              </p>
              {appleSpeechLanguageInstallable ? (
                <div className="mt-2 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={languageInstallBusy}
                      onClick={() => void installAppleSpeechLanguageAssets()}
                    >
                      {languageInstallBusy
                        ? "Installing language…"
                        : "Install language"}
                    </Button>
                    {languageInstallBusy ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={languageInstallCancelling}
                        onClick={() =>
                          void cancelAppleSpeechLanguageAssets()
                        }
                      >
                        {languageInstallCancelling ? "Stopping…" : "Cancel"}
                      </Button>
                    ) : null}
                    {languageInstallProgress ? (
                      <span className="text-sm text-muted-foreground">
                        {languageInstallProgress.message}
                        {languageInstallProgress.stage === "downloading"
                          ? ` ${Math.round(
                              languageInstallProgress.fraction * 100,
                            )}%`
                          : ""}
                      </span>
                    ) : null}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    macOS downloads and stores the language; Plainsong does not
                    control its size and keeps no copy.
                  </p>
                </div>
              ) : null}
              {languageInstallError ? (
                <p className="mt-1 text-sm text-rust">{languageInstallError}</p>
              ) : null}
            </div>
          ) : null}
        </div>

        {appleNativeTranscriptionReady &&
        appleNativeUsedForDictation &&
        !appleNativeCursorInsertionReady ? (
          <div className="rounded-md border border-rust/30 bg-rust/10 p-3">
            <p className="text-sm font-medium text-rust">
              Apple Speech transcription is ready.
            </p>
            <p className="text-xs text-rust/90">
              Cursor insertion is not ready yet. Enable Plainsong in Privacy &
              Security &gt; Accessibility so it can insert text into the target
              app.
            </p>
          </div>
        ) : null}

        {appleNativeTranscriptionReady &&
        appleNativeUsedForDictation &&
        appleNativeCursorInsertionReady &&
        !appleNativeAccessibilityTrusted &&
        preferredInsertStrategy === "simulated_typing" ? (
          <div className="rounded-md border border-rust/30 bg-rust/10 p-3">
            <p className="text-sm font-medium text-rust">
              Apple Speech transcription is ready.
            </p>
            <p className="text-xs text-rust/90">
              Native Cmd+V fallback is available. Direct Accessibility text
              insertion is not currently verified for this app copy.
            </p>
          </div>
        ) : null}

        {lastCursorInsertFailure ? (
          <div className="rounded-md border border-rust/30 bg-rust/10 p-3">
            <p className="text-sm font-medium text-rust">
              Latest dictation fell back to clipboard-only.
            </p>
            <p className="text-xs text-rust/90">
              {lastCursorInsertFailure}
            </p>
          </div>
        ) : null}

        {permissionDiagnostics?.runningFromDiskImage ? (
          <div className="rounded-md border border-rust/30 bg-rust/10 p-3 space-y-2">
            <p className="text-sm font-medium text-rust">
              You are running Plainsong from the mounted DMG, not the installed
              app.
            </p>
            <p className="text-xs text-rust/90">
              macOS permissions granted to the installed app do not apply to the
              disk image copy. Open the installed app in{" "}
              <code>/Applications</code>, then quit this DMG copy.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void openInstalledPlainsongApp()}
              >
                Open installed app
              </Button>
            </div>
          </div>
        ) : null}

        <div className="grid gap-3 md:grid-cols-3">
          {appleNativePermissionRows.map((row) => (
            <div
              key={row.key}
              className="rounded-md border bg-background/60 p-3 space-y-2"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">{row.label}</p>
                <Badge variant="outline" className="border-border bg-muted/30 text-foreground">
                  <span aria-hidden="true" className={row.ready ? "neume neume-lit mr-1" : "neume neume-hollow mr-1"} />
                  {permissionBadgeLabel(row.key, row.ready)}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">{row.detail}</p>
              {!row.ready &&
              !(
                row.key === "keyboardEvents" && appleNativeAccessibilityTrusted
              ) ? (
                <Button size="sm" variant="outline" onClick={row.onClick}>
                  {row.action}
                </Button>
              ) : null}
            </div>
          ))}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={permissionActionBusy}
            onClick={async () => {
              setPermissionActionBusy(true);
              try {
                await requestAppleSpeechPermission();
                await refreshAppleNativeReadiness();
              } catch (error) {
                console.error(
                  "Failed to request Apple native permissions:",
                  error,
                );
              } finally {
                setPermissionActionBusy(false);
              }
            }}
          >
            {permissionActionBusy
              ? "Requesting..."
              : "Request Apple permissions"}
          </Button>
          {needsInsertRepair ? (
            <Button
              size="sm"
              variant="outline"
              disabled={permissionActionBusy}
              onClick={async () => {
                setPermissionActionBusy(true);
                try {
                  const diagnostics = await repairCursorInsertPermissions();
                  setPermissionDiagnostics(diagnostics);
                  await Promise.all([loadProviders(), loadSelectionSettings()]);
                } catch (error) {
                  console.error("Failed to repair insert permissions:", error);
                } finally {
                  setPermissionActionBusy(false);
                }
              }}
            >
              {permissionActionBusy
                ? "Repairing..."
                : "Repair insert permissions"}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            onClick={() => void refreshAppleNativeReadiness()}
          >
            Re-check readiness
          </Button>
        </div>

        {visibleAppleNativeNotes.length ? (
          <div className="space-y-1">
            {visibleAppleNativeNotes.map((note) => (
              <p key={note} className="text-xs text-rust">
                {note}
              </p>
            ))}
          </div>
        ) : null}
      </div>
    );
  };

  const renderCursorInsertToolsCard = () => {
    if (!permissionDiagnostics) {
      return null;
    }

    const insertReady = !!permissionDiagnostics.cursorInsertionReady;
    const insertDetail = lastCursorInsertFailure
      ? lastCursorInsertFailure
      : insertReady
        ? "Plainsong is currently reporting that auto-insert can target the active app."
        : "macOS is not currently exposing a working auto-insert path for this app copy.";

    return (
      <div className="rounded-lg border border-border bg-muted/10 p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Badge
                variant={insertReady ? "default" : "secondary"}
                className={insertReady ? "bg-gold" : ""}
              >
                {insertReady
                  ? "Auto-insert ready"
                  : "Auto-insert needs attention"}
              </Badge>
              <span className="text-sm font-medium">Cursor Insert</span>
            </div>
            <p className="text-sm text-muted-foreground">
              This repair path is shared by Whisper, Apple Speech, and every
              other dictation provider on macOS.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={permissionActionBusy}
              onClick={async () => {
                setPermissionActionBusy(true);
                try {
                  const diagnostics = await repairCursorInsertPermissions();
                  setPermissionDiagnostics(diagnostics);
                  await Promise.all([loadProviders(), loadSelectionSettings()]);
                } catch (error) {
                  console.error("Failed to repair insert permissions:", error);
                } finally {
                  setPermissionActionBusy(false);
                }
              }}
            >
              {permissionActionBusy
                ? "Repairing..."
                : "Repair insert permissions"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void openPermissionSettings("accessibility")}
            >
              Open Accessibility
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void refreshAppleNativeReadiness()}
            >
              Re-check readiness
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{insertDetail}</p>
      </div>
    );
  };

  const renderProviderCard = (provider: AsrProviderInfo) => {
    const selection = getProviderSelectionStatus(provider);
    const runtimeIssue =
      selection.reason === "runtime_unavailable"
        ? (provider.runtimeMessage ?? "Runtime setup required.")
        : null;
    const providerError = providerErrors[provider.providerType];
    const modelOptions = provider.modelOptions ?? [];
    const selectedModelId =
      provider.selectedModelId || modelOptions[0]?.id || "";

    return (
      <Card
        key={provider.providerType}
        className={cn(
          "transition-all",
          defaultProvider === provider.providerType &&
            "border-gold/40 ring-1 ring-gold",
        )}
      >
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-muted/20 flex items-center justify-center text-muted-foreground">
                {getProviderIcon(provider.providerType)}
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <CardTitle className="font-serif text-lg font-semibold">
                    {provider.name}
                  </CardTitle>
                  {defaultProvider === provider.providerType ? (
                    <Badge variant="outline" className="text-xs">
                      Default
                    </Badge>
                  ) : null}
                </div>
                <CardDescription className="mt-1">
                  {provider.description}
                </CardDescription>
                {describeCloudDictationVocabularyNote(provider.providerType) ? (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {describeCloudDictationVocabularyNote(provider.providerType)}
                  </p>
                ) : null}
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
                <div className="rubric-muted">Size</div>
                <div className="mt-0.5 font-medium tabular-nums">
                  {/* Rust's `size_mb` is MiB despite the name -- see the unit
                      note on AsrModelCapability.sizeMib. */}
                  {provider.modelInfo.sizeMb} MiB
                </div>
              </div>
              <div className="p-2 bg-muted rounded-lg">
                <div className="rubric-muted">
                  Model / Parameters
                </div>
                <div className="mt-0.5 font-medium">
                  {provider.modelInfo.name || provider.modelInfo.parameters}
                </div>
              </div>
              <div className="p-2 bg-muted rounded-lg">
                <div className="rubric-muted">WER</div>
                <div className="mt-0.5 font-medium tabular-nums">
                  {provider.modelInfo.wordErrorRate?.toFixed(2) || "N/A"}%
                </div>
              </div>
              <div className="p-2 bg-muted rounded-lg">
                <div className="rubric-muted">Speed</div>
                <div className="mt-0.5 font-medium tabular-nums">
                  {provider.modelInfo.realTimeFactor?.toFixed(0) || "N/A"}x RTF
                </div>
              </div>
            </div>
          )}

          {provider.modelInfo?.languages &&
            provider.modelInfo.languages.length > 0 && (
              <div>
                <div className="text-sm text-muted-foreground mb-2">
                  Supported Languages ({provider.modelInfo.languages.length})
                </div>
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
              </div>
            )}

          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">Model</Label>
            {modelOptions.length > 1 ? (
              <Select
                value={selectedModelId}
                onValueChange={(value) => {
                  void handleModelChange(provider.providerType, value);
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select model" />
                </SelectTrigger>
                <SelectContent>
                  {modelOptions.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
                  {provider.engineDiagnostics.activeEngine ??
                    "provider_default"}
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
              {provider.engineDiagnostics.notes
                .slice(0, 2)
                .map((note, index) => (
                  <p
                    key={`${provider.providerType}-engine-note-${index}`}
                    className="text-muted-foreground"
                  >
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
                  className="text-xs text-muted-foreground hover:underline"
                >
                  Learn more
                </a>
              )}
            </div>
            <div className="flex items-center gap-2">
              {selection.selectable ? (
                <>
                  <Button
                    variant={
                      defaultProvider === provider.providerType
                        ? "default"
                        : "outline"
                    }
                    size="sm"
                    onClick={() => handleSetDefault(provider.providerType)}
                  >
                    {defaultProvider === provider.providerType
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
                      {(() => {
                        const cap = getAsrModelCapability(
                          provider.providerType,
                          provider.selectedModelId,
                        );
                        return cap
                          ? `Download (${formatModelSize(cap.sizeMib)})`
                          : "Download";
                      })()}
                    </Button>
                  ) : null}
                  {selection.reason === "runtime_unavailable" ? (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          void copySetupCommand(provider.providerType)
                        }
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
                            console.warn(
                              "Failed to refresh runtime probes:",
                              error,
                            );
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
                <span
                  role="status"
                  aria-label={`${provider.name} is unavailable until its runtime is set up. Use the setup steps below.`}
                  className="inline-flex items-center gap-1.5 rounded-md border border-rust/30 bg-rust/10 px-2.5 py-1.5 text-xs font-medium text-rust"
                >
                  <span aria-hidden="true" className="neume neume-rust" />
                  Runtime setup required
                </span>
              ) : selection.reason === "not_enabled" ? (
                <span
                  role="status"
                  aria-label={`${provider.name} is not enabled in this build and cannot be selected.`}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/30 px-2.5 py-1.5 text-xs font-medium text-muted-foreground"
                >
                  <span aria-hidden="true" className="neume neume-hollow" />
                  Not enabled
                </span>
              ) : null}
            </div>
          </div>
          {(runtimeIssue || providerError) && (
            <div className="space-y-2 rounded-md border border-rust/30 bg-rust/10 px-3 py-2 text-xs text-rust">
              <p>{providerError ?? runtimeIssue}</p>
              {selection.reason === "runtime_unavailable" && (
                <>
                  {provider.runtimeDetails?.missingFiles?.length ? (
                    <p className="text-rust/90">
                      Missing:{" "}
                      <span className="font-mono">
                        {provider.runtimeDetails.missingFiles.join(", ")}
                      </span>
                    </p>
                  ) : null}
                  <p className="text-rust/90">
                    How to enable:{" "}
                    <span className="font-mono">
                      {provider.runtimeDetails?.setupAction ??
                        providerSetupCommand(provider.providerType)}
                    </span>
                  </p>
                  {provider.runtimeDetails?.pythonPath ? (
                    <p className="text-rust/90">
                      Detected Python:{" "}
                      <span className="font-mono">
                        {provider.runtimeDetails.pythonPath}
                      </span>
                    </p>
                  ) : null}
                </>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    );
  };

  return (
    <div className={cn("space-y-6", className)}>
      <Tabs defaultValue="providers" className="space-y-4">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="providers">Providers</TabsTrigger>
          <TabsTrigger value="benchmark">Benchmark</TabsTrigger>
        </TabsList>

        <TabsContent value="providers" className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="font-serif text-lg font-semibold">
                Engine status
              </CardTitle>
              <CardDescription>
                Which model each task uses is chosen in Settings &rarr; Models.
                This is the state of the engines behind that choice.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="max-w-md space-y-1.5 rounded-xl border bg-background/70 p-4">
                <Label className="text-sm text-muted-foreground">
                  Meeting quality policy
                </Label>
                <Select
                  value={meetingRoutePolicy}
                  onValueChange={(value) => {
                    void persistSelectionSettings({
                      meetingRoutePolicy: value as
                        | "prefer_local"
                        | "best_available",
                    }).catch((error) => {
                      console.error(
                        "Failed to update meeting route policy:",
                        error,
                      );
                    });
                  }}
                >
                  <SelectTrigger className="w-full" aria-label="Meeting quality policy">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="prefer_local">Prefer local</SelectItem>
                    <SelectItem value="best_available">Best available</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-sm leading-6 text-muted-foreground">
                  Which meeting engine Models offers first: the strongest
                  local one, or a cloud route when you have a key for it.
                </p>
              </div>

              {inventory.length === 0 && isLoading ? (
                <div className="rounded-xl border bg-muted/10 p-6 text-center">
                  <p className="text-sm text-muted-foreground">
                    Reading the installed engines…
                  </p>
                </div>
              ) : null}

              {renderAppleNativeSetupCard()}
              {renderCursorInsertToolsCard()}

              <div className="space-y-1">
                {useSharedAsrSelection
                  ? renderRouteStatus("Shared route", defaultProvider)
                  : renderRouteStatus("Dictation route", dictationProvider)}
                {!useSharedAsrSelection
                  ? renderRouteStatus("Meeting route", meetingProvider)
                  : null}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="font-serif text-lg font-semibold">
                Downloads & Diagnostics
              </CardTitle>
              <CardDescription>
                Model downloads, compatibility tuning, and repair tools for
                power users.
              </CardDescription>
            </CardHeader>
            <CardContent className="pt-0">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowAdvancedTools((value) => !value)}
              >
                {showAdvancedTools ? "Hide tools" : "Show tools"}
              </Button>
            </CardContent>
          </Card>
          {showAdvancedTools && platformSettings ? (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="font-serif text-lg font-semibold">
                  Compatibility & Runtime Tuning
                </CardTitle>
                <CardDescription>
                  Optional macOS and Windows tuning for compatibility, local
                  performance, and repair.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-3 md:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label className="text-sm text-muted-foreground">Mode</Label>
                    <Select
                      value={platformSettings.mode}
                      disabled={platformSaveBusy}
                      onValueChange={(value) => {
                        const next: PlatformOptimizationSettings = {
                          ...platformSettings,
                          mode: value as "auto" | "manual",
                        };
                        void persistPlatformSettings(next);
                      }}
                    >
                      <SelectTrigger className="w-full" aria-label="Mode">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">Auto</SelectItem>
                        <SelectItem value="manual">Manual</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-sm text-muted-foreground">
                      Fallback policy
                    </Label>
                    <Select
                      value={platformSettings.fallbackPolicy}
                      disabled={platformSaveBusy}
                      onValueChange={(value) => {
                        const next: PlatformOptimizationSettings = {
                          ...platformSettings,
                          fallbackPolicy: value as
                            | "local_only"
                            | "allow_cloud"
                            | "fail_fast",
                        };
                        void persistPlatformSettings(next);
                      }}
                    >
                      <SelectTrigger className="w-full" aria-label="Fallback policy">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="local_only">Local only</SelectItem>
                        <SelectItem value="allow_cloud">Allow cloud</SelectItem>
                        <SelectItem value="fail_fast">Fail fast</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <div className="flex items-center justify-between rounded-md border px-3 py-2.5">
                    <Label className="text-sm">Allow MLX acceleration routes</Label>
                    <Switch
                      checked={platformSettings.macos.mlxEnabled}
                      disabled={platformSaveBusy}
                      onCheckedChange={(checked) => {
                        const next: PlatformOptimizationSettings = {
                          ...platformSettings,
                          macos: {
                            ...platformSettings.macos,
                            mlxEnabled: checked,
                          },
                        };
                        void persistPlatformSettings(next);
                      }}
                    />
                  </div>
                  <div className="flex items-center justify-between rounded-md border px-3 py-2.5">
                    <Label className="text-sm">Windows Foundry Local</Label>
                    <Switch
                      checked={platformSettings.windows.foundryEnabled}
                      disabled={platformSaveBusy}
                      onCheckedChange={(checked) => {
                        const next: PlatformOptimizationSettings = {
                          ...platformSettings,
                          windows: {
                            ...platformSettings.windows,
                            foundryEnabled: checked,
                          },
                        };
                        void persistPlatformSettings(next);
                      }}
                    />
                  </div>
                </div>

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
                    {platformSettings.manualEnginePriority.map(
                      (engineId, index) => (
                        <div
                          key={`${engineId}-${index}`}
                          className="flex flex-wrap items-center gap-2"
                        >
                          <Select
                            value={engineId}
                            disabled={platformSaveBusy}
                            onValueChange={(value) => {
                              const nextPriority = [
                                ...platformSettings.manualEnginePriority,
                              ];
                              nextPriority[index] = value;
                              const next: PlatformOptimizationSettings = {
                                ...platformSettings,
                                manualEnginePriority: nextPriority,
                              };
                              void persistPlatformSettings(next);
                            }}
                          >
                            <SelectTrigger className="min-w-0 flex-1" aria-label={`Engine priority ${index + 1}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {manualEngineOptions
                                .filter(
                                  (option) =>
                                    option.value === engineId ||
                                    !platformSettings.manualEnginePriority.includes(
                                      option.value,
                                    ),
                                )
                                .map((option) => (
                                  <SelectItem key={option.value} value={option.value}>
                                    {option.label}
                                  </SelectItem>
                                ))}
                            </SelectContent>
                          </Select>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={platformSaveBusy || index === 0}
                            onClick={() => {
                              if (index === 0) return;
                              const nextPriority = [
                                ...platformSettings.manualEnginePriority,
                              ];
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
                              platformSaveBusy ||
                              index ===
                                platformSettings.manualEnginePriority.length - 1
                            }
                            onClick={() => {
                              if (
                                index ===
                                platformSettings.manualEnginePriority.length - 1
                              )
                                return;
                              const nextPriority = [
                                ...platformSettings.manualEnginePriority,
                              ];
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
                              const nextPriority =
                                platformSettings.manualEnginePriority.filter(
                                  (_value, currentIndex) =>
                                    currentIndex !== index,
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
                      ),
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        platformSaveBusy ||
                        platformSettings.manualEnginePriority.length >=
                          manualEngineOptions.length
                      }
                      onClick={() => {
                        const nextOption = manualEngineOptions.find(
                          (option) =>
                            !platformSettings.manualEnginePriority.includes(
                              option.value,
                            ),
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
                      Advanced routing is for runtime tuning only. Native Apple
                      and Windows speech are selected in the main route picker
                      above.
                    </p>
                  </div>
                ) : null}

                {platformSaveError ? (
                  <p className="text-xs text-destructive">
                    {platformSaveError}
                  </p>
                ) : null}
              </CardContent>
            </Card>
          ) : null}
          {showAdvancedTools ? (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="font-serif text-lg font-semibold">
                  Local Model Cache Repair
                </CardTitle>
                <CardDescription>
                  Deletes only invalid local ASR artifacts, then re-checks
                  runtime probes.
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
                  <p className="text-xs text-muted-foreground">
                    {repairSummary}
                  </p>
                ) : null}
              </CardContent>
            </Card>
          ) : null}
          {showAdvancedTools ? (
            <div className="grid gap-4">
              {providers.length === 0 ? (
                <Card>
                  <CardContent className="p-6 text-center">
                    <p className="text-muted-foreground">
                      Loading providers...
                    </p>
                    <p className="text-xs text-muted-foreground mt-2">
                      This may take up to 15 seconds on first load
                    </p>
                  </CardContent>
                </Card>
              ) : (
                <>
                  {providers.map((provider) => renderProviderCard(provider))}
                </>
              )}
            </div>
          ) : null}
        </TabsContent>

        <TabsContent value="benchmark" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 font-serif font-semibold">
                <BarChart3 className="h-5 w-5" />
                Performance Benchmark
              </CardTitle>
              <CardDescription>
                Compare transcription speed and accuracy across all available
                providers
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-center p-8 border-2 border-dashed rounded-lg">
                <div className="text-center">
                  <FileAudio className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
                  <p className="text-sm text-muted-foreground mb-4">
                    Upload a WAV test audio file to benchmark all available
                    providers
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
                    <Button
                      variant="outline"
                      onClick={() => benchmarkFileInputRef.current?.click()}
                    >
                      Choose WAV File
                    </Button>
                    {benchmarkFileName ? (
                      <p className="text-xs text-muted-foreground">
                        {benchmarkFileName}
                      </p>
                    ) : null}
                  </div>
                  <Button
                    className="mt-3"
                    onClick={runBenchmark}
                    disabled={isBenchmarking || !benchmarkFileName}
                  >
                    <Clock className="h-4 w-4 mr-2" />
                    {isBenchmarking ? "Running..." : "Run Benchmark"}
                  </Button>
                  {benchmarkError && (
                    <p className="mt-3 rounded-md bg-rust/10 p-2 text-xs text-rust">
                      {benchmarkError}
                    </p>
                  )}
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
                          {result.modelId} · {result.runtimeStatus} ·
                          Confidence: {(result.confidence * 100).toFixed(1)}%
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Transcript:{" "}
                          {result.nonEmptyTranscript ? "non-empty" : "empty"}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="font-mono font-medium tabular-nums">
                          {(result.processingTimeMs / 1000).toFixed(2)}s
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Processing time
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {benchmarkHistory.length > 0 && (
                <div className="space-y-2 pt-2">
                  <p className="rubric-muted">
                    Recent benchmark history
                  </p>
                  {benchmarkHistory.map((entry) => (
                    <div
                      key={entry.id}
                      className="flex items-center justify-between rounded-lg border p-2 text-xs"
                    >
                      <div>
                        <p className="font-medium">{entry.providerName}</p>
                        <p className="text-muted-foreground">
                          {entry.modelId} · {entry.runtimeStatus}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="font-mono tabular-nums">{(entry.processingTimeMs / 1000).toFixed(2)}s</p>
                        <p className="text-muted-foreground tabular-nums">
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
              <CardTitle className="font-serif font-semibold">Provider Status</CardTitle>
              <CardDescription>
                Production availability for ASR providers in this build
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4 text-sm">
                <div className="p-3 bg-muted/50 rounded-lg">
                  <p className="font-medium mb-1">Whisper (Enabled)</p>
                  <p className="text-muted-foreground">
                    Production local transcription provider. Supports model
                    selection including turbo variants. The multilingual
                    small, medium, large-v3 and large-v3-turbo models can also
                    run meetings (100 languages, on the GPU, slower than
                    Parakeet); tiny, base and every .en model stay dictation-only.
                  </p>
                </div>
                <div className="p-3 bg-muted/50 rounded-lg">
                  <p className="font-medium mb-1">
                    Parakeet (Enabled when runtime ready)
                  </p>
                  <p className="text-muted-foreground">
                    Uses a local NeMo runtime bridge. Provider becomes
                    selectable only when model files and runtime health checks
                    are both ready.
                  </p>
                </div>
                <div className="p-3 bg-muted/50 rounded-lg">
                  <p className="font-medium mb-1">
                    Distil Whisper (Enabled)
                  </p>
                  <p className="text-muted-foreground">
                    Native local Distil runtime using model artifacts from
                    distil-large-v3.5.
                  </p>
                </div>
                <div className="p-3 bg-muted/50 rounded-lg">
                  <p className="font-medium mb-1">
                    Whisper Candle (Experimental)
                  </p>
                  <p className="text-muted-foreground">
                    Uses Whisper Large V3 Turbo through the native Candle
                    runtime. Best for Apple Silicon dictation experiments after
                    the local bundle is downloaded.
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
