import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDictationShortcutSignalRuntime,
  DICTATION_HOLD_WATCHDOG_MS,
  resolveDictationShortcutBehavior,
  resolveDictationShortcutCapability,
  resolveDictationShortcutDecision,
  shouldHandleDictationShortcutSource,
} from "../../electron/dictation-shortcut-controller";

describe("resolveDictationShortcutBehavior", () => {
  it("prefers hands-free when enabled", () => {
    expect(
      resolveDictationShortcutBehavior({
        dictationPushToTalk: true,
        dictationHandsFreeEnabled: true,
      }),
    ).toBe("hands_free");
  });

  it("maps push-to-talk to hold-to-talk", () => {
    expect(
      resolveDictationShortcutBehavior({
        dictationPushToTalk: true,
        dictationHandsFreeEnabled: false,
      }),
    ).toBe("hold_to_talk");
  });

  it("falls back to toggle", () => {
    expect(
      resolveDictationShortcutBehavior({
        dictationPushToTalk: false,
        dictationHandsFreeEnabled: false,
      }),
    ).toBe("toggle");
  });
});

describe("resolveDictationShortcutDecision", () => {
  it("starts from idle on press-only fallback", () => {
    expect(
      resolveDictationShortcutDecision({
        phase: "idle",
        behavior: "hold_to_talk",
        capability: "press_only",
        signal: "pressed",
      }),
    ).toMatchObject({
      action: "start",
      usesPressOnlyFallback: true,
    });
  });

  it("stops on second press while recording in press-only fallback", () => {
    expect(
      resolveDictationShortcutDecision({
        phase: "recording",
        behavior: "hold_to_talk",
        capability: "press_only",
        signal: "pressed",
      }),
    ).toMatchObject({
      action: "stop",
      stopReason: "toggle",
      usesPressOnlyFallback: true,
    });
  });

  it("ignores presses while transcribing in press-only fallback", () => {
    expect(
      resolveDictationShortcutDecision({
        phase: "transcribing",
        behavior: "toggle",
        capability: "press_only",
        signal: "pressed",
      }),
    ).toMatchObject({
      action: "ignore",
    });
  });

  it("supports release-to-stop when release events exist", () => {
    expect(
      resolveDictationShortcutDecision({
        phase: "recording",
        behavior: "hold_to_talk",
        capability: "press_and_release",
        signal: "released",
      }),
    ).toMatchObject({
      action: "stop",
      stopReason: "release",
      usesPressOnlyFallback: false,
    });
  });

  it("uses hands-free specific stop reason", () => {
    expect(
      resolveDictationShortcutDecision({
        phase: "recording",
        behavior: "hands_free",
        capability: "press_only",
        signal: "pressed",
      }),
    ).toMatchObject({
      action: "stop",
      stopReason: "hands_free_toggle",
    });
  });

  it("cancels (discards) a recording session on a cancelled signal", () => {
    expect(
      resolveDictationShortcutDecision({
        phase: "recording",
        behavior: "hold_to_talk",
        capability: "press_and_release",
        signal: "cancelled",
      }),
    ).toMatchObject({
      action: "cancel",
      stopReason: "cancelled",
    });
  });

  it("ignores a cancelled signal outside of an active recording", () => {
    expect(
      resolveDictationShortcutDecision({
        phase: "idle",
        behavior: "hold_to_talk",
        capability: "press_and_release",
        signal: "cancelled",
      }),
    ).toMatchObject({
      action: "ignore",
      stopReason: null,
    });
  });
});

describe("resolveDictationShortcutCapability", () => {
  it("reports press-and-release only when hold-to-talk is selected and the native helper is available", () => {
    expect(
      resolveDictationShortcutCapability({
        nativeShortcutAvailable: true,
        behavior: "hold_to_talk",
      }),
    ).toBe("press_and_release");
  });

  it("falls back to press-only when the native helper is unavailable", () => {
    expect(
      resolveDictationShortcutCapability({
        nativeShortcutAvailable: false,
        behavior: "hold_to_talk",
      }),
    ).toBe("press_only");
  });

  it("stays press-only for toggle and hands-free behaviors even when the native helper is available", () => {
    expect(
      resolveDictationShortcutCapability({
        nativeShortcutAvailable: true,
        behavior: "toggle",
      }),
    ).toBe("press_only");
    expect(
      resolveDictationShortcutCapability({
        nativeShortcutAvailable: true,
        behavior: "hands_free",
      }),
    ).toBe("press_only");
  });
});

describe("createDictationShortcutSignalRuntime", () => {
  const holdToTalk = {
    behavior: "hold_to_talk",
    capability: "press_and_release",
  } as const;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createHarness(options?: { failStart?: boolean }) {
    let phase = "idle";
    const invocations: Array<{ command: string; args: Record<string, unknown> }> = [];
    let resolveStart: (() => void) | null = null;
    const invoke = vi.fn((command: string, args: Record<string, unknown>) => {
      invocations.push({ command, args });
      if (command === "start_dictation") {
        return new Promise<unknown>((resolve, reject) => {
          resolveStart = () => {
            if (options?.failStart) {
              reject(new Error("start failed"));
            } else {
              phase = "recording";
              resolve(null);
            }
          };
        });
      }
      if (command === "stop_dictation") {
        phase = "stopping";
      }
      return Promise.resolve(null);
    });
    const runtime = createDictationShortcutSignalRuntime({
      getPhase: () => phase as Parameters<typeof resolveDictationShortcutDecision>[0]["phase"],
      invoke,
    });
    return {
      runtime,
      invocations,
      invoke,
      setPhase: (next: string) => {
        phase = next;
      },
      finishStart: () => {
        resolveStart?.();
        resolveStart = null;
      },
    };
  }

  it("stops a rapid hold-to-talk tap whose release lands before the start resolves", async () => {
    const harness = createHarness();

    const press = harness.runtime.handleSignal({ ...holdToTalk, signal: "pressed" });
    // The release arrives while start_dictation is still in flight and the
    // cached phase is still "idle" — previously this resolved to "ignore" and
    // the microphone recorded forever.
    await harness.runtime.handleSignal({ ...holdToTalk, signal: "released" });
    expect(harness.invocations.map((entry) => entry.command)).toEqual([
      "start_dictation",
    ]);

    harness.finishStart();
    await press;
    await vi.runAllTimersAsync();

    expect(harness.invocations.map((entry) => entry.command)).toEqual([
      "start_dictation",
      "stop_dictation",
    ]);
    expect(harness.invocations[1]?.args).toEqual({ stopReason: "release" });
  });

  it("does not issue a buffered stop when the start itself failed", async () => {
    const harness = createHarness({ failStart: true });

    const press = harness.runtime.handleSignal({ ...holdToTalk, signal: "pressed" });
    await harness.runtime.handleSignal({ ...holdToTalk, signal: "released" });
    harness.finishStart();
    await expect(press).rejects.toThrow("start failed");

    expect(harness.invocations.map((entry) => entry.command)).toEqual([
      "start_dictation",
    ]);
  });

  it("stops normally on a release that arrives after recording started", async () => {
    const harness = createHarness();

    const press = harness.runtime.handleSignal({ ...holdToTalk, signal: "pressed" });
    harness.finishStart();
    await press;

    await harness.runtime.handleSignal({ ...holdToTalk, signal: "released" });

    expect(harness.invocations.map((entry) => entry.command)).toEqual([
      "start_dictation",
      "stop_dictation",
    ]);
    expect(harness.invocations[1]?.args).toEqual({ stopReason: "release" });
  });

  it("stops a hold whose release never arrives via the watchdog backstop", async () => {
    const harness = createHarness();

    const press = harness.runtime.handleSignal({ ...holdToTalk, signal: "pressed" });
    harness.finishStart();
    await press;

    await vi.advanceTimersByTimeAsync(DICTATION_HOLD_WATCHDOG_MS);

    expect(harness.invocations.map((entry) => entry.command)).toEqual([
      "start_dictation",
      "stop_dictation",
    ]);
    expect(harness.invocations[1]?.args).toEqual({ stopReason: "watchdog_timeout" });
  });

  it("does not fire the watchdog after a normal release already stopped the session", async () => {
    const harness = createHarness();

    const press = harness.runtime.handleSignal({ ...holdToTalk, signal: "pressed" });
    harness.finishStart();
    await press;
    await harness.runtime.handleSignal({ ...holdToTalk, signal: "released" });

    await vi.advanceTimersByTimeAsync(DICTATION_HOLD_WATCHDOG_MS * 2);

    expect(
      harness.invocations.filter((entry) => entry.command === "stop_dictation"),
    ).toHaveLength(1);
  });

  it("clears the stale watchdog when the release lands after the session already ended", async () => {
    const harness = createHarness();

    const press = harness.runtime.handleSignal({ ...holdToTalk, signal: "pressed" });
    harness.finishStart();
    await press;

    // The session ends through a path the runtime never sees (VAD silence
    // auto-stop, overlay stop button) while the key is still held; the
    // release then resolves to "ignore".
    harness.setPhase("done");
    await harness.runtime.handleSignal({ ...holdToTalk, signal: "released" });

    // A later unrelated session (UI- or hands-free-started) is recording when
    // the stale timer would have fired — it must not be stopped.
    harness.setPhase("recording");
    await vi.advanceTimersByTimeAsync(DICTATION_HOLD_WATCHDOG_MS * 2);

    expect(
      harness.invocations.filter((entry) => entry.command === "stop_dictation"),
    ).toHaveLength(0);
  });

  it("clears the stale watchdog when a cancel lands after the session already ended", async () => {
    const harness = createHarness();

    const press = harness.runtime.handleSignal({ ...holdToTalk, signal: "pressed" });
    harness.finishStart();
    await press;

    harness.setPhase("done");
    await harness.runtime.handleSignal({ ...holdToTalk, signal: "cancelled" });

    harness.setPhase("recording");
    await vi.advanceTimersByTimeAsync(DICTATION_HOLD_WATCHDOG_MS * 2);

    expect(
      harness.invocations.filter((entry) => entry.command === "stop_dictation"),
    ).toHaveLength(0);
  });

  it("cancels a recording session on a cancelled signal", async () => {
    const harness = createHarness();
    harness.setPhase("recording");

    await harness.runtime.handleSignal({ ...holdToTalk, signal: "cancelled" });

    expect(harness.invocations.map((entry) => entry.command)).toEqual([
      "force_stop_dictation",
    ]);
  });
});

describe("shouldHandleDictationShortcutSource", () => {
  it("always handles native-sourced events", () => {
    expect(
      shouldHandleDictationShortcutSource({
        source: "native",
        nativeShortcutAvailable: true,
      }),
    ).toBe(true);
    expect(
      shouldHandleDictationShortcutSource({
        source: "native",
        nativeShortcutAvailable: false,
      }),
    ).toBe(true);
  });

  it("ignores electron-sourced events once the native helper takes over", () => {
    expect(
      shouldHandleDictationShortcutSource({
        source: "electron",
        nativeShortcutAvailable: true,
      }),
    ).toBe(false);
  });

  it("falls back to handling electron-sourced events when the native helper is unavailable", () => {
    expect(
      shouldHandleDictationShortcutSource({
        source: "electron",
        nativeShortcutAvailable: false,
      }),
    ).toBe(true);
  });
});
