import { describe, expect, it } from "vitest";
import {
  describeSidecarLoss,
  parseSidecarRuntimeEvent,
  type SidecarExitReason,
} from "@/lib/sidecar-runtime";

describe("parseSidecarRuntimeEvent", () => {
  it("reads the typed reason the bridge sends", () => {
    expect(
      parseSidecarRuntimeEvent({
        ready: false,
        reason: "crash",
        message: "Sidecar process exited (code=1, signal=null)",
      }),
    ).toEqual({
      ready: false,
      reason: "crash",
      detail: "Sidecar process exited (code=1, signal=null)",
    });
  });

  it("treats an untyped sentence as detail, not as a reason", () => {
    // Older builds put a free-form sentence in the same key.
    expect(
      parseSidecarRuntimeEvent({
        ready: false,
        reason: "Sidecar process exited (code=1, signal=null)",
      }),
    ).toEqual({
      ready: false,
      reason: null,
      detail: "Sidecar process exited (code=1, signal=null)",
    });
  });

  it("reads a recovery with nothing else attached", () => {
    expect(parseSidecarRuntimeEvent({ ready: true })).toEqual({
      ready: true,
      reason: null,
      detail: null,
    });
  });

  it("discards a payload that is not the promised shape", () => {
    expect(parseSidecarRuntimeEvent(null)).toBeNull();
    expect(parseSidecarRuntimeEvent("crash")).toBeNull();
    expect(parseSidecarRuntimeEvent({ reason: "crash" })).toBeNull();
  });
});

describe("describeSidecarLoss", () => {
  it("never renders the bridge's log line", () => {
    const reasons: Array<SidecarExitReason | null> = [
      "crash",
      "killed",
      "spawn_failed",
      "unresponsive",
      null,
    ];

    for (const reason of reasons) {
      const notice = describeSidecarLoss(reason);
      expect(notice.title).toMatch(/transcription engine/i);
      expect(notice.title).not.toMatch(/sidecar|code=|signal=/i);
      expect(notice.message).not.toMatch(/sidecar|code=|signal=/i);
      expect(notice.message.length).toBeGreaterThan(0);
    }
  });

  it("separates a restart in progress from a start that never happened", () => {
    expect(describeSidecarLoss("crash").recovering).toBe(true);
    expect(describeSidecarLoss("unresponsive").recovering).toBe(true);
    // Nothing is being retried here, so the copy must not promise a restart.
    expect(describeSidecarLoss("spawn_failed").recovering).toBe(false);
    expect(describeSidecarLoss("spawn_failed").message).toMatch(
      /restarting plainsong/i,
    );
  });

  it("falls back to a legible line when no reason was sent", () => {
    expect(describeSidecarLoss(null).title).toBe(
      "The local transcription engine stopped",
    );
  });
});
