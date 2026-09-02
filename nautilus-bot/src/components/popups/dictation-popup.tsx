import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
  getPopupSize,
  type DictationPopupDisplayMode,
} from "@/lib/dictation-popup-layout";
import { formatShortcutForDisplay } from "@/lib/shortcuts";
import {
  describeDictationDeliveryRefusal,
  sanitizeUserFacingDictationMessage,
} from "@/lib/dictation-ui-message";
import { cn } from "@/lib/utils";
import { AudioWaveform } from "@/components/ui/audio-waveform";
import { WaveformVisualizer } from "@/components/waveform-visualizer";
import type { DictationCustomMode } from "@/types/settings";

type DisplayMode = DictationPopupDisplayMode;
const DISPLAY_MODES: DisplayMode[] = ["full", "compact", "minimal"];

function isDisplayMode(value: unknown): value is DisplayMode {
  return (
    typeof value === "string" && DISPLAY_MODES.includes(value as DisplayMode)
  );
}

const MODE_META: Record<
  DictationModePreset,
  { label: string; icon: typeof Mic; accent: string }
> = {
  voice: {
    label: "General",
    icon: Mic,
    accent: "text-rust border-rust/30 bg-rust/5",
  },
  messages: {
    label: "Slack & Chat",
    icon: TextCursorInput,
    accent: "text-rust border-rust/30 bg-rust/5",
  },
  email: {
    label: "Writing",
    icon: Mail,
    accent: "text-rust border-rust/30 bg-rust/5",
  },
  notes: {
    label: "Notes",
    icon: StickyNote,
    accent: "text-rust border-rust/30 bg-rust/5",
  },
  meeting_follow_up: {
    label: "Meeting Follow-up",
    icon: Wand2,
    accent: "text-rust border-rust/30 bg-rust/5",
  },
  custom: {
    label: "Custom",
    icon: Wand2,
    accent: "text-rust border-rust/30 bg-rust/5",
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
  auto: {
    label: "Insert at cursor",
    detail: "Insert into the frontmost app",
  },
  clipboard_only: {
    label: "Clipboard only",
    detail: "Do not try to insert automatically",
  },
};

const CLOUD_PROVIDER_LABELS: Record<string, string> = {
  openai_cloud: "OpenAI",
  groq: "Groq",
  elevenlabs_scribe: "ElevenLabs",
  cohere_transcribe: "Cohere",
};

function formatRouteLabel(
  resolvedHosting: DictationRoutePreference | null,
  provider: string | null,
) {
  const isCloud =
    resolvedHosting === "cloud" ||
    (resolvedHosting === null && provider !== null && provider in CLOUD_PROVIDER_LABELS);

  if (!isCloud) {
    return "On this Mac";
  }

  const cloudName = provider ? CLOUD_PROVIDER_LABELS[provider] : undefined;
  return cloudName ? `Cloud (${cloudName})` : "Cloud";
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

function formatDoneTitle(
  outcome: string | null,
  commandApplied: string | null,
  appTarget: string | null,
) {
  // A refused delivery (password or secure field) and a failed one both
  // land on phase "done" — the transcript exists and is in history, only the
  // insertion did not happen. Both have to win over the command arms below:
  // a command applied to text the user never received is not something to
  // report as applied.
  const refusal = describeDictationDeliveryRefusal(outcome);
  if (refusal) {
    return refusal.title;
  }

  if (outcome === "error") {
    return "Not delivered — saved to history";
  }

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
  leftOnClipboard: boolean,
) {
  const refusal = describeDictationDeliveryRefusal(outcome);
  if (refusal) {
    return refusal.message;
  }

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
    // Only claim the clipboard when the text was actually left there;
    // `dictationCopyToClipboard` off restores whatever was there before.
    if (!leftOnClipboard) {
      return appTarget
        ? `The result was inserted into ${appTarget}.`
        : "The result was inserted at your cursor.";
    }
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

// Three capture states have to be distinguishable at a glance, not two: a user
// who cannot tell "still recording" from "already thinking" keeps talking into
// a closed microphone. State is carried by the neume glyph (hollow = not yet,
// lit + live = the earned recording moment, ambient bronze = settling) plus the
// label — never by hue temperature.
type HudState =
  | "idle"
  | "priming"
  | "recording"
  | "processing"
  | "done"
  | "error";

const HUD_STATE_NEUME: Record<HudState, string> = {
  idle: "neume neume-hollow",
  priming: "neume neume-hollow",
  recording: "neume neume-lit neume-live",
  processing: "neume",
  done: "neume neume-lit",
  error: "neume neume-rust",
};

function resolveHudState(phase: DictationPhase): HudState {
  switch (phase) {
    case "preparing":
    case "primed":
      return "priming";
    case "recording":
      return "recording";
    case "stopping":
    case "transcribing":
    case "delivering":
      return "processing";
    case "done":
      return "done";
    case "error":
      return "error";
    default:
      return "idle";
  }
}

function formatCaptureControlHint(
  hudState: HudState,
  shortcut: string | null,
): string | null {
  if (hudState !== "priming" && hudState !== "recording") {
    return null;
  }

  const stopHint = shortcut
    ? `${formatShortcutForDisplay(shortcut)} to stop`
    : "Press the dictation shortcut to stop";
  return `${stopHint} · Esc to cancel`;
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
          ? "border-foreground/15 bg-foreground/8 hover:bg-foreground/12"
          : "border-foreground/10 bg-foreground/4.5 hover:bg-foreground/7.5",
      )}
      onClick={onClick}
    >
      <div
        className={cn(
          "mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
          tone === "primary"
            ? "bg-foreground/10 text-foreground"
            : "bg-foreground/8 text-foreground",
        )}
      >
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{detail}</p>
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
  const [dictationResolvedHosting, setDictationResolvedHosting] =
    useState<DictationRoutePreference | null>(null);
  const [dictationInsertionMode, setDictationInsertionMode] =
    useState<DictationInsertionMode>("auto");
  const [dictationCommandPrefix, setDictationCommandPrefix] =
    useState("command");
  const [dictationShortcut, setDictationShortcut] = useState<string | null>(
    null,
  );
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
  const [finalLeftOnClipboard, setFinalLeftOnClipboard] = useState(false);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);
  const [isSpeakingAloud, setIsSpeakingAloud] = useState(false);
  const [transcriptionLatencyMs, setTranscriptionLatencyMs] = useState<number | null>(null);
  const [insertLatencyMs, setInsertLatencyMs] = useState<number | null>(null);
  const lastSessionIdRef = useRef<number | null>(null);
  const lastActiveStartedAtRef = useRef<number | null>(null);
  const sessionClockStartedAtRef = useRef<number | null>(null);
  const previousPhaseRef = useRef<DictationPhase>("idle");

  const refreshPopupSettings = async () => {
    const settings = await getSettings();
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
    setDictationResolvedHosting(
      settings.transcription.dictationRoutePreference === "cloud"
        ? "cloud"
        : "local",
    );
    setDictationInsertionMode(
      (settings.transcription.dictationInsertionMode ??
        "paste") as DictationInsertionMode,
    );
    setDictationCommandPrefix(
      settings.transcription.dictationCommandPrefix ?? "command",
    );
    setHandsFreeSilenceTimeoutSeconds(
      settings.transcription.dictationSilenceTimeoutSeconds ?? 0,
    );
    setDictationShortcut(settings.shortcuts?.toggleDictation ?? null);
  };

  const resetCompletionState = () => {
    setFinalText(null);
    setFinalCommandApplied(null);
    setFinalSnippetAppliedCount(0);
    setFinalLeftOnClipboard(false);
    setActionFeedback(null);
    setIsSpeakingAloud(false);
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
    if (typeof payload.dictationResolvedHosting !== "undefined") {
      setDictationResolvedHosting(payload.dictationResolvedHosting ?? null);
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

    // Ignore stale, out-of-order events from a prior dictation session (e.g. a
    // late streaming partial whose decode outlived its session) so they can
    // never demote the active session's phase or reset its clock.
    const incomingSessionId =
      typeof payload.sessionId === "number" ? payload.sessionId : null;
    if (
      incomingSessionId !== null &&
      lastSessionIdRef.current !== null &&
      incomingSessionId < lastSessionIdRef.current
    ) {
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
      if (phase === "preparing") {
        await invoke("force_stop_dictation");
      } else {
        await stopDictation();
      }
    } catch (error) {
      console.error("Failed to stop dictation from popup:", error);
    }
  };

  useEffect(() => {
    void refreshPopupSettings().catch(() => {
      // Keep default mode if settings are temporarily unavailable.
    });

    // Restore the display mode the user last chose. The overlay window is
    // created at bootstrap and reloaded on app restart, so this lives in the
    // main process alongside the dragged position rather than in the renderer.
    void invoke<{ displayMode?: string } | null>("__overlay_placement__")
      .then((placement) => {
        if (isDisplayMode(placement?.displayMode)) {
          setDisplayMode(placement.displayMode);
        }
      })
      .catch(() => {
        // A missing placement just means the default full HUD.
      });

    return () => {
      stopSpeakingText();
    };
  }, []);

  // The overlay is a small card inside a full-screen transparent window. Left
  // hit-testable, that transparent band swallows every click aimed at the app
  // underneath, so the window ignores mouse events by default and only
  // re-enables hit testing while the pointer is genuinely over the card. The
  // window is created once at bootstrap and never remounts, so the current
  // mode lives in a ref rather than effect-local state.
  const ignoringMouseRef = useRef(true);
  const applyIgnoreMouse = useCallback((nextIgnore: boolean) => {
    if (nextIgnore === ignoringMouseRef.current) {
      return;
    }
    ignoringMouseRef.current = nextIgnore;
    void invoke("__window_set_ignore_mouse_events__", {
      ignore: nextIgnore,
    }).catch(() => {
      // Non-fatal: the window just keeps its previous hit-test mode.
    });
  }, []);

  useEffect(() => {
    const handlePointerMove = (event: MouseEvent) => {
      const element = document.elementFromPoint(event.clientX, event.clientY);
      applyIgnoreMouse(!element?.closest("[data-hud-card]"));
    };
    const handlePointerLeave = () => applyIgnoreMouse(true);

    // `window` is shadowed by the Electron window handle above, so these bind
    // to `document` (mousemove bubbles there anyway).
    document.addEventListener("mousemove", handlePointerMove);
    document.addEventListener("mouseleave", handlePointerLeave);
    return () => {
      document.removeEventListener("mousemove", handlePointerMove);
      document.removeEventListener("mouseleave", handlePointerLeave);
    };
  }, [applyIgnoreMouse]);

  useEffect(() => {
    // Nothing to click once the HUD is down, and the window outlives the
    // session: leaving it hit-testable would have it swallow clicks meant for
    // whatever the user goes back to.
    if (phase === "idle") {
      applyIgnoreMouse(true);
    }
  }, [phase, applyIgnoreMouse]);

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
    // `copied` means the text is still on the clipboard once the session
    // settles — with `dictationCopyToClipboard` off the staged copy is
    // restored, so we must not promise a Cmd+V is waiting.
    setFinalLeftOnClipboard(payload.copied === true);
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
      dictationResolvedHosting,
      dictationProvider,
    );
    const targetDetailValue = runtimeAppTarget ? ` for ${runtimeAppTarget}` : "";
    const autoActivationDetailValue =
      activationMatcher && runtimeAppTarget
        ? `Auto for ${runtimeAppTarget} via "${activationMatcher}"`
        : activationMatcher
          ? `Auto via "${activationMatcher}"`
          : null;
    const isCapturePhaseValue =
      phase === "preparing" || phase === "primed" || phase === "recording";

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
    dictationResolvedHosting,
    dictationProvider,
    runtimeAppTarget,
    activationMatcher,
    phase,
  ]);

  const { selectedModeLabel, contextMeta, insertionMeta, routeLabel, targetDetail, autoActivationDetail, isCapturePhase } = computedMeta;
  const hudState = resolveHudState(phase);
  const captureControlHint = formatCaptureControlHint(
    hudState,
    dictationShortcut,
  );

  const cycleDisplayMode = async () => {
    const next: DisplayMode =
      displayMode === "full"
        ? "compact"
        : displayMode === "compact"
          ? "minimal"
          : "full";
    setDisplayMode(next);
    try {
      await invoke("__overlay_set_display_mode__", { displayMode: next });
    } catch (error) {
      console.error("Failed to persist dictation popup display mode:", error);
    }
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

  const hidePopup = useCallback(async () => {
    try {
      await invoke("dismiss_dictation_overlay");
    } catch (error) {
      console.error("Failed to hide dictation popup:", error);
    }
  }, []);

  // Note: no in-window Escape handler — the overlay window is created with
  // focusable: false and shown via showInactive() (electron/windows.ts), so
  // it never receives keyboard focus and a document-level keydown listener
  // could never fire. Escape-cancel while recording is handled globally by
  // the native macOS shortcut helper; dismissal here is via the close button.

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

  // Computed above every early return below: hooks must run in the same order
  // on every render, and the minimal pill returns before this point.
  const { doneTitle, doneMessage, commandLabel, deliveryRefusal } = useMemo(() => ({
    deliveryRefusal: describeDictationDeliveryRefusal(outcome),
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
        finalLeftOnClipboard,
      ),
    commandLabel: formatAppliedDictationCommandLabel(finalCommandApplied),
  }), [
    outcome,
    finalCommandApplied,
    runtimeAppTarget,
    message,
    finalSnippetAppliedCount,
    finalLeftOnClipboard,
  ]);

  // ── Minimal pill mode ────────────────────────────────────────────────────
  if (displayMode === "minimal") {
    const statusLabel =
      hudState === "priming"
        ? phase === "preparing"
          ? "Loading model"
          : "Model ready"
        : hudState === "recording"
          ? "Listening"
          : hudState === "processing"
            ? "Thinking"
            : hudState === "done"
              ? "Ready"
              : hudState === "error"
                ? "Problem"
                : "Working";

    return (
      <div className="h-screen w-screen bg-transparent flex items-center justify-center">
        <div
          data-hud-card
          data-drag-region
          onDoubleClick={() => void cycleDisplayMode()}
          title="Double-click to expand"
          className="flex items-center gap-2 rounded-full border border-foreground/10 bg-popover/95 px-3 py-2 shadow-[0_10px_30px_hsl(34_26%_4%/0.4)] backdrop-blur-xl"
        >
          <div className={cn(
            "inline-flex h-6 w-6 items-center justify-center rounded-full transition-smooth",
            phase === "recording" ? "bg-gold/12 text-gold-text" : "bg-foreground/6 text-foreground"
          )}>
            <Mic className="h-3 w-3" />
          </div>
          <span
            aria-hidden="true"
            className={cn(HUD_STATE_NEUME[hudState], "shrink-0")}
          />
          <AudioWaveform
            levels={displayAudioLevel}
            active={phase === "recording"}
            size="sm"
            barCount={11}
            barColor={phase === "recording" ? "var(--brand-warm)" : "var(--muted-foreground)"}
          />
          <span className="whitespace-nowrap text-xs font-medium tracking-[0.08em] text-foreground">
            {statusLabel}
          </span>
          {/* The pill has no room for a separate Stop, so while capture is
              live this button stops the session instead of only hiding the
              HUD — dismissing alone would leave the microphone open with no
              indicator anywhere on screen. */}
          <button
            type="button"
            className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/8 hover:text-foreground"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() =>
              void (isCapturePhase ? handleStopFromPopup() : hidePopup())
            }
            aria-label={isCapturePhase ? "Stop" : "Hide popup"}
          >
            {isCapturePhase ? (
              <Square className="h-2.5 w-2.5 fill-current" />
            ) : (
              <X className="h-3 w-3" />
            )}
          </button>
        </div>
      </div>
    );
  }

  const compact = displayMode === "compact";
  const phaseLabel =
    phase === "preparing"
      ? "Loading model"
      : phase === "primed"
        ? "Model ready"
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
      <div
        data-hud-card
        className="overflow-hidden rounded-[20px] border border-foreground/10 bg-popover/95 px-4 py-3.5 backdrop-blur-xl shadow-[0_20px_60px_hsl(34_26%_4%/0.5)]"
      >
        {/* Header - Minimal. Also the drag handle: the HUD is a floating pill
            the user is expected to move out of the way of their own writing. */}
        <div data-drag-region className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className={cn(HUD_STATE_NEUME[hudState], "shrink-0")}
            />
            <span className="text-xs font-medium text-muted-foreground">{phaseLabel}</span>
            <span className="text-muted-foreground">·</span>
            <span className="text-xs text-muted-foreground">{selectedModeLabel}</span>
          </div>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-foreground/5 hover:text-foreground transition-colors"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => void cycleDisplayMode()}
              aria-label={compact ? "Expand" : "Compact"}
            >
              {compact ? <PanelsTopLeft className="h-3.5 w-3.5" /> : <Minimize2 className="h-3.5 w-3.5" />}
            </button>
            {/* Hidden while capture is live: dismissing only hides this HUD,
                it does not stop the microphone, and there would be nothing
                left on screen to say recording was still running. The Stop
                button below (and Escape) end the session properly. */}
            {!isCapturePhase && (
              <button
                type="button"
                className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-foreground/5 hover:text-foreground transition-colors"
                onMouseDown={(event) => event.stopPropagation()}
                onClick={() => void hidePopup()}
                aria-label="Hide"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {isCapturePhase && (
          <div className="settle-in space-y-3">
            {/* Main Recording Bar - Super Minimal */}
            <div className="flex items-center gap-3 rounded-2xl bg-foreground/3 px-3 py-2.5">
              {/* Mic Icon — the earned gold "set down" moment */}
              <div className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-smooth",
                phase === "recording" ? "gilt-edge gilt-halo bg-gold/12" : "bg-foreground/5"
              )}>
                <Mic className={cn("h-4 w-4", phase === "recording" ? "text-gold-text" : "text-muted-foreground")} />
              </div>

              {/* Waveform — the chant staff resolving into gold while recording */}
              <div className="flex-1">
                <AudioWaveform
                  levels={displayAudioLevel}
                  active={phase === "recording"}
                  size="sm"
                  barCount={20}
                  barColor={phase === "recording" ? "var(--brand-warm)" : "var(--muted-foreground)"}
                />
              </div>
              
              {/* Timer */}
              <span className={cn(
                "shrink-0 font-mono text-sm tabular-nums",
                phase === "recording" ? "text-gold-text" : "text-muted-foreground"
              )}>
                {elapsedText}
              </span>

              {/* Stop Button */}
              <button
                type="button"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-foreground hover:bg-foreground/15 transition-colors"
                onClick={() => void handleStopFromPopup()}
                aria-label="Stop"
              >
                <Square className="h-3.5 w-3.5 fill-current" />
              </button>
            </div>
            
            {/* Subtle Status Line */}
            <p className="text-sm text-muted-foreground text-center">
              {formatHandsFreeRuntimeHint(
                _handsFreeEnabled,
                handsFreeSilenceTimeoutSeconds,
                runtimeAppTarget,
                contextMeta.detail,
              )}
            </p>
            {/* Escape-cancel is real (the native macOS shortcut helper handles
                it) but nothing in the UI said so until now. */}
            {captureControlHint && (
              <p className="text-center font-mono text-xs tracking-[0.08em] text-muted-foreground">
                {captureControlHint}
              </p>
            )}
            {!compact && preview && (
              <div className="settle-in rounded-[20px] border border-foreground/10 bg-foreground/3 px-4 py-3">
                <p className="font-mono text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                  Live text
                </p>
                <p
                  key={preview}
                  className="ink-in mt-2 text-sm leading-6 text-foreground line-clamp-4"
                >
                  {preview}
                </p>
              </div>
            )}
          </div>
        )}

        {phase === "stopping" && (
          <div className="flex items-center gap-3 text-foreground">
            <Loader2 className="h-5 w-5 animate-spin text-foreground" />
            <div>
              <p className="text-sm font-semibold">Stopping</p>
              <p className="text-xs text-muted-foreground">
                Finalizing audio and preserving context…
              </p>
            </div>
          </div>
        )}

        {phase === "transcribing" && (
          <div className="flex items-center gap-3 text-foreground">
            <Loader2 className="h-5 w-5 animate-spin text-foreground" />
            <div className="min-w-0 flex-1">
              <div className="mb-1.5">
                <WaveformVisualizer
                  data={[]}
                  settled
                  settledNeumeCount={6}
                  height={16}
                />
              </div>
              <p className="text-sm font-semibold">Transcribing</p>
              {/* Clamped so `getPopupSize` can bound the window it sizes to
                  this card; an unclamped paragraph would grow past it. */}
              <p className="text-xs text-muted-foreground line-clamp-6">
                {message ??
                  `${selectedModeLabel} is shaping the result for ${insertionMeta.label.toLowerCase()}${targetDetail}.`}
              </p>
              {autoActivationDetail && (
                <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
                  {autoActivationDetail}
                </p>
              )}
              {!compact && preview && (
                <div className="mt-2 max-w-[330px] rounded-xl border border-foreground/10 bg-foreground/4.5 px-3 py-2">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Live preview
                  </p>
                  <p
                    key={preview}
                    className="ink-in mt-1 text-xs leading-relaxed text-foreground line-clamp-4"
                  >
                    {preview}
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {phase === "delivering" && (
          <div className="flex items-center gap-3 text-foreground">
            <Loader2 className="h-5 w-5 animate-spin text-foreground" />
            <div>
              <p className="text-sm font-semibold">Inserting</p>
              <p className="text-xs text-muted-foreground line-clamp-6">
                {message ??
                  `Finishing ${insertionMeta.label.toLowerCase()}${targetDetail} with ${routeLabel}.`}
              </p>
              {!compact && preview && (
                <div className="commit-shine mt-2 max-w-[330px] rounded-xl border border-foreground/10 bg-foreground/4.5 px-3 py-2">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Latest text
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-foreground line-clamp-4">
                    {preview}
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {phase === "done" && (
          <div className="flex items-center gap-3 text-foreground">
            {outcome === "error" || deliveryRefusal ? (
              <TriangleAlert className="h-5 w-5 text-destructive" />
            ) : (
              <CheckCircle2 className="h-5 w-5 text-foreground" />
            )}
            <div className="min-w-0 flex-1">
              <p className="manuscript text-base font-serif text-foreground">{doneTitle}</p>
              {!compact && (
                <p className="max-w-[330px] text-sm leading-relaxed text-muted-foreground line-clamp-6">
                  {doneMessage}
                </p>
              )}
              {!compact && (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-foreground">
                  {commandLabel && (
                    <span className="rounded-full border border-foreground/10 bg-foreground/5 px-2.5 py-1">
                      {commandLabel}
                    </span>
                  )}
                  {finalSnippetAppliedCount > 0 && (
                    <span className="rounded-full border border-foreground/10 bg-foreground/5 px-2.5 py-1">
                      {finalSnippetAppliedCount === 1
                        ? "1 snippet"
                        : `${finalSnippetAppliedCount} snippets`}
                    </span>
                  )}
                  {runtimeAppTarget && (
                    <span className="rounded-full border border-foreground/10 bg-foreground/5 px-2.5 py-1">
                      Target {runtimeAppTarget}
                    </span>
                  )}
                  {transcriptionLatencyMs !== null && (
                    <span className="rounded-full border border-foreground/10 bg-foreground/5 px-2.5 py-1">
                      {formatLatencyMetric(transcriptionLatencyMs)} transcribe
                    </span>
                  )}
                  {insertLatencyMs !== null && (
                    <span className="rounded-full border border-foreground/10 bg-foreground/5 px-2.5 py-1">
                      {formatLatencyMetric(insertLatencyMs)} insert
                    </span>
                  )}
                  <span className="rounded-full border border-foreground/10 bg-foreground/5 px-2.5 py-1">
                    {deliveryRefusal
                      ? "Kept in history"
                      : outcome === "copied"
                        ? "Clipboard ready"
                        : "Edit commands available"}
                  </span>
                </div>
              )}
              {!compact && (finalText || preview) && (
                <div className="mt-3 max-w-[330px] rounded-xl border border-foreground/10 bg-foreground/4.5 px-3 py-2">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Latest result
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-foreground line-clamp-4">
                    {finalText ?? preview}
                  </p>
                </div>
              )}
              {!compact && (
                <div className="mt-3 rounded-xl border border-foreground/10 bg-foreground/4.5 px-3 py-2">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Voice edits
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-foreground">
                    {spokenEditHints.map((hint) => (
                      <span
                        key={hint}
                        className="rounded-full border border-foreground/10 bg-popover/95 px-2.5 py-1"
                      >
                        {hint}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {!compact && (
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
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
                <p className="mt-2 text-xs text-muted-foreground">{actionFeedback}</p>
              )}
            </div>
          </div>
        )}

        {phase === "error" && (
          <div className="flex items-center gap-3 text-foreground">
            <TriangleAlert className="h-5 w-5 text-foreground" />
            <div>
              <p className="text-sm font-semibold">Problem</p>
              {!compact && message && (
                <p className="max-w-[330px] text-sm leading-relaxed text-muted-foreground line-clamp-6">
                  {message}
                </p>
              )}
              {!compact && (
                <p className="text-sm text-muted-foreground">
                  Check microphone access, {routeLabel.toLowerCase()}, and
                  shortcut permissions.
                </p>
              )}
              {!compact && (
                <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <button
                    type="button"
                    className="rounded-lg border border-foreground/10 bg-foreground/5 px-2.5 py-1.5 hover:bg-foreground/8"
                    onClick={() => void handleStartAgain()}
                  >
                    Start again
                  </button>
                  <button
                    type="button"
                    className="rounded-lg border border-foreground/10 bg-foreground/5 px-2.5 py-1.5 hover:bg-foreground/10"
                    onClick={() => void openMainApp("dictation")}
                  >
                    Open dictation
                  </button>
                  <button
                    type="button"
                    className="rounded-lg border border-foreground/10 bg-foreground/5 px-2.5 py-1.5 hover:bg-foreground/10"
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
