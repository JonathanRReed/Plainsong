import { describe, expect, it } from "vitest";
import { sanitizeMeetingSoakReceipt } from "../../scripts/lib/meeting-soak-receipt.mjs";

describe("meeting soak receipt sanitization", () => {
  it("removes captured transcript and log content while preserving release proof", () => {
    const secret = "private unrelated system audio";
    const sanitized = sanitizeMeetingSoakReceipt({
      generatedAt: "2026-08-09T21:10:50.860Z",
      pass: true,
      checks: { recordingCompleted: true },
      transcript: {
        actualProvider: "parakeet",
        fullText: secret,
        segments: [
          {
            id: "segment-1",
            startTime: 1,
            endTime: 2,
            text: secret,
          },
        ],
      },
      fixtureTranscriptMatch: {
        matched: true,
        transcriptTokens: ["private", "unrelated", "system", "audio"],
        transcriptLength: { characters: secret.length, tokens: 4 },
      },
      events: [
        {
          event: "recording-transcription-stream",
          payload: { text: secret, segmentText: secret, status: "processing" },
        },
      ],
      stderr: { length: secret.length, tail: secret },
    });

    expect(JSON.stringify(sanitized)).not.toContain(secret);
    expect(sanitized).toMatchObject({
      pass: true,
      contentRedacted: true,
      checks: { recordingCompleted: true },
      transcriptEvidence: {
        characters: secret.length,
        segmentCount: 1,
        contentRedacted: true,
      },
      transcript: {
        actualProvider: "parakeet",
        fullTextLength: secret.length,
        fullTextRedacted: true,
        segments: [
          {
            id: "segment-1",
            startTime: 1,
            endTime: 2,
            textLength: secret.length,
            textRedacted: true,
          },
        ],
      },
      fixtureTranscriptMatch: {
        matched: true,
        transcriptTokenCount: 4,
        transcriptTokensRedacted: true,
      },
      events: [
        {
          event: "recording-transcription-stream",
          payload: {
            status: "processing",
            segmentTextLength: secret.length,
            segmentTextRedacted: true,
            textLength: secret.length,
            textRedacted: true,
          },
        },
      ],
      stderr: {
        length: secret.length,
        tailRedacted: true,
      },
    });
    expect(sanitized.transcript).not.toHaveProperty("fullText");
    expect(sanitized.fixtureTranscriptMatch).not.toHaveProperty(
      "transcriptTokens",
    );
    expect(sanitized.stderr).not.toHaveProperty("tail");
  });
});
