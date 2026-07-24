import { spawnSync } from "node:child_process";
import {
  chmodSync,
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
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "plainsong-release-preflight-"));
  const tempScriptsDir = path.join(tempRoot, "scripts");
  mkdirSync(tempScriptsDir, { recursive: true });

  const sourceScript = path.resolve(process.cwd(), "scripts", scriptName);
  const tempScript = path.join(tempScriptsDir, scriptName);
  copyFileSync(sourceScript, tempScript);

  return { tempRoot, tempScript };
}

describe("release-credentials-preflight.mjs", () => {
  it("writes secret-safe JSON and Markdown artifacts using dummy credentials and a fake codesigning identity count", () => {
    const { tempRoot, tempScript } = createTempRepo("release-credentials-preflight.mjs");
    try {
      const tempBinDir = path.join(tempRoot, "bin");
      mkdirSync(tempBinDir, { recursive: true });

      const securityScript = path.join(tempBinDir, "security");
      writeFileSync(
        securityScript,
        "#!/bin/sh\nprintf '%s\\n' '2 valid identities found'\n",
        "utf8",
      );
      chmodSync(securityScript, 0o755);

      const env = {
        PATH: `${tempBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
        CSC_LINK: "dummy-csc-link",
        CSC_KEY_PASSWORD: "dummy-csc-key-password",
        APPLE_ID: "dummy@example.com",
        APPLE_APP_SPECIFIC_PASSWORD: "dummy-app-specific-password",
        APPLE_TEAM_ID: "DUMMYTEAMID",
      };

      const result = spawnSync("node", [tempScript], {
        encoding: "utf8",
        env,
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.signal).toBeNull();

      const jsonPath = path.join(tempRoot, "artifacts", "release-credential-preflight.json");
      const markdownPath = path.join(tempRoot, "artifacts", "release-credential-preflight.md");
      expect(existsSync(jsonPath)).toBe(true);
      expect(existsSync(markdownPath)).toBe(true);

      const artifact = JSON.parse(readFileSync(jsonPath, "utf8")) as {
        codesigningIdentityCount: number | null;
        envPresence: Record<string, boolean>;
        hasCertificateInput: boolean;
        hasNotarizationInputs: boolean;
        ready: boolean;
      };

      const expectedIdentityCount = process.platform === "darwin" ? 2 : null;

      expect(artifact).toMatchObject({
        codesigningIdentityCount: expectedIdentityCount,
        envPresence: {
          CSC_LINK: true,
          CSC_NAME: false,
          CSC_KEY_PASSWORD: true,
          APPLE_ID: true,
          APPLE_APP_SPECIFIC_PASSWORD: true,
          APPLE_TEAM_ID: true,
        },
        hasCertificateInput: true,
        hasNotarizationInputs: true,
        ready: true,
      });

      const markdown = readFileSync(markdownPath, "utf8");
      expect(markdown).toContain("Status: READY");
      expect(markdown).toContain(
        process.platform === "darwin"
          ? "Developer ID codesigning identities in keychain: 2"
          : "Developer ID codesigning identities in keychain: n/a (not macOS)",
      );
      expect(markdown).not.toContain("dummy-csc-link");
      expect(markdown).not.toContain("dummy-csc-key-password");
      expect(markdown).not.toContain("dummy-app-specific-password");
      expect(markdown).not.toContain("dummy@example.com");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
    // Spawns the preflight script in a subprocess, so it loses the default 5s
    // race whenever the rest of the suite is running in parallel.
  }, 30_000);
});
