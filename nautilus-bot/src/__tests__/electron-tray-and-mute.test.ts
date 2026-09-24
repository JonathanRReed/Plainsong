import { describe, expect, it } from "vitest";
import { describeTrayStatus, formatTrayClock } from "../../electron/tray-status";
import { createMediaMuteController } from "../../electron/media-mute";

describe("menu-bar status", () => {
  it("shows a running clock while dictating and while recording a meeting", () => {
    const live = describeTrayStatus({ dictationPhase: "recording", dictationStartedAt: 0, meetingStartedAt: null, now: 12_400 });
    expect(live).toMatchObject({ title: "● 0:12", statusLine: "Listening", ticking: true });
    const meeting = describeTrayStatus({ dictationPhase: "idle", dictationStartedAt: null, meetingStartedAt: 0, now: 3_725_000 });
    expect(meeting).toMatchObject({ title: "● 1:02:05", ticking: true });
  });

  it("says what is happening after the mic closes, and stays quiet when idle", () => {
    expect(describeTrayStatus({ dictationPhase: "transcribing", dictationStartedAt: null, meetingStartedAt: null, now: 0 })).toMatchObject({ title: "…", statusLine: "Transcribing…" });
    expect(describeTrayStatus({ dictationPhase: "idle", dictationStartedAt: null, meetingStartedAt: null, now: 0 })).toMatchObject({ title: "", statusLine: "Ready to dictate", ticking: false });
    expect(formatTrayClock(59_999)).toBe("0:59");
  });
});

function fakeOsascript(initiallyMuted = false) {
  let muted = initiallyMuted;
  const calls: string[] = [];
  const timers: Array<() => void> = [];
  const controller = createMediaMuteController({
    run: async (script) => {
      calls.push(script);
      if (script.startsWith("output muted")) return String(muted);
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
  });
  const flush = async () => {
    for (const run of timers.splice(0)) run();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { controller, calls, flush, isMuted: () => muted };
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
});
