import { describe, expect, it } from "vitest";
import {
  buildNativeShortcutHelperArgs,
  isNativeShortcutRawEvent,
  normalizeNativeShortcutHelperShortcut,
  normalizeNativeShortcutEvent,
  resolveNativeShortcutStatus,
} from "../../electron/native-macos-shortcut";

describe("normalizeNativeShortcutEvent", () => {
  it("maps a binding's down to pressed", () => {
    expect(normalizeNativeShortcutEvent({ event: "down", bindingId: "primary" })).toEqual({
      signal: "pressed",
      bindingId: "primary",
    });
  });

  it("maps a binding's up to released", () => {
    expect(normalizeNativeShortcutEvent({ event: "up", bindingId: "primary" })).toEqual({
      signal: "released",
      bindingId: "primary",
    });
  });

  it("maps the reserved escape id to cancelled", () => {
    expect(normalizeNativeShortcutEvent({ event: "down", bindingId: "escape" })).toEqual({
      signal: "cancelled",
      bindingId: "escape",
    });
  });
});

describe("isNativeShortcutRawEvent (helper JSON protocol)", () => {
  it("accepts the {event, bindingId} lines the helper prints", () => {
    expect(isNativeShortcutRawEvent({ event: "down", bindingId: "primary" })).toBe(true);
    expect(isNativeShortcutRawEvent({ event: "up", bindingId: "b2" })).toBe(true);
  });

  it("rejects the retired {type, key} shape and malformed lines", () => {
    expect(isNativeShortcutRawEvent({ type: "down", key: "Space" })).toBe(false);
    expect(isNativeShortcutRawEvent({ event: "noop", bindingId: "primary" })).toBe(false);
    expect(isNativeShortcutRawEvent({ event: "down", bindingId: "" })).toBe(false);
    expect(isNativeShortcutRawEvent("down")).toBe(false);
    expect(isNativeShortcutRawEvent(null)).toBe(false);
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
  it("hands the whole binding table over as one JSON argument", () => {
    const table = [
      { id: "primary", kind: "key" as const, accelerator: "Ctrl+Alt+Cmd+D" },
      { id: "mouse", kind: "mouse" as const, button: 4 as const, modifiers: ["Cmd"] },
      { id: "fn", kind: "modifier" as const, modifier: "Fn" },
    ];
    const args = buildNativeShortcutHelperArgs(table);
    expect(args[0]).toBe("--bindings");
    expect(JSON.parse(args[1])).toEqual(table);
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
