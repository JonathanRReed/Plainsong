import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDictationShortcutSignalRuntime,
  DICTATION_HOLD_WATCHDOG_MS,
  dictationShortcutFailureMessage,
  resolveDictationShortcutBehavior,
  resolveDictationShortcutCapability,
  resolveDictationShortcutDecision,
  shouldHandleDictationShortcutSource,
} from "../../electron/dictation-shortcut-controller";

describe("dictationShortcutFailureMessage", () => {
  it("preserves actionable sidecar errors", () => {
    expect(dictationShortcutFailureMessage(new Error("Download base.en before dictating."))).toBe(
      "Download base.en before dictating.",
    );
  });

  it("falls back when the rejection has no message", () => {
    for (const error of [null, {}]) {
      expect(dictationShortcutFailureMessage(error)).toBe(
        "Dictation could not start. Open Plainsong to check setup.",
      );
    }
  });
});

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

  it("cancels from every phase a live session can be sitting in", () => {
    // Escape used to require phase "recording", so it did nothing during the
    // primed window (start acked, microphone already live) and did nothing at
    // all while a slow model held the session in stopping/transcribing.
    for (const phase of [
      "preparing",
      "primed",
      "stopping",
      "transcribing",
    ] as const) {
      expect(
        resolveDictationShortcutDecision({
          phase,
          behavior: "hold_to_talk",
          capability: "press_and_release",
          signal: "cancelled",
        }),
      ).toMatchObject({
        action: "cancel",
        stopReason: "cancelled",
      });
    }
  });

  it("ignores a cancelled signal outside of an active recording", () => {
    for (const phase of ["idle", "done", "error"] as const) {
      expect(
        resolveDictationShortcutDecision({
          phase,
          behavior: "hold_to_talk",
          capability: "press_and_release",
          signal: "cancelled",
        }),
      ).toMatchObject({
        action: "ignore",
        stopReason: null,
      });
    }
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
  const handsFree = {
    behavior: "hands_free",
    capability: "press_only",
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
    let resolveStart: ((deliverRecordingPhase: boolean) => void) | null = null;
    const invoke = vi.fn((command: string, args: Record<string, unknown>) => {
      invocations.push({ command, args });
      if (command === "start_dictation") {
        return new Promise<unknown>((resolve, reject) => {
          resolveStart = (deliverRecordingPhase: boolean) => {
            if (options?.failStart) {
              reject(new Error("start failed"));
            } else {
              if (deliverRecordingPhase) {
                phase = "recording";
              }
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
      getSessionId: () => 41,
      invoke,
    });
    return {
      runtime,
      invocations,
      invoke,
      // Mirrors main.ts, which updates the cached phase and forwards it into
      // runtime.onPhase at the same site whenever a dictation-state-changed
      // event (or a synthetic sidecar-termination reset) is observed.
      setPhase: (next: string) => {
        phase = next;
        runtime.onPhase(next);
      },
      finishStart: () => {
        resolveStart?.(true);
        resolveStart = null;
      },
      // Resolves the start_dictation invoke while leaving the cached phase
      // untouched: sidecar command responses and phase events travel on
      // independent paths, so the ack routinely wins the race against the
      // phase "recording" event.
      finishStartBeforePhaseEvent: () => {
        resolveStart?.(false);
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
    expect(harness.invocations[1]?.args).toEqual({
      stopReason: "release",
      stopGestureEpochMs: expect.any(Number),
    });
  });

  it("stops a rapid hands-free toggle whose second press lands before start resolves", async () => {
    const harness = createHarness();

    const firstPress = harness.runtime.handleSignal({ ...handsFree, signal: "pressed" });
    await harness.runtime.handleSignal({ ...handsFree, signal: "pressed" });
    expect(harness.invocations.map((entry) => entry.command)).toEqual(["start_dictation"]);

    harness.finishStart();
    await firstPress;

    expect(harness.invocations.map((entry) => entry.command)).toEqual([
      "start_dictation",
      "stop_dictation",
    ]);
    expect(harness.invocations[1]?.args).toEqual({
      stopReason: "hands_free_toggle",
      stopGestureEpochMs: expect.any(Number),
    });
  });

  it("stops a hands-free toggle after the start ack but before its phase event", async () => {
    const harness = createHarness();

    const firstPress = harness.runtime.handleSignal({ ...handsFree, signal: "pressed" });
    harness.finishStartBeforePhaseEvent();
    await firstPress;
    await harness.runtime.handleSignal({ ...handsFree, signal: "pressed" });

    expect(harness.invocations.map((entry) => entry.command)).toEqual([
      "start_dictation",
      "stop_dictation",
    ]);
    expect(harness.invocations[1]?.args).toEqual({
      stopReason: "hands_free_toggle",
      stopGestureEpochMs: expect.any(Number),
    });
  });

  it("does not revive a hands-free start after its session already ended", async () => {
    const harness = createHarness();

    const firstPress = harness.runtime.handleSignal({ ...handsFree, signal: "pressed" });
    harness.setPhase("error");
    harness.finishStartBeforePhaseEvent();
    await firstPress;

    const secondPress = harness.runtime.handleSignal({ ...handsFree, signal: "pressed" });
    expect(harness.invocations.map((entry) => entry.command)).toEqual([
      "start_dictation",
      "start_dictation",
    ]);
    harness.finishStart();
    await secondPress;
  });

  it("drops the hands-free marker as soon as the session begins stopping", async () => {
    const harness = createHarness();

    const firstPress = harness.runtime.handleSignal({ ...handsFree, signal: "pressed" });
    harness.finishStartBeforePhaseEvent();
    await firstPress;
    harness.setPhase("stopping");
    await harness.runtime.handleSignal({ ...handsFree, signal: "pressed" });

    expect(harness.invocations.map((entry) => entry.command)).toEqual(["start_dictation"]);
  });

  it("tracks externally triggered hands-free starts through the same toggle lifecycle", async () => {
    const harness = createHarness();

    const externalStart = harness.runtime.startHandsFree({ handsFreeTrigger: true });
    await harness.runtime.handleSignal({ ...handsFree, signal: "pressed" });
    harness.finishStart();
    await externalStart;

    expect(harness.invocations).toEqual([
      { command: "start_dictation", args: { options: { handsFreeTrigger: true } } },
      {
        command: "stop_dictation",
        args: {
          stopReason: "hands_free_toggle",
          stopGestureEpochMs: expect.any(Number),
        },
      },
    ]);
  });

  it("stops a tap whose release lands after the start ack but before the recording phase event", async () => {
    const harness = createHarness();

    const press = harness.runtime.handleSignal({ ...holdToTalk, signal: "pressed" });
    harness.finishStartBeforePhaseEvent();
    await press;

    // Cached phase is still "idle": the queued phase "recording" event has
    // not been drained yet, so the decision table resolves the release to
    // "ignore". Previously this cleared the watchdog and dropped the release,
    // leaving the microphone recording forever with no backstop.
    await harness.runtime.handleSignal({ ...holdToTalk, signal: "released" });

    expect(harness.invocations.map((entry) => entry.command)).toEqual([
      "start_dictation",
      "stop_dictation",
    ]);
    expect(harness.invocations[1]?.args).toEqual({
      stopReason: "release",
      stopGestureEpochMs: expect.any(Number),
    });

    // The lagging phase events drain afterwards; the watchdog must not fire
    // a second stop.
    harness.setPhase("recording");
    harness.setPhase("stopping");
    await vi.advanceTimersByTimeAsync(DICTATION_HOLD_WATCHDOG_MS * 2);
    expect(
      harness.invocations.filter((entry) => entry.command === "stop_dictation"),
    ).toHaveLength(1);
  });

  it("stops a release seen while the sidecar phase is still primed", async () => {
    const harness = createHarness();

    const press = harness.runtime.handleSignal({ ...holdToTalk, signal: "pressed" });
    harness.finishStartBeforePhaseEvent();
    await press;
    // "primed" is a live pre-recording phase of the guarded session: it must
    // neither clear the watchdog nor swallow the release.
    harness.setPhase("primed");

    await harness.runtime.handleSignal({ ...holdToTalk, signal: "released" });

    expect(harness.invocations.map((entry) => entry.command)).toEqual([
      "start_dictation",
      "stop_dictation",
    ]);
    expect(harness.invocations[1]?.args).toEqual({
      stopReason: "release",
      stopGestureEpochMs: expect.any(Number),
    });
  });

  it("keeps the watchdog armed across primed/recording phase events", async () => {
    const harness = createHarness();

    const press = harness.runtime.handleSignal({ ...holdToTalk, signal: "pressed" });
    harness.finishStartBeforePhaseEvent();
    await press;
    harness.setPhase("primed");
    harness.setPhase("recording");

    await vi.advanceTimersByTimeAsync(DICTATION_HOLD_WATCHDOG_MS);

    expect(harness.invocations.map((entry) => entry.command)).toEqual([
      "start_dictation",
      "stop_dictation",
    ]);
    expect(harness.invocations[1]?.args).toEqual({
      stopReason: "watchdog_timeout",
      stopGestureEpochMs: expect.any(Number),
    });
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
    expect(harness.invocations[1]?.args).toEqual({
      stopReason: "release",
      stopGestureEpochMs: expect.any(Number),
    });
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
    expect(harness.invocations[1]?.args).toEqual({
      stopReason: "watchdog_timeout",
      stopGestureEpochMs: expect.any(Number),
    });
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

    // The session ends through another path (VAD silence auto-stop, overlay
    // stop button) while the key is still held; the observed phase change
    // clears the watchdog, so the later release resolves to a true "ignore".
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
    expect(harness.invocations[0]?.args).toEqual({ sessionId: 41 });
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
