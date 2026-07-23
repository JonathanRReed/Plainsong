import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

function createTempRepo(scriptName: string) {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "plainsong-update-metadata-"));
  const tempScriptsDir = path.join(tempRoot, "scripts");
  mkdirSync(tempScriptsDir, { recursive: true });

  const sourceScript = path.resolve(process.cwd(), "scripts", scriptName);
  const tempScript = path.join(tempScriptsDir, scriptName);
  copyFileSync(sourceScript, tempScript);

  writeFileSync(
    path.join(tempRoot, "package.json"),
    JSON.stringify({ name: "plainsong", version: "1.0.0" }, null, 2),
  );

  return { tempRoot, tempScript };
}

describe("verify-packaged-macos-update-metadata.mjs", () => {
  it("writes JSON and Markdown artifacts and preserves the missing app-update.yml error when the packaged app is missing", () => {
    const { tempRoot, tempScript } = createTempRepo("verify-packaged-macos-update-metadata.mjs");
    try {
      const outPath = path.join(tempRoot, "artifacts", "qa", "macos", "update-metadata.json");
      const markdownPath = path.join(tempRoot, "artifacts", "qa", "macos", "update-metadata.md");
      const appPath = path.join(tempRoot, "missing.app");
      const latestPath = path.join(tempRoot, "release", "latest-mac.yml");

      const result = spawnSync(
        "node",
        [
          tempScript,
          "--app",
          appPath,
          "--latest",
          latestPath,
          "--out",
          outPath,
          "--markdown",
          markdownPath,
        ],
        {
          encoding: "utf8",
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.signal).toBeNull();

      expect(result.stdout).not.toMatch(/TypeError/);
      expect(result.stdout).toContain("packaged app-update.yml not found");
      expect(result.stderr).not.toContain("TypeError");

      expect(existsSync(outPath)).toBe(true);
      expect(existsSync(markdownPath)).toBe(true);

      const artifact = JSON.parse(readFileSync(outPath, "utf8")) as {
        error?: string;
        pass: boolean;
      };
      expect(artifact.pass).toBe(false);
      expect(artifact.error).toContain("packaged app-update.yml not found");

      const markdown = readFileSync(markdownPath, "utf8");
      expect(markdown).toContain("Status: FAIL");
      expect(markdown).toContain("qa:packaged:macos:update-metadata");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
