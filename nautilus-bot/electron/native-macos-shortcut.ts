import type { NativeHelperBindingEntry } from "./dictation-bindings";
import { ESCAPE_NATIVE_BINDING_ID } from "./dictation-bindings";

/**
 * One line of the native helper's stdout: a trigger transition for one entry
 * of the binding table it was handed (see
 * scripts/native-macos-shortcut-helper.swift). A bare Escape press arrives
 * with the reserved id `escape`.
 */
export type NativeShortcutRawEvent = {
  event: "down" | "up";
  bindingId: string;
};

type NativeShortcutSignal = "pressed" | "released" | "cancelled";

type NativeShortcutEvent = {
  signal: NativeShortcutSignal;
  bindingId: string;
};

export type NativeShortcutStatus = {
  available: boolean;
  reason: "unsupported_platform" | "helper_unavailable" | "shortcut_disabled" | null;
};

export type NativeShortcutController = {
  status: NativeShortcutStatus;
  dispose: () => void;
};

const MACOS_SYMBOL_SHORTCUT_TOKENS = /[⌘⌃⌥⇧]/g;

type RuntimePlatform =
  | "aix"
  | "android"
  | "darwin"
  | "freebsd"
  | "haiku"
  | "linux"
  | "openbsd"
  | "sunos"
  | "win32"
  | "cygwin"
  | "netbsd";

export function isNativeShortcutRawEvent(value: unknown): value is NativeShortcutRawEvent {
  if (!value || typeof value !== "object") {
    return false;
  }
  const event = value as Partial<NativeShortcutRawEvent>;
  return (
    (event.event === "down" || event.event === "up") &&
    typeof event.bindingId === "string" &&
    event.bindingId.length > 0
  );
}

export function normalizeNativeShortcutEvent(
  event: NativeShortcutRawEvent,
): NativeShortcutEvent {
  if (event.event === "down" && event.bindingId === ESCAPE_NATIVE_BINDING_ID) {
    return { signal: "cancelled", bindingId: event.bindingId };
  }

  return {
    signal: event.event === "up" ? "released" : "pressed",
    bindingId: event.bindingId,
  };
}

export function resolveNativeShortcutStatus(input: {
  platform: RuntimePlatform;
  helperReady: boolean;
}): NativeShortcutStatus {
  if (input.platform !== "darwin") {
    return { available: false, reason: "unsupported_platform" };
  }
  if (!input.helperReady) {
    return { available: false, reason: "helper_unavailable" };
  }
  return { available: true, reason: null };
}

/**
 * The helper takes its whole binding table as one JSON argument. Key
 * accelerators are normalized to the spelling its parser expects
 * (`Cmd+Shift+Space`) before they get here — see
 * `buildNativeHelperBindingTable`.
 */
export function buildNativeShortcutHelperArgs(table: NativeHelperBindingEntry[]): string[] {
  return ["--bindings", JSON.stringify(table)];
}

export function normalizeNativeShortcutHelperShortcut(shortcut: string): string {
  return shortcut
    .replace(MACOS_SYMBOL_SHORTCUT_TOKENS, " $& ")
    .split(/[+\s]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map(normalizeNativeShortcutHelperToken)
    .join("+");
}

function normalizeNativeShortcutHelperToken(token: string): string {
  const normalized = token.toLowerCase();
  switch (normalized) {
    case "⌘":
    case "cmd":
    case "command":
    case "meta":
    case "super":
      return "Cmd";
    case "⌃":
    case "ctrl":
    case "control":
      return "Ctrl";
    case "⌥":
    case "alt":
    case "option":
    case "opt":
      return "Alt";
    case "⇧":
    case "shift":
      return "Shift";
    case "fn":
    case "function":
      return "Fn";
    case "spacebar":
    case "space":
      return "Space";
    case "esc":
    case "escape":
      return "Escape";
    case "return":
    case "enter":
      return "Enter";
    case "arrowup":
    case "up":
      return "Up";
    case "arrowdown":
    case "down":
      return "Down";
    case "arrowleft":
    case "left":
      return "Left";
    case "arrowright":
    case "right":
      return "Right";
    default:
      if (token.length === 1) {
        return token.toUpperCase();
      }
      return token.charAt(0).toUpperCase() + token.slice(1);
  }
}

// ── Helper restart policy ──────────────────────────────────────────────────
//
// The helper takes its whole binding table on argv, so any change to the
// table means killing it and spawning a replacement. Every binding edit in
// Settings saves immediately, which meant a SIGTERM landed mid-keystroke: a
// hold-to-talk press already delivered as `down` never got its `up`, and the
// session ran on to the 10-minute watchdog. The two functions below are the
// policy, kept pure so it can be tested without a helper, a keyboard, or a
// real dictation.

/** Phases in which a session is live and its stop gesture may still arrive. */
const LIVE_DICTATION_PHASES: ReadonlySet<string> = new Set([
  "preparing",
  "primed",
  "recording",
]);

export type NativeHelperConfigDecision =
  | { action: "unchanged" }
  | { action: "apply" }
  | { action: "defer"; reason: "binding_held" | "dictation_active" };

/**
 * Whether a new helper binding table may be applied right now.
 *
 * Deferring is safe in a way restarting is not: the running helper keeps
 * delivering the *old* table, which is exactly the table the in-flight press
 * came from, so the release lands on the binding that started the session.
 * The caller re-runs this on the next idle.
 */
export function resolveNativeHelperConfigApplication(input: {
  desiredConfig: string;
  appliedConfig: string | null;
  helperAvailable: boolean;
  /** The last `dictation-state-changed` phase Electron saw. */
  dictationPhase: string;
  /** How many bindings the helper has reported down and not yet up. */
  bindingsDown: number;
}): NativeHelperConfigDecision {
  if (input.helperAvailable && input.appliedConfig === input.desiredConfig) {
    return { action: "unchanged" };
  }
  // A physically held key outranks the phase: the press may not have reached
  // a live phase yet (model still loading), and its release is still owed.
  if (input.bindingsDown > 0) {
    return { action: "defer", reason: "binding_held" };
  }
  if (LIVE_DICTATION_PHASES.has(input.dictationPhase)) {
    return { action: "defer", reason: "dictation_active" };
  }
  return { action: "apply" };
}

/**
 * The bindings the helper has reported down and not yet up, updated for one
 * event. Returns a new set rather than mutating, so the caller's value is
 * never half-updated if something throws downstream.
 *
 * Escape is excluded: the helper reports it as a bare `down` and it is the
 * cancel gesture, not a hold — there is no release to owe.
 */
export function trackNativeShortcutDownBindings(
  down: ReadonlySet<string>,
  event: NativeShortcutRawEvent,
): Set<string> {
  const next = new Set(down);
  if (event.bindingId === ESCAPE_NATIVE_BINDING_ID) {
    return next;
  }
  if (event.event === "down") {
    next.add(event.bindingId);
  } else {
    next.delete(event.bindingId);
  }
  return next;
}

/**
 * The `up` events a dying helper will never send. Fed back through the same
 * handler a real release takes, so a hold that was in progress when the
 * helper was replaced stops the session instead of running to the watchdog.
 */
export function synthesizeNativeShortcutRelease(
  down: ReadonlySet<string>,
): NativeShortcutRawEvent[] {
  return [...down].map((bindingId) => ({ event: "up" as const, bindingId }));
}
