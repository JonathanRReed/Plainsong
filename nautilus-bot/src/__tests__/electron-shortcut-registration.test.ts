import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { dictationBindingConflictSources } from "../../electron/dictation-bindings";
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

  // The regression: only the four legacy fields were walked, and only the
  // *primary* binding is mirrored into `toggleDictation`. A per-profile
  // binding on Open window's keys was therefore invisible here, while
  // `applyElectronGlobalShortcuts` registers the bindings first and takes
  // the keys \u2014 leaving a `console.error` as the only trace.
  it("flags a shortcut field that a non-primary dictation binding takes", () => {
    const conflicts = findConflictingShortcuts(
      { toggleDictation: "Cmd+Shift+Space", openWindow: "Ctrl+Alt+E" },
      [
        { bindingId: "primary", label: "Dictation", accelerator: "Cmd+Shift+Space" },
        { bindingId: "email", label: "Dictation \u00b7 Writing", accelerator: "Control+Alt+E" },
      ],
    );

    expect(conflicts).toEqual([
      {
        field: "openWindow",
        label: "Open window",
        shortcut: "Ctrl+Alt+E",
        conflictsWith: "Dictation \u00b7 Writing",
        conflictsWithField: "toggleDictation",
      },
    ]);
  });

  it("does not make the primary binding collide with its own toggleDictation mirror", () => {
    expect(
      findConflictingShortcuts({ toggleDictation: "Cmd+Shift+Space", openWindow: "Ctrl+Alt+O" }, [
        { bindingId: "primary", label: "Dictation", accelerator: "Cmd+Shift+Space" },
      ]),
    ).toEqual([]);
  });

  // Two bindings on one trigger are the binding table's business:
  // `validateDictationBindings` reports them per row and names the row, which
  // this field-oriented list cannot.
  it("leaves binding-versus-binding collisions to the binding table", () => {
    expect(
      findConflictingShortcuts({ toggleDictation: "Cmd+Shift+Space" }, [
        { bindingId: "a", label: "Dictation", accelerator: "Cmd+Shift+Space" },
        { bindingId: "b", label: "Next mode", accelerator: "Shift+Cmd+Space" },
      ]),
    ).toEqual([]);
  });

  it("still walks the legacy fields when no binding table is supplied", () => {
    expect(
      findConflictingShortcuts({
        toggleDictation: "Control+Alt+D",
        openWindow: "Control+Alt+D",
      }),
    ).toHaveLength(1);
  });
});

describe("dictationBindingConflictSources", () => {
  it("names each key binding the way the Settings list does and skips mouse triggers", () => {
    expect(
      dictationBindingConflictSources(
        [
          {
            id: "primary",
            trigger: { kind: "key", accelerator: "Cmd+Shift+Space" },
            action: { kind: "dictation", modeId: null, behavior: "inherit" },
          },
          {
            id: "email",
            trigger: { kind: "key", accelerator: "Ctrl+Alt+E" },
            action: { kind: "dictation", modeId: "email", behavior: "inherit" },
          },
          {
            id: "blank",
            trigger: { kind: "key", accelerator: "  " },
            action: { kind: "cycleMode" },
          },
          {
            id: "mouse",
            trigger: { kind: "mouse", button: 4 },
            action: { kind: "cancel" },
          },
        ],
        [],
      ),
    ).toEqual([
      { bindingId: "primary", label: "Dictation", accelerator: "Cmd+Shift+Space" },
      { bindingId: "email", label: "Dictation \u00b7 Writing", accelerator: "Ctrl+Alt+E" },
    ]);
  });
});

describe("settings shortcut refresh wiring", () => {
  it("re-registers hotkeys when restored settings are broadcast", () => {
    const mainSource = readFileSync(resolve(process.cwd(), "electron/main.ts"), "utf8");

    expect(mainSource).toMatch(
      /eventName === "settings-changed"[\s\S]{0,700}applyElectronGlobalShortcuts\("settings-changed"\)/,
    );
  });

  it("does not touch global shortcuts when a duplicate instance quits before ready", () => {
    const mainSource = readFileSync(resolve(process.cwd(), "electron/main.ts"), "utf8");

    expect(mainSource).toMatch(
      // The window is generous because `before-quit` also has to finalize an
      // active meeting before the normal teardown runs; the guard being
      // asserted here is the `app.isReady()` check, not its distance from the
      // handler's first line.
      /app\.on\("before-quit"[\s\S]{0,1600}if \(app\.isReady\(\)\) \{\s*globalShortcut\.unregisterAll\(\)/,
    );
  });

  it("forces a bounded process exit if Electron's graceful quit stalls", () => {
    const mainSource = readFileSync(resolve(process.cwd(), "electron/main.ts"), "utf8");

    expect(mainSource).toMatch(
      /app\.on\("before-quit"[\s\S]{0,1400}setTimeout\(\(\) => \{[\s\S]{0,180}app\.exit\(0\)[\s\S]{0,180}FORCED_QUIT_TIMEOUT_MS/,
    );
    expect(mainSource).toMatch(
      /app\.on\("quit"[\s\S]{0,180}clearTimeout\(forcedQuitTimer\)/,
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
