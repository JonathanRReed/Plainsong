import { describe, expect, it } from "vitest";
import {
  convertShortcutToAccelerator,
  normalizeShortcutAccelerator,
  partitionUniqueShortcutRegistrations,
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
      },
    ]);
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
