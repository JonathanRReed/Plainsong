import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativeMediaMuteBackend, MEDIA_MUTE_PROTOCOL, parseMediaMuteEvent, supportsMediaMuteWorker } from "../../electron/media-mute-runtime";

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => true);
  commands: string[] = [];
  constructor() { super(); this.stdin.on("data", chunk => { this.commands.push(String(chunk)); }); }
  send(event: Record<string, unknown>) { this.stdout.write(`${JSON.stringify({ protocol: MEDIA_MUTE_PROTOCOL, ...event })}\n`); }
  close(code = 0) { this.emit("close", code); }
}
function setup(supported = true) {
  const child = new FakeChild();
  const spawnHelper = vi.fn(() => child);
  const backend = createNativeMediaMuteBackend({ platform: "darwin", helperPath: () => "/fake/helper", markerPath: () => "/fake/receipt", supportsHelper: async () => supported, spawnHelper });
  return { child, spawnHelper, backend };
}
afterEach(() => { vi.useRealTimers(); });

describe("device-owned mute worker boundary", () => {
  it.each(["end", "error"])("requests restoration when a muted worker loses stdout through %s", async ending => {
    vi.useFakeTimers();
    const { backend, child } = setup();
    const session = await backend.open();
    if (!session) throw new Error("Missing session");
    child.send({ type: "ready", deviceUid: "A" });
    await session.ready;
    const muting = session.mute();
    child.send({ type: "muted" });
    await expect(muting).resolves.toBe(true);
    if (ending === "end") {
      const ended = new Promise<void>(resolve => child.stdout.once("end", resolve));
      child.stdout.end();
      await ended;
    } else {
      expect(() => child.stdout.emit("error", new Error("pipe failed"))).not.toThrow();
    }
    expect(child.stdin.writableEnded).toBe(true);
    await vi.advanceTimersByTimeAsync(21_000);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    await expect(session.restore()).resolves.toMatchObject({ kind: "deferred" });
  });

  it("finds the protocol marker across read chunks and rejects an older helper", async () => {
    const directory = await mkdtemp(join(tmpdir(), "plainsong-mute-marker-"));
    try {
      const helper = join(directory, "helper");
      await writeFile(helper, "older-sidecar");
      expect(await supportsMediaMuteWorker(helper)).toBe(false);
      await writeFile(helper, Buffer.concat([Buffer.alloc(65_530), Buffer.from(MEDIA_MUTE_PROTOCOL)]));
      expect(await supportsMediaMuteWorker(helper)).toBe(true);
      expect(await supportsMediaMuteWorker(directory)).toBe(false);
      expect(await supportsMediaMuteWorker(join(directory, "missing"))).toBe(false);
    } finally { await rm(directory, { recursive: true }); }
  });

  it("never spawns an unsupported older binary", async () => {
    const fake = setup(false);
    expect(await fake.backend.open()).toBeNull();
    expect(await fake.backend.recover()).toMatchObject({ kind: "skipped" });
    expect(fake.spawnHelper).not.toHaveBeenCalled();
  });

  it("validates the version and required event fields", () => {
    expect(parseMediaMuteEvent({ protocol: MEDIA_MUTE_PROTOCOL, type: "ready", deviceUid: "A" })).toEqual({ type: "ready", deviceUid: "A" });
    for (const value of [null, {}, { protocol: "old", type: "muted" }, { protocol: MEDIA_MUTE_PROTOCOL, type: "ready", deviceUid: "" }, { protocol: MEDIA_MUTE_PROTOCOL, type: "finished", outcome: "unknown" }]) {
      expect(parseMediaMuteEvent(value)).toBeNull();
    }
  });

  it("handshakes without muting, restores by EOF once, and waits for acknowledgment plus close", async () => {
    const { backend, child, spawnHelper } = setup();
    const session = await backend.open(); if (!session) throw new Error("Missing session");
    expect(spawnHelper).toHaveBeenCalledWith("/fake/helper", ["--media-mute-session", "/fake/receipt"]);
    child.send({ type: "ready", deviceUid: "A" });
    expect(await session.ready).toBe(true);
    expect(child.commands).toEqual([]);
    const muted = session.mute(); child.send({ type: "muted" });
    expect(await muted).toBe(true);
    expect(child.commands).toEqual(["mute\n"]);
    const end = vi.spyOn(child.stdin, "end");
    const restore = session.restore(); expect(session.restore()).toBe(restore);
    expect(end).toHaveBeenCalledTimes(1);
    let settled = false; void restore.then(() => { settled = true; });
    child.send({ type: "finished", outcome: "restored" });
    await Promise.resolve(); expect(settled).toBe(false);
    child.close(); expect(await restore).toEqual({ kind: "restored" });
  });

  it("requires a terminal acknowledgment even for a clean exit", async () => {
    const { backend, child } = setup(); const session = await backend.open(); if (!session) throw new Error("Missing session");
    child.close();
    expect(await session.ready).toBe(false);
    expect(await session.restore()).toMatchObject({ kind: "deferred" });
  });

  it("preserves restored acknowledgment when stdout ends before process close", async () => {
    const { backend, child } = setup();
    const session = await backend.open();
    if (!session) throw new Error("Missing session");
    const restoring = session.restore();
    child.send({ type: "finished", outcome: "restored" });
    const ended = new Promise<void>(resolve => child.stdout.once("end", resolve));
    child.stdout.end();
    await ended;
    child.close();
    await expect(restoring).resolves.toEqual({ kind: "restored" });
  });

  it("reports abnormal exit as deferred even after a restored message", async () => {
    const { backend, child } = setup(); const session = await backend.open(); if (!session) throw new Error("Missing session");
    child.send({ type: "finished", outcome: "restored" }); child.close(1);
    expect(await session.restore()).toMatchObject({ kind: "deferred" });
  });

  it("does not let late readiness cancel a pending restoration timeout", async () => {
    vi.useFakeTimers();
    const { backend, child } = setup(); const session = await backend.open(); if (!session) throw new Error("Missing session");
    const restore = session.restore(); child.send({ type: "ready", deviceUid: "A" });
    expect(await session.ready).toBe(false);
    expect(await session.mute()).toBe(false);
    await vi.advanceTimersByTimeAsync(18_000);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.close(1); expect(await restore).toMatchObject({ kind: "deferred" });
  });

  it("does not time out a healthy long recording", async () => {
    vi.useFakeTimers();
    const { backend, child } = setup(); const session = await backend.open(); if (!session) throw new Error("Missing session");
    child.send({ type: "ready", deviceUid: "A" }); await session.ready;
    const muted = session.mute(); child.send({ type: "muted" }); await muted;
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(child.kill).not.toHaveBeenCalled();
    const restore = session.restore(); child.send({ type: "finished", outcome: "restored" }); child.close(); await restore;
  });

  it("bounds an unacknowledged mute operation", async () => {
    vi.useFakeTimers();
    const { backend, child } = setup(); const session = await backend.open(); if (!session) throw new Error("Missing session");
    child.send({ type: "ready", deviceUid: "A" }); await session.ready;
    const muted = session.mute(); await vi.advanceTimersByTimeAsync(18_000);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.close(1); expect(await muted).toBe(false);
    expect(await session.restore()).toMatchObject({ kind: "deferred" });
  });

  it("finishes recovery even when a stuck worker never closes its pipes", async () => {
    vi.useFakeTimers();
    const { backend, child } = setup();
    const session = await backend.open();
    if (!session) throw new Error("Missing session");
    const restore = session.restore();
    await vi.advanceTimersByTimeAsync(21_000);
    expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    expect(await session.ready).toBe(false);
    expect(await restore).toMatchObject({ kind: "deferred" });
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
  });

  it.each(["not json\n", `${JSON.stringify({ protocol: "old", type: "ready", deviceUid: "A" })}\n`])("closes input on malformed or incompatible protocol: %s", async line => {
    const { backend, child } = setup(); const session = await backend.open(); if (!session) throw new Error("Missing session");
    child.stdout.write(line);
    expect(await session.ready).toBe(false);
    expect(child.stdin.writableEnded).toBe(true);
    expect(child.commands).toEqual([]);
    child.close(1); expect(await session.restore()).toMatchObject({ kind: "deferred" });
  });

  it("uses recovery-only mode and preserves a deferred native outcome", async () => {
    const { backend, child, spawnHelper } = setup(); const recovered = backend.recover();
    await Promise.resolve(); await Promise.resolve();
    expect(spawnHelper).toHaveBeenCalledWith("/fake/helper", ["--media-mute-recover", "/fake/receipt"]);
    child.send({ type: "finished", outcome: "deferred", reason: "A disconnected" }); child.close();
    expect(await recovered).toEqual({ kind: "deferred", reason: "A disconnected" });
  });
});
