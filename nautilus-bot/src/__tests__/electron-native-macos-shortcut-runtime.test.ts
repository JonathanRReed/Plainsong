import { createDictationShortcutSignalRuntime } from "../../electron/dictation-shortcut-controller";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { describe, expect, it, vi } from "vitest";
import { startNativeMacosShortcutController } from "../../electron/native-macos-shortcut-runtime";

const PRIMARY_TABLE = [
  { id: "primary", kind: "key" as const, accelerator: "Cmd+Shift+Space" },
];

type NativeShortcutTestChild = NonNullable<
  Parameters<typeof startNativeMacosShortcutController>[0]["spawnHelper"]
> extends (...args: never[]) => infer Child
  ? Child
  : never;

function createNativeShortcutTestChild(): NativeShortcutTestChild & {
  emitError: (error: Error) => void;
  emitExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  stderr: PassThrough;
  stdout: PassThrough;
} {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kill = vi.fn();
  const child = {
    stdin,
    stdout,
    stderr,
    on: (event: string, listener: (...args: unknown[]) => void) => {
      emitter.on(event, listener);
      return child;
    },
    kill,
    emitExit: (code: number | null, signal: NodeJS.Signals | null) => {
      emitter.emit("exit", code, signal);
    },
    emitError: (error: Error) => {
      emitter.emit("error", error);
    },
  };

  return child as unknown as NativeShortcutTestChild & {
    emitError: (error: Error) => void;
    emitExit: (code: number | null, signal: NodeJS.Signals | null) => void;
    stderr: PassThrough;
    stdout: PassThrough;
  };
}

describe("startNativeMacosShortcutController", () => {
  it("reports a lost event stream without waiting for helper process exit", async () => {
    const child = createNativeShortcutTestChild();
    const onUnavailable = vi.fn();
    const controller = startNativeMacosShortcutController({
      platform: "darwin", helperPath: "/fake/helper", helperBindings: PRIMARY_TABLE,
      helperExists: () => true, spawnHelper: () => child, onEvent: vi.fn(), onUnavailable,
    });
    const ended = new Promise<void>(resolve => child.stdout.once("end", resolve));
    child.stdout.end();
    await ended;
    expect(controller.status.available).toBe(false);
    expect(onUnavailable).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledOnce();
    child.emitExit(1, null);
    expect(onUnavailable).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it("does not spawn the helper outside macOS", () => {
    const spawnHelper = vi.fn();

    const controller = startNativeMacosShortcutController({
      platform: "linux",
      helperPath: "/tmp/helper",
      helperBindings: PRIMARY_TABLE,
      helperExists: () => true,
      spawnHelper,
      onEvent: vi.fn(),
    });

    expect(controller.status).toEqual({
      available: false,
      reason: "unsupported_platform",
    });
    expect(spawnHelper).not.toHaveBeenCalled();
  });

  it("does not spawn the helper when every dictation binding was removed", () => {
    const spawnHelper = vi.fn();

    const controller = startNativeMacosShortcutController({
      platform: "darwin",
      helperPath: "/tmp/plainsong-native-shortcut-helper",
      helperBindings: [],
      helperExists: () => true,
      spawnHelper,
      onEvent: vi.fn(),
    });

    expect(controller.status).toEqual({
      available: false,
      reason: "shortcut_disabled",
    });
    expect(spawnHelper).not.toHaveBeenCalled();
  });

  it("reports helper unavailable when the macOS helper is missing", () => {
    const spawnHelper = vi.fn();

    const controller = startNativeMacosShortcutController({
      platform: "darwin",
      helperPath: "/tmp/helper",
      helperBindings: PRIMARY_TABLE,
      helperExists: () => false,
      spawnHelper,
      onEvent: vi.fn(),
    });

    expect(controller.status).toEqual({
      available: false,
      reason: "helper_unavailable",
    });
    expect(spawnHelper).not.toHaveBeenCalled();
  });

  it("spawns the helper with the binding table, forwards its events, and disposes it", () => {
    const child = createNativeShortcutTestChild();
    const spawnHelper = vi.fn(() => child);
    const onEvent = vi.fn();
    const table = [
      { id: "primary", kind: "key" as const, accelerator: "Ctrl+Alt+Cmd+D" },
      { id: "back-button", kind: "mouse" as const, button: 4 as const, modifiers: [] },
      { id: "fn-alone", kind: "modifier" as const, modifier: "Fn" },
    ];

    const controller = startNativeMacosShortcutController({
      platform: "darwin",
      helperPath: "/tmp/plainsong-native-shortcut-helper",
      helperBindings: table,
      helperExists: () => true,
      spawnHelper,
      onEvent,
    });

    expect(controller.status).toEqual({ available: true, reason: null });
    expect(spawnHelper).toHaveBeenCalledTimes(1);
    const [helperPath, args] = spawnHelper.mock.calls[0] as unknown as [string, string[]];
    expect(helperPath).toBe("/tmp/plainsong-native-shortcut-helper");
    expect(args[0]).toBe("--bindings");
    expect(JSON.parse(args[1])).toEqual(table);

    child.stdout.write('{"event":"down","bindingId":"primary"}\n');
    child.stdout.write('{"event":"noop","bindingId":"primary"}\n');
    child.stdout.write('{"type":"down","key":"D"}\n');
    child.stdout.write("not json\n");
    child.stdout.write('{"event":"up","bindingId":"primary"}\n');
    child.stdout.write('{"event":"down","bindingId":"back-button"}\n');

    expect(onEvent).toHaveBeenCalledTimes(3);
    expect(onEvent).toHaveBeenNthCalledWith(1, { event: "down", bindingId: "primary" });
    expect(onEvent).toHaveBeenNthCalledWith(2, { event: "up", bindingId: "primary" });
    expect(onEvent).toHaveBeenNthCalledWith(3, { event: "down", bindingId: "back-button" });

    controller.dispose();

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("marks the helper unavailable after an unexpected helper exit", () => {
    const child = createNativeShortcutTestChild();
    const onUnavailable = vi.fn();

    const controller = startNativeMacosShortcutController({
      platform: "darwin",
      helperPath: "/tmp/plainsong-native-shortcut-helper",
      helperBindings: PRIMARY_TABLE,
      helperExists: () => true,
      spawnHelper: () => child,
      onEvent: vi.fn(),
      onUnavailable,
    });

    expect(controller.status).toEqual({ available: true, reason: null });

    child.emitExit(2, null);

    expect(controller.status).toEqual({
      available: false,
      reason: "helper_unavailable",
    });
    expect(onUnavailable).toHaveBeenCalledWith(controller.status);
  });

  it("does not mark the helper unavailable during normal disposal", () => {
    const child = createNativeShortcutTestChild();
    const onUnavailable = vi.fn();

    const controller = startNativeMacosShortcutController({
      platform: "darwin",
      helperPath: "/tmp/plainsong-native-shortcut-helper",
      helperBindings: PRIMARY_TABLE,
      helperExists: () => true,
      spawnHelper: () => child,
      onEvent: vi.fn(),
      onUnavailable,
    });

    controller.dispose();
    child.emitExit(null, "SIGTERM");

    expect(controller.status).toEqual({ available: true, reason: null });
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it.each([
    [0, null],
    [null, "SIGTERM"],
  ] as const)("reports unexpected helper exit %s/%s", (code, signal) => {
    const child = createNativeShortcutTestChild();
    const onUnavailable = vi.fn();
    const controller = startNativeMacosShortcutController({
      platform: "darwin",
      helperPath: "/tmp/helper",
      helperBindings: PRIMARY_TABLE,
      helperExists: () => true,
      spawnHelper: () => child,
      onEvent: vi.fn(),
      onUnavailable,
    });

    child.emitExit(code, signal);

    expect(controller.status).toEqual({
      available: false,
      reason: "helper_unavailable",
    });
    expect(onUnavailable).toHaveBeenCalledExactlyOnceWith(controller.status);
  });

  it("marks the helper unavailable after a helper process error", () => {
    const child = createNativeShortcutTestChild();
    const onUnavailable = vi.fn();

    const controller = startNativeMacosShortcutController({
      platform: "darwin",
      helperPath: "/tmp/plainsong-native-shortcut-helper",
      helperBindings: PRIMARY_TABLE,
      helperExists: () => true,
      spawnHelper: () => child,
      onEvent: vi.fn(),
      onUnavailable,
    });

    child.emitError(new Error("permission denied"));

    expect(controller.status).toEqual({
      available: false,
      reason: "helper_unavailable",
    });
    expect(onUnavailable).toHaveBeenCalledWith(controller.status);
  });

  it("ignores a stale crash-exit that fires after the controller was disposed", () => {
    const child = createNativeShortcutTestChild();
    const onUnavailable = vi.fn();

    const controller = startNativeMacosShortcutController({
      platform: "darwin",
      helperPath: "/tmp/plainsong-native-shortcut-helper",
      helperBindings: PRIMARY_TABLE,
      helperExists: () => true,
      spawnHelper: () => child,
      onEvent: vi.fn(),
      onUnavailable,
    });

    controller.dispose();
    // A queued crash-exit from the old helper must not report unavailability
    // (which would clobber the state of a freshly spawned replacement).
    child.emitExit(1, null);

    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it("reports helper unavailability once when error and exit both fire", () => {
    const child = createNativeShortcutTestChild();
    const onUnavailable = vi.fn();

    const controller = startNativeMacosShortcutController({
      platform: "darwin",
      helperPath: "/tmp/plainsong-native-shortcut-helper",
      helperBindings: PRIMARY_TABLE,
      helperExists: () => true,
      spawnHelper: () => child,
      onEvent: vi.fn(),
      onUnavailable,
    });

    child.emitError(new Error("permission denied"));
    child.emitExit(2, null);

    expect(controller.status).toEqual({
      available: false,
      reason: "helper_unavailable",
    });
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(onUnavailable).toHaveBeenCalledWith(controller.status);
  });
});


it("starts inactive, resends session state, and clears it on helper loss or disposal", () => {
  for (const ending of ["exit", "error", "dispose"] as const) {
    const child = createNativeShortcutTestChild();
    const writes: string[] = [];
    child.stdin.on("data", (chunk) => writes.push(String(chunk)));
    const controller = startNativeMacosShortcutController({
      platform: "darwin", helperPath: "/tmp/helper", helperBindings: PRIMARY_TABLE,
      helperExists: () => true, spawnHelper: () => child, onEvent: vi.fn(),
    });
    expect(writes).toEqual(['{"sessionActive":false}\n']);
    controller.setSessionActive(true);
    controller.setSessionActive(false);
    controller.setSessionActive(true);
    if (ending === "dispose") controller.dispose();
    if (ending === "exit") child.emitExit(1, null);
    if (ending === "error") child.emitError(new Error("lost helper"));
    expect(writes).toEqual([false, true, false, true, false].map((sessionActive) => `${JSON.stringify({ sessionActive })}\n`));
    controller.setSessionActive(true);
    expect(writes).toHaveLength(5);
  }
});


it.each([42, 43])("helper loss cancels only its owner, current session %i", async (currentSessionId) => {
  const invoke = vi.fn().mockResolvedValue(undefined);
  let phase: "idle" | "recording" = "idle";
  let sessionId = 42;
  const owned = createDictationShortcutSignalRuntime({ getPhase: () => phase, getSessionId: () => sessionId, invoke });
  const input = { behavior: "hold_to_talk", capability: "press_and_release", bindingId: "primary" } as const;
  await owned.handleSignal({ ...input, signal: "pressed" });
  phase = "recording"; owned.onPhase(phase);
  sessionId = currentSessionId;
  const child = createNativeShortcutTestChild();
  let cancellation = Promise.resolve();
  const controller = startNativeMacosShortcutController({
    platform: "darwin", helperPath: "/tmp/helper", helperBindings: PRIMARY_TABLE,
    helperExists: () => true, spawnHelper: () => child, onEvent: vi.fn(),
    onUnavailable: () => { cancellation = owned.cancelOwned(); },
  });
  child.emitExit(1, null);
  child.emitExit(1, null);
  await cancellation;
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(currentSessionId === 42
    ? ["start_dictation", "force_stop_dictation"] : ["start_dictation"]);
  if (currentSessionId === 42) expect(invoke).toHaveBeenLastCalledWith("force_stop_dictation", { sessionId: 42 });
  expect(invoke.mock.calls.some(([command]) => command === "stop_dictation")).toBe(false);
  controller.dispose(); owned.dispose();
});
