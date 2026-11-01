import { ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IpcBridge } from "../../electron/ipc-bridge";
import { getCommandTimeoutMs } from "../../electron/ipc-command-policy";

const ipc = vi.hoisted(() => ({ handle: vi.fn() }));
vi.mock("electron/main", () => ({ ipcMain: ipc }));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(), spawn: vi.fn(),
}));

function child() {
  const value = new ChildProcess();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  value.stdin = stdin;
  value.stdout = stdout;
  value.stderr = new PassThrough();
  value.kill = vi.fn(() => true);
  const requests: Array<{ id: string; method: string; params: unknown }> = [];
  stdin.on("data", chunk => requests.push(JSON.parse(String(chunk))));
  return { value, stdout, requests };
}

function harness() {
  const children: ReturnType<typeof child>[] = [];
  vi.mocked(spawn).mockImplementation(() => {
    const next = child();
    children.push(next);
    return next.value;
  });
  const bridge = new IpcBridge("/fake/sidecar");
  bridge.start();
  const handler = ipc.handle.mock.calls.at(-1)?.[1];
  return { bridge, children, handler };
}

// Exercise every command admitted by the single renderer IPC handler without
// copying its allowlist or invoking a native command.
const source = readFileSync("electron/ipc-bridge.ts", "utf8");
const allowlist = source.slice(source.indexOf("const ALLOWED_RENDERER_COMMANDS"), source.indexOf("const CAPTURE_START_COMMANDS"));
const commands = [...allowlist.matchAll(/^ {2}"([a-z0-9_]+)",/gm)].map(match => match[1]);

beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("renderer message envelopes", () => {
  it.each([null, true, 42, "args", [], new Date(), new Map()])("rejects malformed arguments %j before local dispatch for every command", async args => {
    const { bridge, handler, children } = harness();
    const local = vi.fn(() => ({ handled: true, result: "unexpected dispatch" }));
    bridge.onLocalCommand(local);
    expect(commands.length).toBeGreaterThan(250);
    for (const command of commands) {
      await expect(handler({}, command, args), command).rejects.toThrow("arguments");
    }
    expect(local).not.toHaveBeenCalled();
    expect(children[0].requests).toEqual([]);
    bridge.shutdown();
  });

  it.each([undefined, null, 3, true, [], {}, { toString: null }].map(command => ({ command })))("rejects malformed command $command without dispatch", async ({ command }) => {
    const { bridge, handler } = harness();
    const local = vi.fn();
    bridge.onLocalCommand(local);
    await expect(handler({}, command, {})).rejects.toThrow("command");
    expect(local).not.toHaveBeenCalled();
    bridge.shutdown();
  });

  it("retains omitted and object arguments for every allowed command", async () => {
    const { bridge, handler } = harness();
    bridge.onLocalCommand(() => ({ handled: true, result: "local" }));
    for (const command of commands) {
      await expect(handler({}, command)).resolves.toBe("local");
      await expect(handler({}, command, {})).resolves.toBe("local");
    }
    bridge.shutdown();
  });
});

describe("sidecar generation and protocol", () => {
  it.each([null, [], {}, true, { id: "bogus", result: 1 }, { jsonrpc: "2.0", method: "event", params: { event: 4 } }])("does not mark malformed output %j healthy", output => {
    const { bridge, children } = harness();
    const events = vi.fn();
    bridge.onEvent(events);
    children[0].stdout.write(`${JSON.stringify(output)}\n`);
    expect(bridge.getRuntimeStatus().ready).toBe(false);
    expect(events).not.toHaveBeenCalled();
    bridge.shutdown();
  });

  it("ignores buffered events and replies immediately after process exit", async () => {
    const { bridge, children } = harness();
    const events = vi.fn();
    const resolved = vi.fn();
    bridge.onEvent(events);
    bridge.onCommandResolved(resolved);
    const pending = bridge.invoke("get_settings");
    const rejected = expect(pending).rejects.toThrow("exited");
    const request = children[0].requests[0];
    children[0].value.emit("exit", 1, null);
    await rejected;
    events.mockClear();
    children[0].stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "event", params: { event: "dictation-state-changed", payload: { phase: "recording" } } })}\n`);
    children[0].stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} })}\n`);
    expect(events).not.toHaveBeenCalled();
    expect(resolved).not.toHaveBeenCalled();
    expect(bridge.getRuntimeStatus()).toMatchObject({ ready: false, reason: "crash" });
    bridge.shutdown();
  });

  it.each([
    {},
    { jsonrpc: "2.0", method: "event", params: { event: "booting", payload: {} } },
    { jsonrpc: "2.0", id: "no-pending-request", result: {} },
  ])("bounds crash loops when a process prints %j but never answers a request", async output => {
    const { bridge, children } = harness();
    for (const delay of [1000, 2000, 4000, 8000, 16000]) {
      const current = children.at(-1)!;
      current.stdout.write(`${JSON.stringify(output)}\n`);
      current.value.emit("exit", 1, null);
      await vi.advanceTimersByTimeAsync(delay);
    }
    children.at(-1)!.stdout.write(`${JSON.stringify(output)}\n`);
    children.at(-1)!.value.emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(children).toHaveLength(6);
    bridge.shutdown();
  });

  it("cancels one timed out request, ignores its late reply, and admits a fresh request", async () => {
    const { bridge, children } = harness();
    const current = children[0];
    const resolved = vi.fn();
    bridge.onCommandResolved(resolved);
    const pending = bridge.invoke("get_settings");
    const timeout = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(getCommandTimeoutMs("get_settings"));
    await timeout;
    expect(current.requests[1]).toMatchObject({ method: "$/cancelRequest", params: { id: current.requests[0].id } });
    current.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: current.requests[0].id, result: "late" })}\n`);
    expect(resolved).not.toHaveBeenCalled();
    const fresh = bridge.invoke("get_settings");
    current.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: current.requests[2].id, result: "fresh" })}\n`);
    await expect(fresh).resolves.toBe("fresh");
    expect(resolved).toHaveBeenCalledOnce();
    bridge.shutdown();
  });
});
