type DictationShortcutBehavior = "hold_to_talk" | "toggle" | "hands_free";
type DictationShortcutSignal =
  | "pressed"
  | "released"
  | "cancelled"
  | "emergency_stop"
  | "watchdog_timeout";
type DictationShortcutCapability = "press_only" | "press_and_release";
type DictationShortcutSource = "electron" | "native";
// "primed" is emitted by the sidecar between the start_dictation ack and the
// "recording" event; main.ts mirrors raw sidecar phases into this type, so it
// must be part of the union. It is deliberately not idle-like (a press during
// "primed" must not double-start) and not "recording" (the pure decision table
// ignores a release seen then — the stateful runtime below handles that case).
type DictationShortcutPhase =
  | "idle"
  | "preparing"
  | "primed"
  | "recording"
  | "stopping"
  | "transcribing"
  | "delivering"
  | "done"
  | "error";
type DictationShortcutAction = "start" | "stop" | "cancel" | "ignore";

type DictationShortcutDecision = {
  action: DictationShortcutAction;
  stopReason: string | null;
  usesPressOnlyFallback: boolean;
  effectiveBehavior: DictationShortcutBehavior;
};

function isIdleLikePhase(phase: DictationShortcutPhase): boolean {
  return phase === "idle" || phase === "done" || phase === "error";
}

export function dictationShortcutFailureMessage(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message.trim()
      : typeof error === "string"
        ? error.trim()
        : "";
  return message || "Dictation could not start. Open Plainsong to check setup.";
}

// Escape is the user's way out of a session that is still running, so it has
// to cover every phase between the start ack and a terminal phase — not just
// "recording". "primed" is the window where the start was acked but the
// recording event has not arrived yet (the microphone can already be live),
// and "stopping"/"transcribing" is where a slow model would otherwise leave
// Escape doing nothing at all. The sidecar discards a session cancelled this
// way instead of inserting its text.
function isCancellablePhase(phase: DictationShortcutPhase): boolean {
  return (
    phase === "preparing" ||
    phase === "primed" ||
    phase === "recording" ||
    phase === "stopping" ||
    phase === "transcribing"
  );
}

export function resolveDictationShortcutBehavior(settings: {
  dictationPushToTalk?: boolean;
  dictationHandsFreeEnabled?: boolean;
}): DictationShortcutBehavior {
  if (settings.dictationHandsFreeEnabled) {
    return "hands_free";
  }
  if (settings.dictationPushToTalk) {
    return "hold_to_talk";
  }
  return "toggle";
}

export function resolveDictationShortcutCapability(input: {
  nativeShortcutAvailable: boolean;
  behavior: DictationShortcutBehavior;
}): DictationShortcutCapability {
  if (input.nativeShortcutAvailable && input.behavior === "hold_to_talk") {
    return "press_and_release";
  }
  return "press_only";
}

export function shouldHandleDictationShortcutSource(input: {
  source: DictationShortcutSource;
  nativeShortcutAvailable: boolean;
}): boolean {
  return input.source === "native" || !input.nativeShortcutAvailable;
}

export function resolveDictationShortcutDecision(input: {
  phase: DictationShortcutPhase;
  behavior: DictationShortcutBehavior;
  capability: DictationShortcutCapability;
  signal: DictationShortcutSignal;
}): DictationShortcutDecision {
  const { phase, behavior, capability, signal } = input;
  const usesPressOnlyFallback =
    capability === "press_only" && behavior === "hold_to_talk";

  if (signal === "emergency_stop" || signal === "watchdog_timeout") {
    return phase === "recording"
      ? {
          action: "stop",
          stopReason: signal,
          usesPressOnlyFallback,
          effectiveBehavior: behavior,
        }
      : {
          action: "ignore",
          stopReason: null,
          usesPressOnlyFallback,
          effectiveBehavior: behavior,
        };
  }

  if (signal === "cancelled") {
    return isCancellablePhase(phase)
      ? {
          action: "cancel",
          stopReason: "cancelled",
          usesPressOnlyFallback,
          effectiveBehavior: behavior,
        }
      : {
          action: "ignore",
          stopReason: null,
          usesPressOnlyFallback,
          effectiveBehavior: behavior,
        };
  }

  if (capability === "press_only") {
    if (signal !== "pressed") {
      return {
        action: "ignore",
        stopReason: null,
        usesPressOnlyFallback,
        effectiveBehavior: behavior,
      };
    }

    if (isIdleLikePhase(phase)) {
      return {
        action: "start",
        stopReason: null,
        usesPressOnlyFallback,
        effectiveBehavior: behavior,
      };
    }

    if (phase === "recording") {
      return {
        action: "stop",
        stopReason: behavior === "hands_free" ? "hands_free_toggle" : "toggle",
        usesPressOnlyFallback,
        effectiveBehavior: behavior,
      };
    }

    return {
      action: "ignore",
      stopReason: null,
      usesPressOnlyFallback,
      effectiveBehavior: behavior,
    };
  }

  if (behavior === "hold_to_talk") {
    if (signal === "pressed" && isIdleLikePhase(phase)) {
      return {
        action: "start",
        stopReason: null,
        usesPressOnlyFallback: false,
        effectiveBehavior: behavior,
      };
    }
    if (signal === "released" && phase === "recording") {
      return {
        action: "stop",
        stopReason: "release",
        usesPressOnlyFallback: false,
        effectiveBehavior: behavior,
      };
    }
    return {
      action: "ignore",
      stopReason: null,
      usesPressOnlyFallback: false,
      effectiveBehavior: behavior,
    };
  }

  if (signal === "pressed" && isIdleLikePhase(phase)) {
    return {
      action: "start",
      stopReason: null,
      usesPressOnlyFallback: false,
      effectiveBehavior: behavior,
    };
  }

  if (signal === "pressed" && phase === "recording") {
    return {
      action: "stop",
      stopReason: behavior === "hands_free" ? "hands_free_toggle" : "toggle",
      usesPressOnlyFallback: false,
      effectiveBehavior: behavior,
    };
  }

  return {
    action: "ignore",
    stopReason: null,
    usesPressOnlyFallback: false,
    effectiveBehavior: behavior,
  };
}

// Backstop for hold-to-talk sessions whose release event is lost entirely
// (helper killed mid-hold, tap outage, ...): stop recording after this long.
export const DICTATION_HOLD_WATCHDOG_MS = 5 * 60 * 1000;

// A short press and the gap before a second tap each have this limit.
const HOLD_TAP_LOCK_MS = 300;

/**
 * What a start issued by this controller tells the sidecar beyond "start":
 * the selected profile for an inherited binding, or the per-session mode
 * a binding named, and whether the starting binding asked for Return after
 * inserting. Mirrors the sidecar's dictation start options.
 */
export type DictationShortcutStartOptions = {
  profile?: "normal_speed" | "power_rewrite";
  modeOverride?: { preset: string; customModeId: string | null };
  handsFreeTrigger?: boolean;
  submitAfterInsert?: boolean;
};

export function resolveDictationShortcutStartOptions(
  profile: unknown,
  modeOverride: { preset: string; customModeId: string | null } | null,
  submitAfterInsert = false,
): DictationShortcutStartOptions {
  const submit = submitAfterInsert ? { submitAfterInsert: true } : {};
  if (modeOverride) {
    return {
      modeOverride: { preset: modeOverride.preset, customModeId: modeOverride.customModeId },
      ...submit,
    };
  }
  return {
    profile: profile === "power_rewrite" || profile === "accuracy" ? "power_rewrite" : "normal_speed",
    ...submit,
  };
}

type DictationShortcutSignalInput = {
  behavior: DictationShortcutBehavior;
  capability: DictationShortcutCapability;
  signal: DictationShortcutSignal;
  /** Applied to the `start_dictation` this signal may issue; ignored otherwise. */
  startOptions?: DictationShortcutStartOptions;
  /**
   * Hold-to-talk only: a quick tap locks the session on instead of stopping
   * it (see HOLD_TAP_LOCK_MS). Off unless the caller asks for it.
   */
  holdTapLocks?: boolean;
  holdDoubleTapLocks?: boolean;
  bindingId?: string;
  pressEpochMs?: number;
  occurrenceEpochMs?: number;
  modifierArmDelayMs?: number;
};

export type DictationShortcutSignalRuntime = {
  handleSignal: (input: DictationShortcutSignalInput) => Promise<void>;
  startHandsFree: (startOptions: DictationShortcutStartOptions) => Promise<void>;
  cancelOwned: (bindingId?: string, occurrenceEpochMs?: number) => Promise<void>;
  getActivationState: () => { shortcutLocked: boolean; shortcutBindingId: string | null };
  onPhase: (phase: string) => void;
  dispose: () => void;
};

/**
 * Stateful wrapper around resolveDictationShortcutDecision that closes
 * hold-to-talk gaps the pure decision table cannot see. Sidecar command
 * responses and dictation-state-changed events travel on independent paths
 * (the response is written by the dispatch task, events drain through a
 * separate channel task), so the start_dictation ack routinely reaches
 * Electron before the phase "recording" event does:
 *
 * - A rapid press/release taps out before the start_dictation invoke
 *   resolves, so the release resolves to "ignore" and the microphone would
 *   stay live forever. The runtime remembers the release while the start is
 *   in flight and issues the stop as soon as the start resolves.
 * - A release that lands after the start resolved but before the phase
 *   "recording" event was observed (cached phase still "idle"/"primed") also
 *   resolves to "ignore"; the armed watchdog marks the session as live, so
 *   the runtime stops it immediately instead of dropping the release.
 * - A release that never arrives at all (helper respawned mid-hold, event tap
 *   outage) is bounded by a watchdog that emits the already-typed
 *   "watchdog_timeout" signal after DICTATION_HOLD_WATCHDOG_MS.
 *
 * The caller must forward every observed dictation phase into onPhase; the
 * watchdog is cleared when the guarded session leaves its live phases
 * ("primed"/"recording") through any path — VAD auto-stop, overlay stop,
 * Escape force-stop, sidecar restart — so a stale timer can never stop a
 * later unrelated session.
 */
export function createDictationShortcutSignalRuntime(deps: {
  getPhase: () => DictationShortcutPhase;
  getSessionId?: () => number | null;
  invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>;
  log?: (message: string, payload?: unknown) => void;
  holdWatchdogMs?: number;
  onLockChanged?: (locked: boolean) => void;
}): DictationShortcutSignalRuntime {
  const holdWatchdogMs = deps.holdWatchdogMs ?? DICTATION_HOLD_WATCHDOG_MS;
  // Start bookkeeping is per-attempt, not global. These used to be two shared
  // booleans, so a second physical tap arriving while the first start was still
  // in flight reset `pendingHoldRelease` and the first tap's release was lost —
  // the user held the key and the session never stopped. Each start now owns a
  // generation, and only that generation may consume or clear its own release.
  let cancelledSessionId: number | null = null;
  let startGeneration = 0;
  let activeStartGeneration: number | null = null;
  let pendingHoldReleaseGeneration: number | null = null;
  let pendingHoldReleaseEpochMs: number | null = null;
  let pendingToggleStopReason: "toggle" | "hands_free_toggle" = "toggle";
  let pendingToggleStopGeneration: number | null = null;
  let pendingToggleStopGestureEpochMs: number | null = null;
  let liveShortcutStartGeneration: number | null = null;
  // Tap to lock: when the current hold started, and whether a tap locked it.
  let holdPressEpochMs: number | null = null;
  let tapLocked = false;
  const setTapLocked = (locked: boolean): void => {
    if (tapLocked === locked) return;
    tapLocked = locked;
    deps.onLockChanged?.(locked);
  };
  let ownerBindingId: string | undefined;
  let ownerSessionId: number | null = null;
  let pendingBindingCancel = false;
  let doubleTapTimer: ReturnType<typeof setTimeout> | null = null;
  let secondTap = false;
  let pendingRestart: {
    input: DictationShortcutSignalInput;
    sessionId: number | null;
    generation: number;
    stopSettled: boolean;
    terminalSeen: boolean;
  } | null = null;
  const restartIfReady = (): void => {
    const pending = pendingRestart;
    if (!pending || !pending.stopSettled || !pending.terminalSeen) return;
    pendingRestart = null;
    if (!isIdleLikePhase(deps.getPhase()) || startGeneration !== pending.generation ||
        (deps.getSessionId !== undefined && pending.sessionId === null) ||
        (pending.sessionId !== null && deps.getSessionId?.() !== pending.sessionId)) return;
    void handleSignal(pending.input).catch((error) => deps.log?.("separate hold start failed", error));
  };
  let firstTapReleaseEpochMs: number | null = null;
  const clearDoubleTap = (): void => {
    if (doubleTapTimer !== null) clearTimeout(doubleTapTimer);
    doubleTapTimer = null;
    secondTap = false;
    firstTapReleaseEpochMs = null;
  };
  // The press that unlocked a tap-locked session already stopped it; its
  // release must not send a second stop (the sidecar answers "already
  // stopping" and the HUD shows an error).
  let swallowUnlockRelease = false;
  const invalidatedStartGenerations = new Set<number>();
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingStop: { generation: number; sessionId: number | null; work: Promise<unknown> } | null = null;
  const stop = (args: Record<string, unknown>): Promise<unknown> => {
    const sessionId = deps.getSessionId?.() ?? null;
    if (pendingStop?.generation === startGeneration && pendingStop.sessionId === sessionId) return pendingStop.work;
    const work = deps.invoke("stop_dictation", args);
    const request = { generation: startGeneration, sessionId, work };
    pendingStop = request;
    const clear = () => { if (pendingStop === request) pendingStop = null; };
    void work.then(clear, clear);
    return work;
  };

  const clearWatchdog = (): void => {
    if (watchdogTimer !== null) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
  };

  const armWatchdog = (input: DictationShortcutSignalInput): void => {
    clearWatchdog();
    watchdogTimer = setTimeout(() => {
      watchdogTimer = null;
      void handleSignal({ ...input, occurrenceEpochMs: undefined, signal: "watchdog_timeout" }).catch((error) => {
        console.error("[shortcuts] dictation hold watchdog stop failed", error);
      });
    }, holdWatchdogMs);
  };

  const handleSignal = async (input: DictationShortcutSignalInput): Promise<void> => {
    const stopGestureEpochMs = input.occurrenceEpochMs ?? Date.now();
    const phase = deps.getPhase();
    if (cancelledSessionId !== null && cancelledSessionId === deps.getSessionId?.()) return;
    if (pendingRestart && (input.signal === "cancelled" || input.signal === "emergency_stop") &&
        (input.bindingId === undefined || input.bindingId === pendingRestart.input.bindingId)) {
      pendingRestart = null;
    }
    if (pendingRestart && input.bindingId === pendingRestart.input.bindingId) {
      if (input.signal === "released" || input.signal === "cancelled") {
        pendingRestart = null;
        return;
      }
      if (input.signal === "pressed") return;
    }
    if (input.bindingId && input.bindingId !== ownerBindingId &&
        (input.signal !== "pressed" || ownerBindingId !== undefined && input.behavior === "hold_to_talk")) return;
    if (input.bindingId && ownerSessionId !== null && deps.getSessionId?.() !== ownerSessionId) {
      clearDoubleTap();
      clearWatchdog();
      ownerBindingId = undefined;
      return;
    }
    if (input.signal === "cancelled") {
      if (activeStartGeneration !== null && invalidatedStartGenerations.has(activeStartGeneration)) return;
      clearDoubleTap();
      clearWatchdog();
      liveShortcutStartGeneration = null;
      setTapLocked(false);
      holdPressEpochMs = null;
      if (input.bindingId && activeStartGeneration === null && ownerBindingId === undefined) return;
      if (activeStartGeneration !== null) {
        pendingBindingCancel = true;
        if (ownerSessionId !== null) await cancelStartingSession();
        return;
      }
      if (input.bindingId) {
        ownerBindingId = undefined;
        cancelledSessionId = ownerSessionId;
        clearWatchdog();
        await deps.invoke("force_stop_dictation", ownerSessionId === null ? {} : { sessionId: ownerSessionId });
        return;
      }
    }
    const decision = resolveDictationShortcutDecision({ phase, ...input });
    const holdToTalkWithRelease =
      input.behavior === "hold_to_talk" && input.capability === "press_and_release";

    // The cached phase can still be idle while a start is in flight or after
    // its ack. Resolve a second toggle press against tracked state first.
    const togglesOnPress = !holdToTalkWithRelease;
    const toggleStopReason = input.behavior === "hands_free" ? "hands_free_toggle" : "toggle";
    if (input.signal === "pressed" && togglesOnPress) {
      if (activeStartGeneration !== null) {
        if (pendingToggleStopGeneration !== activeStartGeneration) {
          pendingToggleStopGeneration = activeStartGeneration;
          pendingToggleStopGestureEpochMs = stopGestureEpochMs;
          pendingToggleStopReason = toggleStopReason;
        }
        return;
      }
      if (liveShortcutStartGeneration !== null) {
        liveShortcutStartGeneration = null;
        deps.log?.("dictation shortcut stop_dictation", {
          phase,
          behavior: input.behavior,
          capability: input.capability,
          stopReason: toggleStopReason,
        });
        await stop({
          stopReason: toggleStopReason,
          stopGestureEpochMs,
        });
        return;
      }
    }

    if (holdToTalkWithRelease && input.signal === "released" && swallowUnlockRelease) {
      swallowUnlockRelease = false;
      return;
    }

    if (holdToTalkWithRelease && input.holdDoubleTapLocks && !tapLocked) {
      if (input.signal === "pressed" && doubleTapTimer !== null) {
        const withinWindow = firstTapReleaseEpochMs !== null &&
          (input.occurrenceEpochMs ?? input.pressEpochMs ?? stopGestureEpochMs) - firstTapReleaseEpochMs < HOLD_TAP_LOCK_MS;
        const firstReleaseEpochMs = firstTapReleaseEpochMs;
        clearDoubleTap();
        if (!withinWindow) {
          const pending = {
            input,
            sessionId: ownerSessionId,
            generation: startGeneration,
            stopSettled: false,
            terminalSeen: false,
          };
          const startInFlight = activeStartGeneration !== null;
          try {
            const stopping = handleSignal({ ...input, occurrenceEpochMs: firstReleaseEpochMs ?? stopGestureEpochMs,
              signal: "released", holdDoubleTapLocks: false, holdTapLocks: false });
            pendingRestart = pending;
            await stopping;
            if (!startInFlight) pending.stopSettled = true;
            restartIfReady();
          } catch (error) {
            if (pendingRestart === pending) pendingRestart = null;
            throw error;
          }
          return;
        }
        secondTap = true;
        holdPressEpochMs = input.occurrenceEpochMs ?? input.pressEpochMs ?? stopGestureEpochMs;
        return;
      }
      if (input.signal === "released" && holdPressEpochMs !== null &&
          stopGestureEpochMs - holdPressEpochMs < HOLD_TAP_LOCK_MS) {
        holdPressEpochMs = null;
        if (secondTap) {
          clearDoubleTap();
          setTapLocked(true);
          clearWatchdog();
        } else if (doubleTapTimer === null) {
          firstTapReleaseEpochMs = stopGestureEpochMs;
          // Physical press time enforces the window. Allow for the helper's
          // arm delay before deciding that no second press arrived.
          doubleTapTimer = setTimeout(() => {
            doubleTapTimer = null;
            void handleSignal({ ...input, holdDoubleTapLocks: false, holdTapLocks: false, signal: "released" })
              .catch((error) => deps.log?.("double tap release failed", error));
          }, Math.max(0, stopGestureEpochMs + HOLD_TAP_LOCK_MS + (input.modifierArmDelayMs ?? 0) - Date.now()));
        }
        return;
      }
      if (input.signal === "released") clearDoubleTap();
    }

    if (holdToTalkWithRelease && (input.holdTapLocks && !input.holdDoubleTapLocks || tapLocked)) {
      if (
        input.signal === "released" &&
        !tapLocked &&
        holdPressEpochMs !== null &&
        stopGestureEpochMs - holdPressEpochMs < HOLD_TAP_LOCK_MS
      ) {
        // A tap, not a hold: keep listening until the next press. The release
        // was seen, so the lost-release watchdog has nothing left to guard;
        // the sidecar's own maximum dictation length still applies.
        setTapLocked(true);
        holdPressEpochMs = null;
        clearWatchdog();
        deps.log?.("dictation shortcut tap locked", { phase });
        return;
      }
      if (input.signal === "pressed" && tapLocked) {
        setTapLocked(false);
        swallowUnlockRelease = true;
        if (activeStartGeneration !== null) {
          // The start is still in flight: stop as soon as it resolves.
          pendingHoldReleaseGeneration = activeStartGeneration;
          pendingHoldReleaseEpochMs = stopGestureEpochMs;
          return;
        }
        clearWatchdog();
        deps.log?.("dictation shortcut stop_dictation", {
          phase,
          behavior: input.behavior,
          capability: input.capability,
          stopReason: "tap_lock_toggle",
        });
        await stop({ stopReason: "tap_lock_toggle", stopGestureEpochMs });
        return;
      }
      if (input.signal === "released") {
        holdPressEpochMs = null;
      }
    }

    if (holdToTalkWithRelease && input.signal === "pressed" &&
        (activeStartGeneration !== null || watchdogTimer !== null)) return;

    if (decision.action === "ignore") {
      if (input.signal === "released" && holdToTalkWithRelease) {
        if (activeStartGeneration !== null) {
          // Rapid tap: the release arrived while start_dictation was still in
          // flight. Tag it with the generation that is starting so only that
          // start consumes it.
          pendingHoldReleaseGeneration = activeStartGeneration;
          pendingHoldReleaseEpochMs = stopGestureEpochMs;
        } else if (watchdogTimer !== null) {
          // The start already resolved (watchdog armed) but the sidecar's
          // phase "recording" event has not been observed yet, so the cached
          // phase is still "idle"/"primed" and the decision table said
          // ignore. The session is live — stop it now instead of dropping
          // the release. (A watchdog armed for a session that ended through
          // another path is cleared by onPhase, so it reliably marks a live
          // hold session here.)
          clearWatchdog();
          deps.log?.("dictation shortcut stop_dictation", {
            phase,
            behavior: input.behavior,
            capability: input.capability,
            stopReason: "release",
          });
          await stop({ stopReason: "release", stopGestureEpochMs });
        }
      }
      return;
    }

    if (decision.action === "start") {
      deps.log?.("dictation shortcut start_dictation", {
        phase,
        behavior: input.behavior,
        capability: input.capability,
        profile: input.startOptions?.profile,
        modePreset: input.startOptions?.modeOverride?.preset,
      });
      if (activeStartGeneration !== null) return;
      clearDoubleTap();
      ownerBindingId = input.bindingId;
      ownerSessionId = null;
      pendingBindingCancel = false;
      const generation = ++startGeneration;
      activeStartGeneration = generation;
      if (holdToTalkWithRelease) {
        holdPressEpochMs = input.occurrenceEpochMs ?? input.pressEpochMs ?? stopGestureEpochMs;
        setTapLocked(false);
        swallowUnlockRelease = false;
      }
      // Only clear a release that belongs to an older generation; a release
      // already recorded for THIS generation (possible if the signal races the
      // invoke) must survive.
      if (
        pendingHoldReleaseGeneration !== null &&
        pendingHoldReleaseGeneration !== generation
      ) {
        pendingHoldReleaseGeneration = null;
        pendingHoldReleaseEpochMs = null;
      }
      if (pendingToggleStopGeneration !== null && pendingToggleStopGeneration !== generation) {
        pendingToggleStopGeneration = null;
        pendingToggleStopGestureEpochMs = null;
      }
      let started = false;
      try {
        await deps.invoke(
          "start_dictation",
          input.startOptions ? { options: input.startOptions } : {},
        );
        started = true;
      } finally {
        // A newer start may have superseded this one while we awaited; in that
        // case leave its bookkeeping alone.
        if (activeStartGeneration === generation) {
          activeStartGeneration = null;
        }
        if (!started && startGeneration === generation) {
          clearDoubleTap();
          ownerBindingId = undefined;
          ownerSessionId = null;
          holdPressEpochMs = null;
          setTapLocked(false);
        }
        if (!started && pendingHoldReleaseGeneration === generation) {
          pendingHoldReleaseGeneration = null;
          pendingHoldReleaseEpochMs = null;
        }
        if (!started && pendingToggleStopGeneration === generation) {
          pendingToggleStopGeneration = null;
          pendingToggleStopGestureEpochMs = null;
        }
      }
      if (invalidatedStartGenerations.delete(generation)) {
        return;
      }
      if (pendingBindingCancel) {
        pendingBindingCancel = false;
        clearDoubleTap();
        ownerBindingId = undefined;
        await deps.invoke("force_stop_dictation", ownerSessionId === null ? {} : { sessionId: ownerSessionId });
        return;
      }
      liveShortcutStartGeneration = togglesOnPress ? generation : null;
      if (pendingToggleStopGeneration === generation) {
        const pendingStopGestureEpochMs = pendingToggleStopGestureEpochMs ?? stopGestureEpochMs;
        pendingToggleStopGeneration = null;
        pendingToggleStopGestureEpochMs = null;
        liveShortcutStartGeneration = null;
        deps.log?.("dictation shortcut stop_dictation", {
          phase: deps.getPhase(),
          behavior: input.behavior,
          capability: input.capability,
          stopReason: pendingToggleStopReason,
        });
        await stop({
          stopReason: pendingToggleStopReason,
          stopGestureEpochMs: pendingStopGestureEpochMs,
        });
        return;
      }
      if (holdToTalkWithRelease && pendingHoldReleaseGeneration === generation) {
        const bufferedStopGestureEpochMs = pendingHoldReleaseEpochMs ?? stopGestureEpochMs;
        pendingHoldReleaseGeneration = null;
        pendingHoldReleaseEpochMs = null;
        deps.log?.("dictation shortcut stop_dictation", {
          phase: deps.getPhase(),
          behavior: input.behavior,
          capability: input.capability,
          stopReason: "release",
        });
        await stop({
          stopReason: "release",
          stopGestureEpochMs: bufferedStopGestureEpochMs,
        });
        if (pendingRestart) {
          pendingRestart.stopSettled = true;
          restartIfReady();
        }
        return;
      }
      if (holdToTalkWithRelease && !tapLocked) {
        armWatchdog(input);
      }
      return;
    }

    clearWatchdog();
    liveShortcutStartGeneration = null;

    if (decision.action === "stop") {
      clearDoubleTap();
      deps.log?.("dictation shortcut stop_dictation", {
        phase,
        behavior: input.behavior,
        capability: input.capability,
        stopReason: decision.stopReason ?? "toggle",
      });
      await stop({
        stopReason: decision.stopReason ?? "toggle",
        stopGestureEpochMs,
      });
      return;
    }

    if (decision.action === "cancel") {
      ownerBindingId = undefined;
      clearDoubleTap();
      deps.log?.("dictation shortcut force_stop_dictation", {
        phase,
        behavior: input.behavior,
        capability: input.capability,
        stopReason: decision.stopReason ?? "cancelled",
      });
      const sessionId = deps.getSessionId?.();
      cancelledSessionId = sessionId ?? null;
      await deps.invoke("force_stop_dictation", {
        ...(typeof sessionId === "number" ? { sessionId } : {}),
      });
    }
  };

  const cancelStartingSession = async (): Promise<void> => {
    if (!pendingBindingCancel || ownerSessionId === null) return;
    const sessionId = ownerSessionId;
    cancelledSessionId = sessionId;
    pendingBindingCancel = false;
    if (activeStartGeneration !== null) {
      invalidatedStartGenerations.add(activeStartGeneration);
    }
    ownerBindingId = undefined;
    await deps.invoke("force_stop_dictation", { sessionId });
  };

  const onPhase = (phase: string): void => {
    if (phase === "idle" || phase === "done" || phase === "error") cancelledSessionId = null;
    if (pendingRestart) {
      if (pendingRestart.sessionId === null && ownerBindingId === pendingRestart.input.bindingId &&
          (phase === "primed" || phase === "recording")) {
        pendingRestart.sessionId = deps.getSessionId?.() ?? null;
      }
      if (pendingRestart.sessionId !== null && deps.getSessionId?.() !== pendingRestart.sessionId) {
        pendingRestart = null;
      } else if (phase === "idle" || phase === "done" || phase === "error") {
        pendingRestart.terminalSeen = true;
      }
    }
    if ((phase === "preparing" || phase === "primed" || phase === "recording") && ownerBindingId !== undefined && ownerSessionId === null) {
      ownerSessionId = deps.getSessionId?.() ?? null;
      if (pendingBindingCancel) {
        void cancelStartingSession().catch((error) => deps.log?.("dictation cancellation failed", error));
      }
    }
    // The watchdog guards exactly one hold-to-talk session, armed when its
    // start_dictation resolves. Once the observed phase leaves the session's
    // live phases ("primed"/"recording") — VAD auto-stop, overlay stop,
    // Escape force-stop, an error, or a sidecar restart — that session is
    // over, so drop the timer before it can stop a later unrelated session.
    // Events reach us in emission order, so a phase seen while the watchdog
    // is armed always belongs to the guarded session (a press is only
    // accepted after the previous session's terminal phase was processed).
    if (
      watchdogTimer !== null &&
      phase !== "preparing" &&
      phase !== "primed" &&
      phase !== "recording"
    ) {
      clearWatchdog();
    }
    if (phase !== "preparing" && phase !== "primed" && phase !== "recording") {
      clearDoubleTap();
      ownerBindingId = undefined;
      ownerSessionId = null;
      pendingBindingCancel = false;
      liveShortcutStartGeneration = null;
      holdPressEpochMs = null;
      setTapLocked(false);
      if (activeStartGeneration !== null) {
        invalidatedStartGenerations.add(activeStartGeneration);
        if (pendingHoldReleaseGeneration === activeStartGeneration) {
          pendingHoldReleaseGeneration = null;
          pendingHoldReleaseEpochMs = null;
        }
        if (pendingToggleStopGeneration === activeStartGeneration) {
          pendingToggleStopGeneration = null;
          pendingToggleStopGestureEpochMs = null;
        }
        activeStartGeneration = null;
      }
    }
    restartIfReady();
  };

  return {
    getActivationState: () => ({ shortcutLocked: tapLocked, shortcutBindingId: ownerBindingId ?? null }),
    handleSignal,
    cancelOwned: (bindingId = pendingRestart?.input.bindingId ?? ownerBindingId, occurrenceEpochMs) => bindingId === undefined ? Promise.resolve() : handleSignal({
      behavior: "hold_to_talk", capability: "press_and_release", signal: "cancelled", bindingId, occurrenceEpochMs,
    }),
    startHandsFree: (startOptions) =>
      handleSignal({
        behavior: "hands_free",
        capability: "press_only",
        signal: "pressed",
        startOptions,
      }),
    onPhase,
    dispose: () => {
      pendingRestart = null;
      clearWatchdog();
      if (activeStartGeneration !== null) {
        invalidatedStartGenerations.add(activeStartGeneration);
        activeStartGeneration = null;
      }
      clearDoubleTap();
      ownerBindingId = undefined;
      ownerSessionId = null;
      pendingBindingCancel = false;
      liveShortcutStartGeneration = null;
      holdPressEpochMs = null;
      setTapLocked(false);
      swallowUnlockRelease = false;
      pendingHoldReleaseGeneration = null;
      pendingHoldReleaseEpochMs = null;
      pendingToggleStopGeneration = null;
      pendingToggleStopGestureEpochMs = null;
    },
  };
}
