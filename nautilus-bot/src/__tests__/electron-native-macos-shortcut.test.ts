import { createDictationEscapeFallback, dictationSessionCanCancel } from "../../electron/native-macos-shortcut";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildNativeShortcutHelperArgs,
  isNativeShortcutRawEvent,
  normalizeNativeShortcutHelperShortcut,
  normalizeNativeShortcutEvent,
  resolveNativeHelperConfigApplication,
  resolveNativeShortcutStatus,
  trackNativeShortcutDownBindings,
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

describe("resolveNativeHelperConfigApplication", () => {
  const base = {
    desiredConfig: "[{\"id\":\"primary\"}]",
    appliedConfig: "[{\"id\":\"old\"}]",
    helperAvailable: true,
    dictationPhase: "idle",
    bindingsDown: 0,
  };

  it("does nothing when the running helper already has this table", () => {
    expect(
      resolveNativeHelperConfigApplication({
        ...base,
        appliedConfig: base.desiredConfig,
      }),
    ).toEqual({ action: "unchanged" });
  });

  it("respawns when the table changed and nothing is in flight", () => {
    expect(resolveNativeHelperConfigApplication(base)).toEqual({ action: "apply" });
  });

  it("respawns when the helper died, even though the table is unchanged", () => {
    expect(
      resolveNativeHelperConfigApplication({
        ...base,
        appliedConfig: base.desiredConfig,
        helperAvailable: false,
      }),
    ).toEqual({ action: "apply" });
  });

  // The regression: every binding edit saves immediately, so a SIGTERM landed
  // between `down` and `up`. The release never arrived and the session ran to
  // the 10-minute watchdog.
  it("defers while a binding is physically held, whatever the phase says", () => {
    for (const dictationPhase of ["idle", "preparing", "recording", "done"]) {
      expect(
        resolveNativeHelperConfigApplication({ ...base, dictationPhase, bindingsDown: 1 }),
      ).toEqual({ action: "defer", reason: "binding_held" });
    }
  });

  it("defers while a session is live", () => {
    for (const dictationPhase of ["preparing", "primed", "recording"]) {
      expect(resolveNativeHelperConfigApplication({ ...base, dictationPhase })).toEqual({
        action: "defer",
        reason: "dictation_active",
      });
    }
  });

  it("applies once the session is past the point a stop gesture matters", () => {
    for (const dictationPhase of ["transcribing", "done", "error", "idle"]) {
      expect(resolveNativeHelperConfigApplication({ ...base, dictationPhase })).toEqual({
        action: "apply",
      });
    }
  });
});

describe("trackNativeShortcutDownBindings", () => {
  it("owes an up for every down that has not been released", () => {
    let down = trackNativeShortcutDownBindings(new Set(), {
      event: "down",
      bindingId: "primary",
    });
    down = trackNativeShortcutDownBindings(down, { event: "down", bindingId: "email" });
    expect([...down].sort()).toEqual(["email", "primary"]);

    down = trackNativeShortcutDownBindings(down, { event: "up", bindingId: "primary" });
    expect([...down]).toEqual(["email"]);
  });

  it("never mutates the set it was given", () => {
    const before = new Set(["primary"]);
    const after = trackNativeShortcutDownBindings(before, {
      event: "up",
      bindingId: "primary",
    });
    expect([...before]).toEqual(["primary"]);
    expect([...after]).toEqual([]);
  });

  it("does not track Escape", () => {
    expect([
      ...trackNativeShortcutDownBindings(new Set(), { event: "down", bindingId: "escape" }),
    ]).toEqual([]);
  });

});

describe("native helper restart wiring in main.ts", () => {
  const mainSource = readFileSync(resolve(process.cwd(), "electron/main.ts"), "utf8");

  it("asks the policy before replacing the helper, and defers instead of killing it", () => {
    expect(mainSource).toContain("resolveNativeHelperConfigApplication({");
    expect(mainSource).toMatch(
      /decision\.action === "defer"[\s\S]{0,400}pendingNativeShortcutSettings = settings;[\s\S]{0,40}return;/,
    );
  });

  it("applies a deferred table when the session ends or the key comes up", () => {
    expect(mainSource).toContain('applyDeferredNativeShortcutConfig("binding released")');
    expect(mainSource).toContain("applyDeferredNativeShortcutConfig(`phase ${nextPhase}`)");
  });
});

it("accepts binding cancellation and validates native gesture timing", () => {
  const cancel = { event: "cancel", bindingId: "right" } as const;
  expect(isNativeShortcutRawEvent(cancel)).toBe(true);
  expect(normalizeNativeShortcutEvent(cancel)).toEqual({ signal: "cancelled", bindingId: "right" });
  expect(trackNativeShortcutDownBindings(new Set(["right"]), cancel).size).toBe(0);
  expect(isNativeShortcutRawEvent({ event: "down", bindingId: "right", pressEpochMs: 123, modifierArmDelayMs: 150 })).toBe(true);
  for (const value of [NaN, Infinity, "123"]) {
    expect(isNativeShortcutRawEvent({ event: "down", bindingId: "right", pressEpochMs: value })).toBe(false);
  }
});

it.each(["down", "up", "cancel"])("validates occurrence time on native %s", (event) => {
  expect(isNativeShortcutRawEvent({ event, bindingId: "right", occurrenceEpochMs: 1000 })).toBe(true);
  for (const occurrenceEpochMs of [NaN, Infinity, -1, "1000", null]) {
    expect(isNativeShortcutRawEvent({ event, bindingId: "right", occurrenceEpochMs })).toBe(false);
  }
  expect(isNativeShortcutRawEvent({ event, bindingId: "right" })).toBe(true);
});


it("registers fallback Escape only for a cancellable owner without the helper", async () => {
  let escape = () => {};
  const register = vi.fn((_key: string, callback: () => void) => { escape = callback; return true; });
  const unregister = vi.fn();
  const cancel = vi.fn().mockResolvedValue(undefined);
  const fallback = createDictationEscapeFallback({ register, unregister, cancel, onError: vi.fn() });
  fallback.sync(null, false);
  expect(register).not.toHaveBeenCalled();
  fallback.sync(42, true);
  expect(register).not.toHaveBeenCalled();
  fallback.sync(42, false);
  escape(); escape();
  expect(cancel).toHaveBeenCalledExactlyOnceWith(42);
  fallback.sync(null, false);
  expect(unregister).toHaveBeenCalledExactlyOnceWith("Escape");
  escape();
  expect(cancel).toHaveBeenCalledTimes(1);
  for (const phase of ["idle", "done", "error", "aborted", "delivering"]) expect(dictationSessionCanCancel(phase)).toBe(false);
  for (const phase of ["preparing", "primed", "recording", "stopping", "transcribing"]) expect(dictationSessionCanCancel(phase)).toBe(true);
});
