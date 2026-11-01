import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  efficientParakeetOffered,
  buildAsrRouteCatalog,
  getLaneRoutes,
  isRecommendedSpeechRoute,
  routeIdFor,
  type AsrRouteCatalogEntry,
} from "@/lib/asr-route-catalog";
import { formatModelSize } from "@/lib/asr-capabilities";
import {
  recommendedSpeechRoute,
  speechChoicesForLane,
} from "@/lib/speech-model-choices";
import { onnxParakeetLanes, withParakeetUpgrade } from "@/lib/parakeet-upgrade";
import {
  deleteModelFile,
  downloadAsrModels,
  getAsrProviderInventory,
  listDownloadedModels,
  refreshAsrRuntimeProbes,
} from "@/lib/backend/asr";
import {
  cancelAppleSpeechLanguageInstall,
  installAppleSpeechLanguage,
} from "@/lib/backend/settings";
import {
  deleteBundledCleanupModel,
  deleteLivePreviewEngineModel,
  downloadBundledCleanupModel,
  downloadLivePreviewEngineModel,
  getAppleLanguageModelAvailability,
  getBundledCleanupModelStatus,
  getLivePreviewEngineStatus,
  type AppleLanguageModelAvailability,
  type BundledCleanupModelStatus,
  type LivePreviewEngineStatus,
  cancelOllamaModelInstall,
  getCuratedOllamaModelCatalog,
  installOllamaModel,
  listOllamaModelCatalog,
  type OllamaCatalogEntry,
} from "@/lib/backend/ai";
import { invoke, listen } from "@/lib/electron";
import { describeModelDownloadError } from "@/lib/model-download-error";
import type { AsrProviderInventory } from "@/types";
import type { Settings } from "@/types/settings";
import { AiLaneRow } from "@/components/models/ai-lane-row";
import { AI_LANE_KEYS, type AiLaneKey } from "@/components/models/ai-lanes";
import {
  buildDownloadedModelIndex,
  isModelOnDisk,
  type DownloadedModelIndex,
} from "@/components/models/downloaded-models";
import {
  laneRouteReadiness,
  type LaneReadiness,
} from "@/components/models/model-facts";
import { ModelFootprint, type DownloadedSpeechModel } from "@/components/models/model-footprint";
import {
  MODEL_PRESETS,
  resolveActivePresetId,
  type DownloadSizeMibFor,
  type ModelPreset,
} from "@/components/models/model-presets";
import {
  readLaneSelection,
  withModelPreset,
  withSpeechLaneRoute,
  type SpeechLane,
} from "@/components/models/model-selection";
import { LivePreviewEngineRow } from "@/components/models/live-preview-engine-row";
import { MoreModelsDrawer } from "@/components/models/more-models-drawer";
import { NativeTextModelProvider, NativeTextModelRow } from "@/components/models/native-text-model-row";
import { OllamaModelCatalog } from "@/components/models/ollama-model-catalog";
import { PresetPicker } from "@/components/models/preset-picker";
import { ParakeetUpgradePrompt } from "@/components/models/parakeet-upgrade-prompt";
import { SpeechLaneRow } from "@/components/models/speech-lane-row";
import { SpeechModelDownloadNoticeLine } from "@/components/models/speech-model-download-notice";
import { Button } from "@/components/ui/button";
import { SettingsMore, SettingsSelect } from "@/components/ui/settings-control";
import {
  AppleLanguageModelRow,
  BundledCleanupModelRow,
} from "@/components/models/zero-setup-model-row";
import { useProductReadinessStatus } from "@/features/readiness/product-readiness-context";
import { selectReadinessForSurface } from "@/features/readiness/product-readiness";
import { ChatGptAccountControls } from "@/components/models/chatgpt-account-controls";
import {
  CHATGPT_PLAN_PROVIDER,
  EMPTY_CHATGPT_PLAN_STATUS,
  type ChatGptPlanStatus,
} from "@/lib/backend/chatgpt-plan";

interface ModelsScreenProps {
  settings: Settings;
  /**
   * Fold one change into the newest settings. This is `patchSettings`, not a
   * whole-object write: the save queue keeps a single pending slot that it
   * *replaces*, so writing a whole Settings object built from a snapshot
   * deletes any edit still waiting out its debounce.
   */
  onPatchSettings: (apply: (previous: Settings) => Settings) => void;
  aiModelsForProvider: (provider: string) => string[];
  aiModelsLoading: boolean;
  onAiProviderChange: (lane: AiLaneKey, providerName: string) => void;
  onAiModelsRefresh: (providerName: string) => void;
  onAiModelChange: (lane: AiLaneKey, modelId: string | null) => void;
  /** Where an unkeyed cloud route sends the user. */
  onOpenKeySettings: () => void;
  /** Where a broken runtime or a system permission sends the user. */
  onOpenDiagnostics: () => void;
}

const AI_LANE_COPY: Record<AiLaneKey, { label: string; help: string }> = {
  meetingsAi: {
    label: "Who writes summaries, answers, and actions",
    help: "Runs after a meeting ends. The built-in text model needs one download; Ollama and cloud services are optional.",
  },
  dictationAi: {
    label: "Who cleans up dictation",
    help: "AI cleanup runs on every dictation with a short time limit, so a smaller, faster model usually works best. The built-in cleanup model needs nothing installed; Ollama and cloud services can also run saved profiles and dictation commands. A saved profile that names its own AI service overrides this while it is selected.",
  },
};

export function ModelsScreen({
  settings,
  onPatchSettings,
  aiModelsForProvider,
  aiModelsLoading,
  onAiProviderChange,
  onAiModelsRefresh,
  onAiModelChange,
  onOpenKeySettings,
  onOpenDiagnostics,
}: ModelsScreenProps) {
  const {
    productReadiness,
    refresh: refreshProductReadiness,
  } = useProductReadinessStatus();
  const modelReadiness = selectReadinessForSurface(
    productReadiness,
    "models",
  );
  const [inventory, setInventory] = useState<AsrProviderInventory[]>([]);
  const [inventoryLoaded, setInventoryLoaded] = useState(false);
  const [downloadIndex, setDownloadIndex] = useState<DownloadedModelIndex | null>(
    null,
  );
  const [busyRouteId, setBusyRouteId] = useState<string | null>(null);
  const [removingRouteId, setRemovingRouteId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  // The provider whose model the busy row is downloading, and how far it is.
  // The sidecar reports progress per provider, so it is shown only for the
  // one download this screen started.
  const [routeDownload, setRouteDownload] = useState<{
    providerType: string;
    percent: number | null;
  } | null>(null);
  const [cancellingLanguageInstall, setCancellingLanguageInstall] =
    useState(false);
  const [bundledStatus, setBundledStatus] =
    useState<BundledCleanupModelStatus | null>(null);
  const [bundledBusy, setBundledBusy] = useState(false);
  const [bundledProgress, setBundledProgress] = useState<number | null>(null);
  const [bundledError, setBundledError] = useState<string | null>(null);
  const [livePreviewStatus, setLivePreviewStatus] =
    useState<LivePreviewEngineStatus | null>(null);
  const [livePreviewBusy, setLivePreviewBusy] = useState(false);
  const [livePreviewProgress, setLivePreviewProgress] = useState<number | null>(
    null,
  );
  const [livePreviewError, setLivePreviewError] = useState<string | null>(null);
  const [appleAvailability, setAppleAvailability] =
    useState<AppleLanguageModelAvailability | null>(null);
  const [appleChecking, setAppleChecking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [ollamaCatalog, setOllamaCatalog] = useState<OllamaCatalogEntry[]>([]);
  const [ollamaBusyModelId, setOllamaBusyModelId] = useState<string | null>(null);
  const [ollamaProgress, setOllamaProgress] = useState<number | null>(null);
  const [ollamaError, setOllamaError] = useState<string | null>(null);
  const [ollamaCatalogError, setOllamaCatalogError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [upgradeBusy, setUpgradeBusy] = useState(false);
  const [upgradePercent, setUpgradePercent] = useState<number | null>(null);
  const [upgradeError, setUpgradeError] = useState<string | null>(null);
  const [chatGptStatus, setChatGptStatus] = useState<ChatGptPlanStatus>(
    EMPTY_CHATGPT_PLAN_STATUS,
  );
  const mountedRef = useRef(true);
  const ollamaCatalogRequestRef = useRef(0);
  const meetingLaneRef = useRef<HTMLDivElement | null>(null);
  const readyOllamaModelIds = useMemo(
    () => ollamaCatalog.filter((model) => model.ready).map((model) => model.id),
    [ollamaCatalog],
  );
  const chatGptModelLabels = useMemo(
    () => new Map(chatGptStatus.models.map((model) => [model.slug, model.displayName])),
    [chatGptStatus.models],
  );

  const handleChatGptStatusChange = useCallback((status: ChatGptPlanStatus) => {
    setChatGptStatus(status);
    if (!status.loaded || !status.modelsReady) return;
    const available = new Set(status.models.map((model) => model.slug));
    const hasStaleSelection = AI_LANE_KEYS.some((lane) => {
      const value = settings.privacy[lane];
      return value.provider === CHATGPT_PLAN_PROVIDER && Boolean(value.modelId) && !available.has(value.modelId!);
    });
    if (!hasStaleSelection) return;
    onPatchSettings((previous) => {
      let changed = false;
      const privacy = { ...previous.privacy };
      for (const lane of AI_LANE_KEYS) {
        const value = privacy[lane];
        if (
          value.provider === CHATGPT_PLAN_PROVIDER &&
          value.modelId &&
          !available.has(value.modelId)
        ) {
          privacy[lane] = { ...value, modelId: null };
          changed = true;
        }
      }
      return changed ? { ...previous, privacy } : previous;
    });
  }, [onPatchSettings, settings.privacy]);

  const refresh = useCallback(async () => {
    try {
      const loaded = await getAsrProviderInventory();
      if (mountedRef.current) {
        setInventory(loaded);
        setInventoryLoaded(true);
      }
    } catch (error) {
      console.error("Failed to load ASR inventory:", error);
      if (mountedRef.current) {
        setInventoryLoaded(true);
      }
    }

    try {
      const files = await listDownloadedModels();
      if (mountedRef.current) {
        setDownloadIndex(buildDownloadedModelIndex(files));
      }
    } catch (error) {
      // No measured total is better than an invented one.
      console.warn("Failed to read downloaded model files:", error);
      if (mountedRef.current) {
        setDownloadIndex(null);
      }
    }
  }, []);

  // Both zero-setup providers answer a cheap, local question, so they are
  // read on mount rather than only when their row is on screen: the picker
  // has to be able to say "Not available" the moment someone selects one.
  const refreshBundledStatus = useCallback(async () => {
    try {
      const status = await getBundledCleanupModelStatus();
      if (mountedRef.current) {
        setBundledStatus(status);
      }
    } catch (error) {
      // No measured state is better than an invented one.
      console.warn("Failed to read the built-in cleanup model state:", error);
      if (mountedRef.current) {
        setBundledStatus(null);
      }
    }
  }, []);

  const refreshAppleAvailability = useCallback(async (force = false) => {
    setAppleChecking(true);
    try {
      const availability = await getAppleLanguageModelAvailability(force);
      if (mountedRef.current) {
        setAppleAvailability(availability);
      }
    } catch (error) {
      console.warn("Failed to probe the Apple on-device model:", error);
      if (mountedRef.current) {
        setAppleAvailability(null);
      }
    } finally {
      if (mountedRef.current) {
        setAppleChecking(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    void refreshBundledStatus();
    void refreshAppleAvailability();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh, refreshBundledStatus, refreshAppleAvailability]);

  const refreshOllamaCatalog = useCallback(async () => {
    const request = ++ollamaCatalogRequestRef.current;
    try {
      const models = await listOllamaModelCatalog();
      if (mountedRef.current && request === ollamaCatalogRequestRef.current) {
        setOllamaCatalog(models);
        setOllamaCatalogError(null);
      }
    } catch (error) {
      console.warn("Failed to load the local Ollama catalog:", error);
      const curated = await getCuratedOllamaModelCatalog().catch(() => []);
      if (mountedRef.current && request === ollamaCatalogRequestRef.current) {
        setOllamaCatalog(curated);
        setOllamaCatalogError(
          "Ollama isn't responding on this Mac. You can review the list, but installing and checking models need Ollama running.",
        );
      }
    }
  }, []);

  useEffect(() => { void refreshOllamaCatalog(); }, [refreshOllamaCatalog]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen("ollama-model-pull-progress", ({ payload }) => {
      if (disposed) return;
      const update = payload as { modelId?: string; percentage?: number };
      if (update.modelId === ollamaBusyModelId && typeof update.percentage === "number") setOllamaProgress(update.percentage);
    }).then((dispose) => { if (disposed) dispose(); else unlisten = dispose; }).catch((error) => console.warn("Failed to subscribe to Ollama pull progress:", error));
    return () => { disposed = true; unlisten?.(); };
  }, [ollamaBusyModelId]);

  const handleOllamaInstall = useCallback(async (modelId: string, acceptedLicense: boolean) => {
    setOllamaBusyModelId(modelId); setOllamaProgress(null); setOllamaError(null);
    try {
      await installOllamaModel(modelId, acceptedLicense);
      await refreshOllamaCatalog();
    } catch {
      if (mountedRef.current) setOllamaError("The Ollama model could not be installed. Check Ollama and available disk space, then try again.");
      await refreshOllamaCatalog();
    } finally {
      if (mountedRef.current) { setOllamaBusyModelId(null); setOllamaProgress(null); }
    }
  }, [refreshOllamaCatalog]);

  const handleOllamaCancel = useCallback(async () => {
    setOllamaError(null);
    try {
      await cancelOllamaModelInstall();
    } catch {
      if (mountedRef.current) {
        setOllamaError("The Ollama download could not be cancelled. Try again.");
      }
    }
  }, []);

  // The sidecar emits weighted 0..100 progress across all four pinned files
  // while `download_bundled_cleanup_model` runs. Without this the button can
  // only say "Downloading…" for the whole ~484 MB, which reads as a hang.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listen("model-download-progress", ({ payload }) => {
      if (disposed) {
        return;
      }
      const update = payload as { modelName?: string; percentage?: number };
      if (livePreviewStatus?.modelId && update?.modelName === livePreviewStatus.modelId) {
        if (typeof update.percentage === "number" && Number.isFinite(update.percentage)) {
          setLivePreviewProgress(Math.max(0, Math.min(100, update.percentage)));
        }
        return;
      }
      if (update?.modelName !== "bundled_cleanup") {
        return;
      }
      if (typeof update.percentage === "number") {
        setBundledProgress(update.percentage);
      }
    })
      .then((dispose) => {
        if (disposed) {
          dispose?.();
          return;
        }
        unlisten = dispose;
      })
      .catch((error) => {
        console.warn("Failed to subscribe to model-download-progress:", error);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [livePreviewStatus?.modelId]);

  const refreshLivePreviewStatus = useCallback(async () => {
    try {
      const status = await getLivePreviewEngineStatus();
      if (mountedRef.current) {
        setLivePreviewStatus(status);
      }
    } catch {
      // A sidecar that cannot answer leaves the row hidden rather than
      // claiming an engine state it does not know.
      if (mountedRef.current) {
        setLivePreviewStatus(null);
      }
    }
  }, []);

  useEffect(() => {
    void refreshLivePreviewStatus();
  }, [refreshLivePreviewStatus]);

  const handleLivePreviewDownload = useCallback(async () => {
    setLivePreviewBusy(true);
    setLivePreviewProgress(null);
    setLivePreviewError(null);
    try {
      const status = await downloadLivePreviewEngineModel();
      if (mountedRef.current) {
        setLivePreviewStatus(status);
      }
    } catch (error) {
      if (mountedRef.current) {
        setLivePreviewError(describeModelDownloadError(error));
      }
      void refreshLivePreviewStatus();
    } finally {
      if (mountedRef.current) {
        setLivePreviewBusy(false);
        setLivePreviewProgress(null);
      }
    }
  }, [refreshLivePreviewStatus]);

  const handleLivePreviewDelete = useCallback(async () => {
    setLivePreviewBusy(true);
    setLivePreviewError(null);
    try {
      const status = await deleteLivePreviewEngineModel();
      if (mountedRef.current) {
        setLivePreviewStatus(status);
      }
    } catch (error) {
      if (mountedRef.current) {
        setLivePreviewError(
          error instanceof Error ? error.message : "Could not delete it.",
        );
      }
      void refreshLivePreviewStatus();
    } finally {
      if (mountedRef.current) {
        setLivePreviewBusy(false);
      }
    }
  }, [refreshLivePreviewStatus]);

  const handleBundledDownload = useCallback(async () => {
    setBundledBusy(true);
    setBundledProgress(null);
    setBundledError(null);
    try {
      const status = await downloadBundledCleanupModel();
      if (mountedRef.current) {
        setBundledStatus(status);
      }
    } catch (error) {
      if (mountedRef.current) {
        setBundledError(describeModelDownloadError(error));
      }
      void refreshBundledStatus();
    } finally {
      if (mountedRef.current) {
        setBundledBusy(false);
        setBundledProgress(null);
      }
    }
  }, [refreshBundledStatus]);

  const handleBundledDelete = useCallback(async () => {
    setBundledBusy(true);
    setBundledError(null);
    try {
      const status = await deleteBundledCleanupModel();
      if (mountedRef.current) {
        setBundledStatus(status);
      }
    } catch (error) {
      if (mountedRef.current) {
        setBundledError(
          error instanceof Error ? error.message : "Could not delete it.",
        );
      }
      void refreshBundledStatus();
    } finally {
      if (mountedRef.current) {
        setBundledBusy(false);
      }
    }
  }, [refreshBundledStatus]);

  // The sidecar applies each provider's model map while it saves, so download
  // state only becomes true after the write lands. Re-reading on the broadcast
  // is what makes "Needs download" appear against the model you just picked
  // rather than against the one you picked before it.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listen("settings-changed", () => {
      if (!disposed) {
        void refresh();
      }
    })
      .then((dispose) => {
        if (disposed) {
          dispose?.();
          return;
        }
        unlisten = dispose;
      })
      .catch((error) => {
        console.warn("Failed to subscribe to settings-changed:", error);
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refresh]);

  const meetingRoutePolicy =
    settings.transcription.meetingRoutePolicy ?? "prefer_local";

  const catalog = useMemo(
    () => buildAsrRouteCatalog(inventory, meetingRoutePolicy),
    [inventory, meetingRoutePolicy],
  );

  const selection = useMemo(
    () => readLaneSelection(inventory, settings),
    [inventory, settings],
  );

  const routeById = useCallback(
    (routeId: string) =>
      catalog.find((route) => route.routeId === routeId) ?? null,
    [catalog],
  );

  const downloadSizeMibFor = useCallback<DownloadSizeMibFor>(
    (target) =>
      routeById(routeIdFor(target.providerType, target.modelId))?.capability?.sizeMib,
    [routeById],
  );

  const dictationRouteId = routeIdFor(
    selection.dictationSpeech.providerType,
    selection.dictationSpeech.modelId,
  );
  const meetingRouteId = routeIdFor(
    selection.meetingSpeech.providerType,
    selection.meetingSpeech.modelId,
  );
  const activeDictationRoute = routeById(dictationRouteId);
  const activeMeetingRoute = routeById(meetingRouteId);

  const efficientParakeet = efficientParakeetOffered(inventory);
  const recommendedRoute = useMemo(() => recommendedSpeechRoute(catalog), [catalog]);

  // Every distinct model this Mac can run for the lane, recommended first,
  // then any experimental model already downloaded. A lane still on the ONNX
  // build of Parakeet v3 shows that route in the GGUF build's place, so
  // Parakeet v3 is listed once, as what is running; the upgrade prompt above
  // offers the GGUF build. A current choice that is none of these (a cloud
  // service, an experimental model) is listed too.
  const laneOptions = useCallback(
    (lane: SpeechLane, activeRoute: AsrRouteCatalogEntry | null) => {
      const choices = speechChoicesForLane(catalog, lane).map((choice) => choice.route);
      const listed = new Set(choices.map((route) => route.routeId));
      const downloaded = getLaneRoutes(catalog, lane, meetingRoutePolicy).filter(
        (route) =>
          !listed.has(route.routeId) &&
          route.hosting !== "cloud" &&
          (route.readiness === "ready" || route.readiness === "needs_download") &&
          isModelOnDisk(downloadIndex, route.providerType, route.modelId) === true,
      );
      const options = [...choices, ...downloaded];
      if (!activeRoute || options.some((route) => route.routeId === activeRoute.routeId)) {
        return options;
      }
      if (activeRoute.superseded) {
        return options.map((route) =>
          isRecommendedSpeechRoute(route.providerType, route.modelId) ? activeRoute : route,
        );
      }
      return [...options.slice(0, 1), activeRoute, ...options.slice(1)];
    },
    [catalog, downloadIndex, meetingRoutePolicy],
  );

  // Experimental models and cloud services: everything a lane can use that
  // is not one of the distinct models listed in the lanes themselves.
  const drawerRoutes = useMemo(() => {
    const listed = new Set(
      (["dictation", "meeting"] as const).flatMap((lane) =>
        speechChoicesForLane(catalog, lane).map((choice) => choice.route.routeId),
      ),
    );
    return getLaneRoutes(catalog, "dictation", meetingRoutePolicy).filter(
      (route) => !listed.has(route.routeId),
    );
  }, [catalog, meetingRoutePolicy]);

  const onDiskFor = useCallback(
    (route: AsrRouteCatalogEntry) =>
      isModelOnDisk(downloadIndex, route.providerType, route.modelId),
    [downloadIndex],
  );
  const dictationLocalReadiness = activeDictationRoute
    ? laneRouteReadiness(
        activeDictationRoute,
        onDiskFor(activeDictationRoute),
      )
    : null;
  const meetingLocalReadiness = activeMeetingRoute
    ? laneRouteReadiness(activeMeetingRoute, onDiskFor(activeMeetingRoute))
    : null;
  const canonicalRepairOverride: LaneReadiness = {
    label: "Needs attention",
    tone: "attention",
    action: "fix_setup",
    actionLabel: "Review diagnostics",
  };
  const dictationReadinessOverride =
    productReadiness.dictation.state !== "ready" &&
    productReadiness.dictation.cause?.id === "dictation_route" &&
    dictationLocalReadiness?.label === "Ready"
      ? canonicalRepairOverride
      : null;
  const meetingReadinessOverride =
    productReadiness.meetings.state !== "ready" &&
    productReadiness.meetings.cause?.id === "meeting_route" &&
    meetingLocalReadiness?.label === "Ready"
      ? canonicalRepairOverride
      : null;

  const pendingMib = useMemo(() => {
    const seen = new Set<string>();
    let total = 0;
    for (const route of [activeDictationRoute, activeMeetingRoute]) {
      if (!route || !route.capability || seen.has(route.routeId)) {
        continue;
      }
      // Per model, off the files -- the provider-level readiness would count
      // a build that is already here and skip one that is not.
      if (laneRouteReadiness(route, onDiskFor(route)).action !== "download") {
        continue;
      }
      seen.add(route.routeId);
      total += route.capability.sizeMib;
    }
    return total;
  }, [activeDictationRoute, activeMeetingRoute, onDiskFor]);

  const activePresetId = resolveActivePresetId(selection, efficientParakeet);

  // An older install still on the ONNX build of Parakeet v3, on a Mac that
  // runs the GGUF build. The sidecar moves it on its own once the GGUF build
  // is here; until then this offers the download, and nothing downloads
  // without that click.
  const ggufParakeetRoute = efficientParakeet
    ? catalog.find((route) => isRecommendedSpeechRoute(route.providerType, route.modelId)) ?? null
    : null;
  const lanesOnOnnxParakeet = onnxParakeetLanes(settings.transcription);
  const offerParakeetUpgrade =
    ggufParakeetRoute !== null &&
    ggufParakeetRoute.readiness !== "unavailable" &&
    (lanesOnOnnxParakeet.dictation || lanesOnOnnxParakeet.meeting);

  const handleParakeetUpgrade = useCallback(async () => {
    if (!ggufParakeetRoute) return;
    setUpgradeBusy(true);
    setUpgradePercent(null);
    setUpgradeError(null);
    try {
      await downloadAsrModels(ggufParakeetRoute.providerType, ggufParakeetRoute.modelId);
      // Switch only once the sidecar itself calls the downloaded file ready.
      const diagnostics = await invoke<{ runtimeStatus?: unknown } | null>(
        "get_asr_runtime_diagnostics",
        {
          providerType: ggufParakeetRoute.providerType,
          modelId: ggufParakeetRoute.modelId,
        },
      );
      if (diagnostics?.runtimeStatus !== "ready") {
        throw new Error(
          "The download finished, but Parakeet v3 didn't pass its check. Nothing was switched. Try again.",
        );
      }
      onPatchSettings((previous) => withParakeetUpgrade(previous));
      await Promise.all([refresh(), refreshProductReadiness()]);
    } catch (error) {
      if (mountedRef.current) {
        setUpgradeError(describeModelDownloadError(error));
      }
    } finally {
      if (mountedRef.current) {
        setUpgradeBusy(false);
        setUpgradePercent(null);
      }
    }
  }, [ggufParakeetRoute, onPatchSettings, refresh, refreshProductReadiness]);

  useEffect(() => {
    if (!upgradeBusy) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<[string, number]>("asr-download-progress", ({ payload }) => {
      if (disposed || !Array.isArray(payload)) return;
      const [providerType, percent] = payload;
      if (providerType === ggufParakeetRoute?.providerType && Number.isFinite(percent)) {
        setUpgradePercent(Math.max(0, Math.min(100, percent)));
      }
    })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [upgradeBusy, ggufParakeetRoute?.providerType]);

  const routeDownloadProvider = routeDownload?.providerType ?? null;
  useEffect(() => {
    if (!routeDownloadProvider) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<[string, number]>("asr-download-progress", ({ payload }) => {
      if (disposed || !Array.isArray(payload)) return;
      const [providerType, percent] = payload;
      if (providerType === routeDownloadProvider && Number.isFinite(percent)) {
        setRouteDownload((current) =>
          current?.providerType === providerType
            ? { providerType, percent: Math.max(0, Math.min(100, percent)) }
            : current,
        );
      }
    })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [routeDownloadProvider]);
  const busyRoutePercent = routeDownload?.percent ?? null;

  // The readiness cause names model ids ("…-q8_0 is not downloaded for
  // transcribe.cpp"). When the fix is a download on this screen, say it in
  // the words the rows below use instead.
  const routeCauseRoute =
    modelReadiness.cause?.id === "dictation_route"
      ? { route: activeDictationRoute, readiness: dictationLocalReadiness }
      : modelReadiness.cause?.id === "meeting_route"
        ? { route: activeMeetingRoute, readiness: meetingLocalReadiness }
        : null;
  const attentionMessage =
    routeCauseRoute?.route && routeCauseRoute.readiness?.action === "download"
      ? `${routeCauseRoute.route.label} isn't downloaded yet. Download it below.`
      : `${modelReadiness.cause?.message ?? ""} Review the choices below.`.trim();

  const inventoryUnavailable = inventory.length === 0;

  const unavailableReasonFor = useCallback(
    (preset: ModelPreset): string | null => {
      if (inventoryUnavailable) {
        return "Couldn't read the speech models on this Mac.";
      }

      const dictationRoute = routeById(
        routeIdFor(
          preset.dictationSpeech.providerType,
          preset.dictationSpeech.modelId,
        ),
      );
      const meetingRoute = routeById(
        routeIdFor(
          preset.meetingSpeech.providerType,
          preset.meetingSpeech.modelId,
        ),
      );

      if (!dictationRoute || !meetingRoute) {
        return "Not available on this Mac.";
      }
      if (!meetingRoute.laneCompatibility.meeting) {
        return `${meetingRoute.label} can't transcribe meetings on this Mac.`;
      }
      return null;
    },
    [inventoryUnavailable, routeById],
  );

  const handleSelectRoute = useCallback(
    (lane: SpeechLane, route: AsrRouteCatalogEntry) => {
      setActionError(null);
      onPatchSettings((previous) =>
        withSpeechLaneRoute(previous, inventory, lane, {
          providerType: route.providerType,
          modelId: route.modelId,
        }),
      );
    },
    [inventory, onPatchSettings],
  );

  /**
   * Stops a running language install.
   *
   * The sidecar kills the helper, so the in-flight `installAppleSpeechLanguage`
   * call returns with a cancelled note and the row's own `finally` clears the
   * busy state -- there is nothing to unwind here.
   */
  const handleCancelLanguageInstall = useCallback(async () => {
    setCancellingLanguageInstall(true);
    try {
      await cancelAppleSpeechLanguageInstall();
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : "Could not stop the language install.",
      );
      if (mountedRef.current) {
        setCancellingLanguageInstall(false);
      }
    }
  }, []);

  const handleApplyPreset = useCallback(
    (preset: ModelPreset) => {
      setActionError(null);
      onPatchSettings((previous) => withModelPreset(previous, inventory, preset));
    },
    [inventory, onPatchSettings],
  );

  const handleRouteAction = useCallback(
    async (route: AsrRouteCatalogEntry) => {
      // The same per-model readiness the row rendered, so a Download button
      // that only exists because the file is missing actually downloads.
      const { action } = laneRouteReadiness(route, onDiskFor(route));

      if (action === "connect_api_key") {
        onOpenKeySettings();
        return;
      }
      if (action === "install_language") {
        // macOS owns the download and its size; this only asks for it and
        // then re-reads what the machine now has.
        setBusyRouteId(route.routeId);
        setCancellingLanguageInstall(false);
        setActionError(null);
        try {
          const result = await installAppleSpeechLanguage();
          if (result.notes.length > 0) {
            setActionError(result.notes.join(" "));
          }
          await Promise.all([refresh(), refreshProductReadiness()]);
        } catch (error) {
          setActionError(
            error instanceof Error
              ? error.message
              : `Could not install the language for ${route.label}.`,
          );
        } finally {
          if (mountedRef.current) {
            setBusyRouteId(null);
            setCancellingLanguageInstall(false);
          }
        }
        return;
      }
      if (action !== "download") {
        // Runtime repair and the macOS permission prompts live with the
        // diagnostics panel; sending the user there beats a second copy of
        // those buttons that can drift from it.
        onOpenDiagnostics();
        return;
      }

      setBusyRouteId(route.routeId);
      setRouteDownload({ providerType: route.providerType, percent: null });
      setActionError(null);
      try {
        await downloadAsrModels(route.providerType, route.modelId);
        await Promise.all([refresh(), refreshProductReadiness()]);
      } catch (error) {
        setActionError(
          `${route.label} didn't download. ${describeModelDownloadError(error)}`,
        );
      } finally {
        if (mountedRef.current) {
          setBusyRouteId(null);
          setRouteDownload(null);
        }
      }
    },
    [
      onDiskFor,
      onOpenDiagnostics,
      onOpenKeySettings,
      refresh,
      refreshProductReadiness,
    ],
  );

  // Every downloaded speech model the files identify, with what uses it.
  // Models on no lane can be removed from here; one a lane uses has to be
  // swapped out first, or dictation or meetings would break on the spot.
  const downloadedSpeechModels = useMemo((): DownloadedSpeechModel[] => {
    if (!downloadIndex) return [];
    const models: DownloadedSpeechModel[] = [];
    for (const [routeId, files] of downloadIndex.filesByRoute) {
      const route = routeById(routeId);
      if (!route) continue;
      const usedFor = [
        activeDictationRoute?.routeId === routeId ? "dictation" : null,
        activeMeetingRoute?.routeId === routeId ? "meetings" : null,
      ].filter(Boolean).join(" and ");
      models.push({ routeId, label: route.label, bytes: files.bytes, usedFor: usedFor || null });
    }
    return models.sort((a, b) => b.bytes - a.bytes);
  }, [activeDictationRoute?.routeId, activeMeetingRoute?.routeId, downloadIndex, routeById]);

  const handleRemoveModel = useCallback(
    async (routeId: string) => {
      const files = downloadIndex?.filesByRoute.get(routeId);
      if (!files || routeId === activeDictationRoute?.routeId || routeId === activeMeetingRoute?.routeId) {
        return;
      }
      setRemovingRouteId(routeId);
      setRemoveError(null);
      try {
        for (const path of files.paths) {
          await deleteModelFile(path);
        }
      } catch (error) {
        console.warn("Failed to remove a speech model:", error);
        if (mountedRef.current) {
          setRemoveError(
            `${routeById(routeId)?.label ?? "That model"} couldn't be removed completely. Try again.`,
          );
        }
      } finally {
        // Re-read either way: a partial removal leaves the model not ready.
        await refreshAsrRuntimeProbes().catch(() => {});
        // The live preview engine's row reads the same Nemotron file.
        await Promise.all([refresh(), refreshProductReadiness(), refreshLivePreviewStatus()]);
        if (mountedRef.current) setRemovingRouteId(null);
      }
    },
    [
      activeDictationRoute?.routeId,
      activeMeetingRoute?.routeId,
      downloadIndex,
      refresh,
      refreshLivePreviewStatus,
      refreshProductReadiness,
      routeById,
    ],
  );

  if (!inventoryLoaded) {
    return (
      <p className="text-sm text-muted-foreground">
        Reading the speech models on this Mac…
      </p>
    );
  }

  return (
    <div className="space-y-5">
      {modelReadiness.state !== "ready" &&
      (modelReadiness.cause?.id === "dictation_route" ||
        modelReadiness.cause?.id === "meeting_route" ||
        modelReadiness.cause?.id === "ai_route") ? (
        <div
          role="alert"
          aria-label={modelReadiness.cause.id === "ai_route" ? "Your AI model needs attention" : "Your speech model needs attention"}
          className="flex items-start gap-2.5 rounded-md border border-rust/35 bg-rust/10 px-4 py-3 text-sm text-rust"
        >
          <span
            className="neume neume-rust mt-1 shrink-0"
            aria-hidden="true"
          />
          <div>
            <p className="font-medium">
              {modelReadiness.cause.id === "ai_route" ? "Your AI model needs attention" : "Your speech model needs attention"}
            </p>
            <p className="mt-1 leading-6">
              {attentionMessage}
            </p>
          </div>
        </div>
      ) : null}

      {offerParakeetUpgrade && ggufParakeetRoute ? (
        <ParakeetUpgradePrompt
          sizeLabel={
            ggufParakeetRoute.capability
              ? formatModelSize(ggufParakeetRoute.capability.sizeMib)
              : null
          }
          onDisk={onDiskFor(ggufParakeetRoute) === true}
          busy={upgradeBusy}
          percent={upgradePercent}
          error={upgradeError}
          onUpgrade={() => void handleParakeetUpgrade()}
        />
      ) : null}

      {actionError ? (
        <p className="text-sm leading-6 text-rust">{actionError}</p>
      ) : null}

      <SpeechModelDownloadNoticeLine />

      <div>
        <h3 className="section-heading">What each task uses</h3>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
          Dictation and meetings can each use their own speech model, and the
          AI that tidies the text afterwards is a separate choice again.
        </p>

        {inventoryUnavailable ? (
          <p className="mt-3 max-w-2xl text-sm leading-6 text-rust">
            Couldn&apos;t read the speech models, so there is nothing here to
            choose between. The AI choices below still work.
          </p>
        ) : null}

        <div className="mt-4 divide-y divide-border/60">
          {inventoryUnavailable ? null : (
            <div className="pb-5">
              <SpeechLaneRow
                title="Speech for dictation"
                implication="Turns each dictation into text, so speed and word accuracy matter most."
                options={laneOptions("dictation", activeDictationRoute)}
                activeRoute={activeDictationRoute}
                activeRouteId={dictationRouteId}
                isRecommended={(route) => route.routeId === recommendedRoute?.routeId}
                groupByMeetingCapability
                notice={
                  activeDictationRoute && !activeDictationRoute.laneCompatibility.meeting ? (
                    // A dictation-only model says so here, with the way to the
                    // meetings model, so nobody assumes it records meetings too.
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-gold/40 bg-gold/5 px-3 py-2">
                      <p className="min-w-0 flex-1 text-sm leading-6">
                        <span className="font-medium">
                          {activeDictationRoute.label} is for dictation only.
                        </span>{" "}
                        <span className="text-muted-foreground">
                          {activeMeetingRoute
                            ? `Meetings use ${activeMeetingRoute.label}.`
                            : "Choose a model for meetings below."}
                        </span>
                      </p>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          const lane = meetingLaneRef.current;
                          lane?.scrollIntoView({ block: "start", behavior: "smooth" });
                          (
                            lane?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]') ??
                            lane?.querySelector<HTMLElement>('[role="radio"]')
                          )?.focus({ preventScroll: true });
                        }}
                      >
                        Change meetings model
                      </Button>
                    </div>
                  ) : null
                }
                onDiskFor={onDiskFor}
                onSelect={(route) => handleSelectRoute("dictation", route)}
                onAction={(route) => void handleRouteAction(route)}
                actionBusy={busyRouteId === activeDictationRoute?.routeId}
                actionDisabled={busyRouteId !== null}
                actionProgress={busyRoutePercent}
                onCancelLanguageInstall={() =>
                  void handleCancelLanguageInstall()
                }
                cancelLanguageInstallBusy={cancellingLanguageInstall}
                readinessOverride={dictationReadinessOverride}
                explainPauseBehavior
              />
              {/* Under the dictation lane on purpose: it is not a route the
                  lane can select, it is an add-on to that lane's popup. */}
              <LivePreviewEngineRow
                status={livePreviewStatus}
                busy={livePreviewBusy}
                progressPercent={livePreviewProgress}
                error={livePreviewError}
                onDownload={() => void handleLivePreviewDownload()}
                onDelete={() => void handleLivePreviewDelete()}
              />
            </div>
          )}

          {inventoryUnavailable ? null : (
            <div ref={meetingLaneRef} className="scroll-mt-4 py-5">
              {/* The ordering control belongs next to the list it reorders.
                  It used to live on the Transcription tab's diagnostics card
                  under the name "Meeting quality policy", two tabs from the
                  meetings list, where it read like a second engine picker. */}
              <SettingsSelect
                className="mb-4 max-w-md"
                label="Which meeting models to list first"
                description="Only reorders the list below; it never switches models on its own. “The best one on this Mac” keeps cloud services out of the top of the list even when you have a key for one."
                value={meetingRoutePolicy}
                onChange={(value) =>
                  onPatchSettings((previous) => ({
                    ...previous,
                    transcription: {
                      ...previous.transcription,
                      meetingRoutePolicy:
                        value === "best_available" ? "best_available" : "prefer_local",
                    },
                  }))
                }
              >
                <option value="prefer_local">The best one on this Mac</option>
                <option value="best_available">
                  The best one you have a key for
                </option>
              </SettingsSelect>
              <SpeechLaneRow
                title="Speech for meetings"
                implication="Runs over a whole recording after the meeting, so it can be slower than the dictation model."
                options={laneOptions("meeting", activeMeetingRoute)}
                activeRoute={activeMeetingRoute}
                activeRouteId={meetingRouteId}
                isRecommended={(route) => route.routeId === recommendedRoute?.routeId}
                onDiskFor={onDiskFor}
                onSelect={(route) => handleSelectRoute("meeting", route)}
                onAction={(route) => void handleRouteAction(route)}
                actionBusy={busyRouteId === activeMeetingRoute?.routeId}
                actionDisabled={busyRouteId !== null}
                actionProgress={busyRoutePercent}
                onCancelLanguageInstall={() =>
                  void handleCancelLanguageInstall()
                }
                cancelLanguageInstallBusy={cancellingLanguageInstall}
                readinessOverride={meetingReadinessOverride}
                explainPauseBehavior={false}
              />
            </div>
          )}

          <div className="py-5">
            <ChatGptAccountControls
              remoteProcessingEnabled={settings.privacy.remoteProcessingEnabled}
              onStatusChange={handleChatGptStatusChange}
            />
          </div>

          <NativeTextModelProvider
            enabled={AI_LANE_KEYS.some((lane) => settings.privacy[lane].provider === "native_text")}
            onChanged={() => void refreshProductReadiness()}
          >
          {AI_LANE_KEYS.map((lane) => (
            <div key={lane} className="py-5 last:pb-0">
              <AiLaneRow
                lane={lane}
                label={AI_LANE_COPY[lane].label}
                help={AI_LANE_COPY[lane].help}
                value={settings.privacy[lane]}
                remoteProcessingEnabled={settings.privacy.remoteProcessingEnabled}
                models={settings.privacy[lane].provider === CHATGPT_PLAN_PROVIDER
                  ? chatGptStatus.models.map((model) => model.slug)
                  : settings.privacy[lane].provider === "ollama"
                    ? Array.from(new Set([...aiModelsForProvider("ollama"), ...readyOllamaModelIds]))
                    : aiModelsForProvider(settings.privacy[lane].provider)}
                modelsLoading={aiModelsLoading}
                appleAvailable={appleAvailability?.available === true}
                modelLabels={settings.privacy[lane].provider === CHATGPT_PLAN_PROVIDER ? chatGptModelLabels : undefined}
                onProviderChange={onAiProviderChange}
                onRefreshModels={onAiModelsRefresh}
                onModelChange={onAiModelChange}
                zeroSetupSlot={
                  settings.privacy[lane].provider === "native_text" ? (
                    <NativeTextModelRow modelId={settings.privacy[lane].modelId} onModelChange={(modelId) => onAiModelChange(lane, modelId)} />
                  ) : settings.privacy[lane].provider === "bundled_local" ? (
                    <BundledCleanupModelRow
                      status={bundledStatus}
                      busy={bundledBusy}
                      progressPercent={bundledProgress}
                      error={bundledError}
                      onDownload={() => void handleBundledDownload()}
                      onDelete={() => void handleBundledDelete()}
                    />
                  ) : settings.privacy[lane].provider ===
                    "apple_language_model" ? (
                    <AppleLanguageModelRow
                      purpose={lane === "meetingsAi" ? "notes" : "dictation"}
                      availability={appleAvailability}
                      checking={appleChecking}
                      onRecheck={() => void refreshAppleAvailability(true)}
                    />
                  ) : null
                }
              />
            </div>
          ))}
          </NativeTextModelProvider>
          <div className="py-5">
            <OllamaModelCatalog models={ollamaCatalog} busyModelId={ollamaBusyModelId} progressPercent={ollamaProgress} error={[ollamaError, ollamaCatalogError].filter(Boolean).join(" ") || null} onInstall={(modelId, acceptedLicense) => void handleOllamaInstall(modelId, acceptedLicense)} onCancel={() => void handleOllamaCancel()} />
          </div>
        </div>
      </div>

      {/* Most people keep what setup chose; a preset is a shortcut for
          changing both speech models at once, so it waits below the
          choices themselves. */}
      <div className="border-t pt-2">
        <SettingsMore
          settingId="model-presets"
          label="Start from a preset"
          hint={`Active: ${MODEL_PRESETS.find((preset) => preset.id === activePresetId)?.name ?? "Custom"}`}
        >
          <div className="py-3">
            <PresetPicker
              activePresetId={activePresetId}
              unavailableReasonFor={unavailableReasonFor}
              efficientParakeet={efficientParakeet}
              downloadSizeMibFor={downloadSizeMibFor}
              onApply={handleApplyPreset}
            />
          </div>
        </SettingsMore>
      </div>

      {inventoryUnavailable ? null : (
        <div className="border-t pt-5">
          <MoreModelsDrawer
            open={drawerOpen}
            onOpenChange={setDrawerOpen}
            routes={drawerRoutes}
            activeRouteIds={{
              dictation: activeDictationRoute?.routeId ?? null,
              meeting: activeMeetingRoute?.routeId ?? null,
            }}
            onDiskFor={onDiskFor}
            onSelect={handleSelectRoute}
            onAction={(route) => void handleRouteAction(route)}
            busyRouteId={busyRouteId}
            busyProgress={busyRoutePercent}
            onCancelLanguageInstall={() => void handleCancelLanguageInstall()}
            cancelLanguageInstallBusy={cancellingLanguageInstall}
          />
        </div>
      )}

      <div className="border-t pt-5">
        <ModelFootprint
          index={downloadIndex}
          pendingMib={pendingMib}
          models={downloadedSpeechModels}
          onRemove={(routeId) => void handleRemoveModel(routeId)}
          removingRouteId={removingRouteId}
          removeError={removeError}
        />
      </div>
    </div>
  );
}
