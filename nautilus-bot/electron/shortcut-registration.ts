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

export function normalizeShortcutAccelerator(shortcut: string): string {
  return splitShortcutTokens(shortcut)
    .map((part) => normalizeAcceleratorToken(part, false) ?? part)
    .map((part) => part.toLowerCase())
    .join("+");
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
    default:
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

// Fields the app can bind to a keyboard shortcut. Order here has no
// semantic meaning on its own; precedence is expressed separately via
// SHORTCUT_FIELD_PRECEDENCE below.
export type ShortcutFieldKey =
  | "toggleDictation"
  | "toggleRecording"
  | "openWindow"
  | "quickExport"
  | "focusSearch";

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
// wins. Open window is the other field that is actually registered with
// Electron's globalShortcut today, so it comes next. toggleRecording is a
// pre-existing settings field that is not wired to any registration path
// (neither globalShortcut.register nor the native shortcut controller, which
// only wires toggleDictation) — it is ranked below the shortcuts that really
// register something so a collision never disables a working shortcut in
// favor of one that was never going to fire. quickExport/focusSearch are
// renderer-local shortcuts (not yet wired to globalShortcut) but are still
// included so users get a warning if they configure a clash before those are
// wired up.
export const SHORTCUT_FIELD_PRECEDENCE: Array<{ key: ShortcutFieldKey; label: string }> = [
  { key: "toggleDictation", label: "Dictation" },
  { key: "openWindow", label: "Open window" },
  { key: "toggleRecording", label: "Recording" },
  { key: "quickExport", label: "Quick export" },
  { key: "focusSearch", label: "Search" },
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
