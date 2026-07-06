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
