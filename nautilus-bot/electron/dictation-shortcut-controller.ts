type DictationShortcutBehavior = "hold_to_talk" | "toggle" | "hands_free";
type DictationShortcutSignal =
  | "pressed"
  | "released"
  | "cancelled"
  | "emergency_stop"
  | "watchdog_timeout";
type DictationShortcutCapability = "press_only" | "press_and_release";
type DictationShortcutSource = "electron" | "native";
type DictationShortcutPhase =
  | "idle"
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
    return phase === "recording"
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

type DictationShortcutSignalInput = {
  behavior: DictationShortcutBehavior;
  capability: DictationShortcutCapability;
  signal: DictationShortcutSignal;
};

export type DictationShortcutSignalRuntime = {
  handleSignal: (input: DictationShortcutSignalInput) => Promise<void>;
  dispose: () => void;
};

/**
 * Stateful wrapper around resolveDictationShortcutDecision that closes two
 * hold-to-talk gaps the pure decision table cannot see:
 *
 * - A rapid press/release taps out before the sidecar reports
 *   phase "recording", so the release resolves to "ignore" and the microphone
 *   would stay live forever. The runtime remembers the release while a start
 *   is in flight and issues the stop as soon as the start resolves.
 * - A release that never arrives at all (helper respawned mid-hold, event tap
 *   outage) is bounded by a watchdog that emits the already-typed
 *   "watchdog_timeout" signal after DICTATION_HOLD_WATCHDOG_MS.
 */
export function createDictationShortcutSignalRuntime(deps: {
  getPhase: () => DictationShortcutPhase;
  invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>;
  log?: (message: string, payload?: unknown) => void;
  holdWatchdogMs?: number;
}): DictationShortcutSignalRuntime {
  const holdWatchdogMs = deps.holdWatchdogMs ?? DICTATION_HOLD_WATCHDOG_MS;
  let startInFlight = false;
  let pendingHoldRelease = false;
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
    const phase = deps.getPhase();
    const decision = resolveDictationShortcutDecision({ phase, ...input });
    const holdToTalkWithRelease =
      input.behavior === "hold_to_talk" && input.capability === "press_and_release";

    if (decision.action === "ignore") {
      // Rapid tap: the release arrived while start_dictation was still in
      // flight (phase not yet "recording"). Remember it so the session is
      // stopped the moment the start resolves.
      if (input.signal === "released" && holdToTalkWithRelease && startInFlight) {
        pendingHoldRelease = true;
      } else if (input.signal === "released" || input.signal === "cancelled") {
        // The hold ended but the session it was guarding is already gone
        // (VAD auto-stop, overlay stop button, error phase). Drop the stale
        // watchdog so it cannot stop a later unrelated dictation session.
        clearWatchdog();
      }
      return;
    }

    if (decision.action === "start") {
      deps.log?.("dictation shortcut start_dictation", {
        phase,
        behavior: input.behavior,
        capability: input.capability,
      });
      startInFlight = true;
      pendingHoldRelease = false;
      let started = false;
      try {
        await deps.invoke("start_dictation", {});
        started = true;
      } finally {
        startInFlight = false;
        if (!started) {
          pendingHoldRelease = false;
        }
      }
      if (holdToTalkWithRelease && pendingHoldRelease) {
        pendingHoldRelease = false;
        deps.log?.("dictation shortcut stop_dictation", {
          phase: deps.getPhase(),
          behavior: input.behavior,
          capability: input.capability,
          stopReason: "release",
        });
        await deps.invoke("stop_dictation", { stopReason: "release" });
        return;
      }
      if (holdToTalkWithRelease) {
        armWatchdog(input);
      }
      return;
    }

    clearWatchdog();

    if (decision.action === "stop") {
      deps.log?.("dictation shortcut stop_dictation", {
        phase,
        behavior: input.behavior,
        capability: input.capability,
        stopReason: decision.stopReason ?? "toggle",
      });
      await deps.invoke("stop_dictation", {
        stopReason: decision.stopReason ?? "toggle",
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

  return {
    handleSignal,
    dispose: clearWatchdog,
  };
}
