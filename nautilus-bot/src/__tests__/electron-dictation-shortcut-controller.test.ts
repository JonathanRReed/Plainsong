import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDictationShortcutSignalRuntime,
  DICTATION_HOLD_WATCHDOG_MS,
  dictationShortcutFailureMessage,
  resolveDictationShortcutBehavior,
  resolveDictationShortcutStartOptions,
  resolveDictationShortcutCapability,
  resolveDictationShortcutDecision,
  shouldHandleDictationShortcutSource,
} from "../../electron/dictation-shortcut-controller";

describe("selected shortcut profile", () => {
  it("passes the user's selected rewrite profile when the binding inherits", () => {
    expect(resolveDictationShortcutStartOptions("power_rewrite", null)).toEqual({ profile: "power_rewrite" });
  });
  it("keeps normal-speed inheritance and safe fallback", () => {
    expect(resolveDictationShortcutStartOptions("normal_speed", null)).toEqual({ profile: "normal_speed" });
    expect(resolveDictationShortcutStartOptions(undefined, null)).toEqual({ profile: "normal_speed" });
    expect(resolveDictationShortcutStartOptions("accuracy", null)).toEqual({ profile: "power_rewrite" });
  });
  it("lets an explicitly pinned mode choose its own profile in the sidecar", () => {
    const override = { preset: "email", customModeId: null };
    expect(resolveDictationShortcutStartOptions("normal_speed", override)).toEqual({ modeOverride: override });
  });
  it("asks for Return after inserting only when the starting binding does", () => {
    const override = { preset: "messages", customModeId: null };
    expect(resolveDictationShortcutStartOptions("normal_speed", null, true)).toEqual({
      profile: "normal_speed",
      submitAfterInsert: true,
    });
    expect(resolveDictationShortcutStartOptions("normal_speed", override, true)).toEqual({
      modeOverride: override,
      submitAfterInsert: true,
    });
    expect(resolveDictationShortcutStartOptions("normal_speed", override, false)).toEqual({ modeOverride: override });
  });
});

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

  describe.each([
    { behavior: "toggle", capability: "press_only", stopReason: "toggle" },
    { behavior: "toggle", capability: "press_and_release", stopReason: "toggle" },
    { behavior: "hold_to_talk", capability: "press_only", stopReason: "toggle" },
    { behavior: "hands_free", capability: "press_only", stopReason: "hands_free_toggle" },
  ] as const)("$behavior with $capability start ownership", (binding) => {
    it("buffers one stop before acknowledgement with the second gesture timestamp", async () => {
      const harness = createHarness();
      vi.setSystemTime(1_000);
      const first = harness.runtime.handleSignal({ ...binding, signal: "pressed" });
      vi.setSystemTime(1_125);
      const second = harness.runtime.handleSignal({ ...binding, signal: "pressed" });
      expect(harness.invocations.map((entry) => entry.command)).toEqual(["start_dictation"]);
      await second;
      harness.finishStartBeforePhaseEvent();
      await first;
      expect(harness.invocations).toEqual([
        { command: "start_dictation", args: {} },
        { command: "stop_dictation", args: { stopReason: binding.stopReason, stopGestureEpochMs: 1_125 } },
      ]);
      harness.runtime.dispose();
    });

    it("stops after acknowledgement before the recording event", async () => {
      const harness = createHarness();
      const first = harness.runtime.handleSignal({ ...binding, signal: "pressed" });
      harness.finishStartBeforePhaseEvent();
      await first;
      vi.setSystemTime(2_125);
      const second = harness.runtime.handleSignal({ ...binding, signal: "pressed" });
      expect(harness.invocations.map((entry) => entry.command)).toEqual(["start_dictation", "stop_dictation"]);
      await second;
      expect(harness.invocations[1]?.args).toEqual({ stopReason: binding.stopReason, stopGestureEpochMs: 2_125 });
      harness.runtime.dispose();
    });

    it("drops the buffered stop when start rejects", async () => {
      const harness = createHarness({ failStart: true });
      const first = harness.runtime.handleSignal({ ...binding, signal: "pressed" });
      const second = harness.runtime.handleSignal({ ...binding, signal: "pressed" });
      expect(harness.invocations.map((entry) => entry.command)).toEqual(["start_dictation"]);
      await second;
      harness.finishStartBeforePhaseEvent();
      await expect(first).rejects.toThrow("start failed");
      expect(harness.invocations).toHaveLength(1);
      harness.runtime.dispose();
    });

    it("keeps newer ownership when an invalidated start responds late", async () => {
      let phase: Parameters<typeof resolveDictationShortcutDecision>[0]["phase"] = "idle";
      const starts: Array<() => void> = [];
      const invocations: Array<{ command: string; args: Record<string, unknown> }> = [];
      const runtime = createDictationShortcutSignalRuntime({
        getPhase: () => phase,
        invoke: (command, args) => {
          invocations.push({ command, args });
          if (command === "start_dictation") {
            return new Promise((resolve) => starts.push(() => resolve(null)));
          }
          phase = "stopping";
          return Promise.resolve(null);
        },
      });
      const stale = runtime.handleSignal({ ...binding, signal: "pressed" });
      await runtime.handleSignal({ ...binding, signal: "pressed" });
      phase = "error";
      runtime.onPhase(phase);
      const current = runtime.handleSignal({ ...binding, signal: "pressed" });
      vi.setSystemTime(3_125);
      await runtime.handleSignal({ ...binding, signal: "pressed" });
      starts[0]?.();
      await stale;
      expect(invocations.map((entry) => entry.command)).toEqual(["start_dictation", "start_dictation"]);
      starts[1]?.();
      await current;
      expect(invocations[2]).toEqual({
        command: "stop_dictation",
        args: { stopReason: binding.stopReason, stopGestureEpochMs: 3_125 },
      });
      expect(invocations).toHaveLength(3);
      runtime.dispose();
    });

    it("invalidates buffered ownership on a terminal phase", async () => {
      const harness = createHarness();
      const first = harness.runtime.handleSignal({ ...binding, signal: "pressed" });
      const second = harness.runtime.handleSignal({ ...binding, signal: "pressed" });
      expect(harness.invocations).toHaveLength(1);
      await second;
      harness.setPhase("error");
      harness.finishStartBeforePhaseEvent();
      await first;
      harness.setPhase("recording");
      expect(harness.invocations).toHaveLength(1);
      harness.runtime.dispose();
    });
  });

  it("stops a rapid hold-to-talk tap whose release lands before the start resolves", async () => {
    const harness = createHarness();

    vi.setSystemTime(1_000);
    const press = harness.runtime.handleSignal({ ...holdToTalk, signal: "pressed" });
    // The release arrives while start_dictation is still in flight and the
    // cached phase is still "idle" — previously this resolved to "ignore" and
    // the microphone recorded forever.
    vi.setSystemTime(1_125);
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
      stopGestureEpochMs: 1_125,
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

  it.each([
    { behavior: "toggle", capability: "press_only" },
    { behavior: "hold_to_talk", capability: "press_and_release" },
    { behavior: "hands_free", capability: "press_only" },
  ] as const)("starts $behavior with the starting binding's Return choice, not the stopping one's", async (mode) => {
    const harness = createHarness();
    const submitting = { profile: "normal_speed", submitAfterInsert: true } as const;
    const plain = { profile: "normal_speed" } as const;

    const press = harness.runtime.handleSignal({ ...mode, signal: "pressed", bindingId: "chat", startOptions: submitting });
    harness.finishStart();
    await press;
    await harness.runtime.handleSignal({
      ...mode,
      signal: mode.capability === "press_and_release" ? "released" : "pressed",
      bindingId: mode.capability === "press_and_release" ? "chat" : "plain",
      startOptions: plain,
    });

    expect(harness.invocations[0]).toEqual({
      command: "start_dictation",
      args: { options: submitting },
    });
    expect(harness.invocations.map((entry) => entry.command)).toEqual(["start_dictation", "stop_dictation"]);
    expect(JSON.stringify(harness.invocations[1]?.args)).not.toContain("submitAfterInsert");
    harness.runtime.dispose();
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

  describe("tap to lock", () => {
    const tapLock = { ...holdToTalk, holdTapLocks: true } as const;

    it("keeps listening after a quick tap and stops on the next press", async () => {
      const harness = createHarness();
      vi.setSystemTime(10_000);
      const press = harness.runtime.handleSignal({ ...tapLock, signal: "pressed" });
      harness.finishStart();
      await press;
      vi.setSystemTime(10_150);
      await harness.runtime.handleSignal({ ...tapLock, signal: "released" });
      expect(harness.invocations.map((entry) => entry.command)).toEqual(["start_dictation"]);

      vi.setSystemTime(14_000);
      await harness.runtime.handleSignal({ ...tapLock, signal: "pressed" });
      await harness.runtime.handleSignal({ ...tapLock, signal: "released" });
      expect(harness.invocations.map((entry) => entry.command)).toEqual([
        "start_dictation",
        "stop_dictation",
      ]);
      expect(harness.invocations[1]?.args).toEqual({
        stopReason: "tap_lock_toggle",
        stopGestureEpochMs: 14_000,
      });
    });

    it("does not send a second stop for the release of the unlocking press", async () => {
      const harness = createHarness();
      vi.setSystemTime(40_000);
      const press = harness.runtime.handleSignal({ ...tapLock, signal: "pressed" });
      harness.finishStart();
      await press;
      vi.setSystemTime(40_100);
      await harness.runtime.handleSignal({ ...tapLock, signal: "released" });

      vi.setSystemTime(44_000);
      await harness.runtime.handleSignal({ ...tapLock, signal: "pressed" });
      // The sidecar's "stopping" event has not been observed yet, so the
      // cached phase still says "recording" when the key comes back up.
      harness.setPhase("recording");
      await harness.runtime.handleSignal({ ...tapLock, signal: "released" });
      expect(harness.invocations.map((entry) => entry.command)).toEqual([
        "start_dictation",
        "stop_dictation",
      ]);

      // The next session's release is not swallowed.
      harness.setPhase("done");
      vi.setSystemTime(50_000);
      const next = harness.runtime.handleSignal({ ...tapLock, signal: "pressed" });
      harness.finishStart();
      await next;
      vi.setSystemTime(52_000);
      await harness.runtime.handleSignal({ ...tapLock, signal: "released" });
      expect(harness.invocations[harness.invocations.length - 1]).toMatchObject({
        command: "stop_dictation",
        args: { stopReason: "release" },
      });
    });

    it("still stops on release after a real hold", async () => {
      const harness = createHarness();
      vi.setSystemTime(20_000);
      const press = harness.runtime.handleSignal({ ...tapLock, signal: "pressed" });
      harness.finishStart();
      await press;
      vi.setSystemTime(22_500);
      await harness.runtime.handleSignal({ ...tapLock, signal: "released" });
      expect(harness.invocations.map((entry) => entry.command)).toEqual([
        "start_dictation",
        "stop_dictation",
      ]);
      expect(harness.invocations[1]?.args).toMatchObject({ stopReason: "release" });
    });

    it("locks a tap that lands before the start resolves, and forgets the lock once the session ends", async () => {
      const harness = createHarness();
      vi.setSystemTime(30_000);
      const press = harness.runtime.handleSignal({ ...tapLock, signal: "pressed" });
      vi.setSystemTime(30_100);
      await harness.runtime.handleSignal({ ...tapLock, signal: "released" });
      harness.finishStart();
      await press;
      await vi.runAllTimersAsync();
      expect(harness.invocations.map((entry) => entry.command)).toEqual(["start_dictation"]);

      // The session ends on its own (silence, Escape): the next press starts
      // a new one rather than trying to stop the old one.
      harness.setPhase("done");
      const next = harness.runtime.handleSignal({ ...tapLock, signal: "pressed" });
      harness.finishStart();
      await next;
      expect(harness.invocations.map((entry) => entry.command)).toEqual([
        "start_dictation",
        "start_dictation",
      ]);
    });
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

describe("explicit double tap locking", () => {
  it("keeps one capture for two short taps and stops on the next press", async () => {
    vi.useFakeTimers();
    const invoke = vi.fn().mockResolvedValue(undefined);
    const runtime = createDictationShortcutSignalRuntime({ getPhase: () => "idle", invoke });
    const input = { behavior: "hold_to_talk", capability: "press_and_release", holdDoubleTapLocks: true, bindingId: "right" } as const;
    await runtime.handleSignal({ ...input, signal: "pressed" });
    await runtime.handleSignal({ ...input, signal: "released" });
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["start_dictation"]);
    await vi.advanceTimersByTimeAsync(100);
    await runtime.handleSignal({ ...input, signal: "pressed" });
    await runtime.handleSignal({ ...input, signal: "released" });
    await vi.advanceTimersByTimeAsync(400);
    expect(invoke).toHaveBeenCalledTimes(1);
    await runtime.handleSignal({ ...input, signal: "pressed" });
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["start_dictation", "stop_dictation"]);
    runtime.dispose();
    vi.useRealTimers();
  });
});

describe("double tap cleanup and ownership", () => {
  afterEach(() => vi.useRealTimers());
  const input = { behavior: "hold_to_talk", capability: "press_and_release", holdDoubleTapLocks: true, bindingId: "right" } as const;

  it("stops a single tap after its window even when legacy single-tap lock is enabled", async () => {
    vi.useFakeTimers();
    const invoke = vi.fn().mockResolvedValue(undefined);
    const runtime = createDictationShortcutSignalRuntime({ getPhase: () => "idle", invoke });
    await runtime.handleSignal({ ...input, holdTapLocks: true, signal: "pressed" });
    await runtime.handleSignal({ ...input, holdTapLocks: true, signal: "released" });
    await vi.advanceTimersByTimeAsync(299);
    expect(invoke).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["start_dictation", "stop_dictation"]);
    runtime.dispose();
  });

  it("stops a long first or second hold on release", async () => {
    vi.useFakeTimers();
    for (const second of [false, true]) {
      const invoke = vi.fn().mockResolvedValue(undefined);
      let phase: "idle" | "recording" = "idle";
      const owned = createDictationShortcutSignalRuntime({ getPhase: () => phase, invoke });
      await owned.handleSignal({ ...input, signal: "pressed" });
      phase = "recording";
      if (second) {
        await owned.handleSignal({ ...input, signal: "released" });
        await vi.advanceTimersByTimeAsync(100);
        await owned.handleSignal({ ...input, signal: "pressed" });
      }
      await vi.advanceTimersByTimeAsync(301);
      await owned.handleSignal({ ...input, signal: "released" });
      expect(invoke.mock.calls.map(([command]) => command)).toEqual(["start_dictation", "stop_dictation"]);
      owned.dispose();
    }
  });

  it.each(["cancel", "outage", "phase", "dispose"])("clears a pending window on %s", async (reason) => {
    vi.useFakeTimers();
    const invoke = vi.fn().mockResolvedValue(undefined);
    const runtime = createDictationShortcutSignalRuntime({ getPhase: () => "idle", invoke });
    await runtime.handleSignal({ ...input, signal: "pressed" });
    await runtime.handleSignal({ ...input, signal: "released" });
    if (reason === "cancel" || reason === "outage") await runtime.handleSignal({ ...input, signal: "cancelled" });
    if (reason === "phase") runtime.onPhase("done");
    if (reason === "dispose") runtime.dispose();
    await vi.advanceTimersByTimeAsync(500);
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(
      reason === "cancel" || reason === "outage" ? ["start_dictation", "force_stop_dictation"] : ["start_dictation"],
    );
    runtime.dispose();
  });

  it("ignores another binding and protects a newer manual session", async () => {
    vi.useFakeTimers();
    let sessionId = 10;
    const invoke = vi.fn().mockResolvedValue(undefined);
    const runtime = createDictationShortcutSignalRuntime({ getPhase: () => "idle", getSessionId: () => sessionId, invoke });
    await runtime.handleSignal({ ...input, signal: "pressed" });
    runtime.onPhase("recording");
    await runtime.handleSignal({ ...input, bindingId: "other", signal: "cancelled" });
    expect(invoke).toHaveBeenCalledTimes(1);
    sessionId = 11;
    await runtime.handleSignal({ ...input, signal: "cancelled" });
    expect(invoke).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  it("cancels a chord while the start is in flight and ignores repeated downs", async () => {
    let resolveStart!: () => void;
    const invoke = vi.fn((command: string) => command === "start_dictation"
      ? new Promise<void>((resolve) => { resolveStart = resolve; }) : Promise.resolve());
    const runtime = createDictationShortcutSignalRuntime({ getPhase: () => "idle", invoke });
    const starting = runtime.handleSignal({ ...input, signal: "pressed" });
    await runtime.handleSignal({ ...input, signal: "pressed" });
    await runtime.handleSignal({ ...input, signal: "cancelled" });
    resolveStart();
    await starting;
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["start_dictation", "force_stop_dictation"]);
    runtime.dispose();
  });
});

it("uses native press time so the arm delay cannot turn a hold into a double-tap", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const invoke = vi.fn().mockResolvedValue(undefined);
  const runtime = createDictationShortcutSignalRuntime({ getPhase: () => "idle", invoke });
  const input = { behavior: "hold_to_talk", capability: "press_and_release", holdDoubleTapLocks: true, bindingId: "right" } as const;
  await runtime.handleSignal({ ...input, signal: "pressed", pressEpochMs: 800 });
  await vi.advanceTimersByTimeAsync(150);
  await runtime.handleSignal({ ...input, signal: "released" });
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["start_dictation", "stop_dictation"]);
  runtime.dispose();
  vi.useRealTimers();
});

it("cancels a locked binding on helper loss even after its physical release", async () => {
  vi.useFakeTimers();
  const invoke = vi.fn().mockResolvedValue(undefined);
  const runtime = createDictationShortcutSignalRuntime({ getPhase: () => "idle", invoke });
  const input = { behavior: "hold_to_talk", capability: "press_and_release", holdDoubleTapLocks: true, bindingId: "right" } as const;
  for (let tap = 0; tap < 2; tap++) {
    await runtime.handleSignal({ ...input, signal: "pressed" });
    await runtime.handleSignal({ ...input, signal: "released" });
  }
  await runtime.cancelOwned();
  await vi.advanceTimersByTimeAsync(400);
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["start_dictation", "force_stop_dictation"]);
  runtime.dispose();
  vi.useRealTimers();
});

it.each([299, 301])("uses physical time for a second modifier press at %s ms despite delayed reporting", async (physicalPress) => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const invoke = vi.fn().mockResolvedValue(undefined);
  const runtime = createDictationShortcutSignalRuntime({ getPhase: () => "idle", invoke });
  const input = { behavior: "hold_to_talk", capability: "press_and_release", holdDoubleTapLocks: true, bindingId: "fn", modifierArmDelayMs: 150 } as const;
  await runtime.handleSignal({ ...input, signal: "pressed", pressEpochMs: 1000 });
  await runtime.handleSignal({ ...input, signal: "released" });
  await vi.advanceTimersByTimeAsync(400);
  await runtime.handleSignal({ ...input, signal: "pressed", pressEpochMs: 1000 + physicalPress });
  await runtime.handleSignal({ ...input, signal: "released" });
  await vi.advanceTimersByTimeAsync(500);
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(physicalPress === 299 ? ["start_dictation"] : ["start_dictation", "stop_dictation"]);
  runtime.dispose();
  vi.useRealTimers();
});

it("does not mistake the prior session id for the new start before its recording event", async () => {
  let sessionId = 10;
  const invoke = vi.fn().mockResolvedValue(undefined);
  const runtime = createDictationShortcutSignalRuntime({ getPhase: () => "idle", getSessionId: () => sessionId, invoke });
  const input = { behavior: "hold_to_talk", capability: "press_and_release", bindingId: "right" } as const;
  await runtime.handleSignal({ ...input, signal: "pressed" });
  sessionId = 11;
  runtime.onPhase("recording");
  await runtime.cancelOwned();
  expect(invoke).toHaveBeenLastCalledWith("force_stop_dictation", { sessionId: 11 });
  runtime.dispose();
});

describe("native gesture occurrence and ownership", () => {
  const input = { behavior: "hold_to_talk", capability: "press_and_release", holdDoubleTapLocks: true, bindingId: "right", modifierArmDelayMs: 150 } as const;
  afterEach(() => vi.useRealTimers());

  it("does not let another binding consume the owning tap window", async () => {
    vi.useFakeTimers();
    const invoke = vi.fn().mockResolvedValue(undefined);
    const runtime = createDictationShortcutSignalRuntime({ getPhase: () => "idle", invoke });
    await runtime.handleSignal({ ...input, signal: "pressed" });
    await runtime.handleSignal({ ...input, signal: "released" });
    await runtime.handleSignal({ ...input, bindingId: "other", signal: "pressed" });
    await runtime.handleSignal({ ...input, bindingId: "other", signal: "released" });
    await vi.advanceTimersByTimeAsync(500);
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["start_dictation", "stop_dictation"]);
    runtime.dispose();
  });

  it("classifies independently delayed transitions by occurrence time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2000);
    const invoke = vi.fn().mockResolvedValue(undefined);
    const runtime = createDictationShortcutSignalRuntime({ getPhase: () => "idle", invoke });
    await runtime.handleSignal({ ...input, signal: "pressed", occurrenceEpochMs: 1000 });
    vi.setSystemTime(2400);
    await runtime.handleSignal({ ...input, signal: "released", occurrenceEpochMs: 1100 });
    expect(invoke).toHaveBeenCalledTimes(1);
    await runtime.handleSignal({ ...input, signal: "pressed", occurrenceEpochMs: 1200 });
    vi.setSystemTime(2900);
    await runtime.handleSignal({ ...input, signal: "released", occurrenceEpochMs: 1250 });
    await vi.advanceTimersByTimeAsync(500);
    expect(invoke).toHaveBeenCalledTimes(1);
    await runtime.cancelOwned();
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["start_dictation", "force_stop_dictation"]);
    runtime.dispose();
  });

  it.each(["held", "released", "cancelled", "manual"])("sequences an outside-window hold through terminal phase, %s", async (ending) => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    let phase: "idle" | "recording" | "stopping" | "done" = "idle";
    let sessionId = 10;
    let finishStop!: () => void;
    const invoke = vi.fn((command: string) => command === "stop_dictation"
      ? new Promise<void>((resolve) => { finishStop = resolve; }) : Promise.resolve());
    const runtime = createDictationShortcutSignalRuntime({ getPhase: () => phase, getSessionId: () => sessionId, invoke });
    await runtime.handleSignal({ ...input, signal: "pressed", occurrenceEpochMs: 900 });
    phase = "recording"; runtime.onPhase(phase);
    await runtime.handleSignal({ ...input, signal: "released", occurrenceEpochMs: 1000 });
    vi.setSystemTime(1400);
    const second = runtime.handleSignal({ ...input, signal: "pressed", occurrenceEpochMs: 1301 });
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["start_dictation", "stop_dictation"]);
    phase = "stopping"; runtime.onPhase(phase);
    if (ending === "released" || ending === "cancelled") {
      await runtime.handleSignal({ ...input, signal: ending, occurrenceEpochMs: 1500 });
    }
    if (ending === "manual") { sessionId = 11; phase = "recording"; runtime.onPhase(phase); }
    finishStop(); await second;
    if (ending !== "manual") { phase = "done"; runtime.onPhase(phase); }
    await Promise.resolve(); await Promise.resolve();
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(ending === "held"
      ? ["start_dictation", "stop_dictation", "start_dictation"] : ["start_dictation", "stop_dictation"]);
    if (ending === "held") {
      sessionId = 12; phase = "recording"; runtime.onPhase(phase);
      const release = runtime.handleSignal({ ...input, signal: "released", occurrenceEpochMs: 1800 });
      finishStop(); await release;
      expect(invoke).toHaveBeenLastCalledWith("stop_dictation", { stopReason: "release", stopGestureEpochMs: 1800 });
    }
    runtime.dispose();
  });

  it("discards retained capture when the second pending arm becomes a chord", async () => {
    vi.useFakeTimers();
    const invoke = vi.fn().mockResolvedValue(undefined);
    const runtime = createDictationShortcutSignalRuntime({ getPhase: () => "idle", invoke });
    await runtime.handleSignal({ ...input, signal: "pressed", occurrenceEpochMs: 1000 });
    await runtime.handleSignal({ ...input, signal: "released", occurrenceEpochMs: 1050 });
    await runtime.handleSignal({ ...input, signal: "cancelled", occurrenceEpochMs: 1150 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["start_dictation", "force_stop_dictation"]);
    runtime.dispose();
  });
});

it.each(["ack-first", "terminal-first", "release", "escape"])("waits for the buffered stop and terminal event before a separate hold, %s", async (order) => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  let phase: "idle" | "recording" | "stopping" | "done" = "idle";
  let sessionId = 10;
  let finishStart!: () => void;
  let finishStop!: () => void;
  const invoke = vi.fn((command: string) => command === "start_dictation"
    ? new Promise<void>((resolve) => { finishStart = resolve; })
    : command === "stop_dictation" ? new Promise<void>((resolve) => { finishStop = resolve; }) : Promise.resolve());
  const runtime = createDictationShortcutSignalRuntime({ getPhase: () => phase, getSessionId: () => sessionId, invoke });
  const input = { behavior: "hold_to_talk", capability: "press_and_release", holdDoubleTapLocks: true, bindingId: "right", modifierArmDelayMs: 150 } as const;
  const starting = runtime.handleSignal({ ...input, signal: "pressed", occurrenceEpochMs: 900 });
  await runtime.handleSignal({ ...input, signal: "released", occurrenceEpochMs: 1000 });
  vi.setSystemTime(1400);
  await runtime.handleSignal({ ...input, signal: "pressed", occurrenceEpochMs: 1301 });
  sessionId = 11; phase = "recording"; runtime.onPhase(phase);
  finishStart(); await Promise.resolve(); await Promise.resolve();
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["start_dictation", "stop_dictation"]);
  phase = "stopping"; runtime.onPhase(phase);
  if (order === "release") await runtime.handleSignal({ ...input, signal: "released", occurrenceEpochMs: 1500 });
  if (order === "escape") await runtime.handleSignal({ ...input, signal: "cancelled", bindingId: undefined });
  if (order === "ack-first") {
    finishStop(); await starting;
    expect(invoke).toHaveBeenCalledTimes(2);
    phase = "done"; runtime.onPhase(phase);
  } else {
    phase = "done"; runtime.onPhase(phase);
    expect(invoke).toHaveBeenCalledTimes(order === "escape" ? 3 : 2);
    finishStop(); await starting;
  }
  await Promise.resolve();
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(order === "escape"
    ? ["start_dictation", "stop_dictation", "force_stop_dictation"]
    : order === "release" ? ["start_dictation", "stop_dictation"] : ["start_dictation", "stop_dictation", "start_dictation"]);
  if (order !== "release" && order !== "escape") finishStart();
  runtime.dispose(); vi.useRealTimers();
});

it("rejects a physical gap over 300 ms even when the first release arrives late", async () => {
  vi.useFakeTimers(); vi.setSystemTime(2000);
  const invoke = vi.fn().mockResolvedValue(undefined);
  const runtime = createDictationShortcutSignalRuntime({ getPhase: () => "idle", invoke });
  const input = { behavior: "hold_to_talk", capability: "press_and_release", holdDoubleTapLocks: true, bindingId: "right", modifierArmDelayMs: 150 } as const;
  await runtime.handleSignal({ ...input, signal: "pressed", occurrenceEpochMs: 1000 });
  await runtime.handleSignal({ ...input, signal: "released", occurrenceEpochMs: 1100 });
  vi.setSystemTime(2050);
  await runtime.handleSignal({ ...input, signal: "pressed", occurrenceEpochMs: 1401 });
  expect(invoke).toHaveBeenLastCalledWith("stop_dictation", { stopReason: "release", stopGestureEpochMs: 1100 });
  runtime.onPhase("done");
  await Promise.resolve();
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["start_dictation", "stop_dictation", "start_dictation"]);
  runtime.dispose(); vi.useRealTimers();
});


it.each(["before-id", "after-id"])("cancels preparing before the start acknowledgement, %s", async (order) => {
  let finishStart!: () => void;
  let sessionId: number | null = null;
  const invoke = vi.fn((command: string, _args: Record<string, unknown>) => command === "start_dictation"
    ? new Promise<void>((resolve) => { finishStart = resolve; }) : Promise.resolve());
  const input = { behavior: "hold_to_talk", capability: "press_and_release", bindingId: "chord" } as const;
  const owned = createDictationShortcutSignalRuntime({ getPhase: () => sessionId === null ? "idle" : "preparing", getSessionId: () => sessionId, invoke });
  const starting = owned.handleSignal({ ...input, signal: "pressed" });
  if (order === "before-id") await owned.cancelOwned();
  sessionId = 42;
  owned.onPhase("preparing");
  if (order === "after-id") await owned.cancelOwned();
  expect(invoke).toHaveBeenLastCalledWith("force_stop_dictation", { sessionId: 42 });
  await owned.cancelOwned();
  owned.onPhase("idle");
  finishStart();
  await starting;
  await owned.handleSignal({ ...input, signal: "released" });
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["start_dictation", "force_stop_dictation"]);
  owned.dispose();
});


it("aborts a held chord once when Escape arrives and ignores its later release", async () => {
  const invoke = vi.fn().mockResolvedValue(undefined);
  let phase: "idle" | "recording" = "idle";
  const runtime = createDictationShortcutSignalRuntime({ getPhase: () => phase, getSessionId: () => 42, invoke });
  const input = { behavior: "hold_to_talk", capability: "press_and_release", bindingId: "chord" } as const;
  await runtime.handleSignal({ ...input, signal: "pressed" });
  phase = "recording"; runtime.onPhase(phase);
  await runtime.handleSignal({ ...input, bindingId: undefined, signal: "cancelled" });
  await runtime.handleSignal({ ...input, bindingId: undefined, signal: "cancelled" });
  await runtime.handleSignal({ ...input, signal: "released" });
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(["start_dictation", "force_stop_dictation"]);
  expect(invoke).toHaveBeenLastCalledWith("force_stop_dictation", { sessionId: 42 });
  runtime.dispose();
});


it.each([50, 350])("publishes the lock state after a %i ms chord", async (duration) => {
  const states: boolean[] = [];
  const runtime = createDictationShortcutSignalRuntime({
    getPhase: () => "idle", getSessionId: () => 42,
    invoke: vi.fn().mockResolvedValue(undefined),
    onLockChanged: (locked) => states.push(locked),
  });
  const input = { behavior: "hold_to_talk", capability: "press_and_release", bindingId: "chord", holdTapLocks: true } as const;
  await runtime.handleSignal({ ...input, signal: "pressed", occurrenceEpochMs: 1000 });
  runtime.onPhase("recording");
  await runtime.handleSignal({ ...input, signal: "released", occurrenceEpochMs: 1000 + duration });
  expect(runtime.getActivationState()).toEqual({ shortcutLocked: duration < 300, shortcutBindingId: "chord" });
  expect(states.includes(true)).toBe(duration < 300);
  runtime.dispose();
});
