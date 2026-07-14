import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { describe, expect, it, vi } from "vitest";
import { startNativeMacosShortcutController } from "../../electron/native-macos-shortcut-runtime";

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
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kill = vi.fn();
  const child = {
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
  it("does not spawn the helper outside macOS", () => {
    const spawnHelper = vi.fn();

    const controller = startNativeMacosShortcutController({
      platform: "linux",
      helperPath: "/tmp/helper",
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

  it("does not spawn the helper when the dictation shortcut was explicitly cleared", () => {
    const spawnHelper = vi.fn();

    const controller = startNativeMacosShortcutController({
      platform: "darwin",
      helperPath: "/tmp/plainsong-native-shortcut-helper",
      shortcut: "",
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

  it("spawns the helper, forwards valid shortcut events, and disposes it", () => {
    const child = createNativeShortcutTestChild();
    const spawnHelper = vi.fn(() => child);
    const onEvent = vi.fn();

    const controller = startNativeMacosShortcutController({
      platform: "darwin",
      helperPath: "/tmp/plainsong-native-shortcut-helper",
      shortcut: "Ctrl+Alt+Cmd+D",
      helperExists: () => true,
      spawnHelper,
      onEvent,
    });

    expect(controller.status).toEqual({ available: true, reason: null });
    expect(spawnHelper).toHaveBeenCalledWith(
      "/tmp/plainsong-native-shortcut-helper",
      ["--shortcut", "Ctrl+Alt+Cmd+D"],
    );

    child.stdout.write('{"type":"down","key":"D"}\n');
    child.stdout.write('{"type":"noop","key":"D"}\n');
    child.stdout.write("not json\n");
    child.stdout.write('{"type":"up","key":"D"}\n');

    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenNthCalledWith(1, { type: "down", key: "D" });
    expect(onEvent).toHaveBeenNthCalledWith(2, { type: "up", key: "D" });

    controller.dispose();

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("spawns the helper with a normalized shortcut argument", () => {
    const child = createNativeShortcutTestChild();
    const spawnHelper = vi.fn(() => child);

    startNativeMacosShortcutController({
      platform: "darwin",
      helperPath: "/tmp/plainsong-native-shortcut-helper",
      shortcut: "control option command d",
      helperExists: () => true,
      spawnHelper,
      onEvent: vi.fn(),
    });

    expect(spawnHelper).toHaveBeenCalledWith(
      "/tmp/plainsong-native-shortcut-helper",
      ["--shortcut", "Ctrl+Alt+Cmd+D"],
    );
  });

  it("marks the helper unavailable after an unexpected helper exit", () => {
    const child = createNativeShortcutTestChild();
    const onUnavailable = vi.fn();

    const controller = startNativeMacosShortcutController({
      platform: "darwin",
      helperPath: "/tmp/plainsong-native-shortcut-helper",
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
      helperExists: () => true,
      spawnHelper: () => child,
      onEvent: vi.fn(),
      onUnavailable,
    });

    child.emitExit(null, "SIGTERM");

    expect(controller.status).toEqual({ available: true, reason: null });
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it("marks the helper unavailable after a helper process error", () => {
    const child = createNativeShortcutTestChild();
    const onUnavailable = vi.fn();

    const controller = startNativeMacosShortcutController({
      platform: "darwin",
      helperPath: "/tmp/plainsong-native-shortcut-helper",
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
