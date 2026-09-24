type DictationShortcutMode = "hold_to_talk" | "toggle" | "hands_free";

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad/.test(navigator.platform);
}

export function defaultDictationShortcut(isMac = isMacPlatform()): string {
  return isMac ? "Cmd+Shift+Space" : "Ctrl+Shift+Space";
}

/** macOS modifier glyphs, as the nav shortcuts and the system menus show them. */
const MAC_GLYPHS: Record<string, string> = {
  Cmd: "⌘",
  Alt: "⌥",
  Ctrl: "⌃",
  Shift: "⇧",
  Fn: "fn",
};

/**
 * Split a shortcut into its parts. Accepts the stored accelerator form
 * ("Alt+Space") and both display forms ("Alt + Space", "⌥ Space"), because
 * callers sometimes hand an already formatted label back in.
 */
function shortcutParts(shortcut: string): string[] {
  return shortcut
    .replace(/[⌘⌥⌃⇧]/g, (glyph) => `+${glyph}+`)
    .split(/\s*\+\s*|\s+/)
    .filter(Boolean);
}

export function normalizeShortcut(shortcut: string): string {
  return shortcutParts(shortcut)
    .map((part) => {
      const token = part.toLowerCase();
      if (["cmd", "command", "meta", "super", "⌘"].includes(token)) return "Cmd";
      if (["ctrl", "control", "⌃"].includes(token)) return "Ctrl";
      if (["alt", "option", "⌥"].includes(token)) return "Alt";
      if (["shift", "⇧"].includes(token)) return "Shift";
      if (token === "spacebar") return "Space";
      if (token.length === 1) return token.toUpperCase();
      return token.charAt(0).toUpperCase() + token.slice(1);
    })
    .join("+");
}

/**
 * A shortcut as the reader sees it: "⌥ Space" or "⌘ ⇧ Space" on macOS, the
 * same glyphs the nav shortcuts use, and "Ctrl + Shift + Space" elsewhere.
 */
export function formatShortcutForDisplay(shortcut: string, isMac = isMacPlatform()): string {
  const parts = normalizeShortcut(shortcut).split("+").filter(Boolean);
  if (!isMac) {
    return parts.join(" + ");
  }
  return parts.map((part) => MAC_GLYPHS[part] ?? part).join(" ");
}

export function dictationInstruction(shortcut: string, mode: DictationShortcutMode): string {
  const label = formatShortcutForDisplay(shortcut);
  if (mode === "hold_to_talk") {
    return `Hold ${label} to record, release to transcribe and paste.`;
  }
  if (mode === "hands_free") {
    return `Press ${label} to start hands-free dictation. It stops after silence or when you press again.`;
  }
  return `Press ${label} to start dictation, press again to transcribe and paste.`;
}

export function matchesShortcut(event: KeyboardEvent, shortcut: string): boolean {
  const normalized = normalizeShortcut(shortcut).replace(/\s+/g, "");
  const parts = normalized.split("+").filter(Boolean);
  if (parts.length < 2) {
    return false;
  }

  const key = parts[parts.length - 1].toLowerCase();
  const modifiers = new Set(parts.slice(0, -1).map((part) => part.toLowerCase()));

  const expectedMeta = modifiers.has("cmd") || modifiers.has("meta") || modifiers.has("super");
  const expectedCtrl = modifiers.has("ctrl") || modifiers.has("control");
  const expectedAlt = modifiers.has("alt") || modifiers.has("option");
  const expectedShift = modifiers.has("shift");

  if (event.metaKey !== expectedMeta) return false;
  if (event.ctrlKey !== expectedCtrl) return false;
  if (event.altKey !== expectedAlt) return false;
  if (event.shiftKey !== expectedShift) return false;

  if (key === "space") {
    return event.code === "Space";
  }

  const eventKey = event.key.length === 1 ? event.key.toLowerCase() : event.key.toLowerCase();
  return eventKey === key;
}
