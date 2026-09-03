import { describe, expect, it } from "vitest";
import {
  describeCloudDictationVocabularyNote,
  describeDictationDeliveryRefusal,
  sanitizeUserFacingDictationMessage,
} from "@/lib/dictation-ui-message";

describe("describeCloudDictationVocabularyNote", () => {
  it("says the dictionary travels with the audio for cloud routes that take it", () => {
    for (const provider of ["openai_cloud", "groq", "elevenlabs_scribe"]) {
      expect(describeCloudDictationVocabularyNote(provider)).toMatch(
        /dictionary terms and snippet triggers are sent with the audio/,
      );
    }
  });

  it("names the ElevenLabs keyterms surcharge next to the choice", () => {
    expect(describeCloudDictationVocabularyNote("elevenlabs_scribe")).toMatch(
      /ElevenLabs bills 20% more/,
    );
    expect(describeCloudDictationVocabularyNote("openai_cloud")).not.toMatch(/20%/);
  });

  it("says plainly when a cloud route does not take the dictionary", () => {
    expect(describeCloudDictationVocabularyNote("cohere_transcribe")).toMatch(
      /does not accept vocabulary hints/,
    );
  });

  it("says nothing for routes that keep the dictionary on this Mac", () => {
    for (const provider of ["whisper", "parakeet", "macos_apple_speech", "", null, undefined]) {
      expect(describeCloudDictationVocabularyNote(provider)).toBeNull();
    }
  });
});

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
