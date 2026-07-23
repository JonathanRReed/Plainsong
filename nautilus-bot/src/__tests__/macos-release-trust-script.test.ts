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
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "plainsong-macos-trust-"));
  const tempScriptsDir = path.join(tempRoot, "scripts");
  mkdirSync(tempScriptsDir, { recursive: true });

  const sourceScript = path.resolve(process.cwd(), "scripts", scriptName);
  const tempScript = path.join(tempScriptsDir, scriptName);
  copyFileSync(sourceScript, tempScript);

  return { tempRoot, tempScript };
}

function writeExecutableScript(filePath: string, body: string) {
  writeFileSync(filePath, `#!/bin/sh\nset -eu\n${body.trim()}\n`, "utf8");
  chmodSync(filePath, 0o755);
}

function createFakeMacosApp(tempRoot: string) {
  const appPath = path.join(tempRoot, "release", "mac-arm64", "Plainsong.app");
  const contentsDir = path.join(appPath, "Contents");
  const macosDir = path.join(contentsDir, "MacOS");
  const resourcesDir = path.join(contentsDir, "Resources");
  const sidecarDir = path.join(resourcesDir, "sidecar");
  const shortcutHelperDir = path.join(
    resourcesDir,
    "shortcut-helper",
  );

  mkdirSync(macosDir, { recursive: true });
  mkdirSync(sidecarDir, { recursive: true });
  mkdirSync(shortcutHelperDir, { recursive: true });

  const mainExecutable = path.join(macosDir, "Plainsong");
  const sidecarExecutable = path.join(sidecarDir, "plainsong-sidecar");
  const helperExecutable = path.join(shortcutHelperDir, "plainsong-native-shortcut-helper");

  writeFileSync(mainExecutable, "", "utf8");
  writeFileSync(sidecarExecutable, "", "utf8");
  writeFileSync(helperExecutable, "", "utf8");
  chmodSync(mainExecutable, 0o755);
  chmodSync(sidecarExecutable, 0o755);
  chmodSync(helperExecutable, 0o755);

  return {
    appPath,
    helperExecutable,
    mainExecutable,
    sidecarExecutable,
  };
}

function createSpoofedPathToolchain(tempRoot: string) {
  const binDir = path.join(tempRoot, "bin");
  mkdirSync(binDir, { recursive: true });

  const tracePath = path.join(tempRoot, "spoofed-path-trace.log");
  writeFileSync(tracePath, "", "utf8");

  writeExecutableScript(
    path.join(binDir, "codesign"),
    `
printf '%s\\n' "codesign $*" >> "$SPOOFED_PATH_TRACE_LOG"
display_requested=0
for arg in "$@"; do
  case "$arg" in
    -d*|--display)
      display_requested=1
      ;;
  esac
done
if [ "$display_requested" -eq 1 ]; then
  cat <<'EOF'
Executable=/private/tmp/Plainsong.app/Contents/MacOS/Plainsong
Authority=Developer ID Application: Jonathan Reed (AJ9VWBRNZN)
Authority=Apple Root CA
TeamIdentifier=AJ9VWBRNZN
Runtime Version=14.0.0
Timestamp=Thu Jul 23 00:00:00 UTC 2026
Flags=0x10000(runtime)
EOF
fi
exit 0
`,
  );

  writeExecutableScript(
    path.join(binDir, "xcrun"),
    `
printf '%s\\n' "xcrun $*" >> "$SPOOFED_PATH_TRACE_LOG"
if [ "\${1:-}" = "stapler" ] && [ "\${2:-}" = "validate" ]; then
  printf '%s\\n' "The validate action worked!"
  exit 0
fi
printf '%s\\n' "unexpected xcrun invocation: $*" >&2
exit 1
`,
  );

  writeExecutableScript(
    path.join(binDir, "spctl"),
    `
printf '%s\\n' "spctl $*" >> "$SPOOFED_PATH_TRACE_LOG"
if [ "\${TRUST_SPCTL_RESULT:-}" = "reject" ]; then
  printf '%s\\n' "rejected" >&2
  printf '%s\\n' "source=no usable signature" >&2
  exit 1
fi
printf '%s\\n' "accepted"
printf '%s\\n' "source=Notarized Developer ID"
exit 0
`,
  );

  writeExecutableScript(
    path.join(binDir, "lipo"),
    `
printf '%s\\n' "lipo $*" >> "$SPOOFED_PATH_TRACE_LOG"
printf '%s\\n' "arm64"
exit 0
`,
  );

  return { binDir, tracePath };
}

function createMockedAppleTools(tempRoot: string) {
  const preloadPath = path.join(tempRoot, "mock-apple-tools.cjs");
  const tracePath = path.join(tempRoot, "mock-apple-tools-trace.log");
  writeFileSync(tracePath, "", "utf8");
  writeFileSync(
    preloadPath,
    String.raw`
const childProcess = require("node:child_process");
const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");

function commandResult(status, stdout = "", stderr = "") {
  return {
    pid: 1,
    output: [null, stdout, stderr],
    stdout,
    stderr,
    status,
    signal: null,
    error: undefined,
  };
}

childProcess.spawnSync = function mockedSpawnSync(command, args = []) {
  fs.appendFileSync(
    process.env.MOCK_APPLE_TOOLS_TRACE_LOG,
    [command, ...args].join(" ") + "\n",
  );

  if (command === "/usr/bin/codesign") {
    const displayRequested = args.some(
      (arg) => arg === "--display" || String(arg).startsWith("-d"),
    );
    if (displayRequested) {
      return commandResult(
        0,
        "",
        [
          "Executable=/private/tmp/Plainsong.app/Contents/MacOS/Plainsong",
          "Authority=Developer ID Application: Jonathan Reed (AJ9VWBRNZN)",
          "Authority=Apple Root CA",
          "TeamIdentifier=AJ9VWBRNZN",
          "Runtime Version=14.0.0",
          "Timestamp=Thu Jul 23 00:00:00 UTC 2026",
          "Flags=0x10000(runtime)",
          "",
        ].join("\n"),
      );
    }
    return commandResult(0);
  }

  if (command === "/usr/bin/lipo") {
    return commandResult(0, "arm64\n");
  }

  if (command === "/usr/bin/xcrun") {
    if (args[0] === "stapler" && args[1] === "validate") {
      return commandResult(0, "The validate action worked!\n");
    }
    return commandResult(1, "", "unexpected xcrun invocation\n");
  }

  if (command === "/usr/sbin/spctl") {
    if (process.env.TRUST_SPCTL_RESULT === "reject") {
      return commandResult(1, "", "rejected\nsource=no usable signature\n");
    }
    return commandResult(0, "accepted\nsource=Notarized Developer ID\n");
  }

  return commandResult(1, "", "unexpected command: " + command + "\n");
};

syncBuiltinESMExports();
`,
    "utf8",
  );

  return { preloadPath, tracePath };
}

function runTrustScript(
  tempScript: string,
  tempRoot: string,
  appPath: string,
  mode: "accept" | "reject",
  expectedTeam = "AJ9VWBRNZN",
  harness: "mock-apple-tools" | "spoofed-path-only" = "mock-apple-tools",
) {
  const outPath = path.join(tempRoot, "artifacts", "qa", "macos", `${mode}-trust.json`);
  const markdownPath = path.join(tempRoot, "artifacts", "qa", "macos", `${mode}-trust.md`);
  const { binDir, tracePath: spoofedPathTracePath } =
    createSpoofedPathToolchain(tempRoot);
  const mockedTools =
    harness === "mock-apple-tools" ? createMockedAppleTools(tempRoot) : null;

  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    MOCK_APPLE_TOOLS_TRACE_LOG: mockedTools?.tracePath ?? "",
    SPOOFED_PATH_TRACE_LOG: spoofedPathTracePath,
    TRUST_SPCTL_RESULT: mode,
    CSC_LINK: "dummy-csc-link",
    CSC_KEY_PASSWORD: "dummy-csc-key-password",
    APPLE_ID: "dummy@example.com",
    APPLE_APP_SPECIFIC_PASSWORD: "dummy-app-specific-password",
    APPLE_TEAM_ID: "DUMMYTEAMID",
    CSC_NAME: "Developer ID Application: Dummy",
  };

  const nodeArgs = [];
  if (mockedTools) {
    nodeArgs.push("--require", mockedTools.preloadPath);
  }
  nodeArgs.push(
    tempScript,
    "--app",
    appPath,
    "--expected-team",
    expectedTeam,
    "--out",
    outPath,
    "--markdown",
    markdownPath,
  );

  const result = spawnSync(
    process.execPath,
    nodeArgs,
    {
      encoding: "utf8",
      env,
    },
  );

  return {
    markdownPath,
    mockedToolsTracePath: mockedTools?.tracePath ?? null,
    outPath,
    result,
    spoofedPathTracePath,
  };
}

describe("verify-macos-release-trust.mjs", () => {
  it("writes secret-safe PASS artifacts for a trusted fake app bundle", () => {
    const { tempRoot, tempScript } = createTempRepo("verify-macos-release-trust.mjs");
    try {
      const { appPath, helperExecutable, mainExecutable, sidecarExecutable } = createFakeMacosApp(tempRoot);
      const {
        markdownPath,
        mockedToolsTracePath,
        outPath,
        result,
        spoofedPathTracePath,
      } = runTrustScript(tempScript, tempRoot, appPath, "accept");

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(0);
      expect(existsSync(outPath)).toBe(true);
      expect(existsSync(markdownPath)).toBe(true);

      expect(result.stdout).not.toMatch(/TypeError|ReferenceError/);
      expect(result.stdout).not.toContain("dummy-csc-link");
      expect(result.stdout).not.toContain("dummy-csc-key-password");
      expect(result.stdout).not.toContain("dummy-app-specific-password");
      expect(result.stdout).not.toContain("dummy@example.com");
      expect(result.stderr).not.toContain("TypeError");

      const artifact = JSON.parse(readFileSync(outPath, "utf8")) as {
        architectures: Record<string, string[]>;
        checks: Record<string, boolean>;
        identity: Record<string, string | null>;
        pass?: boolean;
        paths: Record<string, string>;
        status?: string;
      };
      expect(artifact.pass).toBe(true);
      expect(artifact.identity.expectedTeam).toBe("AJ9VWBRNZN");
      expect(artifact.identity.appTeamIdentifier).toBe("AJ9VWBRNZN");
      expect(artifact.identity.sidecarTeamIdentifier).toBe("AJ9VWBRNZN");
      expect(artifact.identity.shortcutHelperTeamIdentifier).toBe("AJ9VWBRNZN");
      expect(artifact.architectures.app).toContain("arm64");
      expect(artifact.architectures.sidecar).toContain("arm64");
      expect(artifact.architectures.shortcutHelper).toContain("arm64");
      expect(artifact.paths.app).toBe(appPath);
      expect(artifact.paths.mainExecutable).toBe(mainExecutable);
      expect(artifact.paths.sidecar).toBe(sidecarExecutable);
      expect(artifact.paths.shortcutHelper).toBe(helperExecutable);
      expect(artifact.checks.appExists).toBe(true);
      expect(artifact.checks.mainExecutablePresent).toBe(true);
      expect(artifact.checks.sidecarExecutablePresent).toBe(true);
      expect(artifact.checks.shortcutHelperExecutablePresent).toBe(true);
      expect(artifact.checks.appSignatureValid).toBe(true);
      expect(artifact.checks.sidecarSignatureValid).toBe(true);
      expect(artifact.checks.shortcutHelperSignatureValid).toBe(true);
      expect(artifact.checks.appUsesDeveloperId).toBe(true);
      expect(artifact.checks.sidecarUsesDeveloperId).toBe(true);
      expect(artifact.checks.shortcutHelperUsesDeveloperId).toBe(true);
      expect(artifact.checks.appUsesHardenedRuntime).toBe(true);
      expect(artifact.checks.sidecarUsesHardenedRuntime).toBe(true);
      expect(artifact.checks.shortcutHelperUsesHardenedRuntime).toBe(true);
      expect(artifact.checks.appHasSecureTimestamp).toBe(true);
      expect(artifact.checks.sidecarHasSecureTimestamp).toBe(true);
      expect(artifact.checks.shortcutHelperHasSecureTimestamp).toBe(true);
      expect(artifact.checks.expectedTeamConfigured).toBe(true);
      expect(artifact.checks.appTeamMatchesExpected).toBe(true);
      expect(artifact.checks.sidecarTeamMatchesApp).toBe(true);
      expect(artifact.checks.shortcutHelperTeamMatchesApp).toBe(true);
      expect(artifact.checks.appIsArm64).toBe(true);
      expect(artifact.checks.sidecarIsArm64).toBe(true);
      expect(artifact.checks.shortcutHelperIsArm64).toBe(true);
      expect(artifact.checks.notarizationTicketStapled).toBe(true);
      expect(artifact.checks.gatekeeperAccepted).toBe(true);
      expect(artifact.checks.gatekeeperSourceIsNotarizedDeveloperId).toBe(true);
      if (artifact.status) {
        expect(artifact.status).toMatch(/PASS|READY/);
      }

      const markdown = readFileSync(markdownPath, "utf8");
      expect(markdown).toMatch(/Status:\s+(PASS|READY)/);
      expect(markdown).not.toContain("dummy-csc-link");
      expect(markdown).not.toContain("dummy-csc-key-password");
      expect(markdown).not.toContain("dummy-app-specific-password");
      expect(markdown).not.toContain("dummy@example.com");

      expect(mockedToolsTracePath).not.toBeNull();
      const trace = readFileSync(mockedToolsTracePath!, "utf8");
      expect(trace).toContain("/usr/bin/codesign");
      expect(trace).toContain("/usr/bin/xcrun stapler validate");
      expect(trace).toContain("/usr/sbin/spctl");
      expect(trace).toContain("/usr/bin/lipo");
      expect(trace).toContain(path.basename(mainExecutable));
      expect(trace).toContain(path.basename(sidecarExecutable));
      expect(trace).toContain(path.basename(helperExecutable));
      expect(readFileSync(spoofedPathTracePath, "utf8")).toBe("");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails closed when Gatekeeper rejects the app bundle", () => {
    const { tempRoot, tempScript } = createTempRepo("verify-macos-release-trust.mjs");
    try {
      const { appPath } = createFakeMacosApp(tempRoot);
      const {
        markdownPath,
        mockedToolsTracePath,
        outPath,
        result,
        spoofedPathTracePath,
      } = runTrustScript(tempScript, tempRoot, appPath, "reject");

      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).not.toBe(0);
      expect(existsSync(outPath)).toBe(true);
      expect(existsSync(markdownPath)).toBe(true);

      const artifact = JSON.parse(readFileSync(outPath, "utf8")) as {
        error?: string;
        checks: Record<string, boolean>;
        pass?: boolean;
        status?: string;
      };
      expect(JSON.parse(result.stdout)).toEqual(artifact);
      expect(artifact.pass).toBe(false);
      expect(artifact.checks.gatekeeperAccepted).toBe(false);
      if (artifact.status) {
        expect(artifact.status).not.toBe("PASS");
      }
      if (artifact.error) {
        expect(artifact.error).toMatch(/spctl|Gatekeeper|rejected/i);
      }

      const markdown = readFileSync(markdownPath, "utf8");
      expect(markdown).toMatch(/Status:\s+(FAIL|BLOCKED)/);
      expect(markdown).toMatch(/spctl|Gatekeeper|rejected/i);
      expect(markdown).not.toContain("dummy-csc-link");
      expect(markdown).not.toContain("dummy-csc-key-password");
      expect(markdown).not.toContain("dummy-app-specific-password");
      expect(markdown).not.toContain("dummy@example.com");

      expect(mockedToolsTracePath).not.toBeNull();
      const trace = readFileSync(mockedToolsTracePath!, "utf8");
      expect(trace).toContain("/usr/sbin/spctl");
      expect(trace).toContain(path.basename(appPath));
      expect(readFileSync(spoofedPathTracePath, "utf8")).toBe("");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("cannot be forged by trusted-looking Apple tools prepended to PATH", () => {
    const { tempRoot, tempScript } = createTempRepo("verify-macos-release-trust.mjs");
    try {
      const { appPath } = createFakeMacosApp(tempRoot);
      const {
        markdownPath,
        mockedToolsTracePath,
        outPath,
        result,
        spoofedPathTracePath,
      } = runTrustScript(
        tempScript,
        tempRoot,
        appPath,
        "accept",
        "AJ9VWBRNZN",
        "spoofed-path-only",
      );

      expect(mockedToolsTracePath).toBeNull();
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).not.toBe(0);
      expect(existsSync(outPath)).toBe(true);
      expect(existsSync(markdownPath)).toBe(true);

      const artifact = JSON.parse(readFileSync(outPath, "utf8")) as {
        checks: Record<string, boolean>;
        pass: boolean;
      };
      expect(artifact.pass).toBe(false);
      expect(Object.values(artifact.checks)).toContain(false);
      expect(readFileSync(markdownPath, "utf8")).toMatch(/Status:\s+FAIL/);
      expect(readFileSync(spoofedPathTracePath, "utf8")).toBe("");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
