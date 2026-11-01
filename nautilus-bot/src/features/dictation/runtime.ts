import type { DictationRecognitionReviewWord } from "@/lib/backend/dictation";
import { useEffect, useState } from "react";
import { invoke, listen } from "@/lib/electron";
import type { DictationRoutePreference } from "@/lib/asr-capabilities";
import { sanitizeUserFacingDictationMessage } from "@/lib/dictation-ui-message";

export type DictationPhase =
  | "idle"
  | "preparing"
  | "primed"
  | "recording"
  | "stopping"
  | "transcribing"
  | "delivering"
  | "done"
  | "error";

export type DictationModePreset =
  | "voice"
  | "messages"
  | "email"
  | "notes"
  | "meeting_follow_up"
  | "custom";

export type DictationContextSource =
  | "none"
  | "clipboard"
  | "selected_text"
  | "application_context";

/**
 * `paste` and `inline` were removed: they took the same insert path as `auto`,
 * and `inline` reported itself as `paste` afterwards. The sidecar migrates
 * saved values onto `auto` (rust-sidecar/src/settings.rs).
 */
export type DictationInsertionMode = "auto" | "clipboard_only";

export interface DictationStateChangedEvent {
  phase: DictationPhase;
  dismissed?: boolean;
  startedAtMs?: number | null;
  message?: string | null;
  preview?: string | null;
  partialText?: string | null;
  /**
   * The live preview split into the half the recognizer has committed to and
   * the half it may still rewrite. Only the streaming engine produces the
   * split; the re-decode engine sends `partialText` alone, and the popup then
   * renders the whole thing as volatile, which is what it is.
   */
  partialStableText?: string | null;
  partialVolatileText?: string | null;
  /** Which engine drew this preview: "streaming" or "redecode". */
  partialEngine?: "streaming" | "redecode" | null;
  /**
   * Sub-stage of the `transcribing` phase: speech-to-text, then the optional
   * AI pass. Drives the finishing bar's label and position.
   */
  processingStage?: "transcribing" | "polishing" | null;
  /**
   * The speech model is being prepared for this Mac before it transcribes:
   * a one-time step (about 10 s) on the first dictation after its download.
   */
  speechModelPreparing?: boolean | null;
  /** Estimated speech-to-text time, learned from recent dictations. */
  expectedTranscribeMs?: number | null;
  /** Estimated AI pass time; null when no AI pass is expected. */
  expectedPolishMs?: number | null;
  sessionId?: number | null;
  stopReason?: string | null;
  outcome?: string | null;
  warnings?: string[];
  reviewHeld?: boolean;
  resolvedModePreset?: DictationModePreset | null;
  resolvedCustomModeId?: string | null;
  resolvedModeLabel?: string | null;
  contextSource?: DictationContextSource | null;
  insertionMode?: DictationInsertionMode | "preview" | null;
  appTarget?: string | null;
  activationMatcher?: string | null;
  dictationProvider?: string | null;
  dictationModelId?: string | null;
  requestedProvider?: string | null;
  actualProvider?: string | null;
  requestedModelId?: string | null;
  actualModelId?: string | null;
  fallbackReason?: string | null;
  targetApp?: string | null;
  requestedRoute?: DictationRoutePreference | null;
  resolvedRoute?: string | null;
  providerModelLabel?: string | null;
  dictationRoutePreference?: DictationRoutePreference | null;
  dictationResolvedHosting?: DictationRoutePreference | null;
  modelReadiness?: "loading" | "ready" | "deferred" | "not_required" | "error" | null;
  captureReady?: boolean;
  /**
   * On "recording" with `captureReady`: how long Electron holds the start
   * sound for this input (a Bluetooth headset switches profile first).
   */
  startSoundDelayMs?: number | null;
  /**
   * On "done": where the words can be picked up again, reported apart from
   * `outcome`, which only says what delivery observed.
   */
  recoveryLocation?: "clipboard" | "history" | "recent_dictations" | null;
  /**
   * This dictation takes its audio from a meeting that is recording (an
   * aside). Its words go to the focused app and stay out of the meeting;
   * the call still hears them. Sent from "preparing" on, and absent on
   * events that only update the preview.
   */
  meetingAside?: boolean | null;
}

/**
 * How the format/cleanup stage of one dictation concluded. Mirrors
 * `DictationFormatOutcome` in `rust-sidecar/src/dictation_timing.rs`.
 */
export type DictationFormatOutcome = "not_applicable" | "skipped" | "applied" | "timed_out" | "failed";

/**
 * Wall-clock stage timing for one dictation, from the stop command through
 * insertion -- not just the ASR-only latency fields above. This is the
 * key-release-to-glyph number only when the sidecar had a real client
 * gesture epoch to start from; otherwise it measures from when the sidecar's
 * stop handler received the command, which is honestly later than the
 * user's actual gesture by the Electron-to-sidecar IPC hop. See
 * `dictation_timing.rs`'s module doc for the full explanation, and for what
 * each field means / why a stage can be `null` (never reached).
 */
export interface DictationTimingRecord {
  stopCommandReceivedAtEpochMs: number;
  audioFinalizedMs?: number | null;
  asrCompleteMs?: number | null;
  formatCompleteMs?: number | null;
  formatOutcome: DictationFormatOutcome;
  insertionDispatchedMs?: number | null;
  insertionConfirmedMs?: number | null;
  insertionConfirmed: boolean;
  totalMs?: number | null;
}

interface DictationTextReadyEvent {
  text: string;
  sessionId?: number | null;
  rawTranscript?: string | null;
  recognitionReviewWords?: DictationRecognitionReviewWord[] | null;
  /** Recording ID when this dictation was saved to history; otherwise null. */
  recordingId?: string | null;
  /**
   * Terminal delivery outcome, mirrored from the sidecar: `pasted`,
   * `paste_dispatched`, `copied`, `replaced`, `copied_replacement`,
   * `previewed`, `undone`, `error`, `empty`, `secure_field` (delivery
   * refused because the focused control is a password or secure input —
   * see `describeDictationDeliveryRefusal`), or `clipboard_kept` (refused,
   * and a copy the user made meanwhile was left on the clipboard).
   */
  outcome?: string | null;
  pasted?: boolean;
  copied?: boolean;
  pasteError?: string | null;
  requestedProvider?: string;
  actualProvider?: string;
  isFallback?: boolean;
  optimizationApplied?: boolean | null;
  fallbackReason?: string | null;
  fallbackMessage?: string | null;
  modelId?: string;
  acknowledgementLatencyMs?: number | null;
  captureReadyLatencyMs?: number | null;
  firstStablePartialLatencyMs?: number | null;
  finalTranscriptLatencyMs?: number | null;
  startupLatencyMs?: number | null;
  latencyMs?: number;
  insertLatencyMs?: number;
  endToEndMs?: number;
  acknowledgedAtMs?: number | null;
  captureReadyAtMs?: number | null;
  firstStablePartialAtMs?: number | null;
  finalTranscriptAtMs?: number;
  insertionCompletedAtMs?: number;
  insertionModeUsed?:
    | "auto"
    | "clipboard_only"
    | "command_only"
    | "none";
  commandApplied?: string | null;
  snippetAppliedCount?: number;
  /**
   * Present only when the starting binding asked for Return after inserting:
   * whether the sidecar sent it (the text was confirmed in the same field).
   */
  submitAfterInsertSent?: boolean;
  appTarget?: string | null;
  activationMatcher?: string | null;
  contextSource?: DictationContextSource | null;
  contextChars?: number | null;
  routePreference?: DictationRoutePreference | null;
  resolvedRoute?: string | null;
  resolvedHosting?: DictationRoutePreference | null;
  providerModelLabel?: string | null;
  /**
   * Non-fatal degradations the session recovered from (an AI pass that failed
   * or timed out, a command with no text to work on). The text was still
   * delivered.
   */
  warnings?: string[];
  /**
   * Additive Wave 3 field: end-to-end stage timing for this dictation. See
   * `DictationTimingRecord` above.
   */
  timing?: DictationTimingRecord;
}

function normalizeStateEvent(payload: DictationStateChangedEvent): DictationStateChangedEvent {
  const phaseForMessage =
    payload.phase === "transcribing" ||
    payload.phase === "delivering" ||
    payload.phase === "done" ||
    payload.phase === "error"
      ? payload.phase
      : "recording";

  return {
    ...payload,
    message: sanitizeUserFacingDictationMessage(payload.message, {
      phase: phaseForMessage,
    }),
    preview: payload.preview ?? payload.partialText ?? null,
  };
}

/**
 * Fields that describe one session's result and must not outlive it. The
 * idle event that follows a done/error phase does not repeat them, so a plain
 * spread merge kept the finished session's message and outcome — a
 * secure-field refusal, say — on screen after the overlay had already reset.
 * Provider/route metadata survives idle within the same session. A new
 * session discards the entire carried snapshot before applying its fields.
 */
const VOLATILE_SESSION_FIELDS = [
  "message",
  "preview",
  "partialText",
  "partialStableText",
  "partialVolatileText",
  "partialEngine",
  "processingStage",
  "speechModelPreparing",
  "expectedTranscribeMs",
  "expectedPolishMs",
  "outcome",
  "warnings",
  "reviewHeld",
  "stopReason",
  "fallbackReason",
  "meetingAside",
] as const;

/**
 * Folds the next `dictation-state-changed` event into the last one. Exported
 * for its tests; the hook below is its only production caller.
 */
export function reduceDictationStateEvent(
  previous: DictationStateChangedEvent | null,
  next: DictationStateChangedEvent,
): DictationStateChangedEvent {
  const validSessionId = (id: number | null | undefined) =>
    typeof id === "number" && Number.isSafeInteger(id) && id > 0;
  const changedSession = validSessionId(previous?.sessionId)
    && validSessionId(next.sessionId)
    && previous?.sessionId !== next.sessionId;
  // A partial update belongs to one capture. Do not fill a new capture's
  // omitted fields with the last capture's words, target or resolved route.
  const carried: Partial<DictationStateChangedEvent> = changedSession
    ? {}
    : { ...(previous ?? {}) };
  // Host-level startup failures have no native session to hold or cancel.
  // Never inherit the previous capture's ID onto that error.
  if (next.phase === "error" && !validSessionId(next.sessionId)) {
    delete carried.sessionId;
  }
  if (next.phase === "idle") {
    for (const field of VOLATILE_SESSION_FIELDS) {
      delete carried[field];
    }
  }
  return normalizeStateEvent({
    ...carried,
    ...next,
  });
}

export function useDictationRuntime() {
  const [stateEvent, setStateEvent] = useState<DictationStateChangedEvent | null>(null);
  const [textReadyEvent, setTextReadyEvent] = useState<DictationTextReadyEvent | null>(null);

  useEffect(() => {
    let disposed = false;
    let unlistenState: (() => void) | undefined;
    let unlistenTextReady: (() => void) | undefined;

    let receivedLiveEvent = false;
    let currentSession: { id: number; startedAtMs: number | null } | null = null;
    const deliveredKeys = new Set<string>();
    const validId = (value: number | null | undefined): value is number =>
      typeof value === "number" && Number.isSafeInteger(value) && value > 0;
    const acceptState = (payload: DictationStateChangedEvent) => {
      if (!validId(payload.sessionId)) return true;
      const startedAtMs = validId(payload.startedAtMs) ? payload.startedAtMs : null;
      const startsCapture = payload.phase === "preparing"
        || ((payload.phase === "primed" || payload.phase === "recording") && startedAtMs !== null);
      if (!currentSession) {
        currentSession = { id: payload.sessionId, startedAtMs };
        return true;
      }
      if (startedAtMs !== null && currentSession.startedAtMs !== null
        && startedAtMs < currentSession.startedAtMs) return false;
      if (payload.sessionId !== currentSession.id) {
        if (!startsCapture) return false;
        if (startedAtMs === null && payload.sessionId < currentSession.id) return false;
        if (startedAtMs !== null && startedAtMs === currentSession.startedAtMs
          && payload.sessionId < currentSession.id) return false;
        currentSession = { id: payload.sessionId, startedAtMs };
      } else if (startedAtMs !== null) {
        currentSession.startedAtMs = startedAtMs;
      }
      return true;
    };
    const acceptText = (payload: DictationTextReadyEvent) => {
      if (!validId(payload.sessionId)) return true;
      if (currentSession && payload.sessionId !== currentSession.id) return false;
      // Both timestamps come from the sidecar: acknowledgement is recorded
      // after capture starts. It distinguishes reused IDs after a restart.
      if (validId(payload.acknowledgedAtMs) && currentSession?.startedAtMs != null
        && payload.acknowledgedAtMs < currentSession.startedAtMs) return false;
      const key = JSON.stringify([payload.sessionId, payload.acknowledgedAtMs ?? currentSession?.startedAtMs ?? payload.recordingId ?? null]);
      if (deliveredKeys.has(key)) return false;
      deliveredKeys.add(key);
      if (deliveredKeys.size > 32) {
        const oldest = deliveredKeys.values().next().value;
        if (oldest !== undefined) deliveredKeys.delete(oldest);
      }
      if (!currentSession) currentSession = { id: payload.sessionId, startedAtMs: null };
      return true;
    };
    const setup = async () => {
      // Subscribe before requesting a snapshot. A slow initial request must
      // not prevent capture results from reaching the renderer.
      await Promise.allSettled([
        (async () => {
          const unlisten = await listen<DictationStateChangedEvent>(
            "dictation-state-changed",
            (event) => {
              if (!disposed && acceptState(event.payload)) {
                receivedLiveEvent = true;
                setStateEvent((previous) => reduceDictationStateEvent(previous, event.payload));
              }
            },
          );
          if (disposed) unlisten();
          else unlistenState = unlisten;
        })(),
        (async () => {
          const unlisten = await listen<DictationTextReadyEvent>(
            "dictation-text-ready",
            (event) => {
              if (!disposed && acceptText(event.payload)) {
                receivedLiveEvent = true;
                setTextReadyEvent({ ...event.payload });
              }
            },
          );
          if (disposed) unlisten();
          else unlistenTextReady = unlisten;
        })(),
      ]);
      if (disposed) return;
      try {
        const initialState = await invoke<DictationStateChangedEvent>("get_dictation_overlay_state");
        // Live events describe newer state than this startup snapshot.
        if (!disposed && !receivedLiveEvent && acceptState(initialState)) {
          setStateEvent((previous) => reduceDictationStateEvent(previous, initialState));
        }
      } catch {
        // Live subscriptions still work when initial hydration fails.
      }
    };

    void setup();

    return () => {
      disposed = true;
      unlistenState?.();
      unlistenTextReady?.();
    };
  }, []);

  return {
    stateEvent,
    textReadyEvent,
  };
}
