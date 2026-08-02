import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const scriptPath = path.join(repoRoot, "scripts", "provision-asr-assets.mjs");

describe("ASR provisioner required-provider selection", () => {
  it("fails only the explicitly required local provider set", () => {
    const tempRoot = mkdtempSync(
      path.join(os.tmpdir(), "plainsong-asr-required-providers-"),
    );
    const reportPath = path.join(tempRoot, "report.json");

    try {
      const result = spawnSync(
        process.execPath,
        [
          scriptPath,
          "--validate-only",
          "--allow-missing-secrets",
          "--models-root",
          path.join(tempRoot, "models"),
          "--required-providers",
          "whisper",
          "--out",
          reportPath,
        ],
        { encoding: "utf8" },
      );

      expect(result.status).toBe(1);
      const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
        summary: {
          failingProviders: Array<{ provider: string }>;
          requiredProviders: string[];
          unknownRequiredProviders: string[];
        };
      };
      expect(report.summary.requiredProviders).toEqual(["whisper"]);
      expect(report.summary.unknownRequiredProviders).toEqual([]);
      expect(report.summary.failingProviders.map(({ provider }) => provider)).toEqual([
        "whisper",
      ]);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps the packaged launch preflight local and route-specific", () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const command = packageJson.scripts["qa:asr:preflight"];

    expect(command).toContain("--allow-missing-secrets");
    expect(command).toContain(
      "--required-providers whisper,parakeet_tdt_v3,distil_whisper",
    );
  });
});
