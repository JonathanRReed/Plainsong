import { describe, expect, it } from "vitest";
import {
  describeDictationVocabularyNote,
  describeDictationDeliveryRefusal,
  sanitizeUserFacingDictationMessage,
} from "@/lib/dictation-ui-message";

describe("describeDictationVocabularyNote", () => {
  it("says the dictionary travels with the audio for cloud routes that take it", () => {
    for (const provider of ["openai_cloud", "groq", "elevenlabs_scribe"]) {
      expect(describeDictationVocabularyNote(provider)).toMatch(
        /dictionary terms and snippet triggers are sent with the audio/,
      );
    }
  });

  it("names the ElevenLabs keyterms surcharge next to the choice", () => {
    expect(describeDictationVocabularyNote("elevenlabs_scribe")).toMatch(
      /ElevenLabs bills 20% more/,
    );
    expect(describeDictationVocabularyNote("openai_cloud")).not.toMatch(/20%/);
  });

  it("says plainly when a cloud route does not take the dictionary", () => {
    expect(describeDictationVocabularyNote("cohere_transcribe")).toMatch(
      /does not accept vocabulary hints/,
    );
  });

  it("says whether a local route takes hints or only exact replacements", () => {
    for (const provider of ["whisper", "qwen3_asr", "whistle"]) {
      expect(describeDictationVocabularyNote(provider)).toMatch(/spelling hints on this Mac/);
    }
    for (const provider of ["parakeet", "moonshine", "whisper_candle", "distil_whisper"]) {
      expect(describeDictationVocabularyNote(provider)).toMatch(/does not take vocabulary hints/);
    }
  });

  it("says nothing for routes whose hint behavior is not established", () => {
    for (const provider of ["macos_apple_speech", "", null, undefined]) {
      expect(describeDictationVocabularyNote(provider)).toBeNull();
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
    // History can be off, so the words are placed in Plainsong, not history.
    expect(refusal?.message).toMatch(/stay in Plainsong/);
    expect(refusal?.message).not.toMatch(/dictation history/);
    expect(refusal?.message).toMatch(/Copy result/);
  });

  it("says a newer user clipboard was kept, without sending anyone to Cmd+V", () => {
    const refusal = describeDictationDeliveryRefusal("clipboard_kept");
    expect(refusal?.title).toBe("Not inserted — clipboard kept");
    expect(refusal?.message).toMatch(/did not replace your clipboard/);
    expect(refusal?.message).toMatch(/Copy result/);
    expect(refusal?.message).not.toMatch(/Cmd\+V/);
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
  it.each([
    "CoreML speech model compilation failed",
    "ANE quantization failed",
    "Failed to load GGUF tensor metadata",
    "Unexpected response\n    at decode (/Users/test/model.ts:12:4)",
  ])("replaces diagnostic errors with recovery advice: %s", (message) => {
    expect(sanitizeUserFacingDictationMessage(message, { phase: "error" })).toBe(
      "Transcription failed. Try again or switch to another model.",
    );
  });

  it.each([
    "Error invoking remote method 'sidecar:invoke': Error: ",
    'Error: Error invoking remote method "sidecar:invoke": Error: ',
  ])("removes IPC wrappers while preserving retry advice: %s", (prefix) => {
    expect(sanitizeUserFacingDictationMessage(
      `${prefix}Whisper model not downloaded yet. Download it in Settings -> ASR Models.`,
      { phase: "error" },
    )).toBe("Whisper model not downloaded yet. Download it in Settings > Models.");
  });

  it.each([
    ["transcribing", "Preparing the speech model for this Mac. This happens once."],
    [
      "error",
      "Couldn't transcribe with Parakeet v3. Parakeet is downloading a file it needs on this Mac. Dictation will be ready when it finishes; see Settings > Models.",
    ],
    [
      "error",
      "Couldn't transcribe with Parakeet v3. Parakeet couldn't download a file it needs on this Mac. Check your connection; Plainsong will try again.",
    ],
  ] as const)("keeps the speech model's own %s message: %s", (phase, message) => {
    expect(sanitizeUserFacingDictationMessage(message, { phase })).toBe(message);
  });

  it("preserves an error-like phrase inside the actual advice", () => {
    expect(sanitizeUserFacingDictationMessage("The provider returned Error: model unavailable."))
      .toBe("The provider returned Error: model unavailable.");
  });

  it("passes through normal user-facing messages", () => {
    expect(
      sanitizeUserFacingDictationMessage("Copied to the clipboard.", {
        phase: "done",
      }),
    ).toBe("Copied to the clipboard.");
  });

  it.each([
    "Not enough verified memory headroom for native inference working buffers alongside other applications.",
    "Not enough verified memory headroom to run built-in cleanup alongside other applications",
    "Not enough verified memory headroom for native text processing and other applications.",
    "Not enough current memory headroom for this Ollama model and context alongside other applications.",
    "Could not verify current memory headroom for local Ollama processing.",
    "Could not verify native memory headroom.",
    "Apple Speech needs more verified memory headroom before transcription.",
  ])("adds actionable advice for a native memory admission refusal: %s", (message) => {
    expect(sanitizeUserFacingDictationMessage(message, { phase: "error" })).toBe(
      "Plainsong couldn't confirm enough free memory for local processing. Close memory-heavy applications and try again, or choose a smaller model in Settings > Models.",
    );
  });

  it("keeps captured-audio recovery notices after memory admission advice", () => {
    const recovery = " Captured audio could not be saved for retry: disk is full.";
    expect(sanitizeUserFacingDictationMessage(
      "Error invoking remote method 'sidecar:invoke': Error: Not enough verified memory headroom for native inference working buffers alongside other applications." + recovery,
      { phase: "error" },
    )).toContain("Settings > Models." + recovery);
  });

  it("preserves AI cleanup context and the kept-text fallback around admission advice", () => {
    const message = "AI cleanup unavailable: Not enough verified memory headroom to run built-in cleanup alongside other applications. Kept the recognized text without AI changes.";
    expect(sanitizeUserFacingDictationMessage(message, { phase: "done" })).toBe(
      "AI cleanup unavailable: Plainsong couldn't confirm enough free memory for local processing. Close memory-heavy applications and try again, or choose a smaller model in Settings > Models. Kept the recognized text without AI changes.",
    );
  });

  it("preserves unicode model-name prefixes and saved-audio suffixes", () => {
    const prefix = "Ollama model İTiny: ";
    const suffix = " Captured audio is kept for retry.";
    expect(sanitizeUserFacingDictationMessage(
      prefix + "Not enough current memory headroom for this Ollama model and context alongside other applications." + suffix,
      { phase: "error" },
    )).toBe(prefix + "Plainsong couldn't confirm enough free memory for local processing. Close memory-heavy applications and try again, or choose a smaller model in Settings > Models." + suffix);
  });

  it("preserves actual out-of-memory recovery advice and unrelated memory text", () => {
    for (const message of [
      "transcribe.cpp ran out of memory transcribing with 'test-model'. Close other applications or pick a smaller model.",
      "Could not save memory preferences.",
      "Memory model not downloaded yet.",
    ]) {
      expect(sanitizeUserFacingDictationMessage(message, { phase: "error" })).toBe(message);
    }
  });

  it("replaces raw STT runtime dumps with a plain error message", () => {
    expect(
      sanitizeUserFacingDictationMessage(
        "STTOutput(text='', segments=[{'text': '', 'start': 0.0, 'end': 0.0}], prompt_tps=10.7, generation_tps=0.0)",
        { phase: "error" },
      ),
    ).toBe("Transcription failed. Try again or switch to another model.");
  });

  it("keeps speech-engine internals out of fallback and error copy", () => {
    expect(
      sanitizeUserFacingDictationMessage(
        "Neural Engine helper exited before replying; used the ggml route",
        { phase: "done" },
      ),
    ).toBeNull();
    expect(
      sanitizeUserFacingDictationMessage("Core ML model failed to compile", { phase: "error" }),
    ).toBe("Transcription failed. Try again or switch to another model.");
    expect(
      sanitizeUserFacingDictationMessage("FluidAudio refused the request", { phase: "transcribing" }),
    ).toBe("Finishing transcription.");
    // A Whisper file name is something the user can find on disk, not an internal.
    expect(
      sanitizeUserFacingDictationMessage("Whisper model ggml-base.en.bin is missing."),
    ).toBe("Whisper model ggml-base.en.bin is missing.");
  });
});
