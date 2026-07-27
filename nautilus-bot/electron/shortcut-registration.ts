type ShortcutRegistrationDefinition = {
  label: string;
  shortcut: string | null | undefined;
};

type ShortcutRegistrationConflict<T extends ShortcutRegistrationDefinition> = {
  label: string;
  shortcut: string;
  conflictsWith: string;
  definition: T;
  conflictsWithDefinition: ReadyShortcutRegistration<T>;
};

type ReadyShortcutRegistration<T extends ShortcutRegistrationDefinition> = Omit<
  T,
  "shortcut"
> & {
  shortcut: string;
};

const MACOS_SYMBOL_SHORTCUT_TOKENS = /[⌘⌃⌥⇧]/g;
const MAX_ACCELERATOR_TOKEN_COUNT = 5;

function splitShortcutTokens(shortcut: string): string[] {
  return shortcut
    .replace(MACOS_SYMBOL_SHORTCUT_TOKENS, " $& ")
    .split(/[+\s]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

// Canonical modifier order for conflict comparison. Equivalent chords written
// with a different modifier order (e.g. "Ctrl+Alt+D" vs "Alt+Ctrl+D") must
// normalize to the same string, otherwise both get passed to
// globalShortcut.register and the second silently fails.
const NORMALIZED_MODIFIER_ORDER = ["control", "alt", "command", "shift", "fn"];

export function normalizeShortcutAccelerator(shortcut: string): string {
  const tokens = splitShortcutTokens(shortcut)
    .map((part) => normalizeAcceleratorToken(part, false) ?? part)
    .map((part) => part.toLowerCase());
  const modifiers = NORMALIZED_MODIFIER_ORDER.filter((modifier) =>
    tokens.includes(modifier),
  );
  const keys = tokens.filter(
    (token) => !NORMALIZED_MODIFIER_ORDER.includes(token),
  );
  return [...modifiers, ...keys].join("+");
}

export function convertShortcutToAccelerator(
  shortcut: string | undefined,
): string | null {
  const value = shortcut?.trim();
  if (!value) {
    return null;
  }

  const tokens = splitShortcutTokens(value);
  if (tokens.length === 0) {
    return null;
  }

  if (tokens.length > MAX_ACCELERATOR_TOKEN_COUNT) {
    console.error("[shortcuts] shortcut too long, rejecting:", value);
    return null;
  }

  const mapped = tokens.map((token) => normalizeAcceleratorToken(token, true));
  if (mapped.includes(null)) {
    return null;
  }

  return mapped.join("+");
}

function normalizeAcceleratorToken(
  token: string,
  logInvalid: boolean,
): string | null {
  switch (token.toLowerCase()) {
    case "⌘":
    case "cmd":
    case "command":
    case "meta":
    case "super":
      return "Command";
    case "⌃":
    case "ctrl":
    case "control":
      return "Control";
    case "⌥":
    case "alt":
    case "option":
    case "opt":
      return "Alt";
    case "⇧":
    case "shift":
      return "Shift";
    case "space":
    case "spacebar":
      return "Space";
    case "esc":
    case "escape":
      return "Escape";
    case "enter":
    case "return":
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
    case "backspace":
      return "Backspace";
    case "delete":
    case "del":
      return "Delete";
    case "home":
      return "Home";
    case "end":
      return "End";
    case "pageup":
      return "PageUp";
    case "pagedown":
      return "PageDown";
    case "tab":
      return "Tab";
    case "insert":
      return "Insert";
    case "plus":
      return "Plus";
    default: {
      // F1-F24 are valid Electron accelerator key codes (and the capture UI
      // plus the Swift helper both accept F-keys).
      const functionKey = /^f([1-9]|1[0-9]|2[0-4])$/.exec(token.toLowerCase());
      if (functionKey) {
        return `F${functionKey[1]}`;
      }
      if (token.length === 1) {
        const char = token.toUpperCase();
        if (char >= "!" && char <= "~") {
          return char;
        }
      }
      if (logInvalid) {
        console.error("[shortcuts] invalid token in shortcut:", token);
      }
      return null;
    }
  }
}

// Fields the app can bind to a keyboard shortcut. Order here has no
// semantic meaning on its own; precedence is expressed separately via
// SHORTCUT_FIELD_PRECEDENCE below.
export type ShortcutFieldKey =
  | "toggleDictation"
  | "openWindow"
  | "repasteLastDictation"
  | "recopyLastDictation";

export type ShortcutFieldSettings = Partial<Record<ShortcutFieldKey, string | undefined>>;

export type ShortcutConflictInfo = {
  field: ShortcutFieldKey;
  label: string;
  shortcut: string;
  conflictsWith: string;
  conflictsWithField: ShortcutFieldKey;
};

// Precedence when two configured shortcuts normalize to the same accelerator:
// whichever field is listed first here "wins" and keeps the OS-level
// registration; later fields are skipped. Dictation is the app's primary
// interaction (per the OSS "Cursor Tab of voice" positioning) so it always
// wins. Open window, then the two dictation recovery bindings (re-paste and
// re-copy the last result), are the other fields registered with Electron's
// globalShortcut today, so they come next.
export const SHORTCUT_FIELD_PRECEDENCE: Array<{ key: ShortcutFieldKey; label: string }> = [
  { key: "toggleDictation", label: "Dictation" },
  { key: "openWindow", label: "Open window" },
  { key: "repasteLastDictation", label: "Paste last result" },
  { key: "recopyLastDictation", label: "Copy last result" },
];

export function findConflictingShortcuts(
  shortcuts: ShortcutFieldSettings,
): ShortcutConflictInfo[] {
  const definitions = SHORTCUT_FIELD_PRECEDENCE.map(({ key, label }) => ({
    field: key,
    label,
    shortcut: shortcuts[key],
  }));

  const { conflicts } = partitionUniqueShortcutRegistrations(definitions);

  return conflicts.map((conflict) => ({
    field: conflict.definition.field,
    label: conflict.label,
    shortcut: conflict.shortcut,
    conflictsWith: conflict.conflictsWith,
    conflictsWithField: conflict.conflictsWithDefinition.field,
  }));
}

export function partitionUniqueShortcutRegistrations<
  T extends ShortcutRegistrationDefinition,
>(
  definitions: T[],
): {
  unique: Array<ReadyShortcutRegistration<T>>;
  conflicts: Array<ShortcutRegistrationConflict<T>>;
} {
  const ownersByShortcut = new Map<string, ReadyShortcutRegistration<T>>();
  const unique: Array<ReadyShortcutRegistration<T>> = [];
  const conflicts: Array<ShortcutRegistrationConflict<T>> = [];

  for (const definition of definitions) {
    if (!definition.shortcut) {
      continue;
    }

    const normalizedShortcut = normalizeShortcutAccelerator(
      definition.shortcut,
    );
    if (!normalizedShortcut) {
      continue;
    }

    const existing = ownersByShortcut.get(normalizedShortcut);
    if (existing) {
      conflicts.push({
        label: definition.label,
        shortcut: definition.shortcut,
        conflictsWith: existing.label,
        definition,
        conflictsWithDefinition: existing,
      });
      continue;
    }

    const readyDefinition = {
      ...definition,
      shortcut: definition.shortcut,
    } as ReadyShortcutRegistration<T>;
    ownersByShortcut.set(normalizedShortcut, readyDefinition);
    unique.push(readyDefinition);
  }

  return { unique, conflicts };
}
