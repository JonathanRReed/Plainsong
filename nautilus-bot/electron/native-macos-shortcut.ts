export type NativeShortcutRawEvent = {
  type: "down" | "up";
  key: string;
};

type NativeShortcutSignal = "pressed" | "released" | "cancelled";

type NativeShortcutEvent = {
  signal: NativeShortcutSignal;
  key: string;
};

export type NativeShortcutStatus = {
  available: boolean;
  reason: "unsupported_platform" | "helper_unavailable" | "shortcut_disabled" | null;
};

export type NativeShortcutController = {
  status: NativeShortcutStatus;
  dispose: () => void;
};

// Matches the product default the sidecar's normalize_keyboard_shortcuts
// applies (Cmd+Shift+Space on macOS). Used only when settings carry no
// dictation shortcut at all; an explicitly cleared ("") shortcut disables the
// helper instead of silently falling back to this.
export const DEFAULT_NATIVE_MACOS_DICTATION_SHORTCUT = "Cmd+Shift+Space";

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
    (event.type === "down" || event.type === "up") &&
    typeof event.key === "string" &&
    event.key.length > 0
  );
}

export function normalizeNativeShortcutEvent(
  event: NativeShortcutRawEvent,
): NativeShortcutEvent {
  if (event.type === "down" && event.key === "Escape") {
    return { signal: "cancelled", key: event.key };
  }

  return {
    signal: event.type === "up" ? "released" : "pressed",
    key: event.key,
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

export function buildNativeShortcutHelperArgs(shortcut: string): string[] {
  return ["--shortcut", normalizeNativeShortcutHelperShortcut(shortcut)];
}

export function resolveNativeShortcutHelperShortcut(shortcut?: string | null): string {
  return normalizeNativeShortcutHelperShortcut(
    shortcut?.trim() || DEFAULT_NATIVE_MACOS_DICTATION_SHORTCUT,
  );
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
