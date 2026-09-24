import { describe, expect, it } from "vitest";
import { dictationSoundForTransition } from "../../electron/dictation-sounds";

describe("dictation sounds", () => {
  it("ticks once when the microphone goes live", () => {
    expect(dictationSoundForTransition("primed", "recording", undefined)).toBe("start");
    expect(dictationSoundForTransition("recording", "recording", undefined)).toBeNull();
  });

  it("pops only when the words were delivered", () => {
    expect(dictationSoundForTransition("delivering", "done", "pasted")).toBe("done");
    expect(dictationSoundForTransition("delivering", "done", "copied")).toBe("done");
    for (const outcome of ["empty", "undone", "secure_field", "previewed", undefined]) {
      expect(dictationSoundForTransition("delivering", "done", outcome)).toBeNull();
    }
  });

  it("sounds a failure, and stays quiet on the way back to idle", () => {
    expect(dictationSoundForTransition("transcribing", "error", undefined)).toBe("error");
    expect(dictationSoundForTransition("done", "idle", undefined)).toBeNull();
    expect(dictationSoundForTransition("recording", "stopping", undefined)).toBeNull();
  });
});
