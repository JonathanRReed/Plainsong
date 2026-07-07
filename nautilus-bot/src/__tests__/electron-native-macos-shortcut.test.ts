import { describe, expect, it } from "vitest";
import {
  DEFAULT_NATIVE_MACOS_DICTATION_SHORTCUT,
  buildNativeShortcutHelperArgs,
  normalizeNativeShortcutHelperShortcut,
  normalizeNativeShortcutEvent,
  resolveNativeShortcutHelperShortcut,
  resolveNativeShortcutStatus,
} from "../../electron/native-macos-shortcut";

describe("normalizeNativeShortcutEvent", () => {
  it("maps native key down to pressed", () => {
    expect(normalizeNativeShortcutEvent({ type: "down", key: "Space" })).toEqual({
      signal: "pressed",
      key: "Space",
    });
  });

  it("maps native key up to released", () => {
    expect(normalizeNativeShortcutEvent({ type: "up", key: "Space" })).toEqual({
      signal: "released",
      key: "Space",
    });
  });

  it("maps Escape down to cancelled", () => {
    expect(normalizeNativeShortcutEvent({ type: "down", key: "Escape" })).toEqual({
      signal: "cancelled",
      key: "Escape",
    });
  });
});

describe("resolveNativeShortcutStatus", () => {
  it("is unavailable outside macOS", () => {
    expect(resolveNativeShortcutStatus({ platform: "linux", helperReady: true })).toEqual({
      available: false,
      reason: "unsupported_platform",
    });
  });

  it("is available on macOS when the helper is ready", () => {
    expect(resolveNativeShortcutStatus({ platform: "darwin", helperReady: true })).toEqual({
      available: true,
      reason: null,
    });
  });
});

describe("buildNativeShortcutHelperArgs", () => {
  it("passes the configured shortcut as a normalized argument", () => {
    expect(buildNativeShortcutHelperArgs("Ctrl+Alt+Cmd+D")).toEqual([
      "--shortcut",
      "Ctrl+Alt+Cmd+D",
    ]);
    expect(buildNativeShortcutHelperArgs("⌃ ⌥ ⌘ d")).toEqual([
      "--shortcut",
      "Ctrl+Alt+Cmd+D",
    ]);
  });
});

describe("resolveNativeShortcutHelperShortcut", () => {
  it("uses the shared native default when no shortcut is configured", () => {
    expect(resolveNativeShortcutHelperShortcut(" ")).toBe(
      DEFAULT_NATIVE_MACOS_DICTATION_SHORTCUT,
    );
  });

  it("keeps a configured shortcut", () => {
    expect(resolveNativeShortcutHelperShortcut(" Ctrl+Alt+D ")).toBe("Ctrl+Alt+D");
  });
});

describe("normalizeNativeShortcutHelperShortcut", () => {
  it("accepts plus-separated, space-separated, and macOS symbol shortcuts", () => {
    expect(normalizeNativeShortcutHelperShortcut("Ctrl+Alt+Cmd+D")).toBe(
      "Ctrl+Alt+Cmd+D",
    );
    expect(normalizeNativeShortcutHelperShortcut("control option command d")).toBe(
      "Ctrl+Alt+Cmd+D",
    );
    expect(normalizeNativeShortcutHelperShortcut("⌃⌥⌘D")).toBe("Ctrl+Alt+Cmd+D");
  });

  it("normalizes app-captured key aliases that the helper accepts", () => {
    expect(normalizeNativeShortcutHelperShortcut("Cmd+ArrowLeft")).toBe("Cmd+Left");
    expect(normalizeNativeShortcutHelperShortcut("Ctrl+Spacebar")).toBe("Ctrl+Space");
    expect(normalizeNativeShortcutHelperShortcut("Ctrl+Return")).toBe("Ctrl+Enter");
    expect(normalizeNativeShortcutHelperShortcut("Ctrl+Esc")).toBe("Ctrl+Escape");
  });
});
