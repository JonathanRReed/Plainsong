import type { KeyboardShortcuts } from "@/types/settings";

export type DictationShortcutMode = "hold_to_talk" | "toggle" | "hands_free";

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

// Common system shortcuts that should be avoided
const SYSTEM_SHORTCUTS = new Set([
  "Ctrl+C", "Cmd+C", // Copy
  "Ctrl+V", "Cmd+V", // Paste
  "Ctrl+X", "Cmd+X", // Cut
  "Ctrl+Z", "Cmd+Z", // Undo
  "Ctrl+Y", "Cmd+Y", // Redo
  "Ctrl+A", "Cmd+A", // Select All
  "Ctrl+S", "Cmd+S", // Save
  "Ctrl+P", "Cmd+P", // Print
  "Ctrl+F", "Cmd+F", // Find
  "Ctrl+N", "Cmd+N", // New
  "Ctrl+W", "Cmd+W", // Close
  "Ctrl+Q", "Cmd+Q", // Quit
  "Ctrl+T", "Cmd+T", // New Tab
  "Ctrl+Tab", "Cmd+Tab", // Switch Tab
  "Alt+Tab", // Switch Window
  "Ctrl+Alt+Delete", // Task Manager
  "Cmd+Space", // Spotlight
  "Ctrl+Space", // Input Method
]);

export function isSystemShortcut(shortcut: string): boolean {
  const normalized = normalizeShortcut(shortcut).replace(/\s+/g, "");
  return SYSTEM_SHORTCUTS.has(normalized);
}

export function hasShortcutConflict(
  shortcut: string,
  existingShortcuts: KeyboardShortcuts,
  excludeKey?: keyof KeyboardShortcuts,
): { hasConflict: boolean; conflictWith?: string } {
  const normalized = normalizeShortcut(shortcut).replace(/\s+/g, "");

  // Check against existing shortcuts
  for (const [key, value] of Object.entries(existingShortcuts)) {
    if (key === excludeKey) continue;
    if (!value) continue;

    const existingNormalized = normalizeShortcut(value).replace(/\s+/g, "");
    if (existingNormalized === normalized) {
      return { hasConflict: true, conflictWith: key };
    }
  }

  return { hasConflict: false };
}
