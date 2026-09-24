import { describe, expect, it } from "vitest";
import {
  DICTATION_PROGRESS_CEILING,
  dictationProgressFraction,
  easeTowardExpected,
  transcribeStageEnd,
} from "@/lib/dictation-progress";

const withPolish = { expectedTranscribeMs: 400, expectedPolishMs: 600 };
const transcribeOnly = { expectedTranscribeMs: 400, expectedPolishMs: null };

describe("dictation finishing bar", () => {
  it("is most of the way through a stage at the expected time, then slows", () => {
    const atExpected = easeTowardExpected(1000, 1000);
    expect(atExpected).toBeGreaterThan(0.8);
    expect(atExpected).toBeLessThan(0.9);
    // The second expected-duration adds far less than the first did.
    expect(easeTowardExpected(2000, 1000) - atExpected).toBeLessThan(atExpected / 4);
  });

  it("never reaches the end on its own, however late the text is", () => {
    for (const plan of [withPolish, transcribeOnly]) {
      expect(dictationProgressFraction("transcribing", 600_000, plan)).toBeLessThan(1);
      expect(dictationProgressFraction("polishing", 600_000, plan)).toBeLessThanOrEqual(
        DICTATION_PROGRESS_CEILING,
      );
    }
  });

  it("only moves forward across stages", () => {
    const stopping = dictationProgressFraction("stopping", 0, withPolish);
    const lateTranscribe = dictationProgressFraction("transcribing", 60_000, withPolish);
    const polishStart = dictationProgressFraction("polishing", 0, withPolish);
    expect(stopping).toBeLessThanOrEqual(dictationProgressFraction("transcribing", 0, withPolish));
    expect(lateTranscribe).toBeLessThanOrEqual(polishStart);
    expect(polishStart).toBeLessThan(dictationProgressFraction("polishing", 300, withPolish));
  });

  it("gives transcription the whole bar when no AI pass is expected", () => {
    expect(transcribeStageEnd(transcribeOnly)).toBe(DICTATION_PROGRESS_CEILING);
    expect(transcribeStageEnd(withPolish)).toBeLessThan(DICTATION_PROGRESS_CEILING);
  });

  it("keeps both stages visible when one estimate dwarfs the other", () => {
    const tinyTranscribe = transcribeStageEnd({ expectedTranscribeMs: 1, expectedPolishMs: 10_000 });
    const tinyPolish = transcribeStageEnd({ expectedTranscribeMs: 10_000, expectedPolishMs: 1 });
    expect(tinyTranscribe).toBeGreaterThan(0.3);
    expect(tinyPolish).toBeLessThan(0.8);
  });

  it("treats a missing or broken estimate as a short one instead of NaN", () => {
    const broken = { expectedTranscribeMs: Number.NaN, expectedPolishMs: -5 };
    expect(Number.isFinite(dictationProgressFraction("transcribing", 100, broken))).toBe(true);
    expect(Number.isFinite(dictationProgressFraction("polishing", 100, broken))).toBe(true);
  });
});
