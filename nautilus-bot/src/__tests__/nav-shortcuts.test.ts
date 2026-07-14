import { describe, expect, it } from "vitest";
import { formatNavShortcut, matchNavShortcut, navShortcutKeys } from "@/lib/nav-shortcuts";

function keyEvent(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", init);
}

describe("nav-shortcuts", () => {
  it("avoids plain Cmd+H / Cmd+M, which macOS hide/minimize consume", () => {
    expect(formatNavShortcut("dashboard", true)).toBe("⌘⇧H");
    expect(formatNavShortcut("recordings", true)).toBe("⌘⇧M");
    expect(formatNavShortcut("dictation", true)).toBe("⌘D");
    expect(formatNavShortcut("projects", true)).toBe("⌘P");
    expect(formatNavShortcut("settings", true)).toBe("⌘,");
  });

  it("localizes labels to Ctrl on non-mac platforms", () => {
    expect(formatNavShortcut("dashboard", false)).toBe("Ctrl+Shift+H");
    expect(formatNavShortcut("dictation", false)).toBe("Ctrl+D");
    expect(navShortcutKeys("recordings", false)).toEqual(["Ctrl", "Shift", "M"]);
    expect(navShortcutKeys("settings", true)).toEqual(["⌘", ","]);
  });

  it("returns null for views without a shortcut", () => {
    expect(formatNavShortcut("setup", true)).toBeNull();
    expect(navShortcutKeys("exports", false)).toBeNull();
  });

  it("matches ⌘-based events on macOS", () => {
    expect(matchNavShortcut(keyEvent({ key: "H", metaKey: true, shiftKey: true }), true)).toBe(
      "dashboard"
    );
    expect(matchNavShortcut(keyEvent({ key: "d", metaKey: true }), true)).toBe("dictation");
    expect(matchNavShortcut(keyEvent({ key: "m", metaKey: true, shiftKey: true }), true)).toBe(
      "recordings"
    );
    // Plain Cmd+H / Cmd+M belong to hide/minimize and must not match.
    expect(matchNavShortcut(keyEvent({ key: "h", metaKey: true }), true)).toBeNull();
    expect(matchNavShortcut(keyEvent({ key: "m", metaKey: true }), true)).toBeNull();
    // Ctrl does not act as the primary modifier on macOS.
    expect(matchNavShortcut(keyEvent({ key: "d", ctrlKey: true }), true)).toBeNull();
  });

  it("matches Ctrl-based events on other platforms", () => {
    expect(matchNavShortcut(keyEvent({ key: "h", ctrlKey: true, shiftKey: true }), false)).toBe(
      "dashboard"
    );
    expect(matchNavShortcut(keyEvent({ key: "p", ctrlKey: true }), false)).toBe("projects");
    expect(matchNavShortcut(keyEvent({ key: ",", ctrlKey: true }), false)).toBe("settings");
    expect(matchNavShortcut(keyEvent({ key: "h", metaKey: true, shiftKey: true }), false)).toBeNull();
    expect(matchNavShortcut(keyEvent({ key: "m", ctrlKey: true }), false)).toBeNull();
  });

  it("ignores events with extra modifiers", () => {
    expect(
      matchNavShortcut(keyEvent({ key: "d", metaKey: true, altKey: true }), true)
    ).toBeNull();
    expect(
      matchNavShortcut(keyEvent({ key: "d", metaKey: true, ctrlKey: true }), true)
    ).toBeNull();
    expect(matchNavShortcut(keyEvent({ key: "d", metaKey: true, shiftKey: true }), true)).toBeNull();
  });
});
