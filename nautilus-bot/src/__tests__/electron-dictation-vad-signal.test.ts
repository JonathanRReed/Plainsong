import { describe, expect, it } from "vitest";
import { resolveDictationVadStop } from "../../electron/dictation-vad-signal";

const recording = { phase: "recording", sessionId: 7 };

describe("resolveDictationVadStop", () => {
  it("stops on sustained silence", () => {
    expect(resolveDictationVadStop({ signal: "silence_stop", sessionId: 7 }, recording)).toEqual({
      stopReason: "auto_stop_silence",
      sessionId: 7,
    });
  });

  it("delivers the words as soon as the maximum length ends capture", () => {
    // The sidecar has already stopped storing audio. Leaving the session in
    // "recording" kept the pill saying Listening while nothing was recorded.
    expect(
      resolveDictationVadStop(
        { signal: "max_duration_stop", sessionId: 7, maxDurationSeconds: 600 },
        recording,
      ),
    ).toEqual({ stopReason: "max_duration", sessionId: 7 });
  });

  it("never stops a newer session with a stale signal", () => {
    expect(resolveDictationVadStop({ signal: "max_duration_stop", sessionId: 6 }, recording)).toBeNull();
    expect(resolveDictationVadStop({ signal: "silence_stop", sessionId: 6 }, recording)).toBeNull();
  });

  it("ignores sessions already finishing and unrelated signals", () => {
    for (const phase of ["stopping", "transcribing", "done", "idle"]) {
      expect(
        resolveDictationVadStop({ signal: "max_duration_stop", sessionId: 7 }, { phase, sessionId: 7 }),
      ).toBeNull();
    }
    expect(resolveDictationVadStop({ signal: "hands_free_start" }, recording)).toBeNull();
    expect(resolveDictationVadStop(null, recording)).toBeNull();
  });

  it("accepts an unscoped signal for the live session", () => {
    expect(resolveDictationVadStop({ signal: "silence_stop" }, recording)).toEqual({
      stopReason: "auto_stop_silence",
      sessionId: null,
    });
  });
});
