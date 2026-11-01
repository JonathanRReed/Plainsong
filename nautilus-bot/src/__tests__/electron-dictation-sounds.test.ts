import { spawn } from "child_process";
import { describe, expect, it, vi } from "vitest";
import { dictationSoundForTransition, dictationStartSoundDelayMs, playDictationSound } from "../../electron/dictation-sounds";

vi.mock("child_process", () => ({ spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })) }));

describe("dictation sounds", () => {
  it("ticks once when the first captured sample arrives", () => {
    expect(dictationSoundForTransition("primed", "recording", undefined, true)).toBe("start");
    expect(dictationSoundForTransition("recording", "recording", undefined, true)).toBeNull();
    // A recording event that does not say audio is arriving stays quiet.
    expect(dictationSoundForTransition("primed", "recording", undefined, false)).toBeNull();
    expect(dictationSoundForTransition("primed", "recording", undefined)).toBeNull();
  });

  it("holds the start sound only as long as the input asks, within a bound", () => {
    expect(dictationStartSoundDelayMs(300)).toBe(300);
    expect(dictationStartSoundDelayMs(1200)).toBe(1200);
    expect(dictationStartSoundDelayMs(60_000)).toBe(2000);
    for (const value of [0, -5, Number.NaN, "300", null, undefined]) {
      expect(dictationStartSoundDelayMs(value)).toBe(0);
    }
  });

  it("pops only for a verified insert and calls attention to clipboard or preview results", () => {
    for (const outcome of ["pasted", "replaced"]) {
      expect(dictationSoundForTransition("delivering", "done", outcome)).toBe("done");
    }
    for (const outcome of ["paste_dispatched", "copied", "copied_replacement", "copied_instead", "previewed", "ready"]) {
      expect(dictationSoundForTransition("delivering", "done", outcome)).toBe("attention");
    }
    for (const outcome of ["secure_field", "error"]) {
      expect(dictationSoundForTransition("delivering", "done", outcome)).toBe("error");
    }
    for (const outcome of ["empty", "undone", "aborted", undefined]) {
      expect(dictationSoundForTransition("delivering", "done", outcome)).toBeNull();
    }
  });

  it("sounds a failure, and stays quiet on the way back to idle", () => {
    expect(dictationSoundForTransition("transcribing", "error", undefined)).toBe("error");
    expect(dictationSoundForTransition("done", "idle", undefined)).toBeNull();
    expect(dictationSoundForTransition("recording", "stopping", undefined)).toBeNull();
  });

  it.each([
    ["start", "Tink"], ["done", "Pop"], ["attention", "Purr"], ["error", "Funk"],
  ] as const)("plays %s at quarter volume", (sound, file) => {
    playDictationSound(sound, "darwin");
    expect(spawn).toHaveBeenLastCalledWith("/usr/bin/afplay", ["-v", "0.25", `/System/Library/Sounds/${file}.aiff`], {
      stdio: "ignore", detached: false,
    });
  });
});
