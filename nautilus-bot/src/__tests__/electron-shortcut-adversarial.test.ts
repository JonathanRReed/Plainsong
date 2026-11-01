import { afterEach, describe, expect, it, vi } from "vitest";
import { createDictationShortcutSignalRuntime, DICTATION_HOLD_WATCHDOG_MS } from "../../electron/dictation-shortcut-controller";

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("shortcut storms", () => {
  it.each(["hold_to_talk", "toggle"] as const)("coalesces stop signals while %s is awaiting its stop response", async behavior => {
    let finishStop!: () => void;
    const stopping = new Promise<void>(resolve => { finishStop = resolve; });
    const invoke = vi.fn((command: string) => command === "stop_dictation"
      ? stopping : Promise.resolve());
    const runtime = createDictationShortcutSignalRuntime({ getPhase: () => "recording", invoke });
    const storms = Array.from({ length: 1000 }, () => runtime.handleSignal({
      behavior, capability: "press_and_release", signal: behavior === "toggle" ? "pressed" : "released",
    }));
    finishStop();
    await Promise.all(storms);
    expect(invoke).toHaveBeenCalledTimes(1);
    runtime.dispose();
  });

  it("does not let a pending stop suppress a newer session and retries a failed stop", async () => {
    let finishOld!: () => void;
    let sessionId = 1;
    const old = new Promise<void>(resolve => { finishOld = resolve; });
    const invoke = vi.fn().mockReturnValueOnce(old).mockRejectedValueOnce(new Error("try again")).mockResolvedValue(undefined);
    const runtime = createDictationShortcutSignalRuntime({ getPhase: () => "recording", getSessionId: () => sessionId, invoke });
    const input = { behavior: "toggle", capability: "press_only", signal: "pressed" } as const;
    const first = runtime.handleSignal(input);
    sessionId = 2;
    await expect(runtime.handleSignal(input)).rejects.toThrow("try again");
    await runtime.handleSignal(input);
    finishOld();
    await first;
    expect(invoke).toHaveBeenCalledTimes(3);
    runtime.dispose();
  });

  it("coalesces held-key repeats and bounds a hold past ten minutes", async () => {
    vi.useFakeTimers();
    let phase: "idle" | "recording" | "stopping" = "idle";
    const invoke = vi.fn(async (command: string) => {
      if (command === "start_dictation") phase = "recording";
      if (command === "stop_dictation") phase = "stopping";
    });
    const runtime = createDictationShortcutSignalRuntime({ getPhase: () => phase, invoke });
    const press = { behavior: "hold_to_talk", capability: "press_and_release", signal: "pressed", bindingId: "held" } as const;
    await runtime.handleSignal(press);
    await Promise.all(Array.from({ length: 1000 }, () => runtime.handleSignal(press)));
    expect(invoke).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DICTATION_HOLD_WATCHDOG_MS - 1);
    expect(invoke).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(invoke).toHaveBeenLastCalledWith("stop_dictation", expect.objectContaining({ stopReason: "watchdog_timeout" }));
    runtime.onPhase(phase);
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    await runtime.handleSignal({ ...press, signal: "released" });
    expect(invoke).toHaveBeenCalledTimes(2);
    runtime.dispose();
  });
});
