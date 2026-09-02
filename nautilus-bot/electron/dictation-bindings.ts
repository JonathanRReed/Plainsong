import {
  convertShortcutToAccelerator,
  normalizeShortcutAccelerator,
} from "./shortcut-registration";

/**
 * The dictation binding table (roadmap item B4): several triggers, each
 * routed to an action. Mirrors `DictationBinding` in
 * `rust-sidecar/src/settings.rs` and `src/types/settings.ts`.
 *
 * This module is pure so the policy (migration from the legacy
 * `toggleDictation` key, validation, routing, the mode cycle order) is
 * testable without Electron or a keyboard; `electron/main.ts` and the
 * Settings screen both consume it.
 */

export type DictationBindingMouseButton = 3 | 4 | 5;

export type DictationBindingTrigger =
  | { kind: "key"; accelerator: string }
  | { kind: "mouse"; button: DictationBindingMouseButton; modifiers?: string[] };

export type DictationBindingBehavior = "toggle" | "hold" | "inherit";

export type DictationBindingAction =
  | { kind: "dictation"; modeId: string | null; behavior: DictationBindingBehavior }
  | { kind: "cycleMode" }
  | { kind: "cancel" };

export type DictationBinding = {
  id: string;
  trigger: DictationBindingTrigger;
  action: DictationBindingAction;
};

/** Shape of `settings.shortcuts` this module needs; a subset of the real one. */
export type DictationBindingShortcutSettings = {
  toggleDictation?: string;
  dictationBindings?: DictationBinding[];
};

/** Id the sidecar's migration gives the binding built from `toggleDictation`. */
export const PRIMARY_DICTATION_BINDING_ID = "primary";

/**
 * Reserved binding id the native helper reports for a bare Escape press. It
 * is never in the table; Escape is always the cancel gesture.
 */
export const ESCAPE_NATIVE_BINDING_ID = "escape";

const DICTATION_BINDING_MOUSE_BUTTONS: readonly DictationBindingMouseButton[] = [3, 4, 5];

const MODIFIER_TOKENS = new Set(["command", "control", "alt", "shift", "fn"]);

/** Built-in mode presets in the order `cycleMode` walks them. */
export const DICTATION_MODE_CYCLE_ORDER = [
  "voice",
  "messages",
  "email",
  "notes",
  "meeting_follow_up",
] as const;

export type DictationBuiltinModePreset = (typeof DICTATION_MODE_CYCLE_ORDER)[number];

// Mirrors the labels the Dictation view and the popup use for the built-in
// modes (`DICTATION_MODE_DEFINITIONS` in src/lib/dictation-profiles.ts and
// `normalizePopupModeLabel` in dictation-popup.tsx).
const BUILTIN_MODE_LABELS: Record<DictationBuiltinModePreset, string> = {
  voice: "General",
  messages: "Slack & Chat",
  email: "Writing",
  notes: "Notes",
  meeting_follow_up: "Meeting Follow-up",
};

export type DictationBindingCustomMode = { id: string; name: string };

export type DictationModeSelection = {
  modePreset: string;
  selectedCustomModeId: string | null;
};

export type DictationModeOverride = {
  preset: string;
  customModeId: string | null;
  label: string;
};

function isBuiltinModePreset(value: string): value is DictationBuiltinModePreset {
  return (DICTATION_MODE_CYCLE_ORDER as readonly string[]).includes(value);
}

/**
 * The effective binding table for a settings snapshot. A snapshot written
 * before the table existed carries only `toggleDictation`; it becomes the
 * primary binding, exactly as the sidecar's `normalize_keyboard_shortcuts`
 * does on load, so Electron never registers nothing while the sidecar has
 * not rewritten the file yet.
 */
export function resolveDictationBindings(
  shortcuts: DictationBindingShortcutSettings | null | undefined,
): DictationBinding[] {
  const table = shortcuts?.dictationBindings;
  if (Array.isArray(table)) {
    const valid = table.filter(isDictationBinding);
    if (table.length > 0) {
      return valid;
    }
  }
  const legacy = shortcuts?.toggleDictation?.trim();
  if (!legacy) {
    return [];
  }
  return [
    {
      id: PRIMARY_DICTATION_BINDING_ID,
      trigger: { kind: "key", accelerator: legacy },
      action: { kind: "dictation", modeId: null, behavior: "inherit" },
    },
  ];
}

function isDictationBinding(value: unknown): value is DictationBinding {
  if (!value || typeof value !== "object") {
    return false;
  }
  const binding = value as Partial<DictationBinding>;
  if (typeof binding.id !== "string" || !binding.trigger || !binding.action) {
    return false;
  }
  const trigger = binding.trigger as Partial<DictationBindingTrigger>;
  const triggerOk =
    (trigger.kind === "key" && typeof (trigger as { accelerator?: unknown }).accelerator === "string") ||
    (trigger.kind === "mouse" &&
      (DICTATION_BINDING_MOUSE_BUTTONS as readonly number[]).includes(
        (trigger as { button?: unknown }).button as number,
      ));
  const action = binding.action as Partial<DictationBindingAction>;
  const actionOk =
    action.kind === "cycleMode" ||
    action.kind === "cancel" ||
    (action.kind === "dictation" &&
      ["toggle", "hold", "inherit"].includes(
        (action as { behavior?: unknown }).behavior as string,
      ));
  return triggerOk && actionOk;
}

/**
 * The primary binding: the key trigger that starts dictation in the current
 * mode, i.e. what the legacy `toggleDictation` field described. `null` when
 * the table has no such entry (the hotkey is switched off, or every key
 * binding names a specific mode).
 */
export function findPrimaryDictationBinding(
  bindings: DictationBinding[],
): DictationBinding | null {
  return (
    bindings.find(
      (binding) =>
        binding.trigger.kind === "key" &&
        binding.action.kind === "dictation" &&
        binding.action.modeId === null,
    ) ?? null
  );
}

/** Whether an accelerator names one modifier and nothing else ("Fn", "Cmd"). */
export function isLoneModifierAccelerator(accelerator: string): boolean {
  const tokens = accelerator
    .replace(/[⌘⌃⌥⇧]/g, " $& ")
    .split(/[+\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (tokens.length !== 1) {
    return false;
  }
  return MODIFIER_TOKENS.has(normalizeModifierToken(tokens[0]) ?? "");
}

function normalizeModifierToken(token: string): string | null {
  switch (token.toLowerCase()) {
    case "⌘":
    case "cmd":
    case "command":
    case "meta":
    case "super":
      return "command";
    case "⌃":
    case "ctrl":
    case "control":
      return "control";
    case "⌥":
    case "alt":
    case "option":
    case "opt":
      return "alt";
    case "⇧":
    case "shift":
      return "shift";
    case "fn":
    case "function":
      return "fn";
    default:
      return null;
  }
}

function displayModifier(token: string): string {
  switch (normalizeModifierToken(token)) {
    case "command":
      return "Cmd";
    case "control":
      return "Ctrl";
    case "alt":
      return "Alt";
    case "shift":
      return "Shift";
    case "fn":
      return "Fn";
    default:
      return token;
  }
}

/** Human-readable trigger, e.g. "Cmd+Shift+Space", "Cmd+Mouse 4", "Fn". */
export function describeDictationBindingTrigger(trigger: DictationBindingTrigger): string {
  if (trigger.kind === "key") {
    return trigger.accelerator
      .replace(/[⌘⌃⌥⇧]/g, " $& ")
      .split(/[+\s]+/)
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => (normalizeModifierToken(part) ? displayModifier(part) : part))
      .join("+");
  }
  const modifiers = (trigger.modifiers ?? []).map(displayModifier);
  return [...modifiers, `Mouse ${trigger.button}`].join("+");
}

/**
 * Canonical trigger identity for duplicate detection. Two key triggers with
 * the same modifiers in a different order collide, and so do two mouse
 * triggers on the same button with the same modifiers.
 */
export function dictationBindingTriggerKey(trigger: DictationBindingTrigger): string {
  if (trigger.kind === "key") {
    return `key:${normalizeShortcutAccelerator(trigger.accelerator)}`;
  }
  const modifiers = (trigger.modifiers ?? [])
    .map((modifier) => normalizeModifierToken(modifier))
    .filter((modifier): modifier is string => modifier !== null)
    .sort()
    .join("+");
  return `mouse:${modifiers}:${trigger.button}`;
}

/** Triggers only the native CGEventTap helper can deliver. */
export function isHelperOnlyTrigger(trigger: DictationBindingTrigger): boolean {
  return trigger.kind === "mouse" || isLoneModifierAccelerator(trigger.accelerator);
}

export type DictationBindingIssueCode =
  | "empty_trigger"
  | "bare_key"
  | "duplicate_trigger"
  | "needs_native_helper"
  | "unknown_mode"
  | "invalid_accelerator";

export type DictationBindingIssue = {
  bindingId: string;
  code: DictationBindingIssueCode;
  message: string;
};

/**
 * Per-binding problems the Settings screen shows in rust text and the
 * registration pass logs. A binding with an issue is left out of
 * registration (`registrableDictationBindings`), never registered half-way.
 * Mirrors the machine-independent half in the sidecar's
 * `validate_dictation_bindings`; the helper availability check lives only
 * here because only Electron knows whether the helper is running.
 */
export function validateDictationBindings(
  bindings: DictationBinding[],
  context: {
    nativeShortcutAvailable: boolean;
    customModes?: DictationBindingCustomMode[];
  },
): DictationBindingIssue[] {
  const issues: DictationBindingIssue[] = [];
  const owners = new Map<string, DictationBinding>();
  for (const binding of bindings) {
    if (binding.trigger.kind === "key") {
      const accelerator = binding.trigger.accelerator.trim();
      if (!accelerator) {
        issues.push({
          bindingId: binding.id,
          code: "empty_trigger",
          message: "No keys recorded yet.",
        });
        continue;
      }
      const lone = isLoneModifierAccelerator(accelerator);
      if (!lone) {
        const normalized = normalizeShortcutAccelerator(accelerator);
        const parts = normalized.split("+").filter(Boolean);
        const hasModifier = parts.some((part) => MODIFIER_TOKENS.has(part));
        const key = parts.find((part) => !MODIFIER_TOKENS.has(part)) ?? "";
        const isFunctionKey = /^f([1-9]|1[0-9]|2[0-4])$/.test(key);
        if (!hasModifier && !isFunctionKey) {
          issues.push({
            bindingId: binding.id,
            code: "bare_key",
            message: `${describeDictationBindingTrigger(binding.trigger)} would fire on ordinary typing. Add a modifier such as Cmd or Ctrl.`,
          });
          continue;
        }
        if (!convertShortcutToAccelerator(accelerator)) {
          issues.push({
            bindingId: binding.id,
            code: "invalid_accelerator",
            message: `${describeDictationBindingTrigger(binding.trigger)} is not a shortcut Plainsong can register.`,
          });
          continue;
        }
      }
    }
    if (isHelperOnlyTrigger(binding.trigger) && !context.nativeShortcutAvailable) {
      issues.push({
        bindingId: binding.id,
        code: "needs_native_helper",
        message:
          binding.trigger.kind === "mouse"
            ? "Mouse buttons need the native shortcut helper, which is not running. Grant Accessibility to Plainsong and try again."
            : "A modifier on its own needs the native shortcut helper, which is not running. Grant Accessibility to Plainsong and try again.",
      });
      continue;
    }
    const boundModeId = binding.action.kind === "dictation" ? binding.action.modeId : null;
    if (
      boundModeId !== null &&
      context.customModes &&
      !isBuiltinModePreset(boundModeId) &&
      !context.customModes.some((mode) => mode.id === boundModeId)
    ) {
      issues.push({
        bindingId: binding.id,
        code: "unknown_mode",
        message: "This binding points at a profile that no longer exists. Pick another action.",
      });
      continue;
    }
    const key = dictationBindingTriggerKey(binding.trigger);
    const owner = owners.get(key);
    if (owner) {
      issues.push({
        bindingId: binding.id,
        code: "duplicate_trigger",
        // Says what actually happens: the sidecar's
        // `drop_duplicate_dictation_bindings` removes this row on the next
        // save (it used to reject the whole settings payload instead). "Only
        // one of them will work" understated it -- the row does not survive.
        message: `Same trigger as ${describeDictationBindingAction(owner.action, context.customModes ?? [])} — this one is removed when settings save.`,
      });
      continue;
    }
    owners.set(key, binding);
  }
  return issues;
}

/** Bindings with no validation issue, in table order. */
export function registrableDictationBindings(
  bindings: DictationBinding[],
  context: { nativeShortcutAvailable: boolean; customModes?: DictationBindingCustomMode[] },
): DictationBinding[] {
  const blocked = new Set(
    validateDictationBindings(bindings, context).map((issue) => issue.bindingId),
  );
  return bindings.filter((binding) => !blocked.has(binding.id));
}

/**
 * The binding rows that can collide with an Electron `globalShortcut`
 * registration: every key trigger, named the way the Settings list names it.
 *
 * Mouse triggers are left out because nothing else in the app can bind a
 * mouse button, so they cannot collide with a shortcut field. Feed the result
 * to `findConflictingShortcuts` so a binding that takes Open window's keys is
 * reported in Settings instead of only failing `globalShortcut.register` with
 * a console error.
 */
export function dictationBindingConflictSources(
  bindings: DictationBinding[],
  customModes: DictationBindingCustomMode[] = [],
): Array<{ bindingId: string; label: string; accelerator: string }> {
  const sources: Array<{ bindingId: string; label: string; accelerator: string }> = [];
  for (const binding of bindings) {
    if (binding.trigger.kind !== "key") {
      continue;
    }
    const accelerator = binding.trigger.accelerator.trim();
    if (!accelerator) {
      continue;
    }
    sources.push({
      bindingId: binding.id,
      label: describeDictationBindingAction(binding.action, customModes),
      accelerator,
    });
  }
  return sources;
}

/** Short label for an action, for the Settings list and conflict copy. */
function describeDictationBindingAction(
  action: DictationBindingAction,
  customModes: DictationBindingCustomMode[],
): string {
  if (action.kind === "cycleMode") {
    return "Next mode";
  }
  if (action.kind === "cancel") {
    return "Cancel dictation";
  }
  if (action.modeId === null) {
    return "Dictation";
  }
  return `Dictation · ${dictationModeLabelFor(action.modeId, customModes)}`;
}

/**
 * The name a mode id resolves to: a built-in preset's label, or the saved
 * custom mode's name. Unknown ids read as "Unknown profile" rather than
 * throwing, because a binding can outlive the mode it pointed at.
 */
export function dictationModeLabelFor(
  modeId: string,
  customModes: DictationBindingCustomMode[],
): string {
  if (isBuiltinModePreset(modeId)) {
    return BUILTIN_MODE_LABELS[modeId];
  }
  return customModes.find((mode) => mode.id === modeId)?.name ?? "Unknown profile";
}

/**
 * What `start_dictation` should be told about the mode for a binding that
 * names one. `null` for "the current mode" and for a mode that no longer
 * exists (the sidecar then runs the selected mode, and the validator has
 * already flagged the binding).
 */
export function resolveDictationModeOverride(
  modeId: string | null,
  customModes: DictationBindingCustomMode[],
): DictationModeOverride | null {
  if (modeId === null) {
    return null;
  }
  if (isBuiltinModePreset(modeId)) {
    return { preset: modeId, customModeId: null, label: BUILTIN_MODE_LABELS[modeId] };
  }
  const custom = customModes.find((mode) => mode.id === modeId);
  if (!custom) {
    return null;
  }
  return { preset: "custom", customModeId: custom.id, label: custom.name };
}

/**
 * The next mode after the current selection: the built-in presets in
 * `DICTATION_MODE_CYCLE_ORDER`, then every saved custom mode in table order,
 * wrapping back to the first built-in. A selection that no longer resolves
 * (deleted custom mode, unknown preset) restarts at the first built-in mode.
 */
export function cycleDictationMode(
  current: DictationModeSelection,
  customModes: DictationBindingCustomMode[],
): DictationModeSelection & { label: string } {
  const order: Array<DictationModeSelection & { label: string }> = [
    ...DICTATION_MODE_CYCLE_ORDER.map((preset) => ({
      modePreset: preset,
      selectedCustomModeId: null,
      label: BUILTIN_MODE_LABELS[preset],
    })),
    ...customModes.map((mode) => ({
      modePreset: "custom",
      selectedCustomModeId: mode.id,
      label: mode.name,
    })),
  ];
  const currentIndex = order.findIndex((entry) =>
    current.modePreset === "custom"
      ? entry.modePreset === "custom" &&
        entry.selectedCustomModeId === current.selectedCustomModeId
      : entry.modePreset === current.modePreset,
  );
  return order[(currentIndex + 1) % order.length];
}

export type DictationBindingRoute =
  | { kind: "dictation"; signal: "pressed" | "released"; behavior: DictationBindingBehavior; modeId: string | null }
  | { kind: "cycleMode" }
  | { kind: "cancel" }
  | { kind: "ignore" };

/**
 * Which controller path a raw trigger transition takes. Only dictation
 * bindings care about releases (hold-to-talk); cycle and cancel act on the
 * press and ignore the release.
 */
export function routeDictationBindingEvent(input: {
  binding: DictationBinding;
  event: "down" | "up";
}): DictationBindingRoute {
  const { binding, event } = input;
  if (binding.action.kind === "dictation") {
    return {
      kind: "dictation",
      signal: event === "down" ? "pressed" : "released",
      behavior: binding.action.behavior,
      modeId: binding.action.modeId,
    };
  }
  if (event !== "down") {
    return { kind: "ignore" };
  }
  return binding.action.kind === "cycleMode" ? { kind: "cycleMode" } : { kind: "cancel" };
}

type DictationShortcutBehavior = "hold_to_talk" | "toggle" | "hands_free";

/**
 * The activation behavior one binding runs under: its own choice, or the
 * settings-wide activation mode when it inherits. Hands-free is a
 * settings-level state (the idle monitor starts sessions on speech), so a
 * binding cannot select it; "toggle" on a hands-free install still toggles.
 */
export function resolveDictationBindingBehavior(
  behavior: DictationBindingBehavior,
  settingsBehavior: DictationShortcutBehavior,
): DictationShortcutBehavior {
  if (behavior === "hold") {
    return "hold_to_talk";
  }
  if (behavior === "toggle") {
    return "toggle";
  }
  return settingsBehavior;
}

/** One entry of the table the native helper is handed on argv. */
export type NativeHelperBindingEntry =
  | { id: string; kind: "key"; accelerator: string }
  | { id: string; kind: "modifier"; modifier: string }
  | { id: string; kind: "mouse"; button: DictationBindingMouseButton; modifiers: string[] };

/**
 * The helper's view of the table: every binding it can watch for, with key
 * accelerators in the spelling its parser expects and lone modifiers called
 * out as their own kind (they are matched on `flagsChanged`, not key events).
 */
export function buildNativeHelperBindingTable(
  bindings: DictationBinding[],
  normalizeAccelerator: (accelerator: string) => string,
): NativeHelperBindingEntry[] {
  const entries: NativeHelperBindingEntry[] = [];
  for (const binding of bindings) {
    if (binding.trigger.kind === "mouse") {
      entries.push({
        id: binding.id,
        kind: "mouse",
        button: binding.trigger.button,
        modifiers: (binding.trigger.modifiers ?? []).map(displayModifier),
      });
      continue;
    }
    const accelerator = binding.trigger.accelerator.trim();
    if (!accelerator) {
      continue;
    }
    if (isLoneModifierAccelerator(accelerator)) {
      entries.push({ id: binding.id, kind: "modifier", modifier: displayModifier(accelerator) });
      continue;
    }
    entries.push({ id: binding.id, kind: "key", accelerator: normalizeAccelerator(accelerator) });
  }
  return entries;
}

/**
 * Key bindings Electron's `globalShortcut` can stand in for while the native
 * helper is unavailable (press-only, so hold degrades to toggle exactly as
 * before). Mouse buttons and lone modifiers have no Electron equivalent.
 */
export function electronFallbackDictationBindings(
  bindings: DictationBinding[],
): Array<{ binding: DictationBinding; accelerator: string }> {
  const result: Array<{ binding: DictationBinding; accelerator: string }> = [];
  for (const binding of bindings) {
    if (binding.trigger.kind !== "key" || isLoneModifierAccelerator(binding.trigger.accelerator)) {
      continue;
    }
    const accelerator = convertShortcutToAccelerator(binding.trigger.accelerator);
    if (accelerator) {
      result.push({ binding, accelerator });
    }
  }
  return result;
}
