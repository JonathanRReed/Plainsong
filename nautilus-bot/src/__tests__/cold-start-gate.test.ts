import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const gatePath = path.join(repoRoot, "scripts", "cold-start-gate.mjs");

describe("cold-start-gate.mjs", () => {
  it("waits for a readiness line from a long-running process and then stops it", () => {
    const result = spawnSync(
      process.execPath,
      [
        gatePath,
        "--threshold-ms",
        "2000",
        "--poll-interval-ms",
        "40",
        "--ready-output-pattern",
        "READY_FOR_QA",
        "--",
        process.execPath,
        "-e",
        "setTimeout(() => console.error('READY_FOR_QA'), 80); setInterval(() => {}, 1000);",
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 5000,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      readinessOutputPattern: string;
      elapsedMs: number;
      thresholdMs: number;
    };
    expect(report.ok).toBe(true);
    expect(report.readinessOutputPattern).toBe("READY_FOR_QA");
    expect(report.elapsedMs).toBeLessThan(report.thresholdMs);
  });
});
