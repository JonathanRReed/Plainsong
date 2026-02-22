export type DictationShortcutMode = "hold_to_talk" | "toggle";

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad/.test(navigator.platform);
}

export function defaultDictationShortcut(isMac = isMacPlatform()): string {
  return isMac ? "Cmd+Shift+Space" : "Ctrl+Shift+Space";
}

export function normalizeShortcut(shortcut: string): string {
  return shortcut
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const token = part.toLowerCase();
      if (["cmd", "command", "meta", "super"].includes(token)) return "Cmd";
      if (["ctrl", "control"].includes(token)) return "Ctrl";
      if (["alt", "option"].includes(token)) return "Alt";
      if (token === "shift") return "Shift";
      if (token === "spacebar") return "Space";
      if (token.length === 1) return token.toUpperCase();
      return token.charAt(0).toUpperCase() + token.slice(1);
    })
    .join("+");
}

export function formatShortcutForDisplay(shortcut: string): string {
  const normalized = normalizeShortcut(shortcut);
  return normalized
    .split("+")
    .filter(Boolean)
    .join(" + ");
}

export function dictationInstruction(shortcut: string, mode: DictationShortcutMode): string {
  const label = formatShortcutForDisplay(shortcut);
  if (mode === "hold_to_talk") {
    return `Hold ${label} to record, release to transcribe and paste.`;
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
