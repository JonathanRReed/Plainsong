import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { MediaMuteBackend, MediaMuteOutcome, MediaMuteSession } from "./media-mute";

export const MEDIA_MUTE_PROTOCOL = "PLAINSONG_MEDIA_MUTE_WORKER_PROTOCOL_V1";
const OPERATION_TIMEOUT_MS = 18_000;
export interface MediaMuteChild {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal: NodeJS.Signals): boolean;
}
type WorkerEvent =
  | { type: "ready"; deviceUid: string }
  | { type: "muted" }
  | { type: "finished"; outcome: MediaMuteOutcome }
  | { type: "error"; message: string };

export function parseMediaMuteEvent(value: unknown): WorkerEvent | null {
  if (typeof value !== "object" || value === null || !("protocol" in value)
    || value.protocol !== MEDIA_MUTE_PROTOCOL || !("type" in value)) return null;
  switch (value.type) {
    case "ready":
      return "deviceUid" in value && typeof value.deviceUid === "string"
        && value.deviceUid.length > 0 && value.deviceUid.length <= 4096
        ? { type: "ready", deviceUid: value.deviceUid } : null;
    case "muted": return { type: "muted" };
    case "error":
      return "message" in value && typeof value.message === "string"
        ? { type: "error", message: value.message } : null;
    case "finished": {
      if (!("outcome" in value)) return null;
      if (value.outcome === "restored") return { type: "finished", outcome: { kind: "restored" } };
      if (value.outcome !== "skipped" && value.outcome !== "deferred") return null;
      const reason = "reason" in value && typeof value.reason === "string" ? value.reason : "No audio change required";
      return { type: "finished", outcome: { kind: value.outcome, reason } };
    }
    default: return null;
  }
}

export async function supportsMediaMuteWorker(path: string): Promise<boolean> {
  try {
    const file = await open(path, "r");
    try {
      if (!(await file.stat()).isFile()) return false;
      const marker = Buffer.from(MEDIA_MUTE_PROTOCOL);
      const buffer = Buffer.alloc(64 * 1024);
      let tail = Buffer.alloc(0);
      for (;;) {
        const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
        if (!bytesRead) return false;
        const part = Buffer.concat([tail, buffer.subarray(0, bytesRead)]);
        if (part.includes(marker)) return true;
        tail = Buffer.from(part.subarray(Math.max(0, part.length - marker.length + 1)));
      }
    } finally { await file.close(); }
  } catch { return false; }
}

function nativeSession(child: MediaMuteChild, log?: (message: string) => void): MediaMuteSession {
  let resolveReady: (ready: boolean) => void = () => {};
  const ready = new Promise<boolean>(resolve => { resolveReady = resolve; });
  let resolveMute: ((muted: boolean) => void) | null = null;
  let muteResult: Promise<boolean> | null = null;
  let resolveFinished: (outcome: MediaMuteOutcome) => void = () => {};
  const finished = new Promise<MediaMuteOutcome>(resolve => { resolveFinished = resolve; });
  let terminal: MediaMuteOutcome | null = null;
  let restoreRequested = false;
  let closed = false;
  let prepared = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const complete = (outcome: MediaMuteOutcome): void => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    lines.close();
    resolveReady(false);
    resolveMute?.(false);
    if (outcome.kind === "deferred") log?.(outcome.reason);
    resolveFinished(outcome);
  };
  const armTimeout = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      terminal = { kind: "deferred", reason: "Audio worker did not acknowledge recovery" };
      restoreRequested = true;
      child.stdin.end();
      child.kill("SIGTERM");
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        complete({ kind: "deferred", reason: "Audio worker recovery deadline expired; receipt retained" });
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      }, 3_000);
      timer.unref();
    }, OPERATION_TIMEOUT_MS);
    timer.unref();
  };
  const requestRestore = (): Promise<MediaMuteOutcome> => {
    if (!restoreRequested && !closed) {
      restoreRequested = true;
      child.stdin.end();
      armTimeout();
    }
    return finished;
  };
  const fail = (message: string): void => {
    terminal = { kind: "deferred", reason: message };
    resolveReady(false);
    resolveMute?.(false);
    void requestRestore();
  };
  armTimeout();
  const lines = createInterface({ input: child.stdout });
  lines.on("close", () => { if (!closed && !terminal) fail("Audio worker output closed before restoration"); });
  lines.on("error", () => fail("Audio worker output failed"));
  child.stdout.on("error", () => fail("Audio worker output failed"));
  child.stderr.on("error", () => fail("Audio worker diagnostics failed"));
  lines.on("line", line => {
    if (line.length > 16 * 1024) { fail("Audio worker response exceeded its limit"); return; }
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { fail("Audio worker response was malformed"); return; }
    const event = parseMediaMuteEvent(parsed);
    if (!event) { fail("Audio worker protocol was not supported"); return; }
    if (event.type === "ready") {
      prepared = true;
      if (!restoreRequested) {
        if (timer) clearTimeout(timer);
        timer = null;
      }
      resolveReady(!restoreRequested);
    } else if (event.type === "muted") {
      if (!restoreRequested) {
        if (timer) clearTimeout(timer);
        timer = null;
      }
      resolveMute?.(!restoreRequested);
    } else if (event.type === "finished") {
      terminal = event.outcome;
      resolveReady(false);
      resolveMute?.(false);
    } else fail(event.message);
  });
  child.stderr.on("data", () => {});
  child.stdin.on("error", () => fail("Audio worker input closed"));
  child.on("error", () => fail("Audio worker could not start"));
  child.on("close", (code: number | null) => {
    const outcome = code === 0 && terminal ? terminal
      : { kind: "deferred", reason: "Audio worker exited without acknowledged restoration" } satisfies MediaMuteOutcome;
    complete(outcome);
  });
  return {
    ready,
    mute(): Promise<boolean> {
      if (muteResult) return muteResult;
      if (!prepared || restoreRequested || closed) return Promise.resolve(false);
      muteResult = new Promise(resolve => { resolveMute = resolve; });
      armTimeout();
      child.stdin.write("mute\n", error => { if (error) fail("Audio worker mute command failed"); });
      return muteResult;
    },
    restore: requestRestore,
  };
}

export function createNativeMediaMuteBackend(input: {
  platform: string;
  helperPath: () => string;
  markerPath: () => string;
  supportsHelper?: (path: string) => Promise<boolean>;
  spawnHelper?: (path: string, args: string[]) => MediaMuteChild;
  log?: (message: string) => void;
}): MediaMuteBackend {
  let supported: Promise<boolean> | null = null;
  const start = async (mode: string): Promise<MediaMuteSession | null> => {
    if (input.platform !== "darwin") return null;
    const helper = input.helperPath();
    supported ??= (input.supportsHelper ?? supportsMediaMuteWorker)(helper);
    if (!(await supported)) return null;
    const args = [mode, input.markerPath()];
    const child = input.spawnHelper?.(helper, args) ?? spawn(helper, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PLAINSONG_STARTUP_CREDENTIAL_ACCESS: "0" },
    });
    return nativeSession(child, input.log);
  };
  return {
    open: () => start("--media-mute-session"),
    async recover(): Promise<MediaMuteOutcome> {
      const session = await start("--media-mute-recover");
      return session ? session.restore() : { kind: "skipped", reason: "Device-owned audio worker is unavailable" };
    },
  };
}
