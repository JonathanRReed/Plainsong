import { describe, expect, it } from "vitest";
import {
  describeDictationDeliveryRefusal,
  sanitizeUserFacingDictationMessage,
} from "@/lib/dictation-ui-message";

describe("describeDictationDeliveryRefusal", () => {
  it("explains a secure-field refusal in plain language", () => {
    const refusal = describeDictationDeliveryRefusal("secure_field");
    expect(refusal).not.toBeNull();
    expect(refusal?.title).toBe("Not inserted — secure field");
    // The three facts the user needs: what the field is, what Plainsong did
    // not do (insert OR copy), and where the words are.
    expect(refusal?.message).toMatch(/password or secure input/);
    expect(refusal?.message).toMatch(/did not insert or copy/);
    expect(refusal?.message).toMatch(/dictation history/);
    expect(refusal?.message).toMatch(/Copy result/);
  });

  it("leaves every other outcome to the existing branches", () => {
    for (const outcome of [
      "pasted",
      "paste_dispatched",
      "copied",
      "error",
      "empty",
      "",
      null,
      undefined,
    ]) {
      expect(describeDictationDeliveryRefusal(outcome)).toBeNull();
    }
  });
});

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
