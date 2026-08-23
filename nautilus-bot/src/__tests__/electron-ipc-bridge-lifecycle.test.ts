import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  finalizeMeetingWithinBudget,
  nextActiveMeetingRecordingId,
  resolveMeetingStopId,
} from "../../electron/meeting-lifecycle";

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
}));

vi.mock("electron/main", () => ({
  default: {},
  ipcMain: {
    handle: mocks.handle,
  },
}));

type FakeChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
};

describe("Electron meeting lifecycle mirror", () => {
  it("does not clear the active identifier when Stop enters processing", () => {
    expect(
      nextActiveMeetingRecordingId("meeting-1", {
        phase: "processing",
        recordingId: "meeting-1",
      }),
    ).toBe("meeting-1");
  });

  it("clears only after a confirmed terminal event", () => {
    expect(
      nextActiveMeetingRecordingId("meeting-1", {
        phase: "ready",
        recordingId: "meeting-1",
      }),
    ).toBeNull();
    expect(
      nextActiveMeetingRecordingId("meeting-2", {
        phase: "ready",
        recordingId: "meeting-1",
      }),
    ).toBe("meeting-2");
  });

  it("does not let background processing replace a live capture identifier", () => {
    expect(
      nextActiveMeetingRecordingId("meeting-live", {
        phase: "processing",
        recordingId: "meeting-retry",
      }),
    ).toBe("meeting-live");
  });

  it("uses the caller identifier for idempotent duplicate Stop", () => {
    expect(resolveMeetingStopId(null, "meeting-1")).toBe("meeting-1");
    expect(() => resolveMeetingStopId("meeting-2", "meeting-1")).toThrow(
      "does not match",
    );
  });

  it("distinguishes a confirmed stop, timeout, and immediate stop failure", async () => {
    await expect(
      finalizeMeetingWithinBudget(async () => undefined, 25),
    ).resolves.toEqual({ status: "confirmed" });

    await expect(
      finalizeMeetingWithinBudget(
        () => new Promise<void>(() => undefined),
        1,
      ),
    ).resolves.toEqual({ status: "timed_out" });

    const error = new Error("audio finalization failed");
    await expect(
      finalizeMeetingWithinBudget(async () => {
        throw error;
      }, 25),
    ).resolves.toEqual({ status: "failed", error });
  });
});

function fakeChildProcess(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  return child;
}

function replyToSidecarRequests(
  child: FakeChild,
  reply: (request: { id: string; method: string }) =>
    | { result: unknown }
    | { error: { message: string } }
    | null,
): void {
  let buffered = "";
  child.stdin.on("data", (chunk) => {
    buffered += String(chunk);
    while (buffered.includes("\n")) {
      const newline = buffered.indexOf("\n");
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line.trim()) continue;
      const request = JSON.parse(line) as { id: string; method: string };
      const response = reply(request);
      if (response) {
        child.stdout.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            ...response,
          })}\n`,
        );
      }
    }
  });
}

describe("IpcBridge shutdown lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects pending and new commands without leaking a shutdown EPIPE", async () => {
    const child = fakeChildProcess();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { IpcBridge } = await import("../../electron/ipc-bridge");
    const spawnProcess = vi.fn(
      () => child
    ) as unknown as typeof import("node:child_process").spawn;
    const bridge = new IpcBridge("/tmp/plainsong-sidecar", spawnProcess);

    bridge.start();
    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(child.stdin.listenerCount("error")).toBeGreaterThan(0);
    const pending = bridge.invoke("get_settings");
    bridge.shutdown();

    await expect(pending).rejects.toThrow("Plainsong is shutting down");
    await expect(bridge.invoke("get_settings")).rejects.toThrow(
      "Plainsong is shutting down"
    );
    expect(child.stdin.listenerCount("error")).toBeGreaterThan(0);
    expect(() => {
      child.stdin.emit(
        "error",
        Object.assign(new Error("write EPIPE"), { code: "EPIPE" })
      );
    }).not.toThrow();
    expect(consoleError).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3000);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    consoleError.mockRestore();
  });

  it("restarts the sidecar and retries a stalled microphone start once", async () => {
    const firstChild = fakeChildProcess();
    const replacementChild = fakeChildProcess();
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { IpcBridge } = await import("../../electron/ipc-bridge");
    const spawnProcess = vi
      .fn()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(replacementChild) as unknown as typeof import("node:child_process").spawn;

    replyToSidecarRequests(firstChild, (request) =>
      request.method === "start_recording"
        ? {
            error: {
              message: "Timed out waiting for microphone stream preparation",
            },
          }
        : null,
    );
    replyToSidecarRequests(replacementChild, (request) =>
      request.method === "start_recording"
        ? { result: "recording-after-restart" }
        : null,
    );

    const bridge = new IpcBridge("/tmp/plainsong-sidecar", spawnProcess);
    bridge.start();
    const start = bridge.invoke("start_recording", {
      options: { mic: true, systemAudio: false },
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(firstChild.kill).toHaveBeenCalledWith("SIGTERM");
    firstChild.emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(1025);

    await expect(start).resolves.toBe("recording-after-restart");
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    consoleWarn.mockRestore();
  });

  it("rejects duplicate privileged work before sending a second request", async () => {
    const child = fakeChildProcess();
    const { IpcBridge } = await import("../../electron/ipc-bridge");
    const spawnProcess = vi.fn(
      () => child,
    ) as unknown as typeof import("node:child_process").spawn;
    let firstRequestId: string | null = null;
    replyToSidecarRequests(child, (request) => {
      if (request.method === "download_whisper_model") {
        firstRequestId = request.id;
      }
      return null;
    });

    const bridge = new IpcBridge("/tmp/plainsong-sidecar", spawnProcess);
    bridge.start();
    const first = bridge.invoke("download_whisper_model", {
      modelName: "base.en",
    });
    await vi.advanceTimersByTimeAsync(0);

    await expect(
      bridge.invoke("download_whisper_model", { modelName: "base.en" }),
    ).rejects.toThrow("SIDECAR_DUPLICATE");
    expect(firstRequestId).not.toBeNull();

    child.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: firstRequestId,
        result: null,
      })}\n`,
    );
    await expect(first).resolves.toBeNull();
    bridge.shutdown();
  });
});

describe("IpcBridge crash-loop containment", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("probes a replacement sidecar and announces recovery without a renderer request", async () => {
    const firstChild = fakeChildProcess();
    const replacementChild = fakeChildProcess();
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const spawnProcess = vi
      .fn()
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(replacementChild) as unknown as typeof import("node:child_process").spawn;
    replyToSidecarRequests(replacementChild, (request) =>
      request.method === "get_settings" ? { result: {} } : null,
    );

    const { IpcBridge } = await import("../../electron/ipc-bridge");
    const bridge = new IpcBridge("/tmp/plainsong-sidecar", spawnProcess);
    const runtimeEvents: Array<{ name: string; payload: unknown }> = [];
    bridge.onEvent((name, payload) => runtimeEvents.push({ name, payload }));
    bridge.start();

    firstChild.emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(1_000);
    replacementChild.emit("spawn");
    await vi.advanceTimersByTimeAsync(0);

    expect(runtimeEvents).toContainEqual({
      name: "sidecar-runtime-changed",
      payload: { ready: false, reason: "Sidecar process exited (code=1, signal=null)" },
    });
    expect(runtimeEvents).toContainEqual({
      name: "sidecar-runtime-changed",
      payload: { ready: true },
    });

    bridge.shutdown();
    consoleWarn.mockRestore();
  });

  it("stops respawning a sidecar that starts and immediately dies", async () => {
    // The 'spawn' event fires when the process is created, not when it is
    // usable. Resetting the restart budget there meant a start-then-crash loop
    // refreshed its own budget every cycle and respawned forever.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const children: FakeChild[] = [];
    const spawnProcess = vi.fn(() => {
      const child = fakeChildProcess();
      children.push(child);
      return child as never;
    });

    const { IpcBridge } = await import("../../electron/ipc-bridge");
    const bridge = new IpcBridge("/tmp/plainsong-sidecar", spawnProcess);
    bridge.start();

    // Each generation spawns, announces itself, then dies without ever
    // answering a request.
    for (let i = 0; i < 12; i += 1) {
      const child = children[children.length - 1];
      if (!child) break;
      child.emit("spawn");
      child.emit("exit", 1, null);
      await vi.advanceTimersByTimeAsync(31_000);
    }

    // 1 initial + at most maxRestarts (5) respawns.
    expect(spawnProcess.mock.calls.length).toBeLessThanOrEqual(6);

    consoleError.mockRestore();
    consoleLog.mockRestore();
    consoleWarn.mockRestore();
  });

  it("restores the restart budget once the sidecar actually answers", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const children: FakeChild[] = [];
    const spawnProcess = vi.fn(() => {
      const child = fakeChildProcess();
      children.push(child);
      return child as never;
    });

    const { IpcBridge } = await import("../../electron/ipc-bridge");
    const bridge = new IpcBridge("/tmp/plainsong-sidecar", spawnProcess);
    bridge.start();

    // Burn four of the five restarts without ever becoming healthy.
    for (let i = 0; i < 4; i += 1) {
      const child = children[children.length - 1];
      if (!child) break;
      child.emit("spawn");
      child.emit("exit", 1, null);
      await vi.advanceTimersByTimeAsync(31_000);
    }
    const spawnsBeforeHealth = spawnProcess.mock.calls.length;

    // This generation talks: a well-formed reply is the health signal.
    const healthy = children[children.length - 1];
    expect(healthy).toBeTruthy();
    healthy.emit("spawn");
    replyToSidecarRequests(healthy, (request) =>
      request.method === "get_settings" ? { result: {} } : null,
    );
    await expect(bridge.invoke("get_settings", {})).resolves.toEqual({});

    // With the budget restored, a later crash can still be recovered from.
    healthy.emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(spawnProcess.mock.calls.length).toBeGreaterThan(spawnsBeforeHealth);

    consoleError.mockRestore();
    consoleLog.mockRestore();
    consoleWarn.mockRestore();
  });
});

describe("IpcBridge sender validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects commands from a frame main does not recognize", async () => {
    // The allowlist decides *what* may be asked for; this decides *who* may
    // ask. Without it, any frame carrying our preload reaches the sidecar.
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { IpcBridge } = await import("../../electron/ipc-bridge");
    const bridge = new IpcBridge("/tmp/plainsong-sidecar", (() =>
      fakeChildProcess()) as never);
    bridge.onValidateSender((url) => url.startsWith("plainsong://bundle/"));
    bridge.start();

    const handler = mocks.handle.mock.calls.find(
      ([channel]) => channel === "sidecar:invoke",
    )?.[1] as (event: unknown, command: string, args?: unknown) => Promise<unknown>;
    expect(handler).toBeTruthy();

    await expect(
      handler({ senderFrame: { url: "https://evil.example/x" } }, "get_settings", {}),
    ).rejects.toThrow(/untrusted sender/i);

    consoleWarn.mockRestore();
  });

  it("rejects a command whose sender frame reports no URL", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { IpcBridge } = await import("../../electron/ipc-bridge");
    const bridge = new IpcBridge("/tmp/plainsong-sidecar", (() =>
      fakeChildProcess()) as never);
    bridge.onValidateSender((url) => url.startsWith("plainsong://bundle/"));
    bridge.start();

    const handler = mocks.handle.mock.calls.find(
      ([channel]) => channel === "sidecar:invoke",
    )?.[1] as (event: unknown, command: string, args?: unknown) => Promise<unknown>;

    await expect(handler({ senderFrame: undefined }, "get_settings", {})).rejects.toThrow(
      /untrusted sender/i,
    );

    consoleWarn.mockRestore();
  });

  it("allows the packaged renderer origin through", async () => {
    const child = fakeChildProcess();
    const { IpcBridge } = await import("../../electron/ipc-bridge");
    const bridge = new IpcBridge("/tmp/plainsong-sidecar", (() => child) as never);
    bridge.onValidateSender((url) => url.startsWith("plainsong://bundle/"));
    bridge.start();
    replyToSidecarRequests(child, (request) =>
      request.method === "get_settings" ? { result: { ok: true } } : null,
    );

    const handler = mocks.handle.mock.calls.find(
      ([channel]) => channel === "sidecar:invoke",
    )?.[1] as (event: unknown, command: string, args?: unknown) => Promise<unknown>;

    await expect(
      handler(
        { senderFrame: { url: "plainsong://bundle/index.html" } },
        "get_settings",
        {},
      ),
    ).resolves.toEqual({ ok: true });
  });
});
