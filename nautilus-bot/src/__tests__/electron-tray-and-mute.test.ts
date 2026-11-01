import { describe, expect, it } from "vitest";
import { describeTrayStatus, formatTrayClock, nextTrayRecoveryResults } from "../../electron/tray-status";
import { createMediaMuteController, type MediaMuteOutcome } from "../../electron/media-mute";
import { nextActiveMeetingPhase } from "../../electron/meeting-lifecycle";

describe("recovery menu results", () => {
  it("keeps native ordering through intermediate text, completion and saved-result staging", () => {
    let results: Array<{ text: string }> = [];
    const receive = (texts: string[]) => {
      results = nextTrayRecoveryResults(results, "dictation-recovery-results-changed", {
        results: texts.map(text => ({ text, appTarget: null, appBundleId: null, atMs: 1 })),
      });
      expect(results.map(result => result.text)).toEqual(texts);
    };
    receive(["Raw words"]);
    receive(["Final words", "Raw words"]);
    results = nextTrayRecoveryResults(results, "dictation-text-ready", { text: "Final words" });
    expect(results.map(result => result.text)).toEqual(["Final words", "Raw words"]);
    receive(["Saved edit", "Final words", "Raw words"]);
  });

  it("does not erase a newer snapshot when an earlier reset finishes", () => {
    let results = nextTrayRecoveryResults([{ text: "Old text" }], "dictation-recovery-results-changed", { results: [] });
    expect(results).toEqual([]);
    results = nextTrayRecoveryResults(results, "dictation-recovery-results-changed", { results: [{ text: "New text" }] });
    expect(nextTrayRecoveryResults(results, "app-state-reset", { ok: true })).toEqual([{ text: "New text" }]);
  });

  it("clears a malformed snapshot without shifting any native index", () => {
    for (const payload of [null, {}, { results: [{ text: "Valid" }, null] }, { results: [{ text: "" }] }, { results: Array(4).fill({ text: "Too many" }) }]) {
      expect(nextTrayRecoveryResults([{ text: "Stale" }], "dictation-recovery-results-changed", payload)).toEqual([]);
    }
  });
});

describe("menu-bar status", () => {
  it("names microphone opening until recording starts", () => {
    expect(describeTrayStatus({ dictationPhase: "primed", dictationStartedAt: null, meetingPhase: null, meetingStartedAt: null, now: 12_400 })).toMatchObject({
      title: "…", tooltip: "Plainsong is opening the microphone", statusLine: "Opening microphone…", ticking: false,
    });
  });

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

  it("says a paused meeting is paused and keeps paused time off the clock", () => {
    const paused = describeTrayStatus({
      dictationPhase: "idle",
      dictationStartedAt: null,
      meetingPhase: "recording",
      meetingStartedAt: 0,
      meetingPaused: true,
      meetingPausedMs: 20_000,
      now: 80_000,
    });
    expect(paused).toMatchObject({
      title: "\u275A\u275A 1:00",
      statusLine: "Meeting paused",
      ticking: false,
      meetingControl: "stop",
    });
    const resumed = describeTrayStatus({
      dictationPhase: "idle",
      dictationStartedAt: null,
      meetingPhase: "recording",
      meetingStartedAt: 0,
      meetingPaused: false,
      meetingPausedMs: 20_000,
      now: 90_000,
    });
    expect(resumed).toMatchObject({ title: "● 1:10", statusLine: "Recording a meeting", ticking: true });
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

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fakeAudio(initiallyMuted = false) {
  const devices = new Map([["A", initiallyMuted], ["B", true]]);
  let output = "A";
  let journal: string | null = null;
  let readyGate: Promise<boolean> = Promise.resolve(true);
  let restoreGate: Promise<void> = Promise.resolve();
  let deferRestore = false;
  const calls: string[] = [];
  const timers = new Set<() => void>();
  const recover = async (): Promise<MediaMuteOutcome> => {
    calls.push("recover");
    if (!journal) return { kind: "skipped", reason: "No receipt" };
    if (deferRestore) return { kind: "deferred", reason: "Device unavailable" };
    devices.set(journal, false);
    journal = null;
    return { kind: "restored" };
  };
  const controller = createMediaMuteController({
    backend: {
      recover,
      open: async () => {
        const uid = output;
        calls.push(`open:${uid}`);
        let result: Promise<MediaMuteOutcome> | null = null;
        return {
          ready: readyGate,
          mute: async () => {
            calls.push(`mute:${uid}`);
            if (!devices.get(uid)) { journal = uid; devices.set(uid, true); }
            return true;
          },
          restore: () => {
            result ??= (async () => { calls.push(`restore:${uid}`); await restoreGate; return recover(); })();
            return result;
          },
        };
      },
    },
    schedule: callback => { timers.add(callback); return () => { timers.delete(callback); }; },
  });
  const flush = async () => {
    for (const callback of timers) { timers.delete(callback); callback(); }
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  };
  return { controller, calls, timers, devices, flush,
    switchOutput: (uid: string) => { output = uid; },
    holdReady: (gate: Promise<boolean>) => { readyGate = gate; },
    holdRestore: (gate: Promise<void>) => { restoreGate = gate; },
    deferRestore: (value: boolean) => { deferRestore = value; },
    seedReceipt: () => { journal = "A"; devices.set("A", true); },
    hasReceipt: () => journal !== null,
  };
}

describe("mute other audio while dictating", () => {
  it("waits for recording and the delay, then restores before the done sound", async () => {
    const mac = fakeAudio();
    await mac.controller.onPhase("primed", true);
    await mac.flush();
    expect(mac.calls).toEqual([]);
    await mac.controller.onPhase("recording", true);
    expect(mac.devices.get("A")).toBe(false);
    await mac.flush();
    expect(mac.devices.get("A")).toBe(true);
    await mac.controller.onPhase("done", true);
    expect(mac.devices.get("A")).toBe(false);
    expect(mac.controller.hasPendingWork).toBe(false);
  });

  it("preserves an already-muted output and does nothing when disabled", async () => {
    const mac = fakeAudio(true);
    await mac.controller.onPhase("recording", true); await mac.flush();
    await mac.controller.onPhase("done", true);
    expect(mac.devices.get("A")).toBe(true);
    const off = fakeAudio();
    await off.controller.onPhase("recording", false); await off.flush();
    expect(off.calls).toEqual([]);
  });

  it("cancels before the delay and before readiness without sending mute", async () => {
    const mac = fakeAudio();
    await mac.controller.onPhase("recording", true);
    await mac.controller.onPhase("stopping", true); await mac.flush();
    expect(mac.calls).toEqual([]);
    const gate = deferred<boolean>(); mac.holdReady(gate.promise);
    await mac.controller.onPhase("recording", true); await mac.flush();
    const stopping = mac.controller.onPhase("stopping", true);
    gate.resolve(true); await stopping;
    expect(mac.calls).not.toContain("mute:A");
  });

  it("does not mute when readiness is lost", async () => {
    const mac = fakeAudio(); mac.holdReady(Promise.resolve(false));
    await mac.controller.onPhase("recording", true); await mac.flush();
    expect(mac.calls).not.toContain("mute:A");
    expect(mac.calls).toContain("restore:A");
  });

  it("coalesces recording updates and restores the captured UID after an output switch", async () => {
    const mac = fakeAudio();
    await mac.controller.onPhase("recording", true);
    await mac.controller.onPhase("recording", true);
    expect(mac.timers.size).toBe(1);
    await mac.flush();
    await mac.controller.onPhase("recording", true); await mac.flush();
    mac.switchOutput("B");
    await mac.controller.onPhase("transcribing", true);
    expect(mac.calls.filter(call => call === "mute:A")).toHaveLength(1);
    expect(mac.devices.get("A")).toBe(false);
    expect(mac.devices.get("B")).toBe(true);
  });

  it("disables immediately and waits for old restoration before opening a replacement", async () => {
    const mac = fakeAudio();
    await mac.controller.onPhase("recording", true); await mac.flush();
    const gate = deferred<void>(); mac.holdRestore(gate.promise);
    const disabled = mac.controller.onPhase("recording", false);
    expect(mac.calls).toContain("restore:A");
    mac.devices.set("B", false);
    mac.switchOutput("B");
    await mac.controller.onPhase("recording", true); await mac.flush();
    expect(mac.calls).not.toContain("open:B");
    gate.resolve(); await disabled; await mac.flush();
    expect(mac.calls).toContain("open:B");
    expect(mac.devices.get("B")).toBe(true);
    await mac.controller.restore();
    expect(mac.devices.get("B")).toBe(false);
  });

  it("serializes a new recording behind startup recovery", async () => {
    const gate = deferred<MediaMuteOutcome>();
    const open = () => { throw new Error("Recovery must finish before opening"); };
    const callbacks: Array<() => void> = [];
    const controller = createMediaMuteController({
      backend: { open, recover: () => gate.promise },
      schedule: callback => { callbacks.push(callback); return () => {}; },
    });
    const recovery = controller.recoverStaleMute();
    await controller.onPhase("recording", true);
    callbacks.forEach(callback => { callback(); });
    await Promise.resolve();
    expect(controller.hasPendingWork).toBe(true);
    const stopped = controller.restore();
    gate.resolve({ kind: "skipped", reason: "No receipt" });
    await recovery; await stopped;
    expect(controller.hasPendingWork).toBe(false);
  });

  it("retains deferred recovery and retries the owned receipt at startup", async () => {
    const mac = fakeAudio(); mac.seedReceipt(); mac.deferRestore(true);
    await mac.controller.recoverStaleMute();
    expect(mac.hasReceipt()).toBe(true);
    mac.switchOutput("B"); mac.deferRestore(false);
    await mac.controller.recoverStaleMute();
    expect(mac.devices.get("A")).toBe(false);
    expect(mac.devices.get("B")).toBe(true);
    expect(mac.hasReceipt()).toBe(false);
    const userMuted = fakeAudio(true);
    await userMuted.controller.recoverStaleMute();
    expect(userMuted.devices.get("A")).toBe(true);
  });
});
