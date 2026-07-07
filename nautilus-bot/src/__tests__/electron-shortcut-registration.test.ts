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
});

describe("findConflictingShortcuts", () => {
  it("only ranks fields that are actually registered (toggleDictation, openWindow) ahead of toggleRecording", () => {
    // toggleRecording is a settings field that is never passed to
    // globalShortcut.register anywhere in electron/main.ts, nor wired through
    // the native shortcut controller (which only wires toggleDictation). If
    // it ever outranks a field that IS registered, a collision would silently
    // disable a working shortcut in favor of one that can never fire.
    const dictationRank = SHORTCUT_FIELD_PRECEDENCE.findIndex(
      (entry) => entry.key === "toggleDictation",
    );
    const openWindowRank = SHORTCUT_FIELD_PRECEDENCE.findIndex(
      (entry) => entry.key === "openWindow",
    );
    const toggleRecordingRank = SHORTCUT_FIELD_PRECEDENCE.findIndex(
      (entry) => entry.key === "toggleRecording",
    );

    expect(dictationRank).toBeGreaterThanOrEqual(0);
    expect(openWindowRank).toBeGreaterThanOrEqual(0);
    expect(toggleRecordingRank).toBeGreaterThanOrEqual(0);
    expect(dictationRank).toBeLessThan(toggleRecordingRank);
    expect(openWindowRank).toBeLessThan(toggleRecordingRank);
  });

  it("keeps openWindow as the winner when it collides with toggleRecording", () => {
    const conflicts = findConflictingShortcuts({
      openWindow: "Control+Alt+O",
      toggleRecording: "Control+Alt+O",
    });

    expect(conflicts).toEqual([
      {
        field: "toggleRecording",
        label: "Recording",
        shortcut: "Control+Alt+O",
        conflictsWith: "Open window",
        conflictsWithField: "openWindow",
      },
    ]);
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

  it("reports each conflicting field via its own key, not by re-matching labels", () => {
    // quickExport and focusSearch are unrelated fields but share no label
    // collisions with each other or with the recording/dictation fields;
    // this exercises that the field key on each conflict comes straight from
    // the definition rather than being looked up via label string matching.
    const conflicts = findConflictingShortcuts({
      quickExport: "Control+Alt+E",
      focusSearch: "Control+Alt+E",
    });

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      field: "focusSearch",
      conflictsWithField: "quickExport",
    });
  });

  it("returns no conflicts when all configured shortcuts are distinct", () => {
    const conflicts = findConflictingShortcuts({
      toggleDictation: "Control+Alt+D",
      openWindow: "Control+Alt+O",
      toggleRecording: "Control+Alt+R",
      quickExport: "Control+Alt+E",
      focusSearch: "Control+Alt+F",
    });

    expect(conflicts).toEqual([]);
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

  it("rejects empty, excessive, and unknown shortcut tokens", () => {
    expect(convertShortcutToAccelerator(" ")).toBeNull();
    expect(convertShortcutToAccelerator("Ctrl+Alt+Cmd+Shift+Fn+D")).toBeNull();
    expect(convertShortcutToAccelerator("Ctrl+NotAKey")).toBeNull();
  });
});
