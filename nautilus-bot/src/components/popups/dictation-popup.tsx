import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LogicalSize, invoke, getCurrentWindow, listen } from "@/lib/electron";
import {
  AppWindow,
  CheckCircle2,
  Clipboard,
  Clock3,
  History,
  Loader2,
  Mail,
  Mic,
  MicOff,
  Minimize2,
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
  DICTATION_PILL_SIZE,
  getPopupSize,
  resolveDictationPillDock,
  resolveDictationPillScale,
  type DictationPillDock,
  type DictationPopupDisplayMode,
} from "@/lib/dictation-popup-layout";
import { formatShortcutForDisplay } from "@/lib/shortcuts";
import {
  describeDictationDeliveryRefusal,
  sanitizeUserFacingDictationMessage,
} from "@/lib/dictation-ui-message";
import { cn } from "@/lib/utils";
import { AudioWaveform } from "@/components/ui/audio-waveform";
import {
  DictationFinishBar,
  type DictationFinishStage,
} from "@/components/popups/dictation-finish-bar";
import type { DictationProgressPlan } from "@/lib/dictation-progress";
import { describePillStatus, PREPARING_MODEL_LABEL } from "@/lib/dictation-hud-status";
import {
  MEETING_ASIDE_LABEL,
  MEETING_ASIDE_NOTICE,
  markMeetingAsideNoticeSeen,
  readMeetingAsideNoticeSeen,
} from "@/lib/meeting-aside";
import { SLOW_STAGE_LABEL, slowStageThresholdMs } from "@/lib/dictation-slow-stage";
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
  DictationInsertionMode | "preview",
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
  preview: { label: "Preview only", detail: "Keep the result in Plainsong" },
};

const CLOUD_PROVIDER_LABELS: Record<string, string> = {
  openai_cloud: "OpenAI",
  groq: "Groq",
  elevenlabs_scribe: "ElevenLabs",
  cohere_transcribe: "Cohere",
  deepgram: "Deepgram",
  mistral_voxtral: "Mistral Voxtral",
  gemini_transcribe: "Gemini",
  xai_stt: "xAI Grok",
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
    // Not "saved to history": with history off it was not, and the sidecar's
    // message below says where the words are.
    return "Not inserted";
  }

  if (outcome === "paste_dispatched") {
    return appTarget ? `Check ${appTarget}` : "Check the text";
  }

  if (outcome === "copied_instead") {
    return "Copied, press ⌘V to paste";
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

  if (outcome === "paste_dispatched") {
    const target = appTarget ?? "the target app";
    const recovery = leftOnClipboard
      ? "paste the copied result with Cmd+V"
      : "use Copy result to recover it";
    return `Check the text in ${target}. Insertion was not confirmed. If nothing appeared, ${recovery}.`;
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

const LEVEL_HISTORY_LENGTH = 20;

/** True when the message only restates the title ("Inserted at cursor."). */
function repeatsTitle(title: string | null | undefined, message: string | null | undefined): boolean {
  const normalize = (value: string | null | undefined) =>
    (value ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const normalizedTitle = normalize(title);
  const normalizedMessage = normalize(message);
  return normalizedTitle.length > 0 && normalizedMessage === normalizedTitle;
}

function normalizeFinalWarnings(warnings: unknown): string[] {
  if (!Array.isArray(warnings)) return [];
  return Array.from(
    new Set(
      warnings
        .filter((warning): warning is string => typeof warning === "string")
        .map((warning) => warning.trim())
        .filter(Boolean),
    ),
  );
}

// How long the "next profile" announcement stays on screen. Long enough to
// read one short name, short enough that a second press reads as a second
// step rather than the same notice lingering.
const MODE_CYCLE_NOTICE_MS = 1200;

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
  locked: boolean,
): string | null {
  if (hudState !== "priming" && hudState !== "recording") {
    return null;
  }

  if (locked) return "Locked. Press the shortcut again to finish.";
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
  insertionMode: DictationInsertionMode | "preview",
) {
  const targetDetail = insertionMode === "preview"
    ? "Preview in Plainsong"
    : insertionMode === "clipboard_only"
      ? "Copy to clipboard"
      : runtimeAppTarget
    ? `Sending to ${runtimeAppTarget}`
    : contextDetail === "Fresh dictation"
      ? "Inserting at your cursor"
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
  disabled = false,
}: {
  icon: typeof Clipboard;
  label: string;
  detail: string;
  onClick: () => void;
  tone?: "default" | "primary";
  disabled?: boolean;
}) {
  // One compact row of actions: the done state is on screen for under two
  // seconds, so a grid of tall tiles only pushed the result out of view.
  return (
    <button
      type="button"
      title={detail}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm transition-colors disabled:opacity-50 disabled:cursor-wait focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        tone === "primary"
          ? "border-foreground/15 bg-foreground/8 text-foreground hover:bg-foreground/12"
          : "border-foreground/10 text-muted-foreground hover:bg-foreground/6 hover:text-foreground",
      )}
      onClick={onClick}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </button>
  );
}

export function DictationPopup() {
  const window = getCurrentWindow();
  const { stateEvent, textReadyEvent } = useDictationRuntime();
  const [shortcutLocked, setShortcutLocked] = useState(false);
  const [phase, setPhase] = useState<DictationPhase>("idle");
  // The session takes its audio from a recording meeting (an aside).
  const [meetingAside, setMeetingAside] = useState(false);
  // The once-per-Mac reminder that the call still hears an aside.
  const [asideNoticeVisible, setAsideNoticeVisible] = useState(false);
  const [startedAtMs, setStartedAtMs] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  /**
   * The streaming engine's preview, split into the words it has committed to
   * and the tail it may still rewrite. Null for the re-decode engine, which
   * has no such split to offer -- every one of its partials can change.
   */
  const [previewParts, setPreviewParts] = useState<{
    stable: string;
    volatile: string;
  } | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [processingStage, setProcessingStage] = useState<
    "transcribing" | "polishing"
  >("transcribing");
  const [speechModelPreparing, setSpeechModelPreparing] = useState(false);
  const [progressPlan, setProgressPlan] = useState<DictationProgressPlan>({
    expectedTranscribeMs: 600,
    expectedPolishMs: null,
  });
  // The pill is the default, like every polished dictation HUD: it says what
  // is happening in one word and stays out of the way. The full card is one
  // double-click away and remembered once chosen.
  const [displayMode, setDisplayMode] = useState<DisplayMode>("minimal");
  const [showTemporaryDetails, setShowTemporaryDetails] = useState(false);
  const [isHoldingReview, setIsHoldingReview] = useState(false);
  const [reviewHoldError, setReviewHoldError] = useState<string | null>(null);
  const reviewHoldPendingRef = useRef(false);
  const reviewHoldEpochRef = useRef(0);
  // Settings > Dictation. The main process places the window (bottom, or
  // against a side); this only decides the pill's shape and scale.
  const [pillScale, setPillScale] = useState(1);
  const [pillDock, setPillDock] = useState<DictationPillDock>("bottom");
  const [_handsFreeEnabled, _setHandsFreeEnabled] = useState(false);
  const [handsFreeSilenceTimeoutSeconds, setHandsFreeSilenceTimeoutSeconds] =
    useState(0);
  const [displayAudioLevel, setDisplayAudioLevel] = useState(0);
  // The last few smoothed levels, newest on the right, so the pill draws a
  // moving trace of the voice instead of one level copied to every bar.
  const [levelHistory, setLevelHistory] = useState<number[]>(() =>
    new Array(LEVEL_HISTORY_LENGTH).fill(0),
  );
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
    useState<DictationInsertionMode | "preview">("auto");
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
  const [finalWarnings, setFinalWarnings] = useState<string[]>([]);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);
  const [isCopyingResult, setIsCopyingResult] = useState(false);
  const finalTextRef = useRef<string | null>(null);
  const copyResultRevisionRef = useRef(0);
  const copyResultPendingRef = useRef(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  const [isRestarting, setIsRestarting] = useState(false);
  const restartPendingRef = useRef(false);
  const [cancelError, setCancelError] = useState<{
    sessionId: number;
    message: string;
  } | null>(null);
  const [cancellingSessionId, setCancellingSessionId] = useState<number | null>(
    null,
  );
  const cancelPendingSessionIdsRef = useRef(new Set<number>());
  const [isSpeakingAloud, setIsSpeakingAloud] = useState(false);
  const [transcriptionLatencyMs, setTranscriptionLatencyMs] = useState<number | null>(null);
  const [insertLatencyMs, setInsertLatencyMs] = useState<number | null>(null);
  const lastSessionIdRef = useRef<number | null>(null);
  const lastActiveStartedAtRef = useRef<number | null>(null);
  const sessionClockStartedAtRef = useRef<number | null>(null);
  const previousPhaseRef = useRef<DictationPhase>("idle");
  const currentPhaseRef = useRef<DictationPhase>("idle");
  const currentReviewSessionIdRef = useRef<number | null>(null);
  // Deliberately snapshot the ID for this render. Event refs can advance
  // before React replaces the old DOM, and the click guard below compares
  // this displayed session with the current one before sending a command.
  const displayedSessionId = lastSessionIdRef.current;
  const hasValidDisplayedSessionId =
    typeof displayedSessionId === "number" &&
    Number.isSafeInteger(displayedSessionId) &&
    displayedSessionId > 0;
  const hasValidReviewSessionId =
    typeof currentReviewSessionIdRef.current === "number" &&
    Number.isSafeInteger(currentReviewSessionIdRef.current) &&
    currentReviewSessionIdRef.current > 0;
  const canCancelCapture = hasValidDisplayedSessionId &&
    (phase === "preparing" || phase === "primed" || phase === "recording");
  const canCancelProcessing =
    hasValidDisplayedSessionId &&
    (phase === "stopping" || phase === "transcribing");
  const isCancelling =
    hasValidDisplayedSessionId && cancellingSessionId === displayedSessionId;
  const displayedCancelError =
    hasValidDisplayedSessionId && cancelError?.sessionId === displayedSessionId
      ? cancelError.message
      : null;

  const applyPillSettings = (ui: { dictationPillSize?: unknown; dictationPillDock?: unknown } | undefined) => {
    setPillScale(resolveDictationPillScale(ui?.dictationPillSize));
    setPillDock(resolveDictationPillDock(ui?.dictationPillDock));
  };

  const refreshPopupSettings = async () => {
    const settings = await getSettings();
    applyPillSettings(settings.ui);
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

  const [savedResult, setSavedResult] = useState<{ recordingId: string; sessionId: number } | null>(null);
  const savedResultRef = useRef<{ recordingId: string; sessionId: number } | null>(null);

  const resetCompletionState = () => {
    reviewHoldEpochRef.current += 1;
    reviewHoldPendingRef.current = false;
    setIsHoldingReview(false);
    setReviewHoldError(null);
    savedResultRef.current = null;
    setSavedResult(null);
    finalTextRef.current = null;
    copyResultRevisionRef.current += 1;
    setFinalText(null);
    setFinalCommandApplied(null);
    setFinalSnippetAppliedCount(0);
    setFinalLeftOnClipboard(false);
    setFinalWarnings([]);
    setActionFeedback(null);
    setRestartError(null);
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

  const applyOverlaySnapshot = (payload: DictationStateChangedEvent & { shortcutLocked?: boolean }) => {
    if (payload.dismissed) {
      currentPhaseRef.current = "idle";
      currentReviewSessionIdRef.current = null;
      setCancelError(null);
      setMeetingAside(false);
      setAsideNoticeVisible(false);
      setPhase("idle");
      setMessage(null);
      setPreview(null);
      setPreviewParts(null);
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

    // Keep command guards ahead of React's render cycle. A click from an old
    // processing DOM must observe a newer delivery or terminal event even if
    // that event has not rendered yet.
    currentPhaseRef.current = payload.phase;
    if (payload.phase === "done" || payload.phase === "error") {
      const nextReviewSessionId =
        typeof payload.sessionId === "number" &&
        Number.isSafeInteger(payload.sessionId) &&
        payload.sessionId > 0
          ? payload.sessionId
          : null;
      if (currentReviewSessionIdRef.current !== nextReviewSessionId) {
        reviewHoldEpochRef.current += 1;
        reviewHoldPendingRef.current = false;
        setIsHoldingReview(false);
        setReviewHoldError(null);
      }
      currentReviewSessionIdRef.current = nextReviewSessionId;
    } else if (
      typeof payload.sessionId === "number" &&
      Number.isSafeInteger(payload.sessionId) &&
      payload.sessionId > 0
    ) {
      currentReviewSessionIdRef.current = payload.sessionId;
    }
    if (payload.phase !== "stopping" && payload.phase !== "transcribing") {
      setCancelError(null);
    }

    applyRuntimeMetadata(payload);
    if (typeof payload.meetingAside === "boolean") {
      setMeetingAside(payload.meetingAside);
    }
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

    if (
      payload.phase === "preparing" ||
      payload.phase === "primed" ||
      payload.phase === "recording"
    ) {
      setShowTemporaryDetails(false);
    }

    setShortcutLocked(payload.shortcutLocked === true &&
      (payload.phase === "preparing" || payload.phase === "primed" || payload.phase === "recording"));
    setPhase(payload.phase);
    setMessage(sanitizedMessage);
    setProcessingStage(
      payload.processingStage === "polishing" ? "polishing" : "transcribing",
    );
    setSpeechModelPreparing(payload.speechModelPreparing === true);
    if (typeof payload.expectedTranscribeMs === "number") {
      const expectedTranscribeMs = payload.expectedTranscribeMs;
      const expectedPolishMs =
        typeof payload.expectedPolishMs === "number" ? payload.expectedPolishMs : null;
      setProgressPlan((previous) =>
        previous.expectedTranscribeMs === expectedTranscribeMs &&
        previous.expectedPolishMs === expectedPolishMs
          ? previous
          : { expectedTranscribeMs, expectedPolishMs },
      );
    }
    setPreview(payload.partialText ?? payload.preview ?? null);
    setPreviewParts(
      payload.partialStableText != null || payload.partialVolatileText != null
        ? {
            stable: payload.partialStableText ?? "",
            volatile: payload.partialVolatileText ?? "",
          }
        : null,
    );
    setOutcome(payload.outcome ?? null);
    if (payload.phase === "done" || payload.phase === "error") {
      if (typeof payload.warnings !== "undefined") {
        setFinalWarnings(normalizeFinalWarnings(payload.warnings));
      }
      if (
        !finalTextRef.current &&
        typeof payload.preview === "string" &&
        payload.preview.trim()
      ) {
        finalTextRef.current = payload.preview;
        copyResultRevisionRef.current += 1;
        setFinalText(payload.preview);
      }
      if (payload.reviewHeld === true) {
        setReviewHoldError(null);
        setShowTemporaryDetails(true);
      }
    }
    if (payload.phase === "idle") {
      currentReviewSessionIdRef.current = null;
      setCancelError(null);
      setMeetingAside(false);
      setAsideNoticeVisible(false);
      resetCompletionState();
      setPreviewParts(null);
      lastSessionIdRef.current = null;
      lastActiveStartedAtRef.current = null;
      sessionClockStartedAtRef.current = null;
      setStartedAtMs(null);
      setElapsed(0);
      return;
    }

    if (nextSessionId !== null && nextSessionId !== lastSessionIdRef.current) {
      setCancelError(null);
      if (typeof payload.meetingAside !== "boolean") {
        setMeetingAside(false);
      }
      setAsideNoticeVisible(false);
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

  // The first aside on this Mac says, once, that the call still hears it. It
  // stays up for that whole dictation and is marked shown when it appears.
  useEffect(() => {
    if (meetingAside && phase === "recording" && !asideNoticeVisible && !readMeetingAsideNoticeSeen()) {
      markMeetingAsideNoticeSeen();
      setAsideNoticeVisible(true);
    }
  }, [meetingAside, phase, asideNoticeVisible]);

  // A dictation that a `plainsong://record` link started, not a keypress.
  // Any web page can send that link (see electron/deep-link-policy.ts), so the
  // microphone opening has to be attributable on screen rather than silent.
  const [sourceNotice, setSourceNotice] = useState<string | null>(null);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let clearTimer: ReturnType<typeof setTimeout> | undefined;
    void listen<{ message?: unknown; durationMs?: unknown }>(
      "dictation-source-notice",
      (event) => {
        const message =
          typeof event.payload?.message === "string" ? event.payload.message.trim() : "";
        if (!message) {
          return;
        }
        const durationMs =
          typeof event.payload?.durationMs === "number" && event.payload.durationMs > 0
            ? event.payload.durationMs
            : 1000;
        setSourceNotice(message);
        if (clearTimer) {
          clearTimeout(clearTimer);
        }
        clearTimer = setTimeout(() => setSourceNotice(null), durationMs);
      },
    ).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
      if (clearTimer) {
        clearTimeout(clearTimer);
      }
    };
  }, []);

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
        // A missing placement just means the default pill.
      });

    return () => {
      stopSpeakingText();
    };
  }, []);

  // Pill size and position change from Settings, or from the main process
  // when the user drops the pill against a side of the screen. Either way
  // the saved settings come back through this broadcast.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ ui?: { dictationPillSize?: unknown; dictationPillDock?: unknown } }>(
      "settings-changed",
      (event) => {
        if (!disposed && event.payload && typeof event.payload === "object") {
          applyPillSettings(event.payload.ui);
        }
      },
    ).then((dispose) => {
      if (disposed) {
        dispose();
      } else {
        unlisten = dispose;
      }
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
    // applyPillSettings reads only setters; it is stable for the window's life.
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

  // A "next profile" binding (Settings > Shortcuts) announces the profile it
  // landed on here for a moment, so the user knows what the next dictation
  // runs as without opening the app. The main process shows this window for
  // the announcement; when no session is live it is hidden again afterwards.
  const [cycledModeLabel, setCycledModeLabel] = useState<string | null>(null);
  const cycledModeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cycledNoticeShownRef = useRef(false);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ label?: unknown }>("dictation-mode-cycled", (event) => {
      if (disposed) {
        return;
      }
      const label =
        typeof event.payload?.label === "string" ? event.payload.label.trim() : "";
      if (!label) {
        return;
      }
      setCycledModeLabel(label);
      void refreshPopupSettings().catch(() => {
        // The label already came with the event; settings only refresh the
        // rest of the HUD's mode metadata.
      });
      if (cycledModeTimerRef.current) {
        clearTimeout(cycledModeTimerRef.current);
      }
      cycledModeTimerRef.current = setTimeout(() => {
        cycledModeTimerRef.current = null;
        setCycledModeLabel(null);
      }, MODE_CYCLE_NOTICE_MS);
    }).then((dispose) => {
      if (disposed) {
        dispose();
      } else {
        unlisten = dispose;
      }
    });
    return () => {
      disposed = true;
      unlisten?.();
      if (cycledModeTimerRef.current) {
        clearTimeout(cycledModeTimerRef.current);
        cycledModeTimerRef.current = null;
      }
    };
    // refreshPopupSettings reads only setters; it is stable for the window's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Once the notice has run its course with no session on screen, put the
  // window away the same way the close button does.
  const cycledNoticeVisible = cycledModeLabel !== null;
  useEffect(() => {
    if (cycledNoticeVisible || phase !== "idle") {
      return;
    }
    if (cycledNoticeShownRef.current) {
      cycledNoticeShownRef.current = false;
      void invoke("dismiss_dictation_overlay").catch(() => {
        // The window simply stays until the next session hides it.
      });
    }
  }, [cycledNoticeVisible, phase]);
  useEffect(() => {
    if (cycledNoticeVisible && phase === "idle") {
      cycledNoticeShownRef.current = true;
    }
  }, [cycledNoticeVisible, phase]);

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
    if (typeof payload.sessionId === "number" && lastSessionIdRef.current !== null
      && payload.sessionId !== lastSessionIdRef.current) return;
    const result = typeof payload.recordingId === "string" && payload.recordingId.trim()
      && typeof payload.sessionId === "number" && Number.isSafeInteger(payload.sessionId) && payload.sessionId > 0
      ? { recordingId: payload.recordingId, sessionId: payload.sessionId } : null;
    savedResultRef.current = result;
    setSavedResult(result);
    finalTextRef.current = payload.text ?? null;
    copyResultRevisionRef.current += 1;
    setFinalText(payload.text ?? null);
    setFinalCommandApplied(payload.commandApplied ?? null);
    setFinalSnippetAppliedCount(payload.snippetAppliedCount ?? 0);
    setFinalWarnings(normalizeFinalWarnings(payload.warnings));
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
    setLevelHistory((history) =>
      phase === "recording"
        ? [...history.slice(1), displayAudioLevel]
        : history.every((level) => level === 0)
          ? history
          : new Array(LEVEL_HISTORY_LENGTH).fill(0),
    );
  }, [displayAudioLevel, phase]);

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
        if (outcome === "pasted" || outcome === "replaced") {
          void playDictationEarcon("success");
        } else if (outcome === "error" || describeDictationDeliveryRefusal(outcome)) {
          void playDictationEarcon("error");
        }
      } else if (phase === "error" && previousPhase !== "error") {
        void playDictationEarcon("error");
      }
      previousPhaseRef.current = phase;
    }
  }, [phase, outcome]);

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
    const targetDetailValue = dictationInsertionMode === "auto" && runtimeAppTarget ? ` for ${runtimeAppTarget}` : "";
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

  const { selectedModeLabel, contextMeta, targetDetail, autoActivationDetail, isCapturePhase } = computedMeta;
  const hudState = resolveHudState(phase);
  const finishStage: DictationFinishStage =
    phase === "delivering"
      ? "delivering"
      : phase === "stopping"
        ? "stopping"
        : processingStage;
  const stageKeyForSlow = `${lastSessionIdRef.current ?? ""}:${finishStage}`;
  const stageKey = `${lastSessionIdRef.current ?? ""}:${
    phase === "stopping" || phase === "transcribing" ? finishStage : phase
  }`;
  const stageStartRef = useRef({ key: "", at: 0 });
  if (stageStartRef.current.key !== stageKey) {
    stageStartRef.current = { key: stageKey, at: performance.now() };
  }
  const stageStartedAt = stageStartRef.current.at;
  // "Still working": once the current processing stage runs well past what
  // this Mac usually takes (dictation-slow-stage.ts), the label says so.
  const processingPhase = phase === "stopping" || phase === "transcribing" || phase === "delivering";
  const stageExpectedMs =
    finishStage === "polishing"
      ? progressPlan.expectedPolishMs
      : finishStage === "transcribing"
        ? progressPlan.expectedTranscribeMs
        : null;
  const [slowStageKey, setSlowStageKey] = useState<string | null>(null);
  useEffect(() => {
    if (!processingPhase) return;
    const elapsed = performance.now() - stageStartedAt;
    const timer = globalThis.setTimeout(
      () => setSlowStageKey(stageKeyForSlow),
      Math.max(0, slowStageThresholdMs(stageExpectedMs) - elapsed),
    );
    return () => globalThis.clearTimeout(timer);
  }, [processingPhase, stageKeyForSlow, stageExpectedMs, stageStartedAt]);
  const slowStage = processingPhase && slowStageKey === stageKeyForSlow;
  const preparingModel = speechModelPreparing && phase === "transcribing" && finishStage === "transcribing";
  const finishStageLabel = preparingModel
    ? PREPARING_MODEL_LABEL
    : slowStage
    ? SLOW_STAGE_LABEL
    : finishStage === "stopping"
      ? "Finishing"
      : finishStage === "polishing"
        ? "Polishing"
        : "Transcribing";
  const captureControlHint = formatCaptureControlHint(
    hudState,
    dictationShortcut,
    shortcutLocked,
  );

  // The first aside opens the details card once, so the reminder that the
  // call can still hear has room to be read; the pill itself has none.
  const temporaryDetailsVisible =
    (showTemporaryDetails || asideNoticeVisible) && displayMode === "minimal";
  const effectiveDisplayMode: DisplayMode = temporaryDetailsVisible
    ? "full"
    : displayMode;
  const minimalDetailsAvailable =
    displayMode === "minimal" &&
    (phase === "error" ||
      (phase === "done" &&
        (outcome === "error" ||
          outcome === "paste_dispatched" ||
          outcome === "copied_instead" ||
          Boolean(describeDictationDeliveryRefusal(outcome)) ||
          finalWarnings.length > 0)));

  const cycleDisplayMode = async () => {
    const next: DisplayMode =
      effectiveDisplayMode === "full"
        ? "compact"
        : effectiveDisplayMode === "compact"
          ? "minimal"
          : "full";
    setShowTemporaryDetails(false);
    setDisplayMode(next);
    try {
      await invoke("__overlay_set_display_mode__", { displayMode: next });
    } catch (error) {
      console.error("Failed to persist dictation popup display mode:", error);
    }
  };

  useEffect(() => {
    const { width, height } = getPopupSize(
      effectiveDisplayMode,
      phase,
      message,
      preview,
      { dock: pillDock, scale: pillScale },
    );
    const actionHeight =
      effectiveDisplayMode !== "minimal" && canCancelProcessing ? 40 : 0;
    const errorHeight =
      effectiveDisplayMode !== "minimal" && (restartError || displayedCancelError)
        ? 70
        : 0;
    const reviewHoldHeight =
      effectiveDisplayMode !== "minimal" && reviewHoldError ? 72 : 0;
    // Two text-sm lines at the card widths, py-2 and mb-3.
    const asideNoticeHeight =
      effectiveDisplayMode !== "minimal" && asideNoticeVisible ? 72 : 0;
    void window
      .setSize(
        new LogicalSize(
          width,
          height + actionHeight + errorHeight + reviewHoldHeight + asideNoticeHeight,
        ),
      )
      .catch((error) => {
        console.error("Failed to resize dictation popup:", error);
      });
  }, [
    asideNoticeVisible,
    canCancelProcessing,
    effectiveDisplayMode,
    displayedCancelError,
    message,
    phase,
    preview,
    pillDock,
    pillScale,
    restartError,
    reviewHoldError,
    window,
  ]);

  const openMainApp = async (
    view?: "dictation" | "settings" | "recordings",
    recordingId?: string,
  ) => {
    try {
      if (view) {
        await invoke("open_main_window_to", { view, ...(recordingId ? { recordingId } : {}) });
      } else {
        await invoke("open_main_window");
      }
    } catch (error) {
      console.error("Failed to open main window:", error);
    }
  };

  const hidePopup = useCallback(async () => {
    reviewHoldEpochRef.current += 1;
    reviewHoldPendingRef.current = false;
    setIsHoldingReview(false);
    setReviewHoldError(null);
    setShowTemporaryDetails(false);
    try {
      await invoke("dismiss_dictation_overlay");
    } catch (error) {
      console.error("Failed to hide dictation popup:", error);
    }
  }, []);

  const handleShowDetails = async () => {
    const sessionId = currentReviewSessionIdRef.current;
    if (
      reviewHoldPendingRef.current ||
      (currentPhaseRef.current !== "done" && currentPhaseRef.current !== "error")
    ) {
      return;
    }

    if (
      typeof sessionId !== "number" ||
      !Number.isSafeInteger(sessionId) ||
      sessionId <= 0
    ) {
      reviewHoldEpochRef.current += 1;
      setReviewHoldError(
        "This review may close automatically. Open the app to continue reviewing.",
      );
      setShowTemporaryDetails(true);
      return;
    }

    const requestEpoch = ++reviewHoldEpochRef.current;
    reviewHoldPendingRef.current = true;
    setIsHoldingReview(true);
    setReviewHoldError(null);
    try {
      const result = await invoke<{ held?: boolean; sessionId?: number }>(
        "hold_dictation_overlay_review",
        { sessionId },
      );
      if (
        reviewHoldEpochRef.current === requestEpoch &&
        currentReviewSessionIdRef.current === sessionId &&
        (currentPhaseRef.current === "done" || currentPhaseRef.current === "error")
      ) {
        if (result?.held === true && result.sessionId === sessionId) {
          setShowTemporaryDetails(true);
        } else {
          setReviewHoldError(
            "Couldn't keep this review open. It may close automatically. Retry keep open or open the app to continue reviewing.",
          );
          setShowTemporaryDetails(true);
        }
      }
    } catch (error) {
      console.error("Failed to hold dictation overlay review:", error);
      if (
        reviewHoldEpochRef.current === requestEpoch &&
        currentReviewSessionIdRef.current === sessionId &&
        (currentPhaseRef.current === "done" || currentPhaseRef.current === "error")
      ) {
        setReviewHoldError(
          "Couldn't keep this review open. It may close automatically. Retry keep open or open the app to continue reviewing.",
        );
        setShowTemporaryDetails(true);
      }
    } finally {
      if (reviewHoldEpochRef.current === requestEpoch) {
        reviewHoldPendingRef.current = false;
        setIsHoldingReview(false);
      }
    }
  };

  const handleCancelProcessing = async () => {
    const sessionId = displayedSessionId;
    if (
      typeof sessionId !== "number" ||
      !Number.isSafeInteger(sessionId) ||
      sessionId <= 0 ||
      cancelPendingSessionIdsRef.current.has(sessionId) ||
      lastSessionIdRef.current !== sessionId ||
      !["preparing", "primed", "recording", "stopping", "transcribing"].includes(currentPhaseRef.current)
    ) {
      return;
    }

    cancelPendingSessionIdsRef.current.add(sessionId);
    setCancellingSessionId(sessionId);
    setCancelError(null);
    try {
      await invoke("force_stop_dictation", { sessionId });
    } catch {
      if (
        lastSessionIdRef.current === sessionId &&
        ["preparing", "primed", "recording", "stopping", "transcribing"].includes(currentPhaseRef.current)
      ) {
        setCancelError({
          sessionId,
          message: "Couldn't cancel this dictation. Try again.",
        });
      }
    } finally {
      cancelPendingSessionIdsRef.current.delete(sessionId);
      setCancellingSessionId((current) =>
        current === sessionId ? null : current,
      );
    }
  };

  // Note: no in-window Escape handler — the overlay window is created with
  // focusable: false and shown via showInactive() (electron/windows.ts), so
  // it never receives keyboard focus and a document-level keydown listener
  // could never fire. Escape-cancel while recording is handled globally by
  // the native macOS shortcut helper; dismissal here is via the close button.

  const handleStartAgain = async () => {
    if (restartPendingRef.current) return;
    restartPendingRef.current = true;
    setIsRestarting(true);
    setRestartError(null);
    try {
      setActionFeedback(null);
      setIsSpeakingAloud(false);
      stopSpeakingText();
      await startDictation();
    } catch (error) {
      console.error("Failed to restart dictation from popup:", error);
      setRestartError("Couldn't start dictation. Check your microphone and speech model in Settings, then try again.");
    } finally {
      restartPendingRef.current = false;
      setIsRestarting(false);
    }
  };

  const handleCopyResult = async () => {
    const text = finalTextRef.current;
    if (!text?.trim() || copyResultPendingRef.current) {
      return;
    }

    const resultRevision = copyResultRevisionRef.current;
    copyResultPendingRef.current = true;
    setIsCopyingResult(true);
    setActionFeedback(null);
    try {
      await invoke("__overlay_copy_text__", { text });
      if (
        copyResultRevisionRef.current === resultRevision &&
        finalTextRef.current === text
      ) {
        setActionFeedback("Copied result");
      }
    } catch (error) {
      console.error("Failed to copy dictation result from popup:", error);
      if (
        copyResultRevisionRef.current === resultRevision &&
        finalTextRef.current === text
      ) {
        setActionFeedback("Copy failed");
      }
    } finally {
      copyResultPendingRef.current = false;
      setIsCopyingResult(false);
    }
  };

  const handleToggleReadAloud = async () => {
    // The finished result only. The button is already gated on `finalText`,
    // but falling back to `preview` here meant any future caller could make
    // Plainsong read a half-heard live partial aloud as though it were the
    // transcription.
    const text = (finalText ?? "").trim();
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
  // The pill already reads "No speech" from the message; the card must not
  // say "Transcription ready" with a check mark over the same result.
  const heardNothing =
    phase === "done" &&
    describePillStatus({ phase, stage: finishStage, outcome, message }).label === "No speech";
  const { doneTitle, doneMessage, commandLabel, deliveryRefusal } = useMemo(() => ({
    deliveryRefusal: describeDictationDeliveryRefusal(outcome),
    doneTitle: heardNothing
      ? "Nothing heard"
      : formatDoneTitle(
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
    heardNothing,
    outcome,
    finalCommandApplied,
    runtimeAppTarget,
    message,
    finalSnippetAppliedCount,
    finalLeftOnClipboard,
  ]);
  const supplementalFinalWarnings = finalWarnings.filter(
    (warning) =>
      !doneMessage?.toLocaleLowerCase("en-US").includes(warning.toLocaleLowerCase("en-US")),
  );

  // The "next profile" announcement. Picking a profile is a mode selector,
  // which STYLE.md §5 makes a rubric control: rust and neutral, never gold.
  // Gilding it competed with the one thing on this HUD that has earned gold
  // -- the live recording moment -- and this notice fires while nothing is
  // being recorded at all. Rust neume, rust rubric label, neutral surface,
  // and the profile name in plain foreground. Lasts MODE_CYCLE_NOTICE_MS.
  const cycledModeNotice = cycledModeLabel ? (
    <div
      role="status"
      aria-live="polite"
      className="settle-in flex items-center justify-center gap-2 rounded-2xl border border-foreground/10 bg-foreground/4.5 px-3 py-2"
    >
      <span aria-hidden="true" className="neume neume-rust shrink-0" />
      <span className="rubric">Next profile</span>
      <span className="text-sm font-medium text-foreground">{cycledModeLabel}</span>
    </div>
  ) : null;
  const processingCancelControls = canCancelProcessing ? (
    <>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          className="rounded-lg border border-foreground/10 bg-foreground/5 px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-foreground/8 hover:text-foreground disabled:cursor-wait disabled:opacity-50"
          onClick={() => void handleCancelProcessing()}
          disabled={isCancelling}
        >
          {isCancelling ? "Cancelling…" : "Cancel dictation"}
        </button>
        <span className="font-mono text-xs text-muted-foreground">
          Esc to cancel
        </span>
      </div>
      {displayedCancelError && (
        <p
          role="alert"
          className="mt-2 max-w-[330px] text-sm leading-relaxed text-rust"
        >
          {displayedCancelError}
        </p>
      )}
    </>
  ) : null;

  if (phase === "idle" && cycledModeNotice) {
    return (
      <div className="h-screen w-screen bg-transparent p-3">
        <div
          data-hud-card
          className="overflow-hidden rounded-[20px] border border-foreground/10 bg-popover px-4 py-3.5 shadow-[0_6px_18px_hsl(34_26%_4%/0.35)]"
        >
          {cycledModeNotice}
        </div>
      </div>
    );
  }

  if (phase === "idle") {
    return <div className="h-screen w-screen bg-transparent" />;
  }

  // ── Minimal pill mode ────────────────────────────────────────────────────
  // Fixed size with fixed slots (glyph, trace, label, action), so the pill
  // never jitters as its label changes between states. Docked against a side
  // of the screen the same slots stack into an upright column, and the trace
  // turns with them. The size preset scales the whole pill (type, trace and
  // padding together) through `zoom`, which the window size already matches.
  if (effectiveDisplayMode === "minimal") {
    const pill = describePillStatus({
      phase,
      stage: finishStage,
      outcome,
      message,
      slow: slowStage,
      preparingModel: speechModelPreparing,
      meetingAside,
    });
    // "Dictating during a meeting" is twice the slot "Listening" fills, so
    // the horizontal pill sets it on two small lines and gives it half the
    // trace (measured: 80 px of a 94 px slot in IBM Plex Sans 11/500). The
    // upright pill keeps its two-line clamp; the full sentence stays in the
    // tooltip and accessible name.
    const asideLabel = meetingAside && phase === "recording";
    const pillNeume =
      pill.tone === "live"
        ? "neume neume-lit neume-live"
        : pill.tone === "success"
          ? "neume neume-lit"
          : pill.tone === "alert"
            ? "neume neume-rust"
            : pill.tone === "quiet"
              ? "neume neume-hollow"
              : "neume";
    const vertical = pillDock !== "bottom";
    const pillSize = DICTATION_PILL_SIZE[vertical ? "vertical" : "horizontal"];
    const trace = pill.showBar ? (
      <DictationFinishBar
        stage={finishStage}
        plan={progressPlan}
        complete={pill.barComplete}
        stageStartedAt={stageStartedAt}
      />
    ) : (
      <AudioWaveform
        levels={levelHistory}
        active={phase === "recording"}
        envelope={false}
        size="sm"
        barColor={phase === "recording" ? "var(--brand-warm)" : "var(--muted-foreground)"}
      />
    );
    const statusLabel = (
      <span
        role={pill.tone === "alert" ? "alert" : "status"}
        aria-live={pill.tone === "alert" ? "assertive" : "polite"}
        aria-label={
          displayedCancelError ??
          (pill.detail ? `${pill.label}. ${pill.detail}` : undefined)
        }
        className={cn(
          "font-medium",
          vertical
            ? "line-clamp-2 w-full text-center text-[11px] leading-tight"
            : asideLabel
              ? "line-clamp-2 min-w-0 flex-1 text-[11px] leading-tight"
              : "min-w-0 flex-1 truncate text-sm",
          pill.tone === "alert"
            ? "text-rust"
            : pill.tone === "live" || pill.tone === "success"
              ? "text-foreground"
              : "text-muted-foreground",
        )}
        data-testid="dictation-hud-status"
      >
        {displayedCancelError ?? sourceNotice ?? pill.label}
      </span>
    );
    const detailsButton = minimalDetailsAvailable ? (
      <button
        type="button"
        disabled={isHoldingReview}
        className="shrink-0 rounded-full border border-foreground/10 bg-foreground/5 px-2 py-1 text-[10px] font-medium text-foreground transition-colors hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onMouseDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          void handleShowDetails();
        }}
        aria-label="Details"
      >
        {isHoldingReview ? "Opening…" : "Details"}
      </button>
    ) : null;

    return (
      <div className="flex h-screen w-screen items-center justify-center bg-transparent">
        <div
          data-hud-card
          data-tone={pill.tone}
          data-dock={pillDock}
          onDoubleClick={() =>
            void (phase === "done" || phase === "error"
              ? handleShowDetails()
              : cycleDisplayMode())
          }
          title={displayedCancelError ?? pill.detail ?? "Double-click for details"}
          style={{ width: pillSize.width, height: pillSize.height, zoom: pillScale }}
          className={cn(
            "flex shrink-0 items-center rounded-full border bg-popover shadow-[0_4px_14px_hsl(34_26%_4%/0.3)] transition-smooth",
            vertical ? "flex-col gap-2.5 px-1 pb-1.5 pt-4" : "gap-2.5 pl-3.5 pr-1.5",
            pill.tone === "alert" ? "border-rust/35" : "border-foreground/10",
          )}
        >
          <span aria-hidden="true" data-drag-region title="Drag to move" className={cn(pillNeume, "shrink-0")} />
          {vertical && detailsButton ? detailsButton : !detailsButton &&
            pill.tone !== "alert" &&
            (vertical ? (
              // The horizontal trace turned a quarter so it reads bottom to
              // top: the finish bar fills upward and the newest level sample
              // sits at the top.
              <div className="flex h-12 w-4 shrink-0 items-center justify-center">
                <div className="flex h-4 w-12 shrink-0 -rotate-90 items-center justify-center">
                  {trace}
                </div>
              </div>
            ) : (
              <div
                className={cn(
                  "flex h-4 shrink-0 items-center justify-center overflow-hidden",
                  asideLabel ? "w-8" : "w-16",
                )}
              >
                {trace}
              </div>
            ))}
          {vertical ? (
            <div className="flex min-h-0 w-full flex-1 items-center justify-center">
              {statusLabel}
            </div>
          ) : (
            statusLabel
          )}
          {!vertical && detailsButton}
          {canCancelCapture && (
            <button type="button" aria-label="Cancel (discard)" disabled={isCancelling}
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/8 hover:text-foreground"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => void handleCancelProcessing()}>
              <X className="h-3.5 w-3.5" />
            </button>
          )}
          {/* The pill has no room for a separate Stop, so while capture is
              live this button stops the session instead of only hiding the
              HUD — dismissing alone would leave the microphone open with no
              indicator anywhere on screen. */}
          <button
            type="button"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-smooth hover:bg-foreground/8 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() =>
              void (isCapturePhase
                ? handleStopFromPopup()
                : canCancelProcessing
                  ? handleCancelProcessing()
                  : hidePopup())
            }
            aria-label={
              isCapturePhase
                ? "Stop"
                : canCancelProcessing
                  ? isCancelling
                    ? "Cancelling…"
                    : "Cancel dictation"
                  : "Hide popup"
            }
            title={
              canCancelProcessing
                ? isCancelling
                  ? "Cancelling…"
                  : "Cancel dictation"
                : undefined
            }
            disabled={canCancelProcessing && isCancelling}
          >
            {isCapturePhase ? (
              <Square className="h-2.5 w-2.5 fill-current" />
            ) : canCancelProcessing && isCancelling ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <X className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>
    );
  }

  const compact = effectiveDisplayMode === "compact";
  // The header carries the phase; the body below never repeats it.
  const phaseLabel =
    phase === "preparing"
      ? "Starting"
      : phase === "primed"
        ? "Starting mic"
      : phase === "recording"
        ? meetingAside
          ? MEETING_ASIDE_LABEL
          : "Listening"
        : phase === "stopping" || phase === "transcribing"
          ? finishStageLabel
          : phase === "delivering"
            ? slowStage ? SLOW_STAGE_LABEL : "Inserting"
            : phase === "done"
              ? describePillStatus({ phase, stage: finishStage, outcome, message }).label
              : phase === "error"
                ? describePillStatus({ phase, stage: finishStage, outcome, message }).label
                : "Working";

  const spokenEditHints = [
    "scratch that",
    "actually ...",
    "replace X with Y",
    `${dictationCommandPrefix} rewrite professional`,
  ];

  // Bottom-anchored: the window sits just above the Dock, so a window taller
  // than its card (a generous estimate) leaves the gap above, not below.
  return (
    <div className="flex h-screen w-screen flex-col justify-end bg-transparent p-3">
      <div
        data-hud-card
        className={cn(
          "overflow-hidden rounded-[20px] border border-foreground/10 bg-popover px-4 py-3.5 shadow-[0_6px_18px_hsl(34_26%_4%/0.35)]",
          phase === "done" && !compact &&
            "max-h-[calc(100vh-1.5rem)] overflow-y-auto",
        )}
      >
        {cycledModeNotice && <div className="mb-3">{cycledModeNotice}</div>}
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
            {sourceNotice && (
              <>
                <span className="text-muted-foreground">·</span>
                <span
                  className="text-xs font-medium text-gold-text"
                  data-testid="dictation-source-notice"
                >
                  {sourceNotice}
                </span>
              </>
            )}
          </div>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-foreground/5 hover:text-foreground transition-colors"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => void cycleDisplayMode()}
              aria-label={compact ? "Show pill" : "Show compact controls"}
              title={compact ? "Show pill" : "Show compact controls"}
            >
              <Minimize2 className="h-3.5 w-3.5" />
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

        {asideNoticeVisible && (
          <p
            role="status"
            aria-live="polite"
            data-testid="meeting-aside-notice"
            className="settle-in mb-3 rounded-xl border border-foreground/10 bg-foreground/4.5 px-3 py-2 text-sm leading-snug text-foreground"
          >
            {MEETING_ASIDE_NOTICE}
          </p>
        )}

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

              {canCancelCapture && (
                <button type="button" aria-label="Cancel (discard)" disabled={isCancelling}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-foreground/8 hover:text-foreground"
                  onClick={() => void handleCancelProcessing()}>
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
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
            
            {displayedCancelError && <p role="alert" className="text-sm text-rust">{displayedCancelError}</p>}
            {/* Subtle Status Line */}
            <p className="text-sm text-muted-foreground text-center">
              {formatHandsFreeRuntimeHint(
                _handsFreeEnabled,
                handsFreeSilenceTimeoutSeconds,
                runtimeAppTarget,
                contextMeta.detail,
                dictationInsertionMode,
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
                {/* The streaming engine tells the two halves apart, so the
                    popup does too: settled words in the reading colour, the
                    tail the recognizer may still change in the muted one. The
                    re-decode engine has no such split -- every partial it
                    sends can change -- so its text renders as one run. */}
                <p
                  key={preview}
                  className="ink-in mt-2 text-sm leading-6 text-foreground line-clamp-4"
                >
                  {previewParts ? (
                    <>
                      <span>{previewParts.stable}</span>
                      <span className="text-muted-foreground">
                        {previewParts.volatile}
                      </span>
                    </>
                  ) : (
                    preview
                  )}
                </p>
              </div>
            )}
          </div>
        )}

        {phase === "stopping" && (
          <div className="text-foreground">
            <DictationFinishBar
              stage="stopping"
              plan={progressPlan}
              stageStartedAt={stageStartedAt}
              className="my-1.5"
            />
            <p className="text-sm text-muted-foreground">
              Finishing the recording…
            </p>
            {processingCancelControls}
          </div>
        )}

        {phase === "transcribing" && (
          <div className="flex items-center gap-3 text-foreground">
            <div className="min-w-0 flex-1">
              <DictationFinishBar
                stage={finishStage}
                plan={progressPlan}
                stageStartedAt={stageStartedAt}
                className="my-1.5"
              />
              {/* Clamped so `getPopupSize` can bound the window it sizes to
                  this card; an unclamped paragraph would grow past it. */}
              <p className="text-sm text-muted-foreground line-clamp-6">
                {message && !/^(Transcribing|Polishing)…?$/.test(message)
                  ? message
                  : finishStage === "polishing"
                    ? `Tidying punctuation${targetDetail}.`
                    : `Transcribing${targetDetail}.`}
              </p>
              {autoActivationDetail && (
                <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
                  {autoActivationDetail}
                </p>
              )}
              {processingCancelControls}
              {!compact && preview && (
                <div className="mt-2 max-w-[330px] rounded-xl border border-foreground/10 bg-foreground/4.5 px-3 py-2">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Heard so far
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
              <p className="text-sm font-semibold">{slowStage ? SLOW_STAGE_LABEL : "Inserting"}</p>
              <p className="text-xs text-muted-foreground line-clamp-6">
                {message ??
                  `Inserting${targetDetail.replace(/^ for /, " into ")}.`}
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
          <div className="flex items-start gap-3 text-foreground">
            {outcome === "error" || deliveryRefusal ? (
              <TriangleAlert className="mt-1 h-5 w-5 shrink-0 text-rust" />
            ) : heardNothing ? (
              <MicOff className="mt-1 h-5 w-5 shrink-0 text-muted-foreground" />
            ) : outcome === "paste_dispatched" ? (
              <Clock3 className="mt-1 h-5 w-5 shrink-0 text-muted-foreground" />
            ) : (
              <CheckCircle2 className="mt-1 h-5 w-5 shrink-0 text-foreground" />
            )}
            <div className="min-w-0 flex-1">
              <p className="manuscript text-base font-serif text-foreground">{doneTitle}</p>
              {!compact && doneMessage && !repeatsTitle(doneTitle, doneMessage) && (
                <p className="max-w-[330px] text-sm leading-relaxed text-muted-foreground line-clamp-6">
                  {doneMessage}
                </p>
              )}
              {!compact && supplementalFinalWarnings.length > 0 && (
                <div
                  aria-label="Warnings"
                  className="mt-2 max-w-[330px] space-y-1 rounded-md border border-gold/20 bg-gold/5 px-3 py-2 text-sm leading-relaxed text-muted-foreground"
                >
                  {supplementalFinalWarnings.map((warning) => (
                    <p key={warning}>{warning}</p>
                  ))}
                </div>
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
                  <span
                    className="rounded-full border border-foreground/10 bg-foreground/5 px-2.5 py-1"
                    title={`Say: ${spokenEditHints.join(", ")}`}
                  >
                    {deliveryRefusal || outcome === "error"
                      ? "Kept in history"
                      : outcome === "copied" || outcome === "copied_instead"
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
                  <div
                    role="region"
                    aria-label="Latest result"
                    tabIndex={0}
                    className="mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground select-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {finalText ?? preview}
                  </div>
                </div>
              )}
              {!compact && (
                <div className="mt-3">
                  <div className="flex flex-wrap gap-1.5">
                    {finalText?.trim() && (
                      <PopupActionButton
                        icon={Clipboard}
                        label="Copy result"
                        disabled={isCopyingResult}
                        detail="Put the latest text on your clipboard again."
                        onClick={() => void handleCopyResult()}
                      />
                    )}
                    <PopupActionButton
                      icon={RotateCcw}
                      label={isRestarting ? "Starting…" : "New dictation"}
                      disabled={isRestarting}
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
                    {finalWarnings.length > 0 && savedResult && savedResult.sessionId === currentReviewSessionIdRef.current && (
                      <PopupActionButton
                        icon={History}
                        label="Review this result"
                        detail="Open this saved dictation for review."
                        onClick={() => {
                          const result = savedResultRef.current;
                          if (currentPhaseRef.current !== "done" || !result
                            || result.sessionId !== currentReviewSessionIdRef.current) return;
                          void openMainApp("dictation", result.recordingId);
                        }}
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
              {!compact && reviewHoldError && (
                <div role="alert" className="mt-3 max-w-[330px] rounded-md border border-rust/30 bg-rust/10 px-3 py-2 text-sm text-rust">
                  <p>{reviewHoldError}</p>
                  {hasValidReviewSessionId && (
                    <button
                      type="button"
                      className="mt-2 rounded-lg border border-rust/30 bg-background/40 px-2.5 py-1.5 text-xs hover:bg-background/70 disabled:opacity-50"
                      disabled={isHoldingReview}
                      onClick={() => void handleShowDetails()}
                    >
                      {isHoldingReview ? "Keeping open…" : "Retry keep open"}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {phase === "error" && (
          <div className="flex items-start gap-3 text-foreground">
            <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-rust" />
            <div>
              {/* The header already names the problem; this says why and
                  what to do. Compact keeps the reason too: "Problem" on its
                  own told the user nothing. */}
              <p
                className={cn(
                  "max-w-[330px] text-sm leading-relaxed text-foreground",
                  compact ? "line-clamp-3" : "line-clamp-6",
                )}
              >
                {message ??
                  "Dictation stopped before it finished. Check microphone and Accessibility access in System Settings, then try again."}
              </p>
              {!compact && reviewHoldError && (
                <div role="alert" className="mt-2 max-w-[330px] rounded-md border border-rust/30 bg-rust/10 px-3 py-2 text-sm text-rust">
                  <p>{reviewHoldError}</p>
                  {hasValidReviewSessionId && (
                    <button
                      type="button"
                      className="mt-2 rounded-lg border border-rust/30 bg-background/40 px-2.5 py-1.5 text-xs hover:bg-background/70 disabled:opacity-50"
                      disabled={isHoldingReview}
                      onClick={() => void handleShowDetails()}
                    >
                      {isHoldingReview ? "Keeping open…" : "Retry keep open"}
                    </button>
                  )}
                </div>
              )}
              {!compact && (
                <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <button
                    type="button"
                    className="rounded-lg border border-foreground/10 bg-foreground/5 px-2.5 py-1.5 hover:bg-foreground/8"
                    onClick={() => void handleStartAgain()}
                    disabled={isRestarting}
                  >
                    {isRestarting ? "Starting…" : "New dictation"}
                  </button>
                  <button
                    type="button"
                    className="rounded-lg border border-foreground/10 bg-foreground/5 px-2.5 py-1.5 hover:bg-foreground/10"
                    onClick={() => void openMainApp("dictation")}
                  >
                    Open history
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
        {restartError && (
          <p role="alert" className="mt-3 max-w-[330px] text-sm leading-relaxed text-rust">
            {restartError}
          </p>
        )}
      </div>
    </div>
  );
}
