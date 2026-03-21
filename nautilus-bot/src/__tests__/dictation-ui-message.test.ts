import { describe, expect, it } from "vitest";
import { sanitizeUserFacingDictationMessage } from "@/lib/dictation-ui-message";

describe("sanitizeUserFacingDictationMessage", () => {
  it("passes through normal user-facing messages", () => {
    expect(
      sanitizeUserFacingDictationMessage("Copied to the clipboard.", {
        phase: "done",
      }),
    ).toBe("Copied to the clipboard.");
  });

  it("replaces raw STT runtime dumps with a plain error message", () => {
    expect(
      sanitizeUserFacingDictationMessage(
        "STTOutput(text='', segments=[{'text': '', 'start': 0.0, 'end': 0.0}], prompt_tps=10.7, generation_tps=0.0)",
        { phase: "error" },
      ),
    ).toBe("Transcription failed. Try again or switch to another model.");
  });
});
