import { useState, useEffect, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";
import { normalizeDownloadStatus } from "@/lib/download-status";
import { getProviderSelectionStatus } from "@/lib/asr-provider-selection";
import {
  refreshAsrRuntimeProbes,
  repairLocalModelCache,
  getSettings,
  saveSettings,
  getPermissionDiagnostics,
  openPermissionSettings,
  openInstalledNautilusApp,
  requestDictationPermissions,
  type PermissionDiagnostics,
} from "@/lib/tauri";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
  const [defaultModelId, setDefaultModelId] = useState("distil-large-v3.5");
  const [useSharedAsrSelection, setUseSharedAsrSelection] = useState(true);
  const [dictationProvider, setDictationProvider] = useState<AsrProviderType>("distil_whisper");
  const [dictationModelId, setDictationModelId] = useState("distil-large-v3.5");
  const [meetingProvider, setMeetingProvider] = useState<AsrProviderType>("distil_whisper");
  const [meetingModelId, setMeetingModelId] = useState("distil-large-v3.5");
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
  const [showAdvancedTools, setShowAdvancedTools] = useState(false);
  const [permissionActionBusy, setPermissionActionBusy] = useState(false);
  const [permissionDiagnostics, setPermissionDiagnostics] = useState<PermissionDiagnostics | null>(null);
  const benchmarkFileInputRef = useRef<HTMLInputElement | null>(null);
  const autoPromptedNativePermissionRef = useRef<string | null>(null);

  const manualEngineOptions = [
    { value: "provider_default", label: "Provider default" },
    { value: "macos_mlx_sidecar", label: "macOS MLX sidecar" },
    { value: "windows_foundry_local", label: "Windows Foundry Local" },
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

  const withoutNativeRouteOverrides = (
    settings: PlatformOptimizationSettings
  ): PlatformOptimizationSettings => {
    const nextPriority = settings.manualEnginePriority.filter(
      (engine) => engine !== "macos_apple_speech" && engine !== "windows_sdk_dictation"
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
    loadSelectionSettings();
    loadBenchmarkHistory();
    loadPlatformSettings();
    void refreshPermissionDiagnostics();

    // Listen for download progress events
    void listen<[AsrProviderType, number]>("asr-download-progress", (event) => {
      const [providerType, progress] = event.payload;
      setDownloadProgress((prev) => ({ ...prev, [providerType]: progress }));
    }).then(() => {
      // Cleanup if component unmounts - simpler to just let it leak in this top-level component 
      // or store unlisten function in a ref if strictly needed. 
      // For now, this is acceptable for a main view component.
    }).catch((error) => {
      console.warn("Failed to subscribe to ASR download progress:", error);
    });
  }, []);

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

  const loadPlatformSettings = async () => {
    try {
      const settings = await getSettings();
      const normalized = withNormalizedManualPriority(
        withoutNativeRouteOverrides(
          settings.transcription.platformOptimization ?? defaultPlatformSettings()
        )
      );
      setPlatformSettings(normalized);

      if (
        JSON.stringify(normalized) !==
        JSON.stringify(settings.transcription.platformOptimization ?? defaultPlatformSettings())
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

  const loadSelectionSettings = async () => {
    try {
      const settings = await getSettings();
      setDefaultProvider((settings.transcription.defaultProvider as AsrProviderType) ?? "distil_whisper");
      setDefaultModelId(settings.transcription.selectedModelId ?? "distil-large-v3.5");
      setUseSharedAsrSelection(settings.transcription.useSharedAsrSelection ?? true);
      setDictationProvider(
        (settings.transcription.dictationProvider as AsrProviderType) ??
          (settings.transcription.defaultProvider as AsrProviderType) ??
          "distil_whisper"
      );
      setDictationModelId(
        settings.transcription.dictationModelId ??
          settings.transcription.selectedModelId ??
          "distil-large-v3.5"
      );
      setMeetingProvider(
        (settings.transcription.meetingProvider as AsrProviderType) ??
          (settings.transcription.defaultProvider as AsrProviderType) ??
          "distil_whisper"
      );
      setMeetingModelId(
        settings.transcription.meetingModelId ??
          settings.transcription.selectedModelId ??
          "distil-large-v3.5"
      );
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
  }) => {
    const settings = await getSettings();
    const nextUseShared = updates.useSharedAsrSelection ?? useSharedAsrSelection;
    const nextDefaultProvider = updates.defaultProvider ?? defaultProvider;
    const nextSelectedModelId = updates.selectedModelId ?? defaultModelId;
    const nextDictationProvider = updates.dictationProvider ?? dictationProvider;
    const nextDictationModelId = updates.dictationModelId ?? dictationModelId;
    const nextMeetingProvider = updates.meetingProvider ?? meetingProvider;
    const nextMeetingModelId = updates.meetingModelId ?? meetingModelId;

    await saveSettings({
      ...settings,
      transcription: {
        ...settings.transcription,
        useSharedAsrSelection: nextUseShared,
        defaultProvider: nextDefaultProvider,
        selectedModelId: nextSelectedModelId,
        dictationProvider: nextUseShared ? nextDefaultProvider : nextDictationProvider,
        dictationModelId: nextUseShared ? nextSelectedModelId : nextDictationModelId,
        meetingProvider: nextUseShared ? nextDefaultProvider : nextMeetingProvider,
        meetingModelId: nextUseShared ? nextSelectedModelId : nextMeetingModelId,
      },
    });

    setUseSharedAsrSelection(nextUseShared);
    setDefaultProvider(nextDefaultProvider);
    setDefaultModelId(nextSelectedModelId);
    setDictationProvider(nextUseShared ? nextDefaultProvider : nextDictationProvider);
    setDictationModelId(nextUseShared ? nextSelectedModelId : nextDictationModelId);
    setMeetingProvider(nextUseShared ? nextDefaultProvider : nextMeetingProvider);
    setMeetingModelId(nextUseShared ? nextSelectedModelId : nextMeetingModelId);
    await loadProviders();
  };

  const providerByType = (providerType: AsrProviderType) =>
    providers.find((provider) => provider.providerType === providerType);

  const modelOptionsForProvider = (providerType: AsrProviderType) =>
    providerByType(providerType)?.modelOptions ?? [];

  const providerUsesManagedModel = (providerType: AsrProviderType) =>
    providerType === "macos_apple_speech" || providerType === "windows_sdk_dictation";

  const managedModelLabel = (providerType: AsrProviderType) =>
    providerType === "macos_apple_speech"
      ? "Built into macOS"
      : providerType === "windows_sdk_dictation"
        ? "Built into Windows"
        : "Built into your system";

  const handleSetDefault = async (providerType: AsrProviderType) => {
    const selected = providers.find((provider) => provider.providerType === providerType);
    if (!selected?.inferenceEnabled) {
      console.warn(`${providerType} is not enabled for inference in this build`);
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
      if (defaultProvider === providerType) {
        setDefaultModelId(modelId);
      }
      if (dictationProvider === providerType) {
        setDictationModelId(modelId);
      }
      if (meetingProvider === providerType) {
        setMeetingModelId(modelId);
      }
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
      case "macos_apple_speech":
        return <Mic className="h-5 w-5" />;
      case "moonshine":
        return <Moon className="h-5 w-5" />;
      case "voxtral":
        return <Mic className="h-5 w-5" />;
      case "windows_sdk_dictation":
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
      case "macos_apple_speech":
        return "Grant Nautilus Speech Recognition access in macOS System Settings > Privacy & Security > Speech Recognition";
      case "moonshine":
        return "Use the Download button to fetch the Moonshine ONNX model (no Python needed)";
      case "voxtral":
        return "Choose Voxtral local/cloud mode. Local mode requires Python (torch, transformers, librosa, soundfile) plus downloaded model assets. Cloud mode requires MISTRAL_API_KEY.";
      case "windows_sdk_dictation":
        return "Use a Windows x86_64 build with Windows speech recognition components available, or pick another ASR provider";
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

  const renderRouteStatus = (label: string, providerType: AsrProviderType) => {
    const provider = providerByType(providerType);
    if (!provider) return null;
    const selection = getProviderSelectionStatus(provider);
    if (selection.reason === null) {
      return (
        <p className="text-xs text-muted-foreground">
          {label}: {provider.name} is ready.
        </p>
      );
    }
    const canRequestSpeechPermission = providerType === "macos_apple_speech";
    return (
      <div className="space-y-2">
        <p className="text-xs text-amber-300">
          {label}: {provider.runtimeMessage ?? `${provider.name} is not ready yet.`}{" "}
          {provider.runtimeDetails.setupAction ?? "Choose another provider if you need to keep working."}
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
                  await requestDictationPermissions();
                  await refreshPermissionDiagnostics();
                  await loadProviders();
                  await loadSelectionSettings();
                } catch (error) {
                  console.error("Failed to request dictation permissions:", error);
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
                  console.error("Failed to open speech permission settings:", error);
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

  const selectedRouteUsesAppleNative = useSharedAsrSelection
    ? defaultProvider === "macos_apple_speech"
    : dictationProvider === "macos_apple_speech" || meetingProvider === "macos_apple_speech";

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

    const promptKey = useSharedAsrSelection ? "shared" : `${dictationProvider}:${meetingProvider}`;
    if (autoPromptedNativePermissionRef.current === promptKey) {
      return;
    }

    autoPromptedNativePermissionRef.current = promptKey;
    setPermissionActionBusy(true);
    void (async () => {
      try {
        await requestDictationPermissions();
        await Promise.all([
          refreshPermissionDiagnostics(),
          loadProviders(),
          loadSelectionSettings(),
        ]);
      } catch (error) {
        console.error("Failed to auto-request Apple native permissions:", error);
      } finally {
        setPermissionActionBusy(false);
      }
    })();
  }, [
    defaultProvider,
    dictationProvider,
    meetingProvider,
    permissionActionBusy,
    permissionDiagnostics?.speechRecognitionReady,
    selectedRouteUsesAppleNative,
    useSharedAsrSelection,
  ]);

  const renderModelControl = (
    label: string,
    providerType: AsrProviderType,
    value: string,
    onChange: (modelId: string) => void
  ) => {
    if (providerUsesManagedModel(providerType)) {
      return (
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">{label}</span>
          <div className="w-full rounded-md border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
            {managedModelLabel(providerType)}
          </div>
        </label>
      );
    }

    return (
      <label className="space-y-1 text-sm">
        <span className="text-muted-foreground">{label}</span>
        <select
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          {modelOptionsForProvider(providerType).map((option) => (
            <option key={`${label}-${option.id}`} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  };

  const appleNativePermissionRows = [
    {
      key: "speech",
      label: "Speech Recognition",
      ready: permissionDiagnostics?.speechRecognitionReady ?? false,
      action: "Open Speech Settings",
      onClick: () => void openPermissionSettings("speech"),
      detail: "Required for Apple Native transcription.",
    },
    {
      key: "accessibility",
      label: "Accessibility",
      ready: permissionDiagnostics?.accessibilityReady ?? false,
      action: "Open Accessibility",
      onClick: () => void openPermissionSettings("accessibility"),
      detail: appleNativeUsedForDictation
        ? "Required to insert dictation at the cursor."
        : "Needed when you later use Apple Native for dictation insertion.",
    },
    {
      key: "automation",
      label: "Automation",
      ready: permissionDiagnostics?.automationReady ?? false,
      action: "Open Automation",
      onClick: () => void openPermissionSettings("automation"),
      detail: appleNativeUsedForDictation
        ? "Required so Nautilus can send paste to the frontmost app."
        : "Needed when you later use Apple Native for dictation insertion.",
    },
  ];

  const appleNativeReadyForMeetings = !!permissionDiagnostics?.speechRecognitionReady;
  const appleNativeTranscriptionReady = appleNativeReadyForMeetings;
  const appleNativeCursorInsertionReady =
    !!permissionDiagnostics?.accessibilityReady && !!permissionDiagnostics?.automationReady;

  const renderAppleNativeSetupCard = () => {
    if (!selectedRouteUsesAppleNative) {
      return null;
    }

    const routeSummary = useSharedAsrSelection
      ? "Apple Native is selected for both dictation and meetings."
      : appleNativeUsedForDictation && meetingProvider === "macos_apple_speech"
        ? "Apple Native is selected for dictation and meetings."
        : appleNativeUsedForDictation
          ? "Apple Native is selected for dictation."
          : "Apple Native is selected for meetings.";

    const overallReady = appleNativeTranscriptionReady;

    return (
      <div className="rounded-lg border border-border bg-muted/10 p-4 space-y-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Badge variant={overallReady ? "default" : "secondary"} className={overallReady ? "bg-green-600" : ""}>
              {overallReady ? "Ready for transcription" : "Setup required"}
            </Badge>
            <span className="text-sm font-medium">Apple Native setup</span>
          </div>
          <p className="text-sm text-muted-foreground">
            {routeSummary} Nautilus will request speech access automatically, but macOS cursor insertion also needs Accessibility and Automation.
          </p>
        </div>

        {appleNativeTranscriptionReady && appleNativeUsedForDictation && !appleNativeCursorInsertionReady ? (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
            <p className="text-sm font-medium text-amber-200">
              Apple Native transcription is ready.
            </p>
            <p className="text-xs text-amber-100/90">
              Cursor insertion still depends on Accessibility and Automation. If dictation is already inserting correctly, this readiness check may be stale.
            </p>
          </div>
        ) : null}

        {permissionDiagnostics?.runningFromDiskImage ? (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 space-y-2">
            <p className="text-sm font-medium text-amber-200">
              You are running Nautilus from the mounted DMG, not the installed app.
            </p>
            <p className="text-xs text-amber-100/90">
              macOS permissions granted to the installed app do not apply to the disk image copy.
              Open the installed app in <code>/Applications</code>, then quit this DMG copy.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void openInstalledNautilusApp()}
              >
                Open installed app
              </Button>
            </div>
          </div>
        ) : null}

        <div className="grid gap-3 md:grid-cols-3">
          {appleNativePermissionRows.map((row) => (
            <div key={row.key} className="rounded-md border bg-background/60 p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">{row.label}</p>
                <Badge variant={row.ready ? "default" : "secondary"} className={row.ready ? "bg-green-600" : ""}>
                  {row.ready
                    ? "Ready"
                    : row.key === "speech"
                      ? "Needs grant"
                      : appleNativeUsedForDictation
                        ? "Needed for insert"
                        : "Optional"}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">{row.detail}</p>
              {!row.ready ? (
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
                await requestDictationPermissions();
                await Promise.all([
                  refreshPermissionDiagnostics(),
                  loadProviders(),
                  loadSelectionSettings(),
                ]);
              } catch (error) {
                console.error("Failed to request Apple native permissions:", error);
              } finally {
                setPermissionActionBusy(false);
              }
            }}
          >
            {permissionActionBusy ? "Requesting..." : "Request Apple permissions"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void refreshPermissionDiagnostics()}
          >
            Re-check readiness
          </Button>
        </div>

        {permissionDiagnostics?.notes?.length ? (
          <div className="space-y-1">
            {permissionDiagnostics.notes.map((note) => (
              <p key={note} className="text-xs text-amber-300">
                {note}
              </p>
            ))}
          </div>
        ) : null}
      </div>
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
              <CardTitle className="text-base">Transcription Route</CardTitle>
              <CardDescription>
                Choose one ASR for everything, or split dictation and meeting transcription.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <label className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                <span>Use the same ASR for dictation and meetings</span>
                <input
                  type="checkbox"
                  checked={useSharedAsrSelection}
                  onChange={(event) => {
                    void persistSelectionSettings({
                      useSharedAsrSelection: event.target.checked,
                    }).catch((error) => {
                      console.error("Failed to update shared ASR selection:", error);
                    });
                  }}
                />
              </label>

              <div className={cn("grid gap-4", useSharedAsrSelection ? "md:grid-cols-2" : "md:grid-cols-4")}>
                <label className="space-y-1 text-sm">
                  <span className="text-muted-foreground">
                    {useSharedAsrSelection ? "Shared provider" : "Dictation provider"}
                  </span>
                  <select
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    value={useSharedAsrSelection ? defaultProvider : dictationProvider}
                    onChange={(event) => {
                      const providerType = event.target.value as AsrProviderType;
                      const nextModelId =
                        modelOptionsForProvider(providerType)[0]?.id ?? providerType;
                      const update = useSharedAsrSelection
                        ? {
                            defaultProvider: providerType,
                            selectedModelId: nextModelId,
                          }
                        : {
                            dictationProvider: providerType,
                            dictationModelId: nextModelId,
                          };
                      void (async () => {
                        try {
                          await persistSelectionSettings(update);
                          if (providerType === "macos_apple_speech") {
                            await requestDictationPermissions();
                            await loadProviders();
                            await loadSelectionSettings();
                          }
                        } catch (error) {
                          console.error("Failed to update ASR provider selection:", error);
                        }
                      })();
                    }}
                  >
                    {providers.map((provider) => (
                      <option key={`shared-${provider.providerType}`} value={provider.providerType}>
                        {provider.name}
                      </option>
                    ))}
                  </select>
                </label>
                {renderModelControl(
                  useSharedAsrSelection ? "Shared model" : "Dictation model",
                  useSharedAsrSelection ? defaultProvider : dictationProvider,
                  useSharedAsrSelection ? defaultModelId : dictationModelId,
                  (modelId) => {
                    const update = useSharedAsrSelection
                      ? {
                          selectedModelId: modelId,
                        }
                      : {
                          dictationModelId: modelId,
                        };
                    void persistSelectionSettings(update).catch((error) => {
                      console.error("Failed to update ASR model selection:", error);
                    });
                  }
                )}
                {!useSharedAsrSelection ? (
                  <label className="space-y-1 text-sm">
                    <span className="text-muted-foreground">Meeting provider</span>
                    <select
                      className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                      value={meetingProvider}
                      onChange={(event) => {
                        const providerType = event.target.value as AsrProviderType;
                        const nextModelId =
                          modelOptionsForProvider(providerType)[0]?.id ?? providerType;
                        void (async () => {
                          try {
                            await persistSelectionSettings({
                              meetingProvider: providerType,
                              meetingModelId: nextModelId,
                            });
                            if (providerType === "macos_apple_speech") {
                              await requestDictationPermissions();
                              await loadProviders();
                              await loadSelectionSettings();
                            }
                          } catch (error) {
                            console.error("Failed to update meeting ASR provider:", error);
                          }
                        })();
                      }}
                    >
                      {providers.map((provider) => (
                        <option key={`meeting-${provider.providerType}`} value={provider.providerType}>
                          {provider.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {!useSharedAsrSelection
                  ? renderModelControl("Meeting model", meetingProvider, meetingModelId, (modelId) => {
                      void persistSelectionSettings({
                        meetingModelId: modelId,
                      }).catch((error) => {
                        console.error("Failed to update meeting ASR model:", error);
                      });
                    })
                  : null}
              </div>

              {renderAppleNativeSetupCard()}

              <div className="space-y-1">
                {useSharedAsrSelection
                  ? renderRouteStatus("Shared route", defaultProvider)
                  : renderRouteStatus("Dictation route", dictationProvider)}
                {!useSharedAsrSelection ? renderRouteStatus("Meeting route", meetingProvider) : null}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Downloads & Diagnostics</CardTitle>
              <CardDescription>
                Model downloads, compatibility tuning, and repair tools for power users.
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
                <CardTitle className="text-base">Compatibility & Runtime Tuning</CardTitle>
                <CardDescription>
                  Optional macOS and Windows tuning for compatibility, local performance, and repair.
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
                      Advanced routing is for runtime tuning only. Native Apple and Windows speech are selected in the main route picker above.
                    </p>
                  </div>
                ) : null}

                {platformSaveError ? (
                  <p className="text-xs text-destructive">{platformSaveError}</p>
                ) : null}
              </CardContent>
            </Card>
          ) : null}
          {showAdvancedTools ? (
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
          ) : null}
          {showAdvancedTools ? (
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
                return (
                  <Card
                    key={provider.providerType}
                    className={cn(
                      "transition-all",
                      defaultProvider === provider.providerType && "border-trusted ring-1 ring-trusted"
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
                              {defaultProvider === provider.providerType ? (
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
                        <p className="text-xs text-muted-foreground">Model</p>
                        {modelOptions.length > 1 ? (
                          <select
                            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                            value={selectedModelId}
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
                                onClick={() => handleSetDefault(provider.providerType)}
                              >
                                {defaultProvider === provider.providerType ? "Default" : "Set Default"}
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
          ) : null}
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
