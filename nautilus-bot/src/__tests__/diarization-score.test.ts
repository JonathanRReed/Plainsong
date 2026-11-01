import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function score(reference: unknown[], predicted: unknown[]) {
  const directory = mkdtempSync(join(tmpdir(), "plainsong-diar-score-"));
  try {
    const truth = join(directory, "reference.json");
    const result = join(directory, "prediction.txt");
    writeFileSync(truth, JSON.stringify({ durationSeconds: 4, turns: reference }));
    writeFileSync(result, `DIAR-EVAL ${JSON.stringify({ backend: "test", durationSeconds: 4, turns: predicted, wallSeconds: 1, peakRssBytes: 0 })}\n`);
    return JSON.parse(execFileSync("bun", [resolve("scripts/score-diarization-eval.ts"), "--ground-truth", truth, "--result", result], { encoding: "utf8" })).rows[0];
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("diarization frame scoring", () => {
  it("counts an unmatched voice group in silence as a false alarm", () => {
    const result = score([{ start: 0, end: 2, speaker: "A" }], [
      { start: 0, end: 2, speaker: "S1" },
      { start: 2, end: 4, speaker: "S2" },
    ]);
    expect(result.frameErrorRate).toBe(0.5);
  });
  it("counts predicted speech in an entirely silent reference", () => {
    expect(score([], [{ start: 0, end: 4, speaker: "S1" }]).frameErrorRate).toBe(1);
  });
  it("preserves optimal mapping of arbitrary speaker IDs", () => {
    expect(score([
      { start: 0, end: 2, speaker: "A" }, { start: 2, end: 4, speaker: "B" },
    ], [
      { start: 0, end: 2, speaker: "renamed-2" }, { start: 2, end: 4, speaker: "renamed-1" },
    ]).frameErrorRate).toBe(0);
  });
});
