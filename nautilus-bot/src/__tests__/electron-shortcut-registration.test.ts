import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  convertShortcutToAccelerator,
  findConflictingShortcuts,
  normalizeShortcutAccelerator,
  partitionUniqueShortcutRegistrations,
  SHORTCUT_FIELD_PRECEDENCE,
} from "../../electron/shortcut-registration";

describe("partitionUniqueShortcutRegistrations", () => {
  it("keeps the first owner of a shortcut and reports later duplicates", () => {
    const result = partitionUniqueShortcutRegistrations([
      { label: "dictation", shortcut: "Control+Alt+D" },
      { label: "quick fix", shortcut: "Control+Alt+P" },
      { label: "polish", shortcut: "control + alt + p" },
      { label: "prompt engineer", shortcut: "Control+Alt+2" },
      { label: "disabled", shortcut: null },
    ]);

    expect(result.unique.map((registration) => registration.label)).toEqual([
      "dictation",
      "quick fix",
      "prompt engineer",
    ]);
    expect(result.conflicts).toEqual([
      {
        label: "polish",
        shortcut: "control + alt + p",
        conflictsWith: "quick fix",
        definition: { label: "polish", shortcut: "control + alt + p" },
        conflictsWithDefinition: { label: "quick fix", shortcut: "Control+Alt+P" },
      },
    ]);
  });

  it("preserves arbitrary caller-supplied fields on conflict definitions", () => {
    const result = partitionUniqueShortcutRegistrations([
      { field: "toggleDictation", label: "Dictation", shortcut: "Control+Alt+D" },
      { field: "openWindow", label: "Open window", shortcut: "Control+Alt+D" },
    ]);

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.definition.field).toBe("openWindow");
    expect(result.conflicts[0]?.conflictsWithDefinition.field).toBe("toggleDictation");
  });

  it("detects duplicate shortcuts across aliases and macOS symbols", () => {
    const result = partitionUniqueShortcutRegistrations([
      { label: "dictation", shortcut: "Control+Alt+Command+D" },
      { label: "duplicate dictation", shortcut: "⌃⌥⌘D" },
    ]);

    expect(result.unique.map((registration) => registration.label)).toEqual([
      "dictation",
    ]);
    expect(result.conflicts).toEqual([
      {
        label: "duplicate dictation",
        shortcut: "⌃⌥⌘D",
        conflictsWith: "dictation",
        definition: { label: "duplicate dictation", shortcut: "⌃⌥⌘D" },
        conflictsWithDefinition: {
          label: "dictation",
          shortcut: "Control+Alt+Command+D",
        },
      },
    ]);
  });

  it("normalizes accelerator spacing and casing", () => {
    expect(normalizeShortcutAccelerator(" Command + Shift + Space ")).toBe(
      "command+shift+space",
    );
    expect(normalizeShortcutAccelerator("⌃ ⌥ ⌘ d")).toBe(
      "control+alt+command+d",
    );
    expect(normalizeShortcutAccelerator("Control Option Command D")).toBe(
      "control+alt+command+d",
    );
  });

  it("normalizes equivalent chords with different modifier order to the same string", () => {
    expect(normalizeShortcutAccelerator("Alt+Ctrl+D")).toBe(
      normalizeShortcutAccelerator("Ctrl+Alt+D"),
    );
    expect(normalizeShortcutAccelerator("Shift+Cmd+Space")).toBe(
      normalizeShortcutAccelerator("Cmd+Shift+Space"),
    );
  });

  it("detects conflicts between chords written with a different modifier order", () => {
    const result = partitionUniqueShortcutRegistrations([
      { label: "dictation", shortcut: "Ctrl+Alt+D" },
      { label: "open window", shortcut: "Alt+Ctrl+D" },
    ]);

    expect(result.unique.map((registration) => registration.label)).toEqual([
      "dictation",
    ]);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      label: "open window",
      conflictsWith: "dictation",
    });
  });
});

describe("findConflictingShortcuts", () => {
  it("ranks all registered fields in deterministic priority order", () => {
    const rank = (key: string) =>
      SHORTCUT_FIELD_PRECEDENCE.findIndex((entry) => entry.key === key);

    expect(rank("toggleDictation")).toBeGreaterThanOrEqual(0);
    expect(rank("openWindow")).toBeGreaterThanOrEqual(0);
    expect(rank("repasteLastDictation")).toBeGreaterThanOrEqual(0);
    expect(rank("recopyLastDictation")).toBeGreaterThanOrEqual(0);
    expect(rank("toggleDictation")).toBeLessThan(rank("openWindow"));
    expect(rank("openWindow")).toBeLessThan(rank("repasteLastDictation"));
    expect(rank("repasteLastDictation")).toBeLessThan(rank("recopyLastDictation"));
  });

  it("reports a recovery binding that collides with dictation instead of double-registering it", () => {
    const conflicts = findConflictingShortcuts({
      toggleDictation: "Cmd+Ctrl+V",
      repasteLastDictation: "Command+Control+V",
    });

    expect(conflicts).toEqual([
      {
        field: "repasteLastDictation",
        label: "Paste last result",
        shortcut: "Command+Control+V",
        conflictsWith: "Dictation",
        conflictsWithField: "toggleDictation",
      },
    ]);
  });

  it("registers both default recovery bindings when they do not collide", () => {
    expect(
      findConflictingShortcuts({
        toggleDictation: "Cmd+Shift+Space",
        repasteLastDictation: "Cmd+Ctrl+V",
        recopyLastDictation: "Cmd+Ctrl+C",
      }),
    ).toEqual([]);
    expect(convertShortcutToAccelerator("Cmd+Ctrl+V")).toBe("Command+Control+V");
    expect(convertShortcutToAccelerator("Cmd+Ctrl+C")).toBe("Command+Control+C");
  });

  it("keeps toggleDictation as the winner when it collides with openWindow", () => {
    const conflicts = findConflictingShortcuts({
      toggleDictation: "Control+Alt+D",
      openWindow: "Control+Alt+D",
    });

    expect(conflicts).toEqual([
      {
        field: "openWindow",
        label: "Open window",
        shortcut: "Control+Alt+D",
        conflictsWith: "Dictation",
        conflictsWithField: "toggleDictation",
      },
    ]);
  });

  it("reports each conflicting field via its own key", () => {
    const conflicts = findConflictingShortcuts({
      repasteLastDictation: "Control+Alt+E",
      recopyLastDictation: "Control+Alt+E",
    });

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      field: "recopyLastDictation",
      conflictsWithField: "repasteLastDictation",
    });
  });

  it("returns no conflicts when all configured shortcuts are distinct", () => {
    const conflicts = findConflictingShortcuts({
      toggleDictation: "Control+Alt+D",
      openWindow: "Control+Alt+O",
      repasteLastDictation: "Control+Alt+V",
      recopyLastDictation: "Control+Alt+C",
    });

    expect(conflicts).toEqual([]);
  });
});

describe("settings shortcut refresh wiring", () => {
  it("re-registers hotkeys when restored settings are broadcast", () => {
    const mainSource = readFileSync(resolve(process.cwd(), "electron/main.ts"), "utf8");

    expect(mainSource).toMatch(
      /eventName === "settings-changed"[\s\S]{0,700}applyElectronGlobalShortcuts\("settings-changed"\)/,
    );
  });
});

describe("convertShortcutToAccelerator", () => {
  it("accepts plus-separated, space-separated, and macOS symbol shortcuts", () => {
    expect(convertShortcutToAccelerator("Ctrl+Alt+Cmd+D")).toBe(
      "Control+Alt+Command+D",
    );
    expect(convertShortcutToAccelerator("control option command d")).toBe(
      "Control+Alt+Command+D",
    );
    expect(convertShortcutToAccelerator("⌃⌥⌘D")).toBe("Control+Alt+Command+D");
  });

  it("normalizes key aliases accepted by Electron accelerators", () => {
    expect(convertShortcutToAccelerator("Cmd+ArrowLeft")).toBe("Command+Left");
    expect(convertShortcutToAccelerator("Ctrl+Spacebar")).toBe("Control+Space");
    expect(convertShortcutToAccelerator("Ctrl+Return")).toBe("Control+Enter");
    expect(convertShortcutToAccelerator("Ctrl+Esc")).toBe("Control+Escape");
  });

  it("accepts function keys and navigation keys that the capture UI records", () => {
    expect(convertShortcutToAccelerator("Cmd+F5")).toBe("Command+F5");
    expect(convertShortcutToAccelerator("ctrl+f12")).toBe("Control+F12");
    expect(convertShortcutToAccelerator("Cmd+F24")).toBe("Command+F24");
    expect(convertShortcutToAccelerator("Ctrl+Backspace")).toBe("Control+Backspace");
    expect(convertShortcutToAccelerator("Ctrl+Delete")).toBe("Control+Delete");
    expect(convertShortcutToAccelerator("Cmd+Home")).toBe("Command+Home");
    expect(convertShortcutToAccelerator("Cmd+End")).toBe("Command+End");
    expect(convertShortcutToAccelerator("Cmd+PageUp")).toBe("Command+PageUp");
    expect(convertShortcutToAccelerator("Cmd+PageDown")).toBe("Command+PageDown");
    expect(convertShortcutToAccelerator("Ctrl+Tab")).toBe("Control+Tab");
  });

  it("rejects empty, excessive, and unknown shortcut tokens", () => {
    expect(convertShortcutToAccelerator(" ")).toBeNull();
    expect(convertShortcutToAccelerator("Ctrl+Alt+Cmd+Shift+Fn+D")).toBeNull();
    expect(convertShortcutToAccelerator("Ctrl+NotAKey")).toBeNull();
    expect(convertShortcutToAccelerator("Ctrl+F25")).toBeNull();
    expect(convertShortcutToAccelerator("Ctrl+F0")).toBeNull();
  });
});
