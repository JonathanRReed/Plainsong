import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  finalizeMeetingWithinBudget,
  interruptedMeetingMessage,
  nextActiveMeetingPhase,
  nextActiveMeetingRecordingId,
  resolveMeetingStopId,
  type MeetingLifecyclePhase,
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

  it("follows a new meeting that starts while the last one is still transcribing", () => {
    let activeId: string | null = "meeting-a";
    let phase: MeetingLifecyclePhase | null = "processing";
    for (const event of [
      { phase: "preparing", recordingId: "meeting-b" },
      { phase: "recording", recordingId: "meeting-b" },
      // Meeting A finishing must not take the menu bar back.
      { phase: "processing", recordingId: "meeting-a" },
      { phase: "ready", recordingId: "meeting-a" },
    ] as const) {
      activeId = nextActiveMeetingRecordingId(activeId, event, phase);
      phase = nextActiveMeetingPhase(phase, activeId, event);
    }
    expect(activeId).toBe("meeting-b");
    expect(phase).toBe("recording");
  });

  it("does not let a new meeting's events replace one that is still capturing", () => {
    expect(
      nextActiveMeetingRecordingId(
        "meeting-live",
        { phase: "preparing", recordingId: "meeting-other" },
        "recording",
      ),
    ).toBe("meeting-live");
  });

  it("tells a capture interruption apart from a transcription interruption", () => {
    expect(interruptedMeetingMessage("recording")).toContain("Recording stopped unexpectedly");
    expect(interruptedMeetingMessage("processing")).toContain("transcribe it again");
    expect(interruptedMeetingMessage("processing")).not.toContain("Recording stopped");
  });

  it.each(["preparing", "recording", "stopping"] satisfies MeetingLifecyclePhase[])(
    "does not promise saved audio before recovery validates a %s meeting",
    (phase) => {
      expect(interruptedMeetingMessage(phase)).not.toContain("was saved");
      expect(interruptedMeetingMessage(phase)).toContain("check");
    },
  );

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

  it("admits finalization work but rejects new capture while quit is pending", async () => {
    const child = fakeChildProcess();
    const { IpcBridge } = await import("../../electron/ipc-bridge");
    const spawnProcess = vi.fn(
      () => child,
    ) as unknown as typeof import("node:child_process").spawn;
    const receivedCommands: string[] = [];
    replyToSidecarRequests(child, (request) => {
      receivedCommands.push(request.method);
      return { result: null };
    });
    const bridge = new IpcBridge("/tmp/plainsong-sidecar", spawnProcess);
    bridge.start();
    bridge.setQuitPending(true);

    await expect(bridge.invokeSidecar("start_dictation", {})).rejects.toThrow(
      "Plainsong is shutting down",
    );
    await expect(bridge.invokeSidecar("start_recording", {})).rejects.toThrow(
      "Plainsong is shutting down",
    );
    await expect(
      bridge.invokeSidecar("save_dictation_draft", { text: "late words" }),
    ).resolves.toBeNull();
    await expect(
      bridge.invokeSidecar("stop_recording", { recordingId: "meeting-1" }),
    ).resolves.toBeNull();

    expect(receivedCommands).toEqual([
      "save_dictation_draft",
      "stop_recording",
    ]);
    bridge.shutdown();
  });

  it("restores capture admission when a pending quit is cancelled", async () => {
    const child = fakeChildProcess();
    const { IpcBridge } = await import("../../electron/ipc-bridge");
    const spawnProcess = vi.fn(
      () => child,
    ) as unknown as typeof import("node:child_process").spawn;
    replyToSidecarRequests(child, () => ({ result: "started" }));
    const bridge = new IpcBridge("/tmp/plainsong-sidecar", spawnProcess);
    bridge.start();
    bridge.setQuitPending(true);
    bridge.setQuitPending(false);

    await expect(
      bridge.invokeSidecar("start_dictation", {}),
    ).resolves.toBe("started");
    bridge.shutdown();
  });

  it("does not inherit quit-pending state in a new bridge", async () => {
    const firstChild = fakeChildProcess();
    const secondChild = fakeChildProcess();
    const { IpcBridge } = await import("../../electron/ipc-bridge");
    const firstBridge = new IpcBridge(
      "/tmp/plainsong-sidecar",
      vi.fn(() => firstChild) as unknown as typeof import("node:child_process").spawn,
    );
    firstBridge.start();
    firstBridge.setQuitPending(true);

    replyToSidecarRequests(secondChild, () => ({ result: "started" }));
    const secondBridge = new IpcBridge(
      "/tmp/plainsong-sidecar",
      vi.fn(() => secondChild) as unknown as typeof import("node:child_process").spawn,
    );
    secondBridge.start();

    await expect(
      secondBridge.invokeSidecar("start_recording", {}),
    ).resolves.toBe("started");
    firstBridge.shutdown();
    secondBridge.shutdown();
  });

  it("injects trusted relay credentials without forwarding ambient relay or OAuth keys", async () => {
    const { IpcBridge } = await import("../../electron/ipc-bridge");
    const { buildSidecarEnv } = await import("../../electron/sidecar-env");
    const child = fakeChildProcess();
    const spawnMock = vi.fn(() => child);
    vi.stubEnv("PLAINSONG_CHATGPT_RELAY_KEY", "untrusted-ambient-relay");
    vi.stubEnv("PLAINSONG_CHATGPT_RELAY_URL", "https://untrusted.example.invalid");
    vi.stubEnv("OPENAI_API_KEY", "dummy-oauth-or-api-key");
    const bridge = new IpcBridge("/tmp/plainsong-sidecar", spawnMock as unknown as typeof import("node:child_process").spawn, {
      PLAINSONG_CHATGPT_RELAY_URL: "http://127.0.0.1:49152",
      PLAINSONG_CHATGPT_RELAY_KEY: "trusted-session-relay",
    });
    try {
      expect(buildSidecarEnv(process.env).PLAINSONG_CHATGPT_RELAY_KEY).toBeUndefined();
      bridge.start();
      const options = (spawnMock.mock.calls as unknown as Array<[string, string[], { env: NodeJS.ProcessEnv }]>)[0][2];
      expect(options.env.PLAINSONG_CHATGPT_RELAY_URL).toBe("http://127.0.0.1:49152");
      expect(options.env.PLAINSONG_CHATGPT_RELAY_KEY).toBe("trusted-session-relay");
      expect(options.env.OPENAI_API_KEY).toBeUndefined();
    } finally { bridge.shutdown();vi.unstubAllEnvs(); }
  });

  it("rejects pending and new commands without leaking a shutdown EPIPE", async () => {
    const child = fakeChildProcess();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { IpcBridge, SIDECAR_SHUTDOWN_GRACE_MS } = await import("../../electron/ipc-bridge");
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
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SIDECAR_SHUTDOWN_GRACE_MS - 3000);
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

  it("stops automatic retries when startup requires credential access", async () => {
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
    const pending = bridge.invokeSidecar("get_settings", {});
    const pendingRejection = expect(pending).rejects.toThrow("requires credential access");

    children[0].stderr.write("startup failed [PLAINSONG_CRED");
    children[0].stderr.write("ENTIAL_REQUIRED] unlock keychain");
    children[0].emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(31_000);

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(bridge.getRuntimeStatus()).toEqual({
      ready: false,
      reason: "credential_required",
      message: "Sidecar startup requires credential access",
    });
    await pendingRejection;
    consoleWarn.mockRestore();
  });

  it("upgrades an exit to credential-required when stderr drains afterward", async () => {
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

    children[0].emit("exit", 1, null);
    children[0].stderr.write("[PLAINSONG_CREDENTIAL_REQUIRED]");
    await vi.advanceTimersByTimeAsync(31_000);

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(bridge.getRuntimeStatus()).toEqual({
      ready: false,
      reason: "credential_required",
      message: "Sidecar startup requires credential access",
    });
    consoleLog.mockRestore();
    consoleWarn.mockRestore();
  });

  it("finds a credential marker before a long suffix exceeds the stderr tail", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const child = fakeChildProcess();
    const spawnProcess = vi.fn(() => child as never);
    const { IpcBridge } = await import("../../electron/ipc-bridge");
    const bridge = new IpcBridge("/tmp/plainsong-sidecar", spawnProcess);
    bridge.start();

    child.stderr.write(`[PLAINSONG_CREDENTIAL_REQUIRED]${"x".repeat(9_000)}`);
    child.emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(31_000);

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(bridge.getRuntimeStatus().reason).toBe("credential_required");
    consoleWarn.mockRestore();
  });

  it("retries once with credential access and scrubs the flag from later automatic spawns", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const children: FakeChild[] = [];
    const spawnProcess = vi.fn(() => {
      const child = fakeChildProcess();
      children.push(child);
      return child as never;
    });
    const { IpcBridge } = await import("../../electron/ipc-bridge");
    const bridge = new IpcBridge(
      "/tmp/plainsong-sidecar",
      spawnProcess,
      { PLAINSONG_STARTUP_CREDENTIAL_ACCESS: "ambient-must-not-pass" },
    );
    bridge.start();
    children[0].stderr.write("[PLAINSONG_CREDENTIAL_REQUIRED]");
    children[0].emit("exit", 1, null);

    expect(() => bridge.retryWithCredentialAccess()).not.toThrow();
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    const spawnCalls = spawnProcess.mock.calls as unknown as Array<
      [string, string[], { env: NodeJS.ProcessEnv }]
    >;
    expect(spawnCalls[0][2].env.PLAINSONG_STARTUP_CREDENTIAL_ACCESS).toBeUndefined();
    expect(spawnCalls[1][2].env.PLAINSONG_STARTUP_CREDENTIAL_ACCESS).toBe("1");
    expect(() => bridge.retryWithCredentialAccess()).toThrow(/still running/i);

    children[1].emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(spawnProcess).toHaveBeenCalledTimes(3);
    expect(spawnCalls[2][2].env.PLAINSONG_STARTUP_CREDENTIAL_ACCESS).toBeUndefined();
    bridge.shutdown();
    consoleLog.mockRestore();
    consoleWarn.mockRestore();
  });

  it("ignores credential markers after a response and from stale generations", async () => {
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
    replyToSidecarRequests(children[0], () => ({ result: {} }));
    await expect(bridge.invoke("get_settings", {})).resolves.toEqual({});
    children[0].stderr.write("[PLAINSONG_CREDENTIAL_REQUIRED]");
    children[0].emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(spawnProcess).toHaveBeenCalledTimes(2);

    children[0].stderr.write("[PLAINSONG_CREDENTIAL_REQUIRED]");
    children[0].emit("exit", 1, null);
    children[1].emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(spawnProcess).toHaveBeenCalledTimes(3);
    expect(bridge.getRuntimeStatus().reason).toBe("crash");
    bridge.shutdown();
    consoleLog.mockRestore();
    consoleWarn.mockRestore();
  });

  it("handles runtime status and credential retry locally while the sidecar is down", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const children: FakeChild[] = [];
    const spawnProcess = vi.fn(() => {
      const child = fakeChildProcess();
      children.push(child);
      return child as never;
    });
    const { IpcBridge } = await import("../../electron/ipc-bridge");
    const bridge = new IpcBridge("/tmp/plainsong-sidecar", spawnProcess);
    bridge.onLocalCommand((_event, command) => {
      if (command === "get_sidecar_runtime_status") {
        return { handled: true, result: bridge.getRuntimeStatus() };
      }
      if (command === "retry_sidecar_with_credential_access") {
        bridge.retryWithCredentialAccess();
        return { handled: true, result: { started: true } };
      }
      return { handled: false };
    });
    bridge.start();
    children[0].stderr.write("[PLAINSONG_CREDENTIAL_REQUIRED]");
    children[0].emit("exit", 1, null);
    const handler = mocks.handle.mock.calls.find(
      ([channel]) => channel === "sidecar:invoke",
    )?.[1] as (event: unknown, command: string, args?: unknown) => Promise<unknown>;

    await expect(handler({}, "get_sidecar_runtime_status")).resolves.toEqual({
      ready: false,
      reason: "credential_required",
      message: "Sidecar startup requires credential access",
    });
    await expect(handler({}, "retry_sidecar_with_credential_access")).resolves.toEqual({
      started: true,
    });
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    bridge.shutdown();
    consoleWarn.mockRestore();
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

    // The renderer branches on the typed `reason`; the human-readable string
    // travels alongside as `message` rather than being the only signal.
    expect(runtimeEvents).toContainEqual({
      name: "sidecar-runtime-changed",
      payload: {
        ready: false,
        reason: "crash",
        message: "Sidecar process exited (code=1, signal=null)",
      },
    });
    expect(runtimeEvents).toContainEqual({
      name: "sidecar-runtime-changed",
      payload: { ready: true },
    });

    bridge.shutdown();
    consoleWarn.mockRestore();
  });

  it("reports a signalled sidecar as killed rather than crashed", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const firstChild = fakeChildProcess();
    const spawnProcess = vi
      .fn()
      .mockReturnValueOnce(firstChild)
      .mockReturnValue(fakeChildProcess()) as unknown as typeof import("node:child_process").spawn;

    const { IpcBridge } = await import("../../electron/ipc-bridge");
    const bridge = new IpcBridge("/tmp/plainsong-sidecar", spawnProcess);
    const runtimeEvents: Array<{ name: string; payload: unknown }> = [];
    bridge.onEvent((name, payload) => runtimeEvents.push({ name, payload }));
    bridge.start();

    firstChild.emit("exit", null, "SIGKILL");
    await vi.advanceTimersByTimeAsync(0);

    expect(runtimeEvents).toContainEqual({
      name: "sidecar-runtime-changed",
      payload: {
        ready: false,
        reason: "killed",
        message: "Sidecar process exited (code=null, signal=SIGKILL)",
      },
    });

    bridge.shutdown();
    consoleWarn.mockRestore();
  });

  it("reports a sidecar that never started as spawn_failed", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const firstChild = fakeChildProcess();
    const spawnProcess = vi
      .fn()
      .mockReturnValueOnce(firstChild)
      .mockReturnValue(fakeChildProcess()) as unknown as typeof import("node:child_process").spawn;

    const { IpcBridge } = await import("../../electron/ipc-bridge");
    const bridge = new IpcBridge("/tmp/plainsong-sidecar", spawnProcess);
    const runtimeEvents: Array<{ name: string; payload: unknown }> = [];
    bridge.onEvent((name, payload) => runtimeEvents.push({ name, payload }));
    bridge.start();

    firstChild.emit("error", new Error("ENOENT"));
    await vi.advanceTimersByTimeAsync(0);

    const spawnFailure = runtimeEvents.find(
      (event) =>
        event.name === "sidecar-runtime-changed" &&
        (event.payload as { reason?: string }).reason === "spawn_failed",
    );
    expect(spawnFailure).toBeDefined();
    // The path is part of what makes this actionable, so the message must
    // survive the move out of `reason`.
    expect((spawnFailure?.payload as { message?: string }).message).toContain(
      "/tmp/plainsong-sidecar",
    );

    bridge.shutdown();
    consoleError.mockRestore();
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

  // ChildProcess only reports which signal killed the child, not whether it
  // targeted the child alone or its process group. While the bridge is still
  // active, a sidecar killed with SIGTERM must therefore be replaced.
  it("replaces a sidecar killed by an external SIGTERM", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const firstChild = fakeChildProcess();
    const spawnProcess = vi
      .fn()
      .mockReturnValueOnce(firstChild)
      .mockReturnValue(
        fakeChildProcess(),
      ) as unknown as typeof import("node:child_process").spawn;

    const { IpcBridge } = await import("../../electron/ipc-bridge");
    const bridge = new IpcBridge("/tmp/plainsong-sidecar", spawnProcess);
    const runtimeEvents: Array<{ name: string; payload: unknown }> = [];
    bridge.onEvent((name, payload) => runtimeEvents.push({ name, payload }));
    bridge.start();

    firstChild.emit("exit", null, "SIGTERM");
    await vi.advanceTimersByTimeAsync(31_000);

    expect((spawnProcess as unknown as { mock: { calls: unknown[] } }).mock.calls)
      .toHaveLength(2);
    // The renderer is still told the sidecar is gone and why.
    expect(runtimeEvents).toContainEqual({
      name: "sidecar-runtime-changed",
      payload: {
        ready: false,
        reason: "killed",
        message: "Sidecar process exited (code=null, signal=SIGTERM)",
      },
    });

    bridge.shutdown();
    consoleLog.mockRestore();
    consoleWarn.mockRestore();
  });

  it("does not restart during deferred active-meeting shutdown", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const firstChild = fakeChildProcess();
    const spawnProcess = vi.fn(() => firstChild as never);
    const { IpcBridge } = await import("../../electron/ipc-bridge");
    const bridge = new IpcBridge("/tmp/plainsong-sidecar", spawnProcess);
    bridge.start();

    bridge.setQuitPending(true);
    firstChild.emit("exit", null, "SIGTERM");
    await vi.advanceTimersByTimeAsync(6_000);

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    bridge.shutdown();
    consoleWarn.mockRestore();
  });

  // SIGKILL is how jetsam and a force-kill arrive, and those are exactly the
  // faults a replacement sidecar exists for.
  it("still replaces a sidecar killed by SIGKILL", async () => {
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

    children[0]?.emit("exit", null, "SIGKILL");
    await vi.advanceTimersByTimeAsync(31_000);

    expect(spawnProcess.mock.calls.length).toBe(2);

    bridge.shutdown();
    consoleLog.mockRestore();
    consoleWarn.mockRestore();
  });
});

/**
 * A real IpcMainInvokeEvent from a top-level frame: `senderFrame` IS
 * `sender.mainFrame`. Anything that does not satisfy that identity is a
 * subframe (or a shape the bridge does not recognize) and must be refused.
 */
function topLevelFrameEvent(url: string) {
  const mainFrame = { url };
  return { sender: { mainFrame }, senderFrame: mainFrame };
}

function subFrameEvent(mainFrameUrl: string, subFrameUrl: string) {
  return {
    sender: { mainFrame: { url: mainFrameUrl } },
    senderFrame: { url: subFrameUrl },
  };
}

describe("IpcBridge sender validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function bridgeHandler(child = fakeChildProcess()) {
    const { IpcBridge } = await import("../../electron/ipc-bridge");
    const bridge = new IpcBridge("/tmp/plainsong-sidecar", (() => child) as never);
    bridge.onValidateSender((url) => url.startsWith("plainsong://bundle/"));
    bridge.start();
    const handler = mocks.handle.mock.calls.find(
      ([channel]) => channel === "sidecar:invoke",
    )?.[1] as (event: unknown, command: string, args?: unknown) => Promise<unknown>;
    expect(handler).toBeTruthy();
    return { bridge, child, handler };
  }

  it("keeps overlay clipboard requests local and rejects untrusted senders first", async () => {
    mocks.handle.mockClear();
    const { bridge, handler } = await bridgeHandler();
    const forward = vi.spyOn(bridge, "invoke").mockRejectedValue(new Error("must not forward"));
    const local = vi.fn(async () => ({ handled: true, result: null }));
    bridge.onLocalCommand(local);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(handler(topLevelFrameEvent("https://evil.example/x"), "__overlay_copy_text__", { text: "Safe fixture" })).rejects.toThrow(/untrusted sender/i);
      expect(local).not.toHaveBeenCalled();
      await expect(handler(topLevelFrameEvent("plainsong://bundle/dictation.html"), "__overlay_copy_text__", { text: "Safe fixture" })).resolves.toBeNull();
      expect(local).toHaveBeenCalledTimes(1);
      bridge.onLocalCommand(() => ({ handled: false }));
      await expect(handler(topLevelFrameEvent("plainsong://bundle/dictation.html"), "__overlay_copy_text__", { text: "Safe fixture" })).rejects.toThrow("Overlay clipboard handler is unavailable.");
      expect(forward).not.toHaveBeenCalled();
    } finally {
      bridge.shutdown();
      warn.mockRestore();
      forward.mockRestore();
    }
  });

  it("rejects commands from a frame main does not recognize", async () => {
    // The allowlist decides *what* may be asked for; this decides *who* may
    // ask. Without it, any frame carrying our preload reaches the sidecar.
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { handler } = await bridgeHandler();

    await expect(
      handler(topLevelFrameEvent("https://evil.example/x"), "get_settings", {}),
    ).rejects.toThrow(/untrusted sender/i);

    consoleWarn.mockRestore();
  });

  it("rejects a subframe even when its own URL passes the origin check", async () => {
    // A subframe carries the same preload and the same window.electronAPI, so
    // validating its URL alone was not enough: the top-level frame is the one
    // that has to be asking.
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { handler } = await bridgeHandler();

    await expect(
      handler(
        subFrameEvent(
          "plainsong://bundle/index.html",
          "plainsong://bundle/index.html",
        ),
        "get_settings",
        {},
      ),
    ).rejects.toThrow(/untrusted sender/i);

    await expect(
      handler(
        subFrameEvent("plainsong://bundle/index.html", "https://evil.example/x"),
        "get_settings",
        {},
      ),
    ).rejects.toThrow(/untrusted sender/i);

    consoleWarn.mockRestore();
  });

  it("rejects a command whose sender frame reports no URL", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { handler } = await bridgeHandler();

    await expect(
      handler({ sender: { mainFrame: undefined }, senderFrame: undefined }, "get_settings", {}),
    ).rejects.toThrow(/untrusted sender/i);
    await expect(
      handler(topLevelFrameEvent(""), "get_settings", {}),
    ).rejects.toThrow(/untrusted sender/i);

    consoleWarn.mockRestore();
  });

  it("rejects a command whose frame was disposed mid-call", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { handler } = await bridgeHandler();
    const disposed = {
      get sender(): never {
        throw new Error("Object has been destroyed");
      },
      get senderFrame(): never {
        throw new Error("Object has been destroyed");
      },
    };

    await expect(handler(disposed, "get_settings", {})).rejects.toThrow(
      /untrusted sender/i,
    );

    consoleWarn.mockRestore();
  });

  it("allows the packaged renderer origin through", async () => {
    const child = fakeChildProcess();
    const { handler } = await bridgeHandler(child);
    replyToSidecarRequests(child, (request) =>
      request.method === "get_settings" ? { result: { ok: true } } : null,
    );

    await expect(
      handler(
        topLevelFrameEvent("plainsong://bundle/index.html"),
        "get_settings",
        {},
      ),
    ).resolves.toEqual({ ok: true });
  });
});

describe("sidecar error codes", () => {
  it("lifts a typed meeting-start code onto error.code", async () => {
    const { sidecarError } = await import("../../electron/ipc-bridge");

    const error = sidecarError(
      "MEETING_START_FAILED:mic_permission_denied:Microphone permission is not ready. Grant access in System Settings.",
    );

    // The renderer branches on the code and shows the message; the prefix must
    // not survive into anything a user reads.
    expect(error.code).toBe("mic_permission_denied");
    expect(error.message).toBe(
      "Microphone permission is not ready. Grant access in System Settings.",
    );
    expect(error.message).not.toContain("MEETING_START_FAILED");
  });

  it("keeps a message containing colons intact", async () => {
    const { sidecarError } = await import("../../electron/ipc-bridge");

    const error = sidecarError(
      "MEETING_START_FAILED:disk_full:Not enough space: 120 MB free, 900 MB needed.",
    );

    expect(error.code).toBe("disk_full");
    expect(error.message).toBe("Not enough space: 120 MB free, 900 MB needed.");
  });

  it("leaves ordinary sidecar errors untouched", async () => {
    const { sidecarError } = await import("../../electron/ipc-bridge");

    const error = sidecarError("Recording storage is busy. Try again shortly.");

    expect(error.code).toBeUndefined();
    expect(error.message).toBe("Recording storage is busy. Try again shortly.");
  });

  it("does not strip a malformed prefix", async () => {
    const { sidecarError } = await import("../../electron/ipc-bridge");

    const raw = "MEETING_START_FAILED:no-separator-here";
    const error = sidecarError(raw);

    expect(error.code).toBeUndefined();
    expect(error.message).toBe(raw);
  });
});
