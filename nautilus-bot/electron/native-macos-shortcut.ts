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
