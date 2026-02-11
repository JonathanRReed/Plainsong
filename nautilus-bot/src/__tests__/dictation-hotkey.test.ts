import { describe, expect, it } from "vitest";
import { nextDictationPhase } from "@/lib/dictation-hotkey";

describe("nextDictationPhase", () => {
  it("starts recording on press from idle", () => {
    expect(nextDictationPhase("idle", "pressed")).toBe("recording");
  });

  it("moves to stopping on release while recording", () => {
    expect(nextDictationPhase("recording", "released")).toBe("stopping");
  });

  it("moves to stopping on emergency stop while recording", () => {
    expect(nextDictationPhase("recording", "emergency_stop")).toBe("stopping");
  });

  it("moves to stopping on watchdog timeout while recording", () => {
    expect(nextDictationPhase("recording", "watchdog_timeout")).toBe("stopping");
  });

  it("keeps current phase for unrelated events", () => {
    expect(nextDictationPhase("transcribing", "released")).toBe("transcribing");
  });
});
