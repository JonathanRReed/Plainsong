import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildAsrRouteCatalog,
  getLaneRoutes,
  routeIdFor,
  type AsrRouteCatalogEntry,
} from "@/lib/asr-route-catalog";
import {
  downloadAsrModels,
  getAsrProviderInventory,
  listDownloadedModels,
} from "@/lib/backend/asr";
import {
  deleteBundledCleanupModel,
  downloadBundledCleanupModel,
  getAppleLanguageModelAvailability,
  getBundledCleanupModelStatus,
  type AppleLanguageModelAvailability,
  type BundledCleanupModelStatus,
} from "@/lib/backend/ai";
import { listen } from "@/lib/electron";
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
import { ModelFootprint } from "@/components/models/model-footprint";
import {
  resolveActivePresetId,
  type ModelPreset,
} from "@/components/models/model-presets";
import {
  readLaneSelection,
  withModelPreset,
  withSpeechLaneRoute,
  type SpeechLane,
} from "@/components/models/model-selection";
import { MoreModelsDrawer } from "@/components/models/more-models-drawer";
import { PresetPicker } from "@/components/models/preset-picker";
import { SpeechLaneRow } from "@/components/models/speech-lane-row";
import {
  AppleLanguageModelRow,
  BundledCleanupModelRow,
} from "@/components/models/zero-setup-model-row";
import { useProductReadinessStatus } from "@/features/readiness/product-readiness-context";
import { selectReadinessForSurface } from "@/features/readiness/product-readiness";

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
  onAiModelChange: (lane: AiLaneKey, modelId: string | null) => void;
  /** Where an unkeyed cloud route sends the user. */
  onOpenKeySettings: () => void;
  /** Where a broken runtime or a system permission sends the user. */
  onOpenDiagnostics: () => void;
}

const AI_LANE_COPY: Record<AiLaneKey, { label: string; help: string }> = {
  meetingsAi: {
    label: "Who writes summaries, answers, and actions",
    help: "Runs once a meeting has ended, so it can afford a slower, smarter model.",
  },
  dictationAi: {
    label: "Who cleans up dictation",
    help: "Runs on every capture behind a short timeout, so a smaller, faster model usually wins here. Built-in needs nothing installed; Ollama and the cloud providers can also run custom modes and dictation commands. A dictation mode that carries its own AI provider overrides this while that mode is selected.",
  },
};

export function ModelsScreen({
  settings,
  onPatchSettings,
  aiModelsForProvider,
  aiModelsLoading,
  onAiProviderChange,
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
  const [bundledStatus, setBundledStatus] =
    useState<BundledCleanupModelStatus | null>(null);
  const [bundledBusy, setBundledBusy] = useState(false);
  const [bundledProgress, setBundledProgress] = useState<number | null>(null);
  const [bundledError, setBundledError] = useState<string | null>(null);
  const [appleAvailability, setAppleAvailability] =
    useState<AppleLanguageModelAvailability | null>(null);
  const [appleChecking, setAppleChecking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const mountedRef = useRef(true);

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

  // The sidecar emits weighted 0..100 progress across all four pinned files
  // while `download_bundled_cleanup_model` runs. Without this the button can
  // only say "Downloading…" for the whole ~484 MB, which reads as a hang.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listen("model-download-progress", (payload) => {
      if (disposed) {
        return;
      }
      const update = payload as { modelName?: string; percentage?: number };
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
  }, []);

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
        setBundledError(
          error instanceof Error
            ? error.message
            : "The download did not finish.",
        );
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

  const laneOptions = useCallback(
    (lane: SpeechLane, activeRoute: AsrRouteCatalogEntry | null) => {
      const laneRoutes = getLaneRoutes(catalog, lane, meetingRoutePolicy);
      return laneRoutes.filter(
        (route) =>
          route.capability?.tier === "promoted" ||
          route.routeId === activeRoute?.routeId,
      );
    },
    [catalog, meetingRoutePolicy],
  );

  const drawerRoutes = useMemo(
    () =>
      getLaneRoutes(catalog, "dictation", meetingRoutePolicy).filter(
        (route) => route.capability?.tier !== "promoted",
      ),
    [catalog, meetingRoutePolicy],
  );

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

  const promotedTotalMib = useMemo(() => {
    const seen = new Set<string>();
    let total = 0;
    for (const route of catalog) {
      if (route.capability?.tier !== "promoted" || seen.has(route.routeId)) {
        continue;
      }
      seen.add(route.routeId);
      total += route.capability.sizeMib;
    }
    return total > 0 ? total : null;
  }, [catalog]);

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

  const activePresetId = resolveActivePresetId(selection);

  const inventoryUnavailable = inventory.length === 0;

  const unavailableReasonFor = useCallback(
    (preset: ModelPreset): string | null => {
      if (inventoryUnavailable) {
        return "Could not read the engines this build ships with.";
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
        return "This build does not ship one of these models.";
      }
      if (!meetingRoute.laneCompatibility.meeting) {
        return `${meetingRoute.label} is not wired for meetings in this build.`;
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
      if (action !== "download") {
        // Runtime repair and the macOS permission prompts live with the
        // diagnostics panel; sending the user there beats a second copy of
        // those buttons that can drift from it.
        onOpenDiagnostics();
        return;
      }

      setBusyRouteId(route.routeId);
      setActionError(null);
      try {
        await downloadAsrModels(route.providerType, route.modelId);
        await Promise.all([refresh(), refreshProductReadiness()]);
      } catch (error) {
        setActionError(
          error instanceof Error
            ? error.message
            : `Could not download ${route.label}.`,
        );
      } finally {
        if (mountedRef.current) {
          setBusyRouteId(null);
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

  if (!inventoryLoaded) {
    return (
      <p className="text-sm text-muted-foreground">
        Reading the speech engines this build ships with…
      </p>
    );
  }

  return (
    <div className="space-y-5">
      {modelReadiness.state !== "ready" &&
      (modelReadiness.cause?.id === "dictation_route" ||
        modelReadiness.cause?.id === "meeting_route") ? (
        <div
          role="alert"
          aria-label="Selected speech route needs attention"
          className="flex items-start gap-2.5 rounded-md border border-rust/35 bg-rust/10 px-4 py-3 text-sm text-rust"
        >
          <span
            className="neume neume-rust mt-1 shrink-0"
            aria-hidden="true"
          />
          <div>
            <p className="font-medium">
              The selected speech route needs attention
            </p>
            <p className="mt-1 leading-6">
              {modelReadiness.cause.message} Review the selected speech lanes
              below.
            </p>
          </div>
        </div>
      ) : null}

      <PresetPicker
        activePresetId={activePresetId}
        unavailableReasonFor={unavailableReasonFor}
        onApply={handleApplyPreset}
      />

      {actionError ? (
        <p className="text-sm leading-6 text-rust">{actionError}</p>
      ) : null}

      <div className="border-t pt-5">
        <p className="section-heading">What each task uses</p>
        <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
          Dictation and meetings hear you with different engines, and the AI
          that tidies the text afterwards is a separate choice again.
        </p>

        {inventoryUnavailable ? (
          <p className="mt-3 max-w-2xl text-sm leading-6 text-rust">
            Could not read the speech engines from the sidecar, so there is
            nothing here to choose between. The AI lanes below still work.
          </p>
        ) : null}

        <div className="mt-4 divide-y divide-border/60">
          {inventoryUnavailable ? null : (
            <div className="pb-5">
              <SpeechLaneRow
                title="Speech for dictation"
                implication="Runs while you talk, so this is the one where speed is felt."
                options={laneOptions("dictation", activeDictationRoute)}
                activeRoute={activeDictationRoute}
                activeRouteId={dictationRouteId}
                onDiskFor={onDiskFor}
                onSelect={(route) => handleSelectRoute("dictation", route)}
                onAction={(route) => void handleRouteAction(route)}
                actionBusy={busyRouteId === activeDictationRoute?.routeId}
                readinessOverride={dictationReadinessOverride}
                explainPauseBehavior
              />
            </div>
          )}

          {inventoryUnavailable ? null : (
            <div className="py-5">
              <SpeechLaneRow
                title="Speech for meetings"
                implication="Runs over a whole recording after the fact, so it can be slower than the dictation engine."
                options={laneOptions("meeting", activeMeetingRoute)}
                activeRoute={activeMeetingRoute}
                activeRouteId={meetingRouteId}
                onDiskFor={onDiskFor}
                onSelect={(route) => handleSelectRoute("meeting", route)}
                onAction={(route) => void handleRouteAction(route)}
                actionBusy={busyRouteId === activeMeetingRoute?.routeId}
                readinessOverride={meetingReadinessOverride}
                explainPauseBehavior={false}
              />
            </div>
          )}

          {AI_LANE_KEYS.map((lane) => (
            <div key={lane} className="py-5 last:pb-0">
              <AiLaneRow
                lane={lane}
                label={AI_LANE_COPY[lane].label}
                help={AI_LANE_COPY[lane].help}
                value={settings.privacy[lane]}
                remoteProcessingEnabled={settings.privacy.remoteProcessingEnabled}
                models={aiModelsForProvider(settings.privacy[lane].provider)}
                modelsLoading={aiModelsLoading}
                onProviderChange={onAiProviderChange}
                onModelChange={onAiModelChange}
                zeroSetupSlot={
                  settings.privacy[lane].provider === "bundled_local" ? (
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
                      availability={appleAvailability}
                      checking={appleChecking}
                      onRecheck={() => void refreshAppleAvailability(true)}
                    />
                  ) : null
                }
              />
            </div>
          ))}
        </div>
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
          />
        </div>
      )}

      <div className="border-t pt-5">
        <ModelFootprint
          index={downloadIndex}
          promotedTotalMib={promotedTotalMib}
          pendingMib={pendingMib}
        />
      </div>
    </div>
  );
}
