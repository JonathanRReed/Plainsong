import { describe, expect, it } from "vitest";
import {
  dictationInstruction,
  formatShortcutForDisplay,
  normalizeShortcut,
} from "@/lib/shortcuts";
import { formatNavShortcut } from "@/lib/nav-shortcuts";

describe("formatShortcutForDisplay", () => {
  it("uses the same macOS glyphs as the nav shortcuts", () => {
    expect(formatShortcutForDisplay("Alt+Space", true)).toBe("⌥ Space");
    expect(formatShortcutForDisplay("Cmd+Shift+Space", true)).toBe("⌘ ⇧ Space");
    expect(formatShortcutForDisplay("Control+Option+D", true)).toBe("⌃ ⌥ D");
    expect(formatShortcutForDisplay("Fn", true)).toBe("fn");
    expect(formatNavShortcut("dashboard", true)).toBe("⌘⇧H");
  });

  it("keeps words for the modifiers off macOS", () => {
    expect(formatShortcutForDisplay("Alt+Space", false)).toBe("Alt + Space");
    expect(formatShortcutForDisplay("Cmd+Shift+Space", false)).toBe("Cmd + Shift + Space");
  });

  it("reads an already formatted label back without mangling it", () => {
    expect(normalizeShortcut("⌘ ⇧ Space")).toBe("Cmd+Shift+Space");
    expect(normalizeShortcut("⌥Space")).toBe("Alt+Space");
    expect(normalizeShortcut("Cmd + Shift + J")).toBe("Cmd+Shift+J");
    expect(formatShortcutForDisplay(formatShortcutForDisplay("Alt+Space", true), true)).toBe(
      "⌥ Space",
    );
  });

  it("accepts a formatted label in the dictation instruction", () => {
    // jsdom reports a non-mac platform, so the instruction uses words.
    expect(dictationInstruction("⌥ Space", "hold_to_talk")).toBe(
      "Hold Alt + Space to record, release to transcribe and paste.",
    );
  });
});
