type ShortcutRegistrationDefinition = {
  label: string;
  shortcut: string | null | undefined;
};

type ShortcutRegistrationConflict = {
  label: string;
  shortcut: string;
  conflictsWith: string;
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

export function partitionUniqueShortcutRegistrations<
  T extends ShortcutRegistrationDefinition,
>(
  definitions: T[],
): {
  unique: Array<ReadyShortcutRegistration<T>>;
  conflicts: ShortcutRegistrationConflict[];
} {
  const ownersByShortcut = new Map<string, ReadyShortcutRegistration<T>>();
  const unique: Array<ReadyShortcutRegistration<T>> = [];
  const conflicts: ShortcutRegistrationConflict[] = [];

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
