import { describeDictationVocabularyNote } from "@/lib/dictation-ui-message";
import { useState, useEffect, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";
import { normalizeDownloadStatus } from "@/lib/download-status";
import { formatModelSize, getAsrModelCapabilityFor } from "@/lib/asr-capabilities";
import { getProviderSelectionStatus } from "@/lib/asr-provider-selection";
import { AsrBenchmarkResults } from "@/components/asr-benchmark-results";
import { readAsrBenchmarkAudio } from "@/lib/asr-benchmark-audio";
import {
  describeAppleSpeechEngine,
  routeDisplayLabel,
} from "@/lib/asr-route-catalog";
import { selectionStateFromSettings } from "@/lib/asr-route-selection";
import {
  refreshAsrRuntimeProbes,
  repairLocalModelCache,
  getAsrProviderInventory,
} from "@/lib/backend/asr";
import {
  getSettings,
  updateSettings,
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
import { requestSettingsTab } from "@/lib/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  SettingsGroup,
  SettingsMore,
  SettingsRow,
} from "@/components/ui/settings-control";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  const [inventory, setInventory] = useState<AsrProviderInventory[]>([]);
  const [providers, setProviders] = useState<AsrProviderInfo[]>([]);
  const [defaultProvider, setDefaultProvider] =
    useState<AsrProviderType>("whisper");
  const [useSharedAsrSelection, setUseSharedAsrSelection] = useState(true);
  const [dictationProvider, setDictationProvider] =
    useState<AsrProviderType>("distil_whisper");
  const [meetingProvider, setMeetingProvider] =
    useState<AsrProviderType>("distil_whisper");
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
        await updateSettings((draft) => {
          draft.transcription.platformOptimization = withNormalizedManualPriority(
            withoutNativeRouteOverrides(
              draft.transcription.platformOptimization ?? defaultPlatformSettings(),
            ),
          );
        });
      }
    } catch (error) {
      console.error("Failed to load platform optimization settings:", error);
      setPlatformSettings(defaultPlatformSettings());
    }
  };

  /**
   * Writes `platformOptimization` back after the loader or the readiness
   * effect has normalized it.
   *
   * Nothing on screen edits these keys any more -- the "Compatibility &
   * Runtime Tuning" card that did was removed because every control in it was
   * inert on a macOS build (see docs/settings-inventory-2026-10-22.md). What is
   * left is housekeeping, so a failure is logged rather than surfaced: there is
   * no control for the user to retry.
   */
  const persistPlatformSettings = async (
    next: PlatformOptimizationSettings,
  ) => {
    const normalizedNext = withNormalizedManualPriority(next);
    try {
      await updateSettings((draft) => {
        draft.transcription.platformOptimization = normalizedNext;
      });
      setPlatformSettings(normalizedNext);
    } catch (error) {
      console.error("Failed to save platform optimization settings:", error);
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
      setUseSharedAsrSelection(selection.useSharedAsrSelection);
      setDictationProvider(selection.dictationProvider);
      setMeetingProvider(selection.meetingProvider);
    } catch (error) {
      console.error("Failed to load ASR selection settings:", error);
    }
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

  /** The model a task points at, named the way Settings > Models names it. */
  const selectedModelDisplayName = (providerType: AsrProviderType) => {
    const provider = selectionProviderByType(providerType);
    if (!provider) return providerDisplayName(providerType);
    const option = provider.modelOptions.find(
      (candidate) => candidate.id === provider.selectedModelId,
    );
    return option
      ? routeDisplayLabel(providerType, option.id, option.label)
      : provider.name;
  };

  const inventoryReadiness = (provider: SelectionProvider) => {
    const status = normalizeDownloadStatus(provider.downloadStatus);
    if (provider.providerType === "macos_apple_speech" && provider.platformReadiness) {
      return provider.platformReadiness.ready
        ? { tone: "success" as const, label: "Ready on this Mac" }
        : {
            tone: "warning" as const,
            label:
              provider.platformReadiness.status === "authorization_not_determined"
                ? "Permission required"
                : provider.platformReadiness.status === "authorization_denied"
                  ? "Permission denied"
                  : provider.platformReadiness.status === "unsupported_locale"
                    ? "Language not supported"
                    : provider.platformReadiness.status === "helper_missing"
                      ? "Needs repair"
                      : provider.platformReadiness.status === "on_device_unavailable"
                        ? "Not available offline"
                        : "Needs setup",
          };
    }
    if (!provider.inferenceEnabled) {
      return {
        tone: "muted" as const,
        label: "Not available on this Mac",
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
    setBenchmarkResults([]);
    try {
      const fileBytes = await readAsrBenchmarkAudio(selectedFile);
      const results = await invoke<BenchmarkResult[]>(
        "benchmark_asr_providers_bytes",
        {
          audioBytes: Array.from(fileBytes),
        },
      );
      setBenchmarkResults(results);
      if (results.length === 0) {
        setBenchmarkError("No local models were available. Download a model in Providers, then try again.");
      }
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
      case "deepgram":
      case "gemini_transcribe":
      case "mistral_voxtral":
      case "xai_stt":
        return <CloudLightning className="h-5 w-5" />;
      default:
        return <Cpu className="h-5 w-5" />;
    }
  };

  const getDownloadStatusBadge = (provider: AsrProviderInfo) => {
    const normalizedStatus = normalizeDownloadStatus(provider.downloadStatus);
    const activeProgress = downloadProgress[provider.providerType];

    // Determine if this is a large download (>500 MiB) to show a wider bar.
    const cap = getAsrModelCapabilityFor(provider, provider.selectedModelId);
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
        return "Use the Download button to fetch the alternate Whisper Large Turbo. It is experimental and best used for dictation.";
      case "distil_whisper":
        return "Use the Download button to fetch the Distil-Whisper Large v3.5 model (no Python needed)";
      case "macos_apple_speech":
        // The old line was a bare instruction, and macOS named this
        // permission in the era when speech recognition meant sending audio
        // to Apple. On this route nothing is sent anywhere, so the sentence
        // has to say what the grant is actually for before it asks for it.
        return "Grant Speech Recognition in System Settings > Privacy & Security > Speech Recognition. It is consent to on-device processing, not permission to use a server.";
      case "moonshine":
        return "Use the Download button to fetch the selected Moonshine bundle. Tiny is the smallest edge model; Base is the default stable option.";
      case "qwen3_asr":
        return "Use the Download button to fetch the Qwen3-ASR 0.6B model (about 2.0 GB, 7 files). Experimental: tested in English in Plainsong, and built for 30 languages including Chinese, Japanese and Korean. It can be slower than real time.";
      case "cohere_local":
        return "Use the Download button to fetch Cohere Transcribe 03-2026 (about 2.1 GB, 8 files). Experimental and slower than Parakeet: it can't detect a language, so you pick one of its 14, and its timings are estimated rather than measured.";
      case "windows_sdk_dictation":
        return "Use a Windows x86_64 build with Windows speech recognition components available, or pick another speech model";
      case "elevenlabs_scribe":
        return "Add an ElevenLabs API key in Settings > Search & AI > API keys";
      case "openai_cloud":
        return "Add an OpenAI API key in Settings > Search & AI > API keys";
      case "cohere_transcribe":
        return "Add a Cohere API key in Settings > Search & AI > API keys";
      case "deepgram":
        return "Add a Deepgram API key in Settings > Search & AI > API keys";
      case "gemini_transcribe":
        return "Add a Google Gemini API key in Settings > Search & AI > API keys";
      case "mistral_voxtral":
        return "Add a Mistral API key in Settings > Search & AI > API keys";
      case "xai_stt":
        return "Add an xAI API key in Settings > Search & AI > API keys";
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
    const routeLabel = selectedModelDisplayName(providerType);
    if (!provider && lightweightProvider) {
      return (
        <p className="text-sm text-muted-foreground">
          {label}: {routeLabel} · {inventoryReadiness(lightweightProvider).label}
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
        <p className="text-sm text-muted-foreground">
          {label}: {routeLabel} · Ready
        </p>
      );
    }
    const selection = getProviderSelectionStatus(provider);
    if (selection.reason === null) {
      return (
        <p className="text-sm text-muted-foreground">
          {label}: {routeLabel} · Ready
        </p>
      );
    }
    const canRequestSpeechPermission = providerType === "macos_apple_speech";
    return (
      <div className="space-y-2">
        <p className="text-sm text-rust">
          {label}:{" "}
          {provider.runtimeMessage ?? `${routeLabel} is not ready yet.`}{" "}
          {provider.runtimeDetails.setupAction ??
            "Choose another speech model if you need to keep working."}
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
                <p className="mt-1 text-sm text-muted-foreground">
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
            <p className="text-sm text-rust">
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
            <p className="text-sm text-rust">
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
            <p className="text-sm text-rust">
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
            <p className="text-sm text-rust">
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
              {/* A sentence, so it sits on the text-sm body floor (STYLE.md */}
              {/* section 2 and section 7); these details grew from labels into */}
              {/* explanations and text-xs no longer fit them. */}
              <p className="text-sm text-muted-foreground">{row.detail}</p>
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
              <p key={note} className="text-sm text-rust">
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
        ? "Plainsong can type your words into the app you are using."
        : "macOS is not letting this copy of Plainsong type into other apps yet.";

    // The repair and permission buttons live once, under Privacy & data >
    // macOS permissions. This row only reports, and points there.
    return (
      <SettingsRow
        label={
          <span className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className={insertReady ? "neume neume-lit" : "neume neume-rust"}
            />
            {insertReady
              ? "Typing into other apps: ready"
              : "Typing into other apps: needs attention"}
          </span>
        }
        description={insertDetail}
        control={
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void refreshAppleNativeReadiness()}
            >
              Check again
            </Button>
            {!insertReady || lastCursorInsertFailure ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => requestSettingsTab("privacy", "permissions")}
              >
                Fix in Privacy &amp; data
              </Button>
            ) : null}
          </>
        }
      />
    );
  };

  const renderProviderCard = (provider: AsrProviderInfo) => {
    const selection = getProviderSelectionStatus(provider);
    const runtimeIssue =
      selection.reason === "runtime_unavailable"
        ? (provider.runtimeMessage ?? "Needs setup.")
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
                {describeDictationVocabularyNote(provider.providerType) ? (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {describeDictationVocabularyNote(provider.providerType)}
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
                      note on AsrModelCapability.sizeMib. A Parakeet download
                      on Apple Silicon fetches more than its one file. */}
                  {formatModelSize(
                    (provider.modelDownloadBytes?.[provider.selectedModelId] ?? 0) / (1024 * 1024) ||
                      provider.modelInfo.sizeMb,
                  )}
                </div>
              </div>
              <div className="p-2 bg-muted rounded-lg">
                <div className="rubric-muted">
                  Model
                </div>
                <div className="mt-0.5 font-medium">
                  {provider.modelInfo.name || provider.modelInfo.parameters}
                </div>
              </div>
              <div className="p-2 bg-muted rounded-lg">
                <div className="rubric-muted">Word errors</div>
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
                    ? "Needs setup"
                    : provider.runtimeStatus === "missing_model"
                      ? "Model files missing"
                      : "Couldn't start"}
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
                      : "Make default"}
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
                        const cap = getAsrModelCapabilityFor(
                          provider,
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
                              "Failed to refresh speech model checks:",
                              error,
                            );
                          }
                          await loadProviders();
                        }}
                      >
                        Check again
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
                  aria-label={`${provider.name} needs setup before it can be used. Use the setup steps below.`}
                  className="inline-flex items-center gap-1.5 rounded-md border border-rust/30 bg-rust/10 px-2.5 py-1.5 text-xs font-medium text-rust"
                >
                  <span aria-hidden="true" className="neume neume-rust" />
                  Needs setup
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
                    <p className="text-rust">
                      Missing:{" "}
                      <span className="font-mono">
                        {provider.runtimeDetails.missingFiles.join(", ")}
                      </span>
                    </p>
                  ) : null}
                  <p className="text-rust">
                    How to enable:{" "}
                    <span className="font-mono">
                      {provider.runtimeDetails?.setupAction ??
                        providerSetupCommand(provider.providerType)}
                    </span>
                  </p>
                  {provider.runtimeDetails?.pythonPath ? (
                    <p className="text-rust">
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
    <div className={cn("settings-section", className)}>
      <SettingsGroup
        title="Speech model status"
        description="Whether the speech models chosen in Models are ready, and what to do when one is not."
      >
        <div className="space-y-4 py-3.5">
          {inventory.length === 0 && isLoading ? (
            <p className="text-sm text-muted-foreground">
              Reading the speech models on this Mac…
            </p>
          ) : null}

          {renderAppleNativeSetupCard()}

          <div className="space-y-1">
            {useSharedAsrSelection
              ? renderRouteStatus(
                  "Dictation and meetings",
                  defaultProvider,
                )
              : renderRouteStatus("Dictation", dictationProvider)}
            {!useSharedAsrSelection
              ? renderRouteStatus("Meetings", meetingProvider)
              : null}
          </div>
        </div>
        {renderCursorInsertToolsCard()}
      </SettingsGroup>

      <SettingsGroup
        title="Repair and compare"
        description="For when a speech model will not load, or to see which one is fastest on this Mac."
      >
        <SettingsMore
          label="Repair speech models"
          hint="Damaged downloads, each model's status"
          onOpenChange={(open) => {
            if (open) setShowAdvancedTools(true);
          }}
        >
          <SettingsRow
            label="Repair downloaded speech models"
            description="Deletes only damaged speech model files, then checks every model again. Anything that still works is kept."
            control={
              <Button
                size="sm"
                variant="outline"
                onClick={handleRepairLocalCache}
                disabled={repairingCache}
              >
                {repairingCache ? "Repairing…" : "Repair"}
              </Button>
            }
          >
            {repairSummary ? (
              <p className="text-sm text-muted-foreground">{repairSummary}</p>
            ) : null}
          </SettingsRow>
          <div className="grid gap-4 py-3.5">
            {providers.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Reading every speech model on this Mac. The first time can take
                up to 15 seconds.
              </p>
            ) : (
              providers.map((provider) => renderProviderCard(provider))
            )}
          </div>
        </SettingsMore>

        <SettingsMore
          label="Compare speech models"
          hint="Time each one on a short clip"
        >
          <SettingsRow
            label="Clip to compare"
            description="A WAV clip up to 6 MiB. Each speech model on this Mac transcribes it so you can compare speed and text. Audio stays on this Mac."
            control={
              <>
                <input
                  ref={benchmarkFileInputRef}
                  type="file"
                  accept=".wav,audio/wav"
                  className="hidden"
                  disabled={isBenchmarking}
                  onChange={(event) => {
                    const file = event.target.files?.[0] ?? null;
                    setBenchmarkFileName(file?.name ?? null);
                    setBenchmarkResults([]);
                    setBenchmarkError(null);
                  }}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isBenchmarking}
                  onClick={() => benchmarkFileInputRef.current?.click()}
                >
                  <FileAudio aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
                  Choose a clip
                </Button>
                <Button
                  size="sm"
                  onClick={runBenchmark}
                  disabled={isBenchmarking || !benchmarkFileName}
                >
                  <Clock aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
                  {isBenchmarking ? "Comparing…" : "Compare"}
                </Button>
              </>
            }
          >
            {benchmarkFileName ? (
              <p className="text-sm text-muted-foreground">{benchmarkFileName}</p>
            ) : null}
            {benchmarkError ? (
              <p role="alert" className="text-sm text-rust">
                {benchmarkError}
              </p>
            ) : null}
            <AsrBenchmarkResults results={benchmarkResults} />
        {benchmarkHistory.length > 0 && (
          <div className="space-y-2 pt-2">
            <p className="rubric-muted">
              Earlier comparisons
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
                    {entry.runtimeStatus === "error"
                      ? "Could not benchmark"
                      : entry.nonEmptyTranscript
                        ? "Speech returned"
                        : "No speech returned"}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
          </SettingsRow>
        </SettingsMore>
      </SettingsGroup>
    </div>
  );
}
