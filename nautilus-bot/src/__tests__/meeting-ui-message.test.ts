import { describe, expect, it } from "vitest";
import {
  containsTechnicalTerms,
  plainMeetingNotesFailure,
  plainMeetingProcessingMessage,
} from "@/lib/meeting-ui-message";

describe("meeting reader-facing messages", () => {
  it.each([
    "Not enough verified memory headroom for native inference",
    "the speech runtime is busy",
    "ONNX diarization model inference failed",
    "Failed to create embedding extractor",
    "failed with Core Audio status -10877",
    "GGUF tensor missing",
    "process tap could not start",
    "CoreML model compilation failed",
    "ANE quantization failed",
    "Unexpected response\n    at load (/Users/test/model.ts:12:4)",
    "Traceback (most recent call last): decode.py line 5",
    "Failed to open /Users/test/Library/Application Support/Plainsong/model.bin",
  ])("treats %s as internals", (text) => {
    expect(containsTechnicalTerms(text)).toBe(true);
  });

  it.each([
    "The microphone Plainsong was set to use is no longer connected.",
    "Ollama refused the connection.",
    "Speakers were not labelled because there was not enough free memory.",
  ])("leaves %s alone", (text) => {
    expect(containsTechnicalTerms(text)).toBe(false);
    expect(plainMeetingProcessingMessage(text, "fallback")).toBe(text);
  });

  it("strips the transport prefix before deciding", () => {
    expect(
      plainMeetingProcessingMessage(
        "Error invoking remote method 'sidecar:invoke': Error: Speakers were not labelled because the speaker model could not run.",
        "fallback",
      ),
    ).toBe("Speakers were not labelled because the speaker model could not run.");
  });

  it("says a busy text model plainly", () => {
    expect(
      plainMeetingNotesFailure("summary: Native runtime is busy with another task"),
    ).toBe("Another task on this Mac was using the text model. Try again in a moment.");
  });
});
