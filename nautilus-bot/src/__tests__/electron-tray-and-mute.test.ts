import { describe, expect, it } from "vitest";
import { describeTrayStatus, formatTrayClock } from "../../electron/tray-status";
import { createMediaMuteController } from "../../electron/media-mute";
import { nextActiveMeetingPhase } from "../../electron/meeting-lifecycle";

describe("menu-bar status", () => {
  it("shows a running clock while dictating and while recording a meeting", () => {
    const live = describeTrayStatus({ dictationPhase: "recording", dictationStartedAt: 0, meetingPhase: null, meetingStartedAt: null, now: 12_400 });
    expect(live).toMatchObject({ title: "● 0:12", statusLine: "Listening", ticking: true });
    const meeting = describeTrayStatus({ dictationPhase: "idle", dictationStartedAt: null, meetingPhase: "recording", meetingStartedAt: 0, now: 3_725_000 });
    expect(meeting).toMatchObject({ title: "● 1:02:05", ticking: true, meetingControl: "stop" });
  });

  it("says what is happening after the mic closes, and stays quiet when idle", () => {
    expect(describeTrayStatus({ dictationPhase: "transcribing", dictationStartedAt: null, meetingPhase: null, meetingStartedAt: null, now: 0 })).toMatchObject({ title: "…", statusLine: "Transcribing…" });
    expect(describeTrayStatus({ dictationPhase: "idle", dictationStartedAt: null, meetingPhase: null, meetingStartedAt: null, now: 0 })).toMatchObject({ title: "", statusLine: "Ready to dictate", ticking: false, meetingControl: "start" });
    expect(formatTrayClock(59_999)).toBe("0:59");
  });

  it("shows a meeting as recording only while it is capturing", () => {
    const at = (meetingPhase: string) =>
      describeTrayStatus({ dictationPhase: "idle", dictationStartedAt: null, meetingPhase, meetingStartedAt: null, now: 5_000 });
    expect(at("preparing")).toMatchObject({ title: "…", statusLine: "Starting the meeting…", ticking: false, meetingControl: "busy" });
    expect(at("stopping")).toMatchObject({ title: "…", statusLine: "Finishing the meeting…", ticking: false, meetingControl: "busy" });
    expect(at("processing")).toMatchObject({ title: "…", statusLine: "Finishing the meeting…", meetingControl: "busy" });
    expect(at("recording")).toMatchObject({ title: "● 0:00", statusLine: "Recording a meeting", meetingControl: "stop" });
  });

  it("tracks the active meeting's phase from its lifecycle events", () => {
    expect(nextActiveMeetingPhase(null, "m1", { phase: "preparing", recordingId: "m1" })).toBe("preparing");
    expect(nextActiveMeetingPhase("recording", "m1", { phase: "transcribing", recordingId: "m1" })).toBe("processing");
    // Another meeting's event does not move the active one.
    expect(nextActiveMeetingPhase("recording", "m1", { phase: "stopping", recordingId: "m2" })).toBe("recording");
    // Terminal: nothing active any more.
    expect(nextActiveMeetingPhase("processing", null, { phase: "ready", recordingId: "m1" })).toBeNull();
  });
});

function fakeOsascript(initiallyMuted = false, options: { markerSet?: boolean } = {}) {
  let muted = initiallyMuted;
  let marker = options.markerSet ?? false;
  let unmuteFailures = 0;
  let holdQuery: Promise<void> | null = null;
  const calls: string[] = [];
  const timers: Array<() => void> = [];
  const controller = createMediaMuteController({
    run: async (script) => {
      calls.push(script);
      if (script.startsWith("output muted")) {
        if (holdQuery) await holdQuery;
        return String(muted);
      }
      if (script === "set volume without output muted" && unmuteFailures > 0) {
        unmuteFailures -= 1;
        throw new Error("osascript timed out");
      }
      muted = script === "set volume with output muted";
      return "";
    },
    schedule: (callback) => {
      timers.push(callback);
      return timers.length;
    },
    cancel: () => {
      timers.length = 0;
    },
    marker: {
      set: () => {
        marker = true;
      },
      clear: () => {
        marker = false;
      },
      isSet: () => marker,
    },
  });
  const flush = async () => {
    for (const run of timers.splice(0)) run();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return {
    controller,
    calls,
    flush,
    timers,
    isMuted: () => muted,
    hasMarker: () => marker,
    failNextUnmutes: (count: number) => {
      unmuteFailures = count;
    },
    holdQueryUntil: (gate: Promise<void> | null) => {
      holdQuery = gate;
    },
  };
}

describe("mute other audio while dictating", () => {
  it("mutes once the mic is live and restores afterwards", async () => {
    const mac = fakeOsascript();
    mac.controller.onPhase("recording", true);
    await mac.flush();
    expect(mac.isMuted()).toBe(true);
    mac.controller.onPhase("transcribing", true);
    await mac.flush();
    expect(mac.isMuted()).toBe(false);
  });

  it("leaves an already-muted Mac muted and does nothing when off", async () => {
    const muted = fakeOsascript(true);
    muted.controller.onPhase("recording", true);
    await muted.flush();
    muted.controller.onPhase("done", true);
    await muted.flush();
    expect(muted.isMuted()).toBe(true);

    const off = fakeOsascript();
    off.controller.onPhase("recording", false);
    await off.flush();
    expect(off.calls).toEqual([]);
  });

  it("never mutes for a session that ended before the delay ran out", async () => {
    const mac = fakeOsascript();
    mac.controller.onPhase("recording", true);
    mac.controller.onPhase("stopping", true);
    await mac.flush();
    expect(mac.isMuted()).toBe(false);
  });

  it("waits for recording, not primed, so the start sound is not cut off", async () => {
    const mac = fakeOsascript();
    mac.controller.onPhase("primed", true);
    await mac.flush();
    expect(mac.calls).toEqual([]);
    mac.controller.onPhase("recording", true);
    await mac.flush();
    expect(mac.isMuted()).toBe(true);
  });

  it("keeps one pending mute through repeated recording updates", async () => {
    const mac = fakeOsascript();
    let release: () => void = () => {};
    mac.holdQueryUntil(new Promise<void>((resolve) => (release = resolve)));
    mac.controller.onPhase("recording", true);
    await mac.flush();
    // Live-preview updates re-report "recording" while osascript answers.
    mac.controller.onPhase("recording", true);
    mac.controller.onPhase("recording", true);
    expect(mac.timers).toHaveLength(0);
    mac.holdQueryUntil(null);
    release();
    await mac.flush();
    expect(mac.isMuted()).toBe(true);
    expect(mac.calls.filter((call) => call.startsWith("output muted"))).toHaveLength(1);
  });

  it("resolves the phase change only after audio is back, so the done sound is heard", async () => {
    const mac = fakeOsascript();
    mac.controller.onPhase("recording", true);
    await mac.flush();
    const order: string[] = [];
    await mac.controller.onPhase("done", true).then(() => order.push(mac.isMuted() ? "muted" : "restored"));
    expect(order).toEqual(["restored"]);
  });

  it("retries a failed unmute once, and keeps trying later if that fails too", async () => {
    const once = fakeOsascript();
    once.controller.onPhase("recording", true);
    await once.flush();
    once.failNextUnmutes(1);
    await once.controller.onPhase("done", true);
    expect(once.isMuted()).toBe(false);
    expect(once.hasMarker()).toBe(false);

    const twice = fakeOsascript();
    twice.controller.onPhase("recording", true);
    await twice.flush();
    twice.failNextUnmutes(2);
    await twice.controller.onPhase("done", true);
    expect(twice.isMuted()).toBe(true);
    expect(twice.controller.mutedByUs).toBe(true);
    // The restore at quit gets another go.
    await twice.controller.restore();
    expect(twice.isMuted()).toBe(false);
    expect(twice.controller.mutedByUs).toBe(false);
  });

  it("leaves a marker while muted, and a later launch undoes a mute a killed run left", async () => {
    const mac = fakeOsascript();
    mac.controller.onPhase("recording", true);
    await mac.flush();
    expect(mac.hasMarker()).toBe(true);
    await mac.controller.onPhase("idle", true);
    expect(mac.hasMarker()).toBe(false);

    const relaunched = fakeOsascript(true, { markerSet: true });
    await relaunched.controller.recoverStaleMute();
    expect(relaunched.isMuted()).toBe(false);
    expect(relaunched.hasMarker()).toBe(false);

    const userMuted = fakeOsascript(true);
    await userMuted.controller.recoverStaleMute();
    expect(userMuted.isMuted()).toBe(true);
    expect(userMuted.calls).toEqual([]);
  });
});
