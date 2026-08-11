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
}

interface DictationTextReadyEvent {
  text: string;
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

function mergeStateEvent(
  previous: DictationStateChangedEvent | null,
  next: DictationStateChangedEvent,
): DictationStateChangedEvent {
  return normalizeStateEvent({
    ...(previous ?? {}),
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

    const setup = async () => {
      try {
        const initialState = await invoke<DictationStateChangedEvent>("get_dictation_overlay_state");
        if (!disposed) {
          setStateEvent((previous) => mergeStateEvent(previous, initialState));
        }
      } catch {
        // Ignore initial hydration failures.
      }

      const nextUnlistenState = await listen<DictationStateChangedEvent>(
        "dictation-state-changed",
        (event) => {
          if (!disposed) {
            setStateEvent((previous) =>
              mergeStateEvent(previous, event.payload),
            );
          }
        },
      );
      if (disposed) {
        nextUnlistenState();
        return;
      }
      unlistenState = nextUnlistenState;

      const nextUnlistenTextReady = await listen<DictationTextReadyEvent>(
        "dictation-text-ready",
        (event) => {
          if (!disposed) {
            setTextReadyEvent({ ...event.payload });
          }
        },
      );
      if (disposed) {
        nextUnlistenTextReady();
        return;
      }
      unlistenTextReady = nextUnlistenTextReady;
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
