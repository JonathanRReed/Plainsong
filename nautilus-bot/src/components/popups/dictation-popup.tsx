import { useEffect, useMemo, useRef, useState } from "react";
import { LogicalSize, invoke, getCurrentWindow } from "@/lib/electron";
import {
  AppWindow,
  CheckCircle2,
  Clipboard,
  History,
  Loader2,
  Mail,
  Mic,
  Minimize2,
  PanelsTopLeft,
  RotateCcw,
  Settings2,
  Square,
  StickyNote,
  TextCursorInput,
  TriangleAlert,
  Volume2,
  Wand2,
  X,
} from "lucide-react";
import {
  getDictationAudioLevel,
  startDictation,
  stopDictation,
} from "@/lib/backend/dictation";
import { getSettings } from "@/lib/backend/settings";
import {
  useDictationRuntime,
  type DictationContextSource,
  type DictationInsertionMode,
  type DictationModePreset,
  type DictationPhase,
  type DictationStateChangedEvent,
} from "@/features/dictation/runtime";
import type { DictationRoutePreference } from "@/lib/asr-capabilities";
import {
  formatAppliedDictationCommandLabel,
  isBacktrackDictationCommand,
} from "@/lib/dictation-command-labels";
import {
  canSpeakTextAloud,
  speakTextAloud,
  stopSpeakingText,
} from "@/lib/text-to-speech";
import { playDictationEarcon } from "@/lib/dictation-earcons";
import { sanitizeUserFacingDictationMessage } from "@/lib/dictation-ui-message";
import { cn } from "@/lib/utils";
import { AudioWaveform } from "@/components/ui/audio-waveform";
import type { DictationCustomMode } from "@/types/settings";

type DisplayMode = "full" | "compact" | "minimal";
const MODE_META: Record<
  DictationModePreset,
  { label: string; icon: typeof Mic; accent: string }
> = {
  voice: {
    label: "General",
    icon: Mic,
    accent: "text-cyan-200 bg-cyan-400/10 border-cyan-400/30",
  },
  messages: {
    label: "Slack & Chat",
    icon: TextCursorInput,
    accent: "text-emerald-200 bg-emerald-400/10 border-emerald-400/30",
  },
  email: {
    label: "Writing",
    icon: Mail,
    accent: "text-amber-200 bg-amber-400/10 border-amber-400/30",
  },
  notes: {
    label: "Notes",
    icon: StickyNote,
    accent: "text-violet-200 bg-violet-400/10 border-violet-400/30",
  },
  meeting_follow_up: {
    label: "Meeting Follow-up",
    icon: Wand2,
    accent: "text-fuchsia-200 bg-fuchsia-400/10 border-fuchsia-400/30",
  },
  custom: {
    label: "Custom",
    icon: Wand2,
    accent: "text-slate-200 bg-slate-400/10 border-slate-400/30",
  },
};

const CONTEXT_META: Record<
  DictationContextSource,
  { label: string; detail: string }
> = {
  none: { label: "No context", detail: "Fresh dictation" },
  clipboard: { label: "Clipboard", detail: "Using copied text" },
  selected_text: { label: "Selected text", detail: "Using current selection" },
  application_context: {
    label: "App context",
    detail: "Using the frontmost app and window",
  },
};

const INSERTION_META: Record<
  DictationInsertionMode,
  { label: string; detail: string }
> = {
  auto: { label: "Recommended", detail: "Best available insert path" },
  paste: { label: "Paste at cursor", detail: "Paste into the frontmost app" },
  inline: {
    label: "Insert on release",
    detail: "Single insert after you stop speaking",
  },
  clipboard_only: {
    label: "Clipboard only",
    detail: "Do not try to insert automatically",
  },
};

function formatRouteLabel(
  providerModelLabel: string | null,
  resolvedRoute: string | null,
  provider: string | null,
  modelId: string | null,
) {
  if (providerModelLabel) {
    return providerModelLabel;
  }
  if (resolvedRoute) {
    return resolvedRoute;
  }
  if (!provider && !modelId) {
    return "Current transcription route";
  }
  if (provider && modelId) {
    return `${provider} · ${modelId}`;
  }
  return provider || modelId || "Current transcription route";
}

function normalizePopupModeLabel(label: string | null): string | null {
  if (!label) {
    return null;
  }

  switch (label.trim().toLowerCase()) {
    case "voice":
      return "General";
    case "messages":
      return "Slack & Chat";
    case "email":
      return "Writing";
    case "follow-up":
    case "meeting follow-up":
      return "Meeting Follow-up";
    default:
      return label;
  }
}

function estimatePopupTextLines(value: string | null, charsPerLine: number) {
  if (!value) {
    return 0;
  }

  return value
    .split("\n")
    .reduce(
      (total, line) =>
        total + Math.max(1, Math.ceil(line.length / charsPerLine)),
      0,
    );
}

function getPopupSize(
  displayMode: DisplayMode,
  phase: DictationPhase,
  message: string | null,
  preview: string | null,
) {
  if (displayMode === "minimal") {
    return { width: 196, height: 52 };
  }

  if (displayMode === "compact") {
    const compactMessageLines = estimatePopupTextLines(message, 32);
    const compactPreviewLines = estimatePopupTextLines(preview, 32);
    return {
      width: 336,
      height:
        phase === "idle"
          ? 204
          : phase === "error"
            ? Math.max(188, 144 + compactMessageLines * 18)
            : phase === "done"
              ? Math.max(
                  188,
                  146 + Math.max(compactMessageLines, compactPreviewLines) * 16,
                )
              : phase === "recording"
                ? Math.max(164, 136 + compactPreviewLines * 15)
                : 152,
    };
  }

  if (phase === "idle") {
    return { width: 432, height: 308 };
  }

  if (phase === "error") {
    const messageLines = estimatePopupTextLines(message, 48);
    return { width: 432, height: Math.max(252, 212 + messageLines * 18) };
  }

  if (phase === "recording") {
    const previewLines = estimatePopupTextLines(preview, 48);
    return { width: 432, height: Math.max(232, 184 + previewLines * 16) };
  }

  if (phase === "done") {
    const contentLines = Math.max(
      estimatePopupTextLines(message, 48),
      estimatePopupTextLines(preview, 48),
    );
    return { width: 432, height: Math.max(248, 198 + contentLines * 18) };
  }

  const previewLines = estimatePopupTextLines(preview, 48);
  const messageLines = estimatePopupTextLines(message, 48);
  return {
    width: 432,
    height: Math.max(220, 182 + Math.max(previewLines, messageLines) * 16),
  };
}

function formatDoneTitle(
  outcome: string | null,
  commandApplied: string | null,
  appTarget: string | null,
) {
  if (isBacktrackDictationCommand(commandApplied)) {
    return "Backtrack applied";
  }

  if (commandApplied === "undo_last_insert") {
    return "Undo applied";
  }

  if (commandApplied) {
    return `${formatAppliedDictationCommandLabel(commandApplied) ?? "Command"} applied`;
  }

  if (outcome === "pasted") {
    return appTarget ? `Inserted into ${appTarget}` : "Inserted at cursor";
  }

  if (outcome === "copied") {
    return "Copied and ready to paste";
  }

  return "Transcription ready";
}

function formatDoneMessage(
  outcome: string | null,
  commandApplied: string | null,
  snippetAppliedCount: number,
  appTarget: string | null,
) {
  if (commandApplied === "backtrack_replace_last_insert") {
    return appTarget
      ? `Replaced the last insert for ${appTarget}.`
      : "Replaced the last insert.";
  }

  if (commandApplied === "backtrack_replace_phrase") {
    return "Replaced the phrase you corrected by voice.";
  }

  if (
    commandApplied === "backtrack_undo_last_insert" ||
    commandApplied === "undo_last_insert"
  ) {
    return "Undid the last insert.";
  }

  if (commandApplied) {
    return `${formatAppliedDictationCommandLabel(commandApplied) ?? "Command"} finished successfully.`;
  }

  if (snippetAppliedCount > 0) {
    return snippetAppliedCount === 1
      ? "1 snippet expanded in the final result."
      : `${snippetAppliedCount} snippets expanded in the final result.`;
  }

  if (outcome === "pasted") {
    return appTarget
      ? `The result was inserted into ${appTarget} and copied to your clipboard.`
      : "The result was inserted and copied to your clipboard.";
  }

  if (outcome === "copied") {
    return "The result is on your clipboard and ready to paste anywhere.";
  }

  return "The result is ready for a quick spoken edit or another pass.";
}

function formatLatencyMetric(ms: number | null): string | null {
  if (ms === null) return null;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatHandsFreeRuntimeHint(
  handsFreeEnabled: boolean,
  silenceTimeoutSeconds: number,
  runtimeAppTarget: string | null,
  contextDetail: string,
) {
  const targetDetail = runtimeAppTarget
    ? `Sending to ${runtimeAppTarget}`
    : contextDetail;

  if (!handsFreeEnabled) {
    return targetDetail;
  }

  const silenceDetail =
    silenceTimeoutSeconds > 0
      ? `stops after ${silenceTimeoutSeconds}s of silence or when you press again`
      : "stops when you press again after you finish speaking";

  return `Hands-free, ${silenceDetail}. ${targetDetail}`;
}

function PopupActionButton({
  icon: Icon,
  label,
  detail,
  onClick,
  tone = "default",
}: {
  icon: typeof Clipboard;
  label: string;
  detail: string;
  onClick: () => void;
  tone?: "default" | "primary";
}) {
  return (
    <button
      type="button"
      className={cn(
        "group flex items-start gap-3 rounded-xl border px-3 py-3 text-left transition-colors",
        tone === "primary"
          ? "border-white/12 bg-white/8 hover:bg-white/12"
          : "border-white/10 bg-white/4.5 hover:bg-white/7.5",
      )}
      onClick={onClick}
    >
      <div
        className={cn(
          "mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
          tone === "primary"
            ? "bg-white/10 text-white"
            : "bg-white/8 text-slate-100",
        )}
      >
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <p className="text-sm font-medium text-white">{label}</p>
        <p className="mt-1 text-xs leading-relaxed text-slate-300">{detail}</p>
      </div>
    </button>
  );
}

export function DictationPopup() {
  const window = getCurrentWindow();
  const { stateEvent, textReadyEvent } = useDictationRuntime();
  const [phase, setPhase] = useState<DictationPhase>("idle");
  const [startedAtMs, setStartedAtMs] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [displayMode, setDisplayMode] = useState<DisplayMode>("full");
  const [_pushToTalk, _setPushToTalk] = useState(true);
  const [_handsFreeEnabled, _setHandsFreeEnabled] = useState(false);
  const [handsFreeSilenceTimeoutSeconds, setHandsFreeSilenceTimeoutSeconds] =
    useState(0);
  const [displayAudioLevel, setDisplayAudioLevel] = useState(0);
  const [modePreset, setModePreset] = useState<DictationModePreset>("voice");
  const [contextSource, setContextSource] =
    useState<DictationContextSource>("none");
  const [selectedCustomModeId, setSelectedCustomModeId] = useState<
    string | null
  >(null);
  const [customModes, setCustomModes] = useState<DictationCustomMode[]>([]);
  const [dictationProvider, setDictationProvider] = useState<string | null>(
    null,
  );
  const [dictationModelId, setDictationModelId] = useState<string | null>(null);
  const [, setRequestedRoute] = useState<DictationRoutePreference | null>(null);
  const [resolvedRoute, setResolvedRoute] = useState<string | null>(null);
  const [providerModelLabel, setProviderModelLabel] = useState<string | null>(
    null,
  );
  const [_dictationRoutePreference, _setDictationRoutePreference] =
    useState<DictationRoutePreference>("local");
  const [_dictationResolvedHosting, _setDictationResolvedHosting] =
    useState<DictationRoutePreference | null>(null);
  const [dictationInsertionMode, setDictationInsertionMode] =
    useState<DictationInsertionMode>("paste");
  const [, setUseSharedAsrSelection] = useState(true);
  const [, setMeetingProvider] = useState<string | null>(null);
  const [, setMeetingModelId] = useState<string | null>(null);
  const [dictationCommandPrefix, setDictationCommandPrefix] =
    useState("command");
  const [resolvedModeLabel, setResolvedModeLabel] = useState<string | null>(
    null,
  );
  const [runtimeAppTarget, setRuntimeAppTarget] = useState<string | null>(null);
  const [activationMatcher, setActivationMatcher] = useState<string | null>(
    null,
  );
  const [finalText, setFinalText] = useState<string | null>(null);
  const [finalCommandApplied, setFinalCommandApplied] = useState<string | null>(
    null,
  );
  const [finalSnippetAppliedCount, setFinalSnippetAppliedCount] = useState(0);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);
  const [isSpeakingAloud, setIsSpeakingAloud] = useState(false);
  // @ts-ignore - Used for latency tracking, will be displayed in future UI
  const [startupLatencyMs, setStartupLatencyMs] = useState<number | null>(null);
  const [transcriptionLatencyMs, setTranscriptionLatencyMs] = useState<number | null>(null);
  const [insertLatencyMs, setInsertLatencyMs] = useState<number | null>(null);
  const lastSessionIdRef = useRef<number | null>(null);
  const lastActiveStartedAtRef = useRef<number | null>(null);
  const sessionClockStartedAtRef = useRef<number | null>(null);
  const previousPhaseRef = useRef<DictationPhase>("idle");

  const refreshPopupSettings = async () => {
    const settings = await getSettings();
    _setPushToTalk(Boolean(settings.transcription.dictationPushToTalk));
    _setHandsFreeEnabled(
      Boolean(settings.transcription.dictationHandsFreeEnabled),
    );
    setModePreset(
      (settings.transcription.dictationModePreset ??
        "voice") as DictationModePreset,
    );
    setSelectedCustomModeId(
      settings.transcription.dictationSelectedCustomModeId ?? null,
    );
    setCustomModes(settings.transcription.dictationCustomModes ?? []);
    setContextSource(
      (settings.transcription.dictationContextSource ??
        "none") as DictationContextSource,
    );
    setDictationProvider(settings.transcription.dictationProvider ?? null);
    setDictationModelId(settings.transcription.dictationModelId ?? null);
    _setDictationRoutePreference(
      settings.transcription.dictationRoutePreference === "cloud"
        ? "cloud"
        : "local",
    );
    setDictationInsertionMode(
      (settings.transcription.dictationInsertionMode ??
        "paste") as DictationInsertionMode,
    );
    const shared = settings.transcription.useSharedAsrSelection ?? true;
    setUseSharedAsrSelection(shared);
    setMeetingProvider(
      shared
        ? (settings.transcription.defaultProvider ?? null)
        : (settings.transcription.meetingProvider ?? null),
    );
    setMeetingModelId(
      shared
        ? (settings.transcription.selectedModelId ?? null)
        : (settings.transcription.meetingModelId ?? null),
    );
    setDictationCommandPrefix(
      settings.transcription.dictationCommandPrefix ?? "command",
    );
    setHandsFreeSilenceTimeoutSeconds(
      settings.transcription.dictationSilenceTimeoutSeconds ?? 0,
    );
  };

  const resetCompletionState = () => {
    setFinalText(null);
    setFinalCommandApplied(null);
    setFinalSnippetAppliedCount(0);
    setActionFeedback(null);
    setIsSpeakingAloud(false);
    setStartupLatencyMs(null);
    setTranscriptionLatencyMs(null);
    setInsertLatencyMs(null);
    stopSpeakingText();
  };

  const applyRuntimeMetadata = (payload: DictationStateChangedEvent) => {
    setResolvedModeLabel(payload.resolvedModeLabel ?? null);
    setRuntimeAppTarget(payload.targetApp ?? payload.appTarget ?? null);
    if (payload.resolvedModePreset) {
      setModePreset(payload.resolvedModePreset);
    }
    if (typeof payload.resolvedCustomModeId !== "undefined") {
      setSelectedCustomModeId(payload.resolvedCustomModeId ?? null);
    }
    if (payload.contextSource) {
      setContextSource(payload.contextSource);
    }
    if (payload.insertionMode) {
      setDictationInsertionMode(payload.insertionMode);
    }
    if (typeof payload.activationMatcher !== "undefined") {
      setActivationMatcher(payload.activationMatcher ?? null);
    }
    if (typeof payload.dictationProvider !== "undefined") {
      setDictationProvider(payload.dictationProvider ?? null);
    }
    if (typeof payload.actualProvider !== "undefined") {
      setDictationProvider(payload.actualProvider ?? null);
    }
    if (typeof payload.dictationModelId !== "undefined") {
      setDictationModelId(payload.dictationModelId ?? null);
    }
    if (typeof payload.actualModelId !== "undefined") {
      setDictationModelId(payload.actualModelId ?? null);
    }
    if (typeof payload.requestedRoute !== "undefined") {
      setRequestedRoute(payload.requestedRoute ?? null);
    }
    if (typeof payload.resolvedRoute !== "undefined") {
      setResolvedRoute(payload.resolvedRoute ?? null);
    }
    if (typeof payload.providerModelLabel !== "undefined") {
      setProviderModelLabel(payload.providerModelLabel ?? null);
    }
    if (typeof payload.dictationRoutePreference !== "undefined") {
      _setDictationRoutePreference(payload.dictationRoutePreference ?? "local");
    }
    if (typeof payload.dictationResolvedHosting !== "undefined") {
      _setDictationResolvedHosting(payload.dictationResolvedHosting ?? null);
    }
  };

  const applyOverlaySnapshot = (payload: DictationStateChangedEvent) => {
    if (payload.dismissed) {
      setPhase("idle");
      setMessage(null);
      setPreview(null);
      setOutcome(null);
      resetCompletionState();
      return;
    }

    applyRuntimeMetadata(payload);
    const sanitizedMessage = sanitizeUserFacingDictationMessage(
      payload.message,
      {
        phase:
          payload.phase === "transcribing" ||
          payload.phase === "delivering" ||
          payload.phase === "done" ||
          payload.phase === "error"
            ? payload.phase
            : "recording",
      },
    );

    const nextSessionId =
      typeof payload.sessionId === "number" ? payload.sessionId : null;
    const nextStartedAtMs =
      typeof payload.startedAtMs === "number" ? payload.startedAtMs : null;
    const isActiveCapturePhase =
      payload.phase === "primed" || payload.phase === "recording";

    setPhase(payload.phase);
    setMessage(sanitizedMessage);
    setPreview(payload.partialText ?? payload.preview ?? null);
    setOutcome(payload.outcome ?? null);
    if (payload.phase === "idle") {
      resetCompletionState();
      lastSessionIdRef.current = null;
      lastActiveStartedAtRef.current = null;
      sessionClockStartedAtRef.current = null;
      setStartedAtMs(null);
      setElapsed(0);
      return;
    }

    if (nextSessionId !== null && nextSessionId !== lastSessionIdRef.current) {
      if (payload.phase !== "done") {
        resetCompletionState();
      }
      lastSessionIdRef.current = nextSessionId;
      const nextClockStart =
        nextStartedAtMs ?? (isActiveCapturePhase ? Date.now() : null);
      lastActiveStartedAtRef.current = isActiveCapturePhase
        ? nextClockStart
        : null;
      sessionClockStartedAtRef.current = nextClockStart;
      setStartedAtMs(nextClockStart);
      setElapsed(0);
      return;
    }

    if (nextSessionId !== null) {
      lastSessionIdRef.current = nextSessionId;
    }

    if (
      isActiveCapturePhase &&
      nextStartedAtMs !== null &&
      lastActiveStartedAtRef.current === null
    ) {
      lastActiveStartedAtRef.current = nextStartedAtMs;
    }

    const effectiveStartedAt =
      lastActiveStartedAtRef.current ??
      sessionClockStartedAtRef.current ??
      nextStartedAtMs ??
      (isActiveCapturePhase ? Date.now() : null);

    if (effectiveStartedAt !== null) {
      sessionClockStartedAtRef.current = effectiveStartedAt;
      setStartedAtMs(effectiveStartedAt);
    }
  };

  const handleStopFromPopup = async () => {
    try {
      await stopDictation();
    } catch (error) {
      console.error("Failed to stop dictation from popup:", error);
    }
  };

  useEffect(() => {
    void refreshPopupSettings().catch(() => {
      // Keep default mode if settings are temporarily unavailable.
    });

    return () => {
      stopSpeakingText();
    };
  }, []);

  useEffect(() => {
    if (stateEvent) {
      applyOverlaySnapshot(stateEvent);
    }
  }, [stateEvent]);

  useEffect(() => {
    if (!textReadyEvent) {
      return;
    }

    const payload = textReadyEvent;
    setFinalText(payload.text ?? null);
    setFinalCommandApplied(payload.commandApplied ?? null);
    setFinalSnippetAppliedCount(payload.snippetAppliedCount ?? 0);
    setActionFeedback(null);
    if (typeof payload.appTarget !== "undefined") {
      setRuntimeAppTarget(payload.appTarget ?? null);
    }
    if (typeof payload.activationMatcher !== "undefined") {
      setActivationMatcher(payload.activationMatcher ?? null);
    }
    if (payload.contextSource) {
      setContextSource(payload.contextSource);
    }
    if (typeof payload.resolvedRoute !== "undefined") {
      setResolvedRoute(payload.resolvedRoute ?? null);
    }
    if (typeof payload.providerModelLabel !== "undefined") {
      setProviderModelLabel(payload.providerModelLabel ?? null);
    }
    if (typeof payload.routePreference !== "undefined") {
      setRequestedRoute(payload.routePreference ?? null);
    }
    if (typeof payload.resolvedHosting !== "undefined") {
      _setDictationResolvedHosting(payload.resolvedHosting ?? null);
    }
    if (
      typeof payload.insertionModeUsed !== "undefined" &&
      payload.insertionModeUsed
    ) {
      setDictationInsertionMode(
        payload.insertionModeUsed === "command_only" ||
          payload.insertionModeUsed === "none"
          ? "clipboard_only"
          : payload.insertionModeUsed,
      );
    }
    if (
      typeof payload.actualProvider !== "undefined" &&
      payload.actualProvider
    ) {
      setDictationProvider(payload.actualProvider);
    }
    if (typeof payload.modelId !== "undefined" && payload.modelId) {
      setDictationModelId(payload.modelId);
    }
    if (typeof payload.startupLatencyMs !== "undefined") {
      setStartupLatencyMs(payload.startupLatencyMs ?? null);
    }
    if (typeof payload.latencyMs !== "undefined") {
      setTranscriptionLatencyMs(payload.latencyMs);
    }
    if (typeof payload.insertLatencyMs !== "undefined") {
      setInsertLatencyMs(payload.insertLatencyMs);
    }
  }, [textReadyEvent]);

  useEffect(() => {
    if (phase === "idle") {
      setElapsed(0);
      return;
    }

    if (phase !== "recording" || startedAtMs === null) {
      return;
    }

    const tick = () => {
      setElapsed(Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000)));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [phase, startedAtMs]);

  useEffect(() => {
    if (phase !== "recording") {
      setDisplayAudioLevel(0);
      return;
    }

    let mounted = true;
    const sampleLevel = () => {
      void getDictationAudioLevel()
        .then((level) => {
          if (!mounted) {
            return;
          }

          const scaled = Math.min(
            1,
            Math.max(0, level < 0.03 ? 0 : level * 1.9),
          );
          setDisplayAudioLevel((current) => {
            const next =
              scaled > current
                ? current + (scaled - current) * 0.7
                : current * 0.58 + scaled * 0.42;
            return Math.abs(next - current) < 0.01 ? scaled : next;
          });
        })
        .catch(() => {
          if (mounted) {
            setDisplayAudioLevel((current) => current * 0.5);
          }
        });
    };

    sampleLevel();
    const id = setInterval(sampleLevel, 120);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, [phase]);


  useEffect(() => {
    const previousPhase = previousPhaseRef.current;

    if (phase !== previousPhase) {
      if (phase === "recording" && previousPhase !== "recording") {
        void playDictationEarcon("start");
      } else if (phase === "done" && previousPhase !== "done") {
        void playDictationEarcon("success");
      } else if (phase === "error" && previousPhase !== "error") {
        void playDictationEarcon("error");
      }
      previousPhaseRef.current = phase;
    }
  }, [phase]);

  const elapsedText = useMemo(() => {
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }, [elapsed]);

  const computedMeta = useMemo(() => {
    const modeMetaValue = MODE_META[modePreset] ?? MODE_META.voice;
    const selectedModeLabelValue =
      normalizePopupModeLabel(
        resolvedModeLabel ??
          (modePreset === "custom"
            ? (customModes.find((option) => option.id === selectedCustomModeId)
                ?.name ?? modeMetaValue.label)
            : modeMetaValue.label),
      ) ?? modeMetaValue.label;
    const contextMetaValue = CONTEXT_META[contextSource] ?? CONTEXT_META.none;
    const insertionMetaValue =
      INSERTION_META[dictationInsertionMode] ?? INSERTION_META.auto;
    const routeLabelValue = formatRouteLabel(
      providerModelLabel,
      resolvedRoute,
      dictationProvider,
      dictationModelId,
    );
    const targetDetailValue = runtimeAppTarget ? ` for ${runtimeAppTarget}` : "";
    const autoActivationDetailValue =
      activationMatcher && runtimeAppTarget
        ? `Auto for ${runtimeAppTarget} via "${activationMatcher}"`
        : activationMatcher
          ? `Auto via "${activationMatcher}"`
          : null;
    const isCapturePhaseValue = phase === "primed" || phase === "recording";

    return {
      modeMeta: modeMetaValue,
      selectedModeLabel: selectedModeLabelValue,
      contextMeta: contextMetaValue,
      insertionMeta: insertionMetaValue,
      routeLabel: routeLabelValue,
      targetDetail: targetDetailValue,
      autoActivationDetail: autoActivationDetailValue,
      isCapturePhase: isCapturePhaseValue,
    };
  }, [
    modePreset,
    resolvedModeLabel,
    customModes,
    selectedCustomModeId,
    contextSource,
    dictationInsertionMode,
    providerModelLabel,
    resolvedRoute,
    dictationProvider,
    dictationModelId,
    runtimeAppTarget,
    activationMatcher,
    phase,
  ]);

  const { selectedModeLabel, contextMeta, insertionMeta, routeLabel, targetDetail, autoActivationDetail, isCapturePhase } = computedMeta;

  const cycleDisplayMode = async () => {
    const next: DisplayMode =
      displayMode === "full"
        ? "compact"
        : displayMode === "compact"
          ? "minimal"
          : "full";
    setDisplayMode(next);
  };

  useEffect(() => {
    const { width, height } = getPopupSize(
      displayMode,
      phase,
      message,
      preview,
    );
    void window.setSize(new LogicalSize(width, height)).catch((error) => {
      console.error("Failed to resize dictation popup:", error);
    });
  }, [displayMode, message, phase, preview, window]);

  const openMainApp = async (
    view?: "dictation" | "settings" | "recordings",
  ) => {
    try {
      if (view) {
        await invoke("open_main_window_to", { view });
      } else {
        await invoke("open_main_window");
      }
    } catch (error) {
      console.error("Failed to open main window:", error);
    }
  };

  const hidePopup = async () => {
    try {
      await invoke("dismiss_dictation_overlay");
    } catch (error) {
      console.error("Failed to hide dictation popup:", error);
    }
  };

  const handleStartAgain = async () => {
    try {
      setActionFeedback(null);
      setIsSpeakingAloud(false);
      stopSpeakingText();
      await startDictation();
    } catch (error) {
      console.error("Failed to restart dictation from popup:", error);
    }
  };

  const handleCopyResult = async () => {
    if (!finalText?.trim()) {
      return;
    }

    try {
      await navigator.clipboard.writeText(finalText);
      setActionFeedback("Copied result");
    } catch (error) {
      console.error("Failed to copy dictation result from popup:", error);
      setActionFeedback("Copy failed");
    }
  };

  const handleToggleReadAloud = async () => {
    const text = (finalText ?? preview ?? "").trim();
    if (!text) {
      return;
    }

    if (isSpeakingAloud) {
      stopSpeakingText();
      setIsSpeakingAloud(false);
      setActionFeedback("Stopped read aloud");
      return;
    }

    setActionFeedback(null);
    setIsSpeakingAloud(true);
    const started = speakTextAloud(text, {
      onEnd: () => setIsSpeakingAloud(false),
      onError: () => setActionFeedback("Read aloud unavailable"),
    });

    if (!started) {
      setIsSpeakingAloud(false);
      setActionFeedback(
        canSpeakTextAloud()
          ? "Read aloud unavailable"
          : "Read aloud not supported here",
      );
    }
  };

  // ── Minimal pill mode ────────────────────────────────────────────────────
  if (displayMode === "minimal") {
    const statusLabel =
      phase === "recording"
        ? "Listening"
        : phase === "done"
          ? "Ready"
          : phase === "error"
            ? "Problem"
            : "Working";

    return (
      <div
        data-drag-region
        className="h-screen w-screen bg-transparent flex items-center justify-center"
        onDoubleClick={() => void cycleDisplayMode()}
        title="Double-click to expand"
      >
        <div className="flex items-center gap-2 rounded-full border border-white/10 bg-slate-950/92 px-3 py-2 shadow-[0_10px_30px_rgba(2,6,23,0.4)] backdrop-blur-xl">
          <div className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-white/6 text-slate-100">
            <Mic className="h-3 w-3" />
          </div>
          <AudioWaveform
            levels={displayAudioLevel}
            active={phase === "recording"}
            size="sm"
            barCount={11}
            barColor="white"
          />
          <span className="text-[11px] font-medium tracking-[0.08em] text-slate-200">
            {statusLabel}
          </span>
          <button
            type="button"
            className="inline-flex h-6 w-6 items-center justify-center rounded-full text-slate-400 hover:bg-white/8 hover:text-white"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => void hidePopup()}
            aria-label="Hide popup"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      </div>
    );
  }

  const compact = displayMode === "compact";
  const phaseLabel =
    phase === "primed"
      ? "Ready"
      : phase === "recording"
        ? "Listening"
        : phase === "transcribing"
          ? "Transcribing"
          : phase === "delivering"
            ? "Inserting"
            : phase === "done"
              ? "Ready"
              : phase === "error"
                ? "Problem"
                : "Working";

  const { doneTitle, doneMessage, commandLabel } = useMemo(() => ({
    doneTitle: formatDoneTitle(
      outcome,
      finalCommandApplied,
      runtimeAppTarget,
    ),
    doneMessage:
      message ??
      formatDoneMessage(
        outcome,
        finalCommandApplied,
        finalSnippetAppliedCount,
        runtimeAppTarget,
      ),
    commandLabel: formatAppliedDictationCommandLabel(finalCommandApplied),
  }), [outcome, finalCommandApplied, runtimeAppTarget, message, finalSnippetAppliedCount]);
  const spokenEditHints = [
    "scratch that",
    "actually ...",
    "replace X with Y",
    `${dictationCommandPrefix} rewrite professional`,
  ];

  if (phase === "idle") {
    return <div className="h-screen w-screen bg-transparent" />;
  }

  return (
    <div className="h-screen w-screen bg-transparent p-3">
      <div className="overflow-hidden rounded-[20px] border border-white/8 bg-black/80 px-4 py-3.5 backdrop-blur-xl shadow-[0_20px_60px_rgba(0,0,0,0.5)]">
        {/* Header - Minimal */}
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-slate-400">{phaseLabel}</span>
            <span className="text-slate-600">·</span>
            <span className="text-xs text-slate-300">{selectedModeLabel}</span>
          </div>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-slate-200 transition-colors"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => void cycleDisplayMode()}
              aria-label={compact ? "Expand" : "Compact"}
            >
              {compact ? <PanelsTopLeft className="h-3.5 w-3.5" /> : <Minimize2 className="h-3.5 w-3.5" />}
            </button>
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 hover:bg-white/5 hover:text-slate-200 transition-colors"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => void hidePopup()}
              aria-label="Hide"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {isCapturePhase && (
          <div className="space-y-3">
            {/* Main Recording Bar - Super Minimal */}
            <div className="flex items-center gap-3 rounded-2xl bg-white/3 px-3 py-2.5">
              {/* Mic Icon */}
              <div className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-all",
                phase === "recording" ? "bg-emerald-500/15" : "bg-white/5"
              )}>
                <Mic className={cn("h-4 w-4", phase === "recording" ? "text-emerald-400" : "text-slate-400")} />
              </div>
              
              {/* Waveform */}
              <div className="flex-1">
                <AudioWaveform
                  levels={displayAudioLevel}
                  active={phase === "recording"}
                  size="sm"
                  barCount={20}
                  barColor="white"
                />
              </div>
              
              {/* Timer */}
              <span className={cn(
                "shrink-0 font-mono text-sm tabular-nums",
                phase === "recording" ? "text-emerald-400" : "text-slate-500"
              )}>
                {elapsedText}
              </span>
              
              {/* Stop Button */}
              <button
                type="button"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/15 transition-colors"
                onClick={() => void handleStopFromPopup()}
                aria-label="Stop"
              >
                <Square className="h-3.5 w-3.5 fill-current" />
              </button>
            </div>
            
            {/* Subtle Status Line */}
            <p className="text-[11px] text-slate-500 text-center">
              {formatHandsFreeRuntimeHint(
                _handsFreeEnabled,
                handsFreeSilenceTimeoutSeconds,
                runtimeAppTarget,
                contextMeta.detail,
              )}
            </p>
            {!compact && preview && (
              <div className="rounded-[20px] border border-white/10 bg-white/3 px-4 py-3">
                <p className="text-[11px] font-medium tracking-[0.16em] text-slate-500">
                  Live text
                </p>
                <p className="mt-2 text-sm leading-6 text-slate-200 line-clamp-4">
                  {preview}
                </p>
              </div>
            )}
          </div>
        )}

        {phase === "stopping" && (
          <div className="flex items-center gap-3 text-white">
            <Loader2 className="h-5 w-5 animate-spin text-slate-200" />
            <div>
              <p className="text-sm font-semibold">Stopping</p>
              <p className="text-xs text-slate-300">
                Finalizing audio and preserving context…
              </p>
            </div>
          </div>
        )}

        {phase === "transcribing" && (
          <div className="flex items-center gap-3 text-white">
            <Loader2 className="h-5 w-5 animate-spin text-slate-200" />
            <div>
              <p className="text-sm font-semibold">Transcribing</p>
              <p className="text-xs text-slate-300">
                {message ??
                  `${selectedModeLabel} is shaping the result for ${insertionMeta.label.toLowerCase()}${targetDetail}.`}
              </p>
              {autoActivationDetail && (
                <p className="mt-1 text-xs text-slate-400">
                  {autoActivationDetail}
                </p>
              )}
              {!compact && preview && (
                <div className="mt-2 max-w-[330px] rounded-xl border border-white/10 bg-white/4.5 px-3 py-2">
                  <p className="text-[11px] uppercase tracking-wide text-slate-400">
                    Live preview
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-slate-200 line-clamp-4">
                    {preview}
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {phase === "delivering" && (
          <div className="flex items-center gap-3 text-white">
            <Loader2 className="h-5 w-5 animate-spin text-slate-200" />
            <div>
              <p className="text-sm font-semibold">Inserting</p>
              <p className="text-xs text-slate-300">
                {message ??
                  `Finishing ${insertionMeta.label.toLowerCase()}${targetDetail} with ${routeLabel}.`}
              </p>
              {!compact && preview && (
                <div className="mt-2 max-w-[330px] rounded-xl border border-white/10 bg-white/4.5 px-3 py-2">
                  <p className="text-[11px] uppercase tracking-wide text-slate-400">
                    Latest text
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-slate-200 line-clamp-4">
                    {preview}
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {phase === "done" && (
          <div className="flex items-center gap-3 text-white">
            <CheckCircle2 className="h-5 w-5 text-slate-100" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">{doneTitle}</p>
              {!compact && (
                <p className="max-w-[330px] text-xs leading-relaxed text-slate-300">
                  {doneMessage}
                </p>
              )}
              {!compact && (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-200">
                  {commandLabel && (
                    <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1">
                      {commandLabel}
                    </span>
                  )}
                  {finalSnippetAppliedCount > 0 && (
                    <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1">
                      {finalSnippetAppliedCount === 1
                        ? "1 snippet"
                        : `${finalSnippetAppliedCount} snippets`}
                    </span>
                  )}
                  {runtimeAppTarget && (
                    <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1">
                      Target {runtimeAppTarget}
                    </span>
                  )}
                  {transcriptionLatencyMs !== null && (
                    <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1">
                      {formatLatencyMetric(transcriptionLatencyMs)} transcribe
                    </span>
                  )}
                  {insertLatencyMs !== null && (
                    <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1">
                      {formatLatencyMetric(insertLatencyMs)} insert
                    </span>
                  )}
                  <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1">
                    {outcome === "copied"
                      ? "Clipboard ready"
                      : "Edit commands available"}
                  </span>
                </div>
              )}
              {!compact && (finalText || preview) && (
                <div className="mt-3 max-w-[330px] rounded-xl border border-white/10 bg-white/4.5 px-3 py-2">
                  <p className="text-[11px] uppercase tracking-wide text-slate-400">
                    Latest result
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-slate-200 line-clamp-4">
                    {finalText ?? preview}
                  </p>
                </div>
              )}
              {!compact && (
                <div className="mt-3 rounded-xl border border-white/10 bg-white/4.5 px-3 py-2">
                  <p className="text-[11px] uppercase tracking-wide text-slate-400">
                    Voice edits
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-slate-200">
                    {spokenEditHints.map((hint) => (
                      <span
                        key={hint}
                        className="rounded-full border border-white/10 bg-slate-950/90 px-2.5 py-1"
                      >
                        {hint}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {!compact && (
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-300">
                  <div className="grid w-full gap-2 sm:grid-cols-2">
                    {finalText?.trim() && (
                      <PopupActionButton
                        icon={Clipboard}
                        label="Copy result"
                        detail="Put the latest text on your clipboard again."
                        onClick={() => void handleCopyResult()}
                      />
                    )}
                    <PopupActionButton
                      icon={RotateCcw}
                      label="Start again"
                      detail="Jump straight into another dictation."
                      onClick={() => void handleStartAgain()}
                      tone="primary"
                    />
                    {finalText?.trim() && (
                      <PopupActionButton
                        icon={Volume2}
                        label={isSpeakingAloud ? "Stop reading" : "Read aloud"}
                        detail="Play the latest result back without leaving the popup."
                        onClick={() => void handleToggleReadAloud()}
                      />
                    )}
                    <PopupActionButton
                      icon={History}
                      label="Open history"
                      detail="Review recent dictations and reprocess a result."
                      onClick={() => void openMainApp("dictation")}
                    />
                    <PopupActionButton
                      icon={AppWindow}
                      label="Open app"
                      detail="Return to the full workspace for meetings and settings."
                      onClick={() => void openMainApp()}
                    />
                  </div>
                </div>
              )}
              {!compact && actionFeedback && (
                <p className="mt-2 text-xs text-slate-300">{actionFeedback}</p>
              )}
            </div>
          </div>
        )}

        {phase === "error" && (
          <div className="flex items-center gap-3 text-white">
            <TriangleAlert className="h-5 w-5 text-slate-100" />
            <div>
              <p className="text-sm font-semibold">Problem</p>
              {!compact && message && (
                <p className="max-w-[330px] text-xs leading-relaxed text-slate-300">
                  {message}
                </p>
              )}
              {!compact && (
                <p className="text-xs text-slate-400">
                  Check microphone access, {routeLabel.toLowerCase()}, and
                  shortcut permissions.
                </p>
              )}
              {!compact && (
                <div className="mt-2 flex items-center gap-2 text-xs text-slate-300">
                  <button
                    type="button"
                    className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 hover:bg-white/8"
                    onClick={() => void handleStartAgain()}
                  >
                    Start again
                  </button>
                  <button
                    type="button"
                    className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 hover:bg-white/10"
                    onClick={() => void openMainApp("dictation")}
                  >
                    Open dictation
                  </button>
                  <button
                    type="button"
                    className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 hover:bg-white/10"
                    onClick={() => void openMainApp("settings")}
                  >
                    <Settings2 className="mr-1 inline h-3.5 w-3.5" />
                    Open settings
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
