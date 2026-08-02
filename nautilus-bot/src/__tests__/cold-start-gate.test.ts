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
    expect(result.status, result.stderr).toBe(0);
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

  it("stops descendant processes that inherit the launch pipes", () => {
    const childScript = [
      "const { spawn } = require('node:child_process');",
      "spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],",
      "  { stdio: ['ignore', 'inherit', 'inherit'] });",
      "setTimeout(() => console.error('DESCENDANT_READY'), 80);",
      "setInterval(() => {}, 1000);",
    ].join(" ");

    const result = spawnSync(
      process.execPath,
      [
        gatePath,
        "--threshold-ms",
        "2000",
        "--poll-interval-ms",
        "40",
        "--ready-output-pattern",
        "DESCENDANT_READY",
        "--",
        process.execPath,
        "-e",
        childScript,
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 5000,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      readinessOutputPattern: "DESCENDANT_READY",
    });
  });

  it("isolates Electron, sidecar data, and sidecar config for Plainsong QA", () => {
    const childScript = [
      "const path = require('node:path');",
      "const data = process.env.PLAINSONG_DATA_DIR;",
      "const config = process.env.PLAINSONG_CONFIG_DIR;",
      "const profile = process.argv.find((arg) => arg.startsWith('--user-data-dir='));",
      "if (path.isAbsolute(data || '') && path.isAbsolute(config || '') && profile) {",
      "  console.error('PLAINSONG_ISOLATED_READY');",
      "}",
      "setInterval(() => {}, 1000);",
    ].join(" ");

    const result = spawnSync(
      process.execPath,
      [
        gatePath,
        "--threshold-ms",
        "2000",
        "--poll-interval-ms",
        "40",
        "--ready-output-pattern",
        "PLAINSONG_ISOLATED_READY",
        "--isolate-plainsong-data",
        "--",
        process.execPath,
        "-e",
        childScript,
        "--",
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 5000,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      readinessOutputPattern: "PLAINSONG_ISOLATED_READY",
      isolatedPlainsongData: true,
    });
  });
});
