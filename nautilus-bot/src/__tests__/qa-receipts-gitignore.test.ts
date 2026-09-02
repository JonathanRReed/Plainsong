import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");

function isIgnored(relativePath: string) {
  const result = spawnSync(
    "git",
    ["-C", repoRoot, "check-ignore", "--no-index", "-q", relativePath],
    { encoding: "utf8" },
  );
  if (result.error) {
    throw result.error;
  }
  // 0 = ignored, 1 = not ignored, anything else = git itself failed.
  expect([0, 1]).toContain(result.status);
  return result.status === 0;
}

describe("artifacts/ ignore rule keeps QA receipts in the tree", () => {
  it("tracks Markdown and JSON receipts under artifacts/qa/ at any depth", () => {
    expect(isIgnored("artifacts/qa/acceleration-receipt-2026-09-01.md")).toBe(false);
    expect(isIgnored("artifacts/qa/macos/app-matrix-preflight.md")).toBe(false);
    expect(isIgnored("artifacts/qa/macos/backup-create-restore.json")).toBe(false);
    expect(isIgnored("artifacts/qa/macos/nested/deeper/receipt.md")).toBe(false);
  });

  it("still ignores raw captures and the per-machine dictation latency receipts", () => {
    expect(isIgnored("artifacts/qa/macos/capture.wav")).toBe(true);
    expect(isIgnored("artifacts/qa/support-bundle.zip")).toBe(true);
    expect(isIgnored("artifacts/cloud-asr-smoke.json")).toBe(true);
    expect(isIgnored("artifacts/asr-preflight-macos.json")).toBe(true);
    expect(isIgnored("artifacts/qa/dictation-latency.json")).toBe(true);
    expect(isIgnored("artifacts/qa/dictation-latency-e2e.json")).toBe(true);
  });
});
