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

/**
 * What a start issued by this controller tells the sidecar beyond "start":
 * today only the per-session mode a binding named (roadmap item B4). Mirrors
 * `DictationStartOptions.mode_override` in rust-sidecar/src/models.rs.
 */
export type DictationShortcutStartOptions = {
  modeOverride?: { preset: string; customModeId: string | null };
  handsFreeTrigger?: boolean;
};

type DictationShortcutSignalInput = {
  behavior: DictationShortcutBehavior;
  capability: DictationShortcutCapability;
  signal: DictationShortcutSignal;
  /** Applied to the `start_dictation` this signal may issue; ignored otherwise. */
  startOptions?: DictationShortcutStartOptions;
};

export type DictationShortcutSignalRuntime = {
  handleSignal: (input: DictationShortcutSignalInput) => Promise<void>;
  startHandsFree: (startOptions: DictationShortcutStartOptions) => Promise<void>;
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
  invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>;
  log?: (message: string, payload?: unknown) => void;
  holdWatchdogMs?: number;
}): DictationShortcutSignalRuntime {
  const holdWatchdogMs = deps.holdWatchdogMs ?? DICTATION_HOLD_WATCHDOG_MS;
  // Start bookkeeping is per-attempt, not global. These used to be two shared
  // booleans, so a second physical tap arriving while the first start was still
  // in flight reset `pendingHoldRelease` and the first tap's release was lost —
  // the user held the key and the session never stopped. Each start now owns a
  // generation, and only that generation may consume or clear its own release.
  let startGeneration = 0;
  let activeStartGeneration: number | null = null;
  let pendingHoldReleaseGeneration: number | null = null;
  let pendingHoldReleaseEpochMs: number | null = null;
  let pendingHandsFreeStopGeneration: number | null = null;
  let pendingHandsFreeStopGestureEpochMs: number | null = null;
  let liveShortcutStartGeneration: number | null = null;
  const invalidatedStartGenerations = new Set<number>();
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;

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
      void handleSignal({ ...input, signal: "watchdog_timeout" }).catch((error) => {
        console.error("[shortcuts] dictation hold watchdog stop failed", error);
      });
    }, holdWatchdogMs);
  };

  const handleSignal = async (input: DictationShortcutSignalInput): Promise<void> => {
    // Captured before any awaiting: the closest this controller can get to
    // the real stop gesture (hotkey release, hands-free toggle, etc.)
    // without threading a timestamp through the native shortcut helper's own
    // event payload. Sent to the sidecar so its dictation timing record can
    // measure from the actual gesture instead of from whenever its IPC
    // handler happened to run.
    const stopGestureEpochMs = Date.now();
    const phase = deps.getPhase();
    const decision = resolveDictationShortcutDecision({ phase, ...input });
    const holdToTalkWithRelease =
      input.behavior === "hold_to_talk" && input.capability === "press_and_release";

    // The cached phase can still be idle while a start is in flight or after
    // its ack. Resolve the second hands-free press against tracked state first.
    if (input.signal === "pressed" && input.behavior === "hands_free") {
      if (activeStartGeneration !== null) {
        pendingHandsFreeStopGeneration = activeStartGeneration;
        pendingHandsFreeStopGestureEpochMs = stopGestureEpochMs;
        return;
      }
      if (liveShortcutStartGeneration !== null) {
        liveShortcutStartGeneration = null;
        deps.log?.("dictation shortcut stop_dictation", {
          phase,
          behavior: input.behavior,
          capability: input.capability,
          stopReason: "hands_free_toggle",
        });
        await deps.invoke("stop_dictation", {
          stopReason: "hands_free_toggle",
          stopGestureEpochMs,
        });
        return;
      }
    }

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
          await deps.invoke("stop_dictation", { stopReason: "release", stopGestureEpochMs });
        }
      }
      return;
    }

    if (decision.action === "start") {
      deps.log?.("dictation shortcut start_dictation", {
        phase,
        behavior: input.behavior,
        capability: input.capability,
      });
      const generation = ++startGeneration;
      activeStartGeneration = generation;
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
      if (pendingHandsFreeStopGeneration !== null && pendingHandsFreeStopGeneration !== generation) {
        pendingHandsFreeStopGeneration = null;
        pendingHandsFreeStopGestureEpochMs = null;
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
        if (!started && pendingHoldReleaseGeneration === generation) {
          pendingHoldReleaseGeneration = null;
          pendingHoldReleaseEpochMs = null;
        }
        if (!started && pendingHandsFreeStopGeneration === generation) {
          pendingHandsFreeStopGeneration = null;
          pendingHandsFreeStopGestureEpochMs = null;
        }
      }
      if (invalidatedStartGenerations.delete(generation)) {
        return;
      }
      liveShortcutStartGeneration = input.behavior === "hands_free" ? generation : null;
      if (pendingHandsFreeStopGeneration === generation) {
        const pendingStopGestureEpochMs = pendingHandsFreeStopGestureEpochMs ?? stopGestureEpochMs;
        pendingHandsFreeStopGeneration = null;
        pendingHandsFreeStopGestureEpochMs = null;
        liveShortcutStartGeneration = null;
        deps.log?.("dictation shortcut stop_dictation", {
          phase: deps.getPhase(),
          behavior: input.behavior,
          capability: input.capability,
          stopReason: "hands_free_toggle",
        });
        await deps.invoke("stop_dictation", {
          stopReason: "hands_free_toggle",
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
        await deps.invoke("stop_dictation", {
          stopReason: "release",
          stopGestureEpochMs: bufferedStopGestureEpochMs,
        });
        return;
      }
      if (holdToTalkWithRelease) {
        armWatchdog(input);
      }
      return;
    }

    clearWatchdog();
    liveShortcutStartGeneration = null;

    if (decision.action === "stop") {
      deps.log?.("dictation shortcut stop_dictation", {
        phase,
        behavior: input.behavior,
        capability: input.capability,
        stopReason: decision.stopReason ?? "toggle",
      });
      await deps.invoke("stop_dictation", {
        stopReason: decision.stopReason ?? "toggle",
        stopGestureEpochMs,
      });
      return;
    }

    if (decision.action === "cancel") {
      deps.log?.("dictation shortcut force_stop_dictation", {
        phase,
        behavior: input.behavior,
        capability: input.capability,
        stopReason: decision.stopReason ?? "cancelled",
      });
      await deps.invoke("force_stop_dictation", {});
    }
  };

  const onPhase = (phase: string): void => {
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
      liveShortcutStartGeneration = null;
      if (activeStartGeneration !== null) {
        invalidatedStartGenerations.add(activeStartGeneration);
        if (pendingHoldReleaseGeneration === activeStartGeneration) {
          pendingHoldReleaseGeneration = null;
          pendingHoldReleaseEpochMs = null;
        }
        if (pendingHandsFreeStopGeneration === activeStartGeneration) {
          pendingHandsFreeStopGeneration = null;
          pendingHandsFreeStopGestureEpochMs = null;
        }
        activeStartGeneration = null;
      }
    }
  };

  return {
    handleSignal,
    startHandsFree: (startOptions) =>
      handleSignal({
        behavior: "hands_free",
        capability: "press_only",
        signal: "pressed",
        startOptions,
      }),
    onPhase,
    dispose: () => {
      clearWatchdog();
      if (activeStartGeneration !== null) {
        invalidatedStartGenerations.add(activeStartGeneration);
        activeStartGeneration = null;
      }
      liveShortcutStartGeneration = null;
      pendingHoldReleaseGeneration = null;
      pendingHoldReleaseEpochMs = null;
      pendingHandsFreeStopGeneration = null;
      pendingHandsFreeStopGestureEpochMs = null;
    },
  };
}
