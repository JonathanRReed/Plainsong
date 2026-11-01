import { describe, expect, it, vi } from "vitest";
import { createMacosCalendarRuntime } from "../../electron/macos-calendar-runtime";

function helperOutput(payload: Record<string, unknown>): { stdout: string; stderr: string } {
  return { stdout: `${JSON.stringify(payload)}\n`, stderr: "" };
}

function runtimeWith(
  responses: Record<string, Record<string, unknown>>,
  overrides: Parameters<typeof createMacosCalendarRuntime>[0] extends infer T
    ? Partial<T>
    : never = {},
) {
  const calls: string[][] = [];
  const exec = vi.fn(async (_path: string, args: string[]) => {
    calls.push(args);
    const mode = args[0];
    return helperOutput(responses[mode] ?? { type: "error", code: "malformed_request" });
  });

  const runtime = createMacosCalendarRuntime({
    platform: "darwin",
    helperPath: "/tmp/plainsong-native-calendar-helper",
    helperExists: () => true,
    exec,
    now: () => 1_000_000,
    ...overrides,
  });

  return { runtime, exec, calls };
}

const AUTHORIZED_PROBE = { type: "probe", authorization: "authorized" };
const EVENTS_PAYLOAD = {
  type: "events",
  authorization: "authorized",
  calendars: [{ id: "work", title: "Work", account_name: "iCloud" }],
  events: [
    {
      id: "e1",
      title: "Design review",
      starts_at: "2026-08-27T15:10:00Z",
      ends_at: "2026-08-27T15:40:00Z",
      is_all_day: false,
      calendar_id: "work",
      calendar_name: "Work",
      conference_urls: [],
    },
  ],
};

describe("createMacosCalendarRuntime", () => {
  it("drops an event read that completes after Disconnect", async () => {
    let finishEvents!: (result: { stdout: string; stderr: string }) => void;
    let disconnected = false;
    const exec = vi.fn(async (_path: string, args: string[]) => args[0] === "--probe"
      ? helperOutput(AUTHORIZED_PROBE)
      : new Promise<{ stdout: string; stderr: string }>(resolve => { finishEvents = resolve; }));
    const { runtime } = runtimeWith({}, { exec, isDisconnected: () => disconnected });
    const reading = runtime.readSnapshot();
    await Promise.resolve();
    await Promise.resolve();
    expect(exec).toHaveBeenCalledTimes(2);
    disconnected = true;
    runtime.invalidate();
    finishEvents(helperOutput(EVENTS_PAYLOAD));
    await expect(reading).resolves.toMatchObject({ authorization: "unknown", errorCode: "disconnected", events: [], calendars: [] });
  });

  it("does not reuse an in-flight authorized read after invalidation and permission revocation", async () => {
    let finishEvents!: (result: { stdout: string; stderr: string }) => void;
    let authorized = true;
    const exec = vi.fn(async (_path: string, args: string[]) => args[0] === "--probe"
      ? helperOutput({ type: "probe", authorization: authorized ? "authorized" : "denied" })
      : new Promise<{ stdout: string; stderr: string }>(resolve => { finishEvents = resolve; }));
    const { runtime } = runtimeWith({}, { exec });
    const oldRead = runtime.readSnapshot();
    await Promise.resolve();
    await Promise.resolve();
    expect(exec).toHaveBeenCalledTimes(2);
    authorized = false;
    runtime.invalidate();
    const fresh = runtime.readSnapshot({ forceRefresh: true });
    finishEvents(helperOutput(EVENTS_PAYLOAD));
    await oldRead;
    await expect(fresh).resolves.toMatchObject({ authorization: "denied", events: [] });
    await expect(runtime.readSnapshot()).resolves.toMatchObject({ authorization: "denied", events: [] });
  });

  it("never runs a mode that can prompt while only reading", async () => {
    // The whole scoping of this feature rests on this: reading the calendar
    // state on mount must be incapable of raising a TCC dialog.
    const { runtime, calls } = runtimeWith({
      "--probe": AUTHORIZED_PROBE,
      "--events": EVENTS_PAYLOAD,
    });

    await runtime.readSnapshot();
    await runtime.readSnapshot({ forceRefresh: true });

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.flat()).not.toContain("--request-access");
  });

  it("stops at the probe when macOS has not granted access", async () => {
    const { runtime, calls } = runtimeWith({
      "--probe": { type: "probe", authorization: "not_determined" },
      "--events": EVENTS_PAYLOAD,
    });

    const snapshot = await runtime.readSnapshot();

    expect(snapshot.authorization).toBe("not_determined");
    expect(snapshot.events).toEqual([]);
    expect(calls).toEqual([["--probe"]]);
  });

  it("reads events only after an authorized probe", async () => {
    const { runtime, calls } = runtimeWith({
      "--probe": AUTHORIZED_PROBE,
      "--events": EVENTS_PAYLOAD,
    });

    const snapshot = await runtime.readSnapshot();

    expect(calls).toEqual([["--probe"], ["--events", "--horizon-minutes", "480"]]);
    expect(snapshot.events.map((event) => event.title)).toEqual(["Design review"]);
  });

  it("serves a second caller from the cache instead of spawning again", async () => {
    const { runtime, exec } = runtimeWith({
      "--probe": AUTHORIZED_PROBE,
      "--events": EVENTS_PAYLOAD,
    });

    await runtime.readSnapshot();
    const before = exec.mock.calls.length;
    await runtime.readSnapshot();

    expect(exec.mock.calls.length).toBe(before);
  });

  it("shares one subprocess between concurrent callers", async () => {
    // The Meetings header and the Settings row can mount at the same moment;
    // that must not fork two helpers.
    const { runtime, exec } = runtimeWith({
      "--probe": AUTHORIZED_PROBE,
      "--events": EVENTS_PAYLOAD,
    });

    await Promise.all([runtime.readSnapshot(), runtime.readSnapshot()]);

    expect(exec.mock.calls.filter(([, args]) => args[0] === "--probe")).toHaveLength(1);
  });

  it("re-reads after invalidate", async () => {
    const { runtime, exec } = runtimeWith({
      "--probe": AUTHORIZED_PROBE,
      "--events": EVENTS_PAYLOAD,
    });

    await runtime.readSnapshot();
    runtime.invalidate();
    await runtime.readSnapshot();

    expect(exec.mock.calls.filter(([, args]) => args[0] === "--probe")).toHaveLength(2);
  });

  it("reports a non-macOS host as unsupported rather than denied", async () => {
    // Rendering "turn calendar access back on in System Settings" to someone
    // with no System Settings would be a fabricated instruction.
    const { runtime, exec } = runtimeWith(
      { "--probe": AUTHORIZED_PROBE },
      { platform: "win32" },
    );

    expect((await runtime.readSnapshot()).authorization).toBe("unsupported_platform");
    expect(exec).not.toHaveBeenCalled();
  });

  it("reports a missing helper as our failure, not the reader's decision", async () => {
    const { runtime, exec } = runtimeWith(
      { "--probe": AUTHORIZED_PROBE },
      { helperExists: () => false },
    );

    expect((await runtime.readSnapshot()).authorization).toBe("helper_unavailable");
    expect(exec).not.toHaveBeenCalled();
  });

  it("re-reads the calendar once a prompt is granted", async () => {
    const { runtime, calls } = runtimeWith({
      "--request-access": AUTHORIZED_PROBE,
      "--probe": AUTHORIZED_PROBE,
      "--events": EVENTS_PAYLOAD,
    });

    const snapshot = await runtime.requestAccess();

    expect(calls[0]).toEqual(["--request-access"]);
    expect(snapshot.events).toHaveLength(1);
  });

  it("does not read events when a prompt is refused", async () => {
    const { runtime, calls } = runtimeWith({
      "--request-access": { type: "probe", authorization: "denied" },
      "--probe": { type: "probe", authorization: "denied" },
      "--events": EVENTS_PAYLOAD,
    });

    const snapshot = await runtime.requestAccess();

    expect(snapshot.authorization).toBe("denied");
    expect(calls).toEqual([["--request-access"]]);
  });

  it("runs no helper at all while the reader has disconnected the calendar", async () => {
    let disconnected = false;
    const { runtime, calls } = runtimeWith(
      { "--probe": AUTHORIZED_PROBE, "--events": EVENTS_PAYLOAD },
      { isDisconnected: () => disconnected },
    );
    const connected = await runtime.readSnapshot();
    expect(connected.events).toHaveLength(1);
    const helperRuns = calls.length;

    disconnected = true;
    const read = await runtime.readSnapshot();
    const forced = await runtime.readSnapshot({ forceRefresh: true });
    const requested = await runtime.requestAccess();

    expect(calls).toHaveLength(helperRuns);
    for (const snapshot of [read, forced, requested]) {
      expect(snapshot.events).toEqual([]);
      expect(snapshot.calendars).toEqual([]);
      expect(snapshot.errorCode).toBe("disconnected");
    }

    // Reconnecting reads afresh rather than serving what was held before.
    disconnected = false;
    const again = await runtime.readSnapshot();
    expect(again.events).toHaveLength(1);
    expect(calls.length).toBeGreaterThan(helperRuns);
  });
});
