import { useEffect, useMemo, useRef, useState } from "react";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  AppWindow,
  CheckCircle2,
  Clipboard,
  GripHorizontal,
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
  getSettings,
  getDictationAudioLevel,
  startDictation,
  stopDictation,
} from "@/lib/tauri";
import {
  providerHostingPreference,
  type DictationRoutePreference,
} from "@/lib/asr-capabilities";
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
import { cn } from "@/lib/utils";
import type { AsrProviderType } from "@/types";
import type { DictationCustomMode } from "@/types/settings";

type DisplayMode = "full" | "compact" | "minimal";
type DictationPhase =
  | "idle"
  | "primed"
  | "recording"
  | "stopping"
  | "transcribing"
  | "delivering"
  | "done"
  | "error";

interface DictationStateChangedEvent {
  phase: DictationPhase;
  startedAtMs?: number | null;
  message?: string | null;
  preview?: string | null;
  partialText?: string | null;
  sessionId?: number | null;
  stopReason?: string | null;
  outcome?: string | null;
  resolvedModePreset?: DictationModePreset | null;
  resolvedCustomModeId?: string | null;
  resolvedModeLabel?: string | null;
  contextSource?: DictationContextSource | null;
  insertionMode?: DictationInsertionMode | null;
  appTarget?: string | null;
  activationMatcher?: string | null;
  dictationProvider?: string | null;
  dictationModelId?: string | null;
  requestedRoute?: DictationRoutePreference | null;
  resolvedRoute?: string | null;
  providerModelLabel?: string | null;
  dictationRoutePreference?: DictationRoutePreference | null;
  dictationResolvedHosting?: DictationRoutePreference | null;
}

interface DictationTextReadyEvent {
  text: string;
  pasted?: boolean;
  copied?: boolean;
  pasteError?: string | null;
  modelId?: string;
  insertionModeUsed?:
    | "auto"
    | "paste"
    | "inline"
    | "clipboard_only"
    | "command_only"
    | "none";
  commandApplied?: string | null;
  snippetAppliedCount?: number;
  appTarget?: string | null;
  activationMatcher?: string | null;
  contextSource?: DictationContextSource | null;
  routePreference?: DictationRoutePreference | null;
  resolvedRoute?: string | null;
  resolvedHosting?: DictationRoutePreference | null;
  providerModelLabel?: string | null;
  actualProvider?: string | null;
}

type DictationModePreset =
  | "voice"
  | "messages"
  | "email"
  | "notes"
  | "meeting_follow_up"
  | "custom";

type DictationContextSource =
  | "none"
  | "clipboard"
  | "selected_text"
  | "application_context";
type DictationInsertionMode = "auto" | "paste" | "inline" | "clipboard_only";
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
    return { width: 180, height: 48 };
  }

  if (displayMode === "compact") {
    const compactMessageLines = estimatePopupTextLines(message, 32);
    const compactPreviewLines = estimatePopupTextLines(preview, 32);
    return {
      width: 360,
      height:
        phase === "idle"
          ? 212
          : phase === "error"
            ? Math.max(212, 168 + compactMessageLines * 20)
            : phase === "done"
              ? Math.max(
                  196,
                  154 + Math.max(compactMessageLines, compactPreviewLines) * 18,
                )
              : phase === "recording"
                ? Math.max(182, 148 + compactPreviewLines * 16)
                : 164,
    };
  }

  if (phase === "idle") {
    return { width: 480, height: 336 };
  }

  if (phase === "error") {
    const messageLines = estimatePopupTextLines(message, 48);
    return { width: 480, height: Math.max(320, 248 + messageLines * 22) };
  }

  if (phase === "recording") {
    const previewLines = estimatePopupTextLines(preview, 48);
    return { width: 480, height: Math.max(248, 202 + previewLines * 18) };
  }

  if (phase === "done") {
    const contentLines = Math.max(
      estimatePopupTextLines(message, 48),
      estimatePopupTextLines(preview, 48),
    );
    return { width: 480, height: Math.max(264, 214 + contentLines * 20) };
  }

  const previewLines = estimatePopupTextLines(preview, 48);
  const messageLines = estimatePopupTextLines(message, 48);
  return {
    width: 480,
    height: Math.max(236, 194 + Math.max(previewLines, messageLines) * 18),
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
          : "border-white/10 bg-white/[0.045] hover:bg-white/[0.075]",
      )}
      onClick={onClick}
    >
      <div
        className={cn(
          "mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
          tone === "primary"
            ? "bg-white/10 text-white"
            : "bg-white/[0.08] text-slate-100",
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

function DictationWaveStrip({
  level,
  active,
  compact = false,
}: {
  level: number;
  active: boolean;
  compact?: boolean;
}) {
  const bars = compact
    ? [0.28, 0.52, 0.82, 1, 0.82, 0.52, 0.28]
    : [0.16, 0.28, 0.44, 0.66, 0.88, 1, 0.88, 0.66, 0.44, 0.28, 0.16];
  const baseHeight = compact ? 4 : 5;
  const maxExtraHeight = compact ? 12 : 17;

  return (
    <div
      className={cn(
        "relative flex items-center gap-1",
        compact ? "h-[18px]" : "h-6",
      )}
      aria-hidden="true"
    >
      <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-white/10" />
      {bars.map((weight, index) => {
        const intensity = active
          ? Math.max(0.16, Math.min(1, level * (0.72 + weight * 0.72) + 0.08))
          : 0.16;
        return (
          <div key={`meter-bar-${index}`} className="flex h-full items-center">
            <span
              className={cn(
                "rounded-full bg-white/85 transition-[height,opacity,transform] duration-150",
                compact ? "w-1" : "w-1.5",
              )}
              style={{
                height: `${baseHeight + intensity * maxExtraHeight * weight}px`,
                opacity: active ? 0.24 + intensity * 0.76 : 0.24,
                transform: `scaleY(${0.94 + intensity * 0.06})`,
                transformOrigin: "center center",
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

export function DictationPopup() {
  const window = getCurrentWindow();
  const [phase, setPhase] = useState<DictationPhase>("idle");
  const [startedAtMs, setStartedAtMs] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [displayMode, setDisplayMode] = useState<DisplayMode>("full");
  const [pushToTalk, setPushToTalk] = useState(true);
  const [handsFreeEnabled, setHandsFreeEnabled] = useState(false);
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
  const [requestedRoute, setRequestedRoute] =
    useState<DictationRoutePreference | null>(null);
  const [resolvedRoute, setResolvedRoute] = useState<string | null>(null);
  const [providerModelLabel, setProviderModelLabel] = useState<string | null>(
    null,
  );
  const [dictationRoutePreference, setDictationRoutePreference] =
    useState<DictationRoutePreference>("local");
  const [dictationResolvedHosting, setDictationResolvedHosting] =
    useState<DictationRoutePreference | null>(null);
  const [dictationInsertionMode, setDictationInsertionMode] =
    useState<DictationInsertionMode>("paste");
  const [useSharedAsrSelection, setUseSharedAsrSelection] = useState(true);
  const [meetingProvider, setMeetingProvider] = useState<string | null>(null);
  const [meetingModelId, setMeetingModelId] = useState<string | null>(null);
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
  const lastSessionIdRef = useRef<number | null>(null);
  const lastActiveStartedAtRef = useRef<number | null>(null);
  const sessionClockStartedAtRef = useRef<number | null>(null);
  const previousPhaseRef = useRef<DictationPhase>("idle");

  const refreshPopupSettings = async () => {
    const settings = await getSettings();
    setPushToTalk(Boolean(settings.transcription.dictationPushToTalk));
    setHandsFreeEnabled(
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
    setDictationRoutePreference(
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
  };

  const resetCompletionState = () => {
    setFinalText(null);
    setFinalCommandApplied(null);
    setFinalSnippetAppliedCount(0);
    setActionFeedback(null);
    setIsSpeakingAloud(false);
    stopSpeakingText();
  };

  const applyRuntimeMetadata = (payload: DictationStateChangedEvent) => {
    setResolvedModeLabel(payload.resolvedModeLabel ?? null);
    setRuntimeAppTarget(payload.appTarget ?? null);
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
    if (typeof payload.dictationModelId !== "undefined") {
      setDictationModelId(payload.dictationModelId ?? null);
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
      setDictationRoutePreference(payload.dictationRoutePreference ?? "local");
    }
    if (typeof payload.dictationResolvedHosting !== "undefined") {
      setDictationResolvedHosting(payload.dictationResolvedHosting ?? null);
    }
  };

  const applyOverlaySnapshot = (payload: DictationStateChangedEvent) => {
    applyRuntimeMetadata(payload);

    const nextSessionId =
      typeof payload.sessionId === "number" ? payload.sessionId : null;
    const nextStartedAtMs =
      typeof payload.startedAtMs === "number" ? payload.startedAtMs : null;
    const isActiveCapturePhase =
      payload.phase === "primed" || payload.phase === "recording";

    setPhase(payload.phase);
    setMessage(payload.message ?? null);
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
    let unlistenState: (() => void) | undefined;
    let unlistenTextReady: (() => void) | undefined;

    const setup = async () => {
      try {
        const initialState = await invoke<DictationStateChangedEvent>(
          "get_dictation_overlay_state",
        );
        applyOverlaySnapshot(initialState);
        void refreshPopupSettings().catch(() => {
          // Keep default mode if settings are temporarily unavailable.
        });
      } catch (error) {
        console.error("Failed to load initial dictation popup state:", error);
      }

      unlistenState = await listen<DictationStateChangedEvent>(
        "dictation-state-changed",
        (event) => {
          applyOverlaySnapshot(event.payload);
        },
      );

      unlistenTextReady = await listen<DictationTextReadyEvent>(
        "dictation-text-ready",
        (event) => {
          const payload = event.payload;
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
            setDictationResolvedHosting(payload.resolvedHosting ?? null);
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
        },
      );
    };

    void setup();
    return () => {
      stopSpeakingText();
      unlistenState?.();
      unlistenTextReady?.();
    };
  }, []);

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

  const modeMeta = MODE_META[modePreset] ?? MODE_META.voice;
  const selectedModeLabel =
    normalizePopupModeLabel(
      resolvedModeLabel ??
        (modePreset === "custom"
          ? (customModes.find((option) => option.id === selectedCustomModeId)
              ?.name ?? modeMeta.label)
          : modeMeta.label),
    ) ?? modeMeta.label;
  const contextMeta = CONTEXT_META[contextSource] ?? CONTEXT_META.none;
  const insertionMeta =
    INSERTION_META[dictationInsertionMode] ?? INSERTION_META.auto;
  const routeLabel = formatRouteLabel(
    providerModelLabel,
    resolvedRoute,
    dictationProvider,
    dictationModelId,
  );
  const hostingLabel =
    dictationResolvedHosting ??
    (dictationProvider
      ? providerHostingPreference(
          dictationProvider as AsrProviderType,
          dictationModelId,
        )
      : dictationRoutePreference);
  const meetingHostingLabel = meetingProvider
    ? providerHostingPreference(
        meetingProvider as AsrProviderType,
        meetingModelId,
      )
    : "local";
  const targetDetail = runtimeAppTarget ? ` for ${runtimeAppTarget}` : "";
  const autoActivationDetail =
    activationMatcher && runtimeAppTarget
      ? `Auto for ${runtimeAppTarget} via "${activationMatcher}"`
      : activationMatcher
        ? `Auto via "${activationMatcher}"`
        : null;
  const isCapturePhase = phase === "primed" || phase === "recording";

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

  useEffect(() => {
    if (phase !== "idle") {
      const showWindow = (
        window as typeof window & { show?: () => Promise<void> }
      ).show;
      if (typeof showWindow === "function") {
        void showWindow.call(window).catch((error) => {
          console.error("Failed to show dictation popup:", error);
        });
      }
      return;
    }

    void window.hide().catch((error) => {
      console.error("Failed to hide dictation popup while idle:", error);
    });
  }, [phase, window]);

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
      await window.hide();
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
        className="h-screen w-screen bg-transparent flex items-center justify-center"
        onMouseDownCapture={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          void window.startDragging();
        }}
        onDoubleClick={() => void cycleDisplayMode()}
        title="Double-click to expand"
      >
        <div className="flex items-center gap-2 rounded-full border border-white/10 bg-slate-950/88 px-3 py-[9px] shadow-lg backdrop-blur-md">
          <div className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-white/[0.08] text-slate-100">
            <Mic className="h-3.5 w-3.5" />
          </div>
          <DictationWaveStrip
            level={displayAudioLevel}
            active={phase === "recording"}
            compact
          />
          <span className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-200">
            {statusLabel}
          </span>
          <button
            type="button"
            className="inline-flex h-6 w-6 items-center justify-center rounded-full text-slate-300 hover:bg-white/8 hover:text-white"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => void hidePopup()}
            aria-label="Hide popup"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    );
  }

  const compact = displayMode === "compact";
  const doneTitle = formatDoneTitle(
    outcome,
    finalCommandApplied,
    runtimeAppTarget,
  );
  const doneMessage =
    message ??
    formatDoneMessage(
      outcome,
      finalCommandApplied,
      finalSnippetAppliedCount,
      runtimeAppTarget,
    );
  const commandLabel = formatAppliedDictationCommandLabel(finalCommandApplied);
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
      <div className="max-h-[calc(100vh-24px)] overflow-y-auto rounded-[22px] border border-white/10 bg-slate-950/92 px-4 py-3 backdrop-blur-2xl shadow-[0_18px_60px_rgba(2,6,23,0.55)]">
        <div
          data-tauri-drag-region
          className="mb-2 flex cursor-grab select-none items-center justify-between text-slate-300 active:cursor-grabbing"
          onMouseDownCapture={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            void window.startDragging();
          }}
        >
          <div className="inline-flex h-6 items-center gap-1 rounded-full border border-white/8 bg-white/[0.03] px-2 text-slate-400">
            <GripHorizontal className="h-3 w-3" />
          </div>
          <div className="inline-flex items-center gap-1">
            <button
              type="button"
              className="inline-flex h-6 w-6 items-center justify-center rounded-md text-slate-300 hover:bg-white/8 hover:text-white"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => void cycleDisplayMode()}
              aria-label={compact ? "Expand popup" : "Compact popup"}
            >
              {compact ? (
                <PanelsTopLeft className="h-3.5 w-3.5" />
              ) : (
                <Minimize2 className="h-3.5 w-3.5" />
              )}
            </button>
            <button
              type="button"
              className="inline-flex h-6 w-6 items-center justify-center rounded-md text-slate-300 hover:bg-white/8 hover:text-white"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => void openMainApp()}
              aria-label="Open app"
            >
              <AppWindow className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className="inline-flex h-6 w-6 items-center justify-center rounded-md text-slate-300 hover:bg-white/8 hover:text-white"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => void hidePopup()}
              aria-label="Hide popup"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {!compact && (
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 text-[11px] font-medium text-slate-100">
              <modeMeta.icon className="h-3.5 w-3.5" />
              {selectedModeLabel}
            </div>
            {useSharedAsrSelection ? (
              <div className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 text-[11px] font-medium text-slate-200">
                {hostingLabel === "cloud" ? "Cloud route" : "Local route"}
              </div>
            ) : (
              <>
                <div className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 text-[11px] font-medium text-slate-200">
                  Dictation: {hostingLabel === "cloud" ? "Cloud" : "Local"}
                </div>
                <div className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 text-[11px] font-medium text-slate-200">
                  Meeting: {meetingHostingLabel === "cloud" ? "Cloud" : "Local"}
                </div>
              </>
            )}
            {requestedRoute && (
              <div className="inline-flex items-center rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-slate-300">
                Requested {requestedRoute === "cloud" ? "cloud" : "local"}
              </div>
            )}
            <div className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] font-medium text-slate-200">
              <Clipboard className="h-3.5 w-3.5 text-slate-300" />
              {contextMeta.label}
            </div>
            <div className="inline-flex items-center rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-slate-300">
              {handsFreeEnabled
                ? "Hands-free"
                : pushToTalk
                  ? "Hold to talk"
                  : "Toggle capture"}
            </div>
          </div>
        )}

        {isCapturePhase && (
          <div className="flex items-center gap-3 text-white">
            <div className="inline-flex h-11 items-center gap-2 rounded-full border border-white/10 bg-white/[0.045] px-3">
              <div className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/[0.08]">
                <Mic
                  className={cn(
                    "h-4 w-4 text-slate-100 transition-opacity",
                    phase === "recording" ? "opacity-100" : "opacity-85",
                  )}
                />
              </div>
              <DictationWaveStrip
                level={displayAudioLevel}
                active={phase === "recording"}
              />
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold">
                {phase === "primed" ? "Ready" : "Listening"}
              </p>
              {!compact ? (
                <>
                  <p className="mt-1 text-xs text-slate-300">
                    {selectedModeLabel} · {contextMeta.detail} ·{" "}
                    {insertionMeta.label}
                    {runtimeAppTarget ? ` · Target ${runtimeAppTarget}` : ""}
                  </p>
                  {autoActivationDetail && (
                    <p className="mt-1 text-xs text-slate-400">
                      {autoActivationDetail}
                    </p>
                  )}
                  {phase === "recording" ? (
                    <>
                      <p className="mt-1.5 text-xs text-slate-300">
                        {handsFreeEnabled
                          ? `Speak naturally. Nautilus stops after silence${dictationInsertionMode === "clipboard_only" ? " and copies to clipboard" : ""}. Press again to stop sooner.`
                          : pushToTalk
                            ? `Release hotkey to ${dictationInsertionMode === "clipboard_only" ? "finish to clipboard" : "finish dictation"}`
                            : `Press the hotkey again to ${dictationInsertionMode === "clipboard_only" ? "finish to clipboard" : "finish dictation"}`}
                      </p>
                    </>
                  ) : (
                    <p className="mt-1.5 text-xs text-slate-300">
                      Preparing the capture path now. Start speaking
                      immediately.
                    </p>
                  )}
                </>
              ) : (
                <p className="mt-1 text-xs text-slate-300">
                  {phase === "primed"
                    ? "Getting ready."
                    : `${routeLabel} ready${targetDetail}.`}
                </p>
              )}
            </div>
            <span className="font-mono text-sm text-slate-300">
              {phase === "recording" ? elapsedText : "--:--"}
            </span>
            <button
              type="button"
              className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/12 bg-white/10 text-white hover:bg-white/15"
              onClick={() => void handleStopFromPopup()}
              aria-label="Stop dictation"
            >
              <Square className="h-4 w-4 fill-current" />
            </button>
            {!compact && elapsed >= 10 && (
              <button
                type="button"
                className="text-xs text-slate-300 underline underline-offset-2"
                onClick={() => void handleStopFromPopup()}
              >
                Stop now
              </button>
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
                <div className="mt-2 max-w-[330px] rounded-xl border border-white/10 bg-white/[0.045] px-3 py-2">
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
                <div className="mt-2 max-w-[330px] rounded-xl border border-white/10 bg-white/[0.045] px-3 py-2">
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
                    <span className="rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1">
                      {commandLabel}
                    </span>
                  )}
                  {finalSnippetAppliedCount > 0 && (
                    <span className="rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1">
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
                  <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1">
                    {outcome === "copied"
                      ? "Clipboard ready"
                      : "Edit commands available"}
                  </span>
                </div>
              )}
              {!compact && (finalText || preview) && (
                <div className="mt-3 max-w-[330px] rounded-xl border border-white/10 bg-white/[0.045] px-3 py-2">
                  <p className="text-[11px] uppercase tracking-wide text-slate-400">
                    Latest result
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-slate-200 line-clamp-4">
                    {finalText ?? preview}
                  </p>
                </div>
              )}
              {!compact && (
                <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.045] px-3 py-2">
                  <p className="text-[11px] uppercase tracking-wide text-slate-400">
                    Try an edit command
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
                    className="rounded-lg border border-white/10 bg-white/[0.05] px-2.5 py-1.5 hover:bg-white/[0.08]"
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
