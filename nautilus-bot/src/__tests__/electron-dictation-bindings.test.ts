import { describe, expect, it } from "vitest";
import {
  buildNativeHelperBindingTable,
  cycleDictationMode,
  describeDictationBindingTrigger,
  dictationBindingTriggerKey,
  electronFallbackDictationBindings,
  findPrimaryDictationBinding,
  isHelperOnlyTrigger,
  isLoneModifierAccelerator,
  PRIMARY_DICTATION_BINDING_ID,
  registrableDictationBindings,
  resolveDictationBindingBehavior,
  resolveDictationBindings,
  resolveDictationModeOverride,
  routeDictationBindingEvent,
  validateDictationBindings,
  type DictationBinding,
} from "../../electron/dictation-bindings";
import { normalizeNativeShortcutHelperShortcut } from "../../electron/native-macos-shortcut";

function keyBinding(
  id: string,
  accelerator: string,
  action: DictationBinding["action"] = { kind: "dictation", modeId: null, behavior: "inherit" },
): DictationBinding {
  return { id, trigger: { kind: "key", accelerator }, action };
}

const CUSTOM_MODES = [
  { id: "custom-slack", name: "Slack Replies" },
  { id: "custom-notes", name: "Standup Notes" },
];

describe("resolveDictationBindings (migration)", () => {
  it("builds the primary binding from a settings file that only has toggleDictation", () => {
    expect(resolveDictationBindings({ toggleDictation: "Ctrl+Alt+D" })).toEqual([
      {
        id: PRIMARY_DICTATION_BINDING_ID,
        trigger: { kind: "key", accelerator: "Ctrl+Alt+D" },
        action: { kind: "dictation", modeId: null, behavior: "inherit" },
      },
    ]);
  });

  it("returns nothing when the legacy key was cleared and no table exists", () => {
    expect(resolveDictationBindings({ toggleDictation: "" })).toEqual([]);
    expect(resolveDictationBindings(undefined)).toEqual([]);
  });

  it("prefers the table over the legacy key and drops malformed rows", () => {
    const table = [
      keyBinding("email", "Cmd+Alt+E", { kind: "dictation", modeId: "email", behavior: "toggle" }),
      { id: "broken", trigger: { kind: "touchbar" }, action: { kind: "dictation" } },
    ] as unknown as DictationBinding[];
    expect(
      resolveDictationBindings({ toggleDictation: "Cmd+Shift+Space", dictationBindings: table }),
    ).toEqual([table[0]]);
  });

  it("finds the primary binding by shape, not by id", () => {
    const table = [
      keyBinding("email", "Cmd+Alt+E", { kind: "dictation", modeId: "email", behavior: "toggle" }),
      keyBinding("anything", "Ctrl+Alt+D"),
    ];
    expect(findPrimaryDictationBinding(table)?.id).toBe("anything");
    expect(findPrimaryDictationBinding([table[0]])).toBeNull();
  });
});

describe("validateDictationBindings", () => {
  it("flags two bindings on the same trigger, keeping the first", () => {
    const issues = validateDictationBindings(
      [
        keyBinding("a", "Cmd+Shift+Space"),
        keyBinding("b", "shift cmd space", { kind: "cycleMode" }),
        {
          id: "m1",
          trigger: { kind: "mouse", button: 4, modifiers: ["Cmd"] },
          action: { kind: "cancel" },
        },
        {
          id: "m2",
          trigger: { kind: "mouse", button: 4, modifiers: ["command"] },
          action: { kind: "cycleMode" },
        },
      ],
      { nativeShortcutAvailable: true },
    );
    expect(issues.map((issue) => [issue.bindingId, issue.code])).toEqual([
      ["b", "duplicate_trigger"],
      ["m2", "duplicate_trigger"],
    ]);
    expect(issues[0].message).toMatch(/Same trigger as Dictation/);
  });

  it("refuses a bare letter but allows function keys and lone modifiers", () => {
    const issues = validateDictationBindings(
      [keyBinding("bare", "D"), keyBinding("fkey", "F5"), keyBinding("fn", "Fn")],
      { nativeShortcutAvailable: true },
    );
    expect(issues).toEqual([
      expect.objectContaining({ bindingId: "bare", code: "bare_key" }),
    ]);
  });

  it("marks mouse buttons and lone modifiers as needing the native helper when it is down", () => {
    const issues = validateDictationBindings(
      [
        keyBinding("fn", "Fn"),
        {
          id: "back",
          trigger: { kind: "mouse", button: 4 },
          action: { kind: "dictation", modeId: null, behavior: "hold" },
        },
        keyBinding("primary", "Cmd+Shift+Space"),
      ],
      { nativeShortcutAvailable: false },
    );
    expect(issues.map((issue) => [issue.bindingId, issue.code])).toEqual([
      ["fn", "needs_native_helper"],
      ["back", "needs_native_helper"],
    ]);
    expect(
      registrableDictationBindings(
        [keyBinding("fn", "Fn"), keyBinding("primary", "Cmd+Shift+Space")],
        { nativeShortcutAvailable: false },
      ).map((binding) => binding.id),
    ).toEqual(["primary"]);
  });

  it("flags a binding pointing at a profile that no longer exists", () => {
    const issues = validateDictationBindings(
      [
        keyBinding("gone", "Cmd+Alt+1", {
          kind: "dictation",
          modeId: "custom-deleted",
          behavior: "inherit",
        }),
        keyBinding("ok", "Cmd+Alt+2", {
          kind: "dictation",
          modeId: "custom-slack",
          behavior: "inherit",
        }),
        keyBinding("builtin", "Cmd+Alt+3", {
          kind: "dictation",
          modeId: "email",
          behavior: "inherit",
        }),
      ],
      { nativeShortcutAvailable: true, customModes: CUSTOM_MODES },
    );
    expect(issues).toEqual([expect.objectContaining({ bindingId: "gone", code: "unknown_mode" })]);
  });

  it("reports an empty recorder", () => {
    expect(
      validateDictationBindings([keyBinding("new", "  ")], { nativeShortcutAvailable: true }),
    ).toEqual([expect.objectContaining({ bindingId: "new", code: "empty_trigger" })]);
  });
});

describe("trigger helpers", () => {
  it("describes and canonicalizes triggers", () => {
    expect(describeDictationBindingTrigger({ kind: "key", accelerator: "⌘⇧space" })).toBe(
      "Cmd+Shift+space",
    );
    expect(
      describeDictationBindingTrigger({ kind: "mouse", button: 5, modifiers: ["control"] }),
    ).toBe("Ctrl+Mouse 5");
    expect(dictationBindingTriggerKey({ kind: "key", accelerator: "Shift+Cmd+Space" })).toBe(
      dictationBindingTriggerKey({ kind: "key", accelerator: "cmd shift space" }),
    );
    expect(isLoneModifierAccelerator("Fn")).toBe(true);
    expect(isLoneModifierAccelerator("Cmd+Fn")).toBe(false);
    expect(isLoneModifierAccelerator("F5")).toBe(false);
    expect(isHelperOnlyTrigger({ kind: "mouse", button: 3 })).toBe(true);
    expect(isHelperOnlyTrigger({ kind: "key", accelerator: "Cmd" })).toBe(true);
    expect(isHelperOnlyTrigger({ kind: "key", accelerator: "Cmd+Shift+Space" })).toBe(false);
  });

  it("builds the helper table with lone modifiers called out and the Electron fallback without them", () => {
    const table = [
      keyBinding("primary", "control option command d"),
      keyBinding("fn", "Fn"),
      {
        id: "back",
        trigger: { kind: "mouse", button: 4, modifiers: ["cmd"] },
        action: { kind: "cycleMode" },
      } as DictationBinding,
    ];
    expect(buildNativeHelperBindingTable(table, normalizeNativeShortcutHelperShortcut)).toEqual([
      { id: "primary", kind: "key", accelerator: "Ctrl+Alt+Cmd+D" },
      { id: "fn", kind: "modifier", modifier: "Fn" },
      { id: "back", kind: "mouse", button: 4, modifiers: ["Cmd"] },
    ]);
    expect(electronFallbackDictationBindings(table)).toEqual([
      { binding: table[0], accelerator: "Control+Alt+Command+D" },
    ]);
  });
});

describe("routeDictationBindingEvent", () => {
  it("maps dictation bindings to press/release and the rest to press-only actions", () => {
    const hold = keyBinding("h", "Cmd+Shift+Space", {
      kind: "dictation",
      modeId: "email",
      behavior: "hold",
    });
    expect(routeDictationBindingEvent({ binding: hold, event: "down" })).toEqual({
      kind: "dictation",
      signal: "pressed",
      behavior: "hold",
      modeId: "email",
    });
    expect(routeDictationBindingEvent({ binding: hold, event: "up" })).toEqual({
      kind: "dictation",
      signal: "released",
      behavior: "hold",
      modeId: "email",
    });
    const cycle = keyBinding("c", "Cmd+Alt+M", { kind: "cycleMode" });
    expect(routeDictationBindingEvent({ binding: cycle, event: "down" })).toEqual({
      kind: "cycleMode",
    });
    expect(routeDictationBindingEvent({ binding: cycle, event: "up" })).toEqual({ kind: "ignore" });
    const cancel = keyBinding("x", "Cmd+Alt+X", { kind: "cancel" });
    expect(routeDictationBindingEvent({ binding: cancel, event: "down" })).toEqual({
      kind: "cancel",
    });
  });

  it("resolves the binding behavior against the activation setting", () => {
    expect(resolveDictationBindingBehavior("inherit", "hands_free")).toBe("hands_free");
    expect(resolveDictationBindingBehavior("inherit", "hold_to_talk")).toBe("hold_to_talk");
    expect(resolveDictationBindingBehavior("toggle", "hold_to_talk")).toBe("toggle");
    expect(resolveDictationBindingBehavior("hold", "toggle")).toBe("hold_to_talk");
  });

  it("resolves a per-mode override for built-in and custom modes", () => {
    expect(resolveDictationModeOverride(null, CUSTOM_MODES)).toBeNull();
    expect(resolveDictationModeOverride("email", CUSTOM_MODES)).toEqual({
      preset: "email",
      customModeId: null,
      label: "Writing",
    });
    expect(resolveDictationModeOverride("custom-notes", CUSTOM_MODES)).toEqual({
      preset: "custom",
      customModeId: "custom-notes",
      label: "Standup Notes",
    });
    expect(resolveDictationModeOverride("custom-deleted", CUSTOM_MODES)).toBeNull();
  });
});

describe("cycleDictationMode", () => {
  it("walks the built-in modes then the saved profiles and wraps around", () => {
    const seen: string[] = [];
    let current = { modePreset: "voice", selectedCustomModeId: null as string | null };
    for (let i = 0; i < 7; i += 1) {
      const next = cycleDictationMode(current, CUSTOM_MODES);
      seen.push(next.label);
      current = { modePreset: next.modePreset, selectedCustomModeId: next.selectedCustomModeId };
    }
    expect(seen).toEqual([
      "Slack & Chat",
      "Writing",
      "Notes",
      "Meeting Follow-up",
      "Slack Replies",
      "Standup Notes",
      "General",
    ]);
  });

  it("restarts at the first built-in mode when the current selection no longer exists", () => {
    expect(
      cycleDictationMode({ modePreset: "custom", selectedCustomModeId: "custom-deleted" }, CUSTOM_MODES),
    ).toEqual({ modePreset: "voice", selectedCustomModeId: null, label: "General" });
    expect(cycleDictationMode({ modePreset: "meeting_follow_up", selectedCustomModeId: null }, [])).toEqual({
      modePreset: "voice",
      selectedCustomModeId: null,
      label: "General",
    });
  });
});
