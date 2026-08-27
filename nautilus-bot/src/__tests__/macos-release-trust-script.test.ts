import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
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
  mkdirSync(path.join(tempScriptsDir, "lib"), { recursive: true });
  copyFileSync(
    path.resolve(process.cwd(), "scripts/lib/release-candidate-identity.mjs"),
    path.join(tempScriptsDir, "lib/release-candidate-identity.mjs"),
  );

  return { tempRoot, tempScript };
}

function writeExecutableScript(filePath: string, body: string) {
  writeFileSync(filePath, `#!/bin/sh\nset -eu\n${body.trim()}\n`, "utf8");
  chmodSync(filePath, 0o755);
}

/** Electron's fuse states are ASCII: '0' disabled, '1' enabled, 'r' removed. */
const FUSE_SENTINEL = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";
const HARDENED_FUSE_WIRE = "00001100";
const PERMISSIVE_FUSE_WIRE = "11110011";

/**
 * Write a stand-in Electron Framework carrying a fuse wire, which is where the
 * real one lives — the app's own MacOS/ executable is only a launcher stub.
 */
function writeFakeElectronFramework(appPath: string, wire: string) {
  const frameworkDir = path.join(
    appPath,
    "Contents",
    "Frameworks",
    "Electron Framework.framework",
  );
  mkdirSync(frameworkDir, { recursive: true });
  const binary = Buffer.concat([
    Buffer.from("padding-before-the-wire", "utf8"),
    Buffer.from(FUSE_SENTINEL, "utf8"),
    Buffer.from([1, wire.length]),
    Buffer.from(wire, "utf8"),
    Buffer.from("padding-after-the-wire", "utf8"),
  ]);
  writeFileSync(path.join(frameworkDir, "Electron Framework"), binary);
}

/**
 * The four Electron child bundles, which the gate now inspects individually:
 * the generic helper (Chromium's utility processes, audio service included) and
 * the GPU, Renderer and Plugin helpers, which must hold no device or automation
 * authority at all.
 */
const ELECTRON_HELPER_SUFFIXES = ["", " (GPU)", " (Renderer)", " (Plugin)"];

function writeFakeElectronHelpers(appPath: string) {
  const productName = path.basename(appPath, ".app");
  return ELECTRON_HELPER_SUFFIXES.map((suffix) => {
    const helperName = `${productName} Helper${suffix}`;
    const helperMacosDir = path.join(
      appPath,
      "Contents",
      "Frameworks",
      `${helperName}.app`,
      "Contents",
      "MacOS",
    );
    mkdirSync(helperMacosDir, { recursive: true });
    const executable = path.join(helperMacosDir, helperName);
    writeFileSync(executable, "", "utf8");
    chmodSync(executable, 0o755);
    return executable;
  });
}

function createFakeMacosApp(
  tempRoot: string,
  {
    archiveDirectoryName = "release",
    fuseWire = HARDENED_FUSE_WIRE,
  }: { archiveDirectoryName?: string; fuseWire?: string } = {},
) {
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

  writeFakeElectronFramework(appPath, fuseWire);
  const electronHelpers = writeFakeElectronHelpers(appPath);

  // The gate also inspects the disk image and archive the user downloads, not
  // just the bundle inside them.
  const releaseDir = path.join(tempRoot, archiveDirectoryName);
  mkdirSync(releaseDir, { recursive: true });
  const dmgPath = path.join(releaseDir, "Plainsong-0.9.0-beta.2-arm64.dmg");
  const zipPath = path.join(releaseDir, "Plainsong-0.9.0-beta.2-arm64-mac.zip");
  writeFileSync(dmgPath, "dmg", "utf8");
  writeFileSync(zipPath, "zip", "utf8");

  const mainExecutable = path.join(macosDir, "Plainsong");
  const sidecarExecutable = path.join(sidecarDir, "plainsong-sidecar");
  const helperExecutable = path.join(shortcutHelperDir, "plainsong-native-shortcut-helper");
  const speechHelperExecutable = path.join(
    sidecarDir,
    "nautilus-macos-speech-helper-aarch64-apple-darwin",
  );

  writeFileSync(mainExecutable, "", "utf8");
  writeFileSync(sidecarExecutable, "", "utf8");
  writeFileSync(helperExecutable, "", "utf8");
  writeFileSync(speechHelperExecutable, "", "utf8");
  chmodSync(mainExecutable, 0o755);
  chmodSync(sidecarExecutable, 0o755);
  chmodSync(helperExecutable, 0o755);
  chmodSync(speechHelperExecutable, 0o755);

  return {
    appPath,
    dmgPath,
    electronHelpers,
    helperExecutable,
    mainExecutable,
    sidecarExecutable,
    speechHelperExecutable,
    zipPath,
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
const path = require("node:path");
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

  if (command === "/usr/bin/ditto") {
    const extractionRoot = String(args.at(-1) ?? "");
    fs.mkdirSync(extractionRoot, { recursive: true });
    fs.cpSync(
      process.env.MOCK_ZIP_APP_PATH,
      path.join(extractionRoot, "Plainsong.app"),
      { recursive: true },
    );
    return commandResult(0);
  }

  if (command === "/usr/bin/codesign") {
    if (args.includes("--entitlements")) {
      const target = String(args.at(-1) ?? "");
      const basename = path.basename(target);
      const isSpeechHelper =
        basename === "nautilus-macos-speech-helper-aarch64-apple-darwin";
      const isShortcutHelper = basename === "plainsong-native-shortcut-helper";
      const isSidecar = basename === "plainsong-sidecar";
      const speechEntitlement = isSpeechHelper
        ? "<key>com.apple.security.personal-information.speech-recognition</key><true/>"
        : "";
      const unrelatedSpeechPrivilege =
        isSpeechHelper && process.env.SPEECH_HELPER_ENTITLEMENTS === "overbroad"
          ? "<key>com.apple.security.cs.allow-jit</key><true/>"
          : "";
      const shortcutPrivilege =
        isShortcutHelper && process.env.SHORTCUT_HELPER_ENTITLEMENT
          ? "<key>" + process.env.SHORTCUT_HELPER_ENTITLEMENT + "</key><true/>"
          : "";
      const sidecarPrivilege =
        isSidecar && process.env.SIDECAR_ENTITLEMENT
          ? "<key>" + process.env.SIDECAR_ENTITLEMENT + "</key><true/>"
          : "";
      // The four Electron child bundles. The generic helper legitimately keeps
      // audio; GPU/Renderer/Plugin get the narrow inherit set. Either can be
      // given an extra privilege through the environment to exercise a failure.
      const helperMatch = basename.match(/^Plainsong Helper(?: \((\w+)\))?$/);
      const isGenericHelper = Boolean(helperMatch && !helperMatch[1]);
      const isRestrictedHelper = Boolean(helperMatch && helperMatch[1]);
      const helperBaseline = helperMatch
        ? [
            "<key>com.apple.security.cs.allow-jit</key><true/>",
            "<key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>",
            "<key>com.apple.security.inherit</key><true/>",
            isGenericHelper
              ? "<key>com.apple.security.device.audio-input</key><true/>\n<key>com.apple.security.device.microphone</key><true/>"
              : "",
          ].join("\n")
        : "";
      const restrictedHelperPrivilege =
        isRestrictedHelper && process.env.RESTRICTED_HELPER_ENTITLEMENT
          ? "<key>" + process.env.RESTRICTED_HELPER_ENTITLEMENT + "</key><true/>"
          : "";
      const genericHelperPrivilege =
        isGenericHelper && process.env.GENERIC_HELPER_ENTITLEMENT
          ? "<key>" + process.env.GENERIC_HELPER_ENTITLEMENT + "</key><true/>"
          : "";
      const appPrivilege =
        basename === "Plainsong.app" && process.env.APP_ENTITLEMENT
          ? "<key>" + process.env.APP_ENTITLEMENT + "</key><true/>"
          : "";
      return commandResult(
        0,
        [
          "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
          "<plist version=\"1.0\"><dict>",
          speechEntitlement,
          unrelatedSpeechPrivilege,
          shortcutPrivilege,
          sidecarPrivilege,
          helperBaseline,
          restrictedHelperPrivilege,
          genericHelperPrivilege,
          appPrivilege,
          "</dict></plist>",
          "",
        ].join("\n"),
      );
    }
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
  speechHelperEntitlements: "minimal" | "overbroad" = "minimal",
  shortcutHelperEntitlement = "",
  sidecarEntitlement = "",
  releaseDir: string | null = null,
  helperEntitlements: { restricted?: string; generic?: string; app?: string } = {},
) {
  const outPath = path.join(tempRoot, "artifacts", "qa", "macos", `${mode}-trust.json`);
  const markdownPath = path.join(tempRoot, "artifacts", "qa", "macos", `${mode}-trust.md`);
  const zipTempParent = path.join(tempRoot, "zip-temp");
  mkdirSync(zipTempParent, { recursive: true });
  const { binDir, tracePath: spoofedPathTracePath } =
    createSpoofedPathToolchain(tempRoot);
  const mockedTools =
    harness === "mock-apple-tools" ? createMockedAppleTools(tempRoot) : null;

  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    TMPDIR: zipTempParent,
    MOCK_APPLE_TOOLS_TRACE_LOG: mockedTools?.tracePath ?? "",
    MOCK_ZIP_APP_PATH: appPath,
    SHORTCUT_HELPER_ENTITLEMENT: shortcutHelperEntitlement,
    SIDECAR_ENTITLEMENT: sidecarEntitlement,
    RESTRICTED_HELPER_ENTITLEMENT: helperEntitlements.restricted ?? "",
    GENERIC_HELPER_ENTITLEMENT: helperEntitlements.generic ?? "",
    APP_ENTITLEMENT: helperEntitlements.app ?? "",
    SPOOFED_PATH_TRACE_LOG: spoofedPathTracePath,
    SPEECH_HELPER_ENTITLEMENTS: speechHelperEntitlements,
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
  if (releaseDir) {
    nodeArgs.push("--release-dir", releaseDir);
  }

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
    zipTempParent,
  };
}

// Every case here spawns the gate as a real Node process against a fabricated
// app bundle, and the gate now inspects the four Electron child bundles as well.
// The default 5s per test is not enough for that under parallel load.
describe("verify-macos-release-trust.mjs", { timeout: 30_000 }, () => {
  it("resolves DMG and ZIP artifacts only from the requested release directory", () => {
    const { tempRoot, tempScript } = createTempRepo(
      "verify-macos-release-trust.mjs",
    );
    try {
      const { appPath, dmgPath, zipPath } = createFakeMacosApp(tempRoot, {
        archiveDirectoryName: "candidate-release",
      });
      const { outPath, result } = runTrustScript(
        tempScript,
        tempRoot,
        appPath,
        "accept",
        "AJ9VWBRNZN",
        "mock-apple-tools",
        "minimal",
        "",
        "",
        path.join(tempRoot, "candidate-release"),
      );

      expect(result.status).toBe(0);
      const artifact = JSON.parse(readFileSync(outPath, "utf8")) as {
        paths: Record<string, string>;
      };
      expect(realpathSync(artifact.paths.dmg)).toBe(realpathSync(dmgPath));
      expect(realpathSync(artifact.paths.zip)).toBe(realpathSync(zipPath));
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("writes secret-safe PASS artifacts for a trusted fake app bundle", () => {
    const { tempRoot, tempScript } = createTempRepo("verify-macos-release-trust.mjs");
    try {
      const {
        appPath,
        dmgPath,
        helperExecutable,
        mainExecutable,
        sidecarExecutable,
        speechHelperExecutable,
        zipPath,
      } = createFakeMacosApp(tempRoot);
      const {
        markdownPath,
        mockedToolsTracePath,
        outPath,
        result,
        spoofedPathTracePath,
        zipTempParent,
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
      expect(artifact.identity.speechHelperTeamIdentifier).toBe("AJ9VWBRNZN");
      expect(artifact.identity.zipAppTeamIdentifier).toBe("AJ9VWBRNZN");
      expect(artifact.identity.zipSidecarTeamIdentifier).toBe("AJ9VWBRNZN");
      expect(artifact.identity.zipShortcutHelperTeamIdentifier).toBe("AJ9VWBRNZN");
      expect(artifact.identity.zipSpeechHelperTeamIdentifier).toBe("AJ9VWBRNZN");
      expect(artifact.architectures.app).toContain("arm64");
      expect(artifact.architectures.sidecar).toContain("arm64");
      expect(artifact.architectures.shortcutHelper).toContain("arm64");
      expect(artifact.architectures.speechHelper).toContain("arm64");
      expect(artifact.architectures.zipApp).toContain("arm64");
      expect(artifact.architectures.zipSidecar).toContain("arm64");
      expect(artifact.architectures.zipShortcutHelper).toContain("arm64");
      expect(artifact.architectures.zipSpeechHelper).toContain("arm64");
      expect(artifact.paths.app).toBe(appPath);
      expect(artifact.paths.mainExecutable).toBe(mainExecutable);
      expect(artifact.paths.sidecar).toBe(sidecarExecutable);
      expect(artifact.paths.shortcutHelper).toBe(helperExecutable);
      expect(artifact.paths.speechHelper).toBe(speechHelperExecutable);
      expect(artifact.paths.dmg).toBe(realpathSync(dmgPath));
      expect(artifact.paths.zip).toBe(realpathSync(zipPath));
      expect(path.basename(artifact.paths.zipApp)).toBe("Plainsong.app");
      expect(existsSync(artifact.paths.zipApp)).toBe(false);
      expect(existsSync(artifact.paths.zipExtractionRoot)).toBe(false);
      expect(artifact.checks.appExists).toBe(true);
      expect(artifact.checks.mainExecutablePresent).toBe(true);
      expect(artifact.checks.sidecarExecutablePresent).toBe(true);
      expect(artifact.checks.shortcutHelperExecutablePresent).toBe(true);
      expect(artifact.checks.speechHelperExecutablePresent).toBe(true);
      expect(artifact.checks.appSignatureValid).toBe(true);
      expect(artifact.checks.sidecarSignatureValid).toBe(true);
      expect(artifact.checks.shortcutHelperSignatureValid).toBe(true);
      expect(artifact.checks.speechHelperSignatureValid).toBe(true);
      expect(artifact.checks.appUsesDeveloperId).toBe(true);
      expect(artifact.checks.sidecarUsesDeveloperId).toBe(true);
      expect(artifact.checks.shortcutHelperUsesDeveloperId).toBe(true);
      expect(artifact.checks.speechHelperUsesDeveloperId).toBe(true);
      expect(artifact.checks.appUsesHardenedRuntime).toBe(true);
      expect(artifact.checks.sidecarUsesHardenedRuntime).toBe(true);
      expect(artifact.checks.shortcutHelperUsesHardenedRuntime).toBe(true);
      expect(artifact.checks.speechHelperUsesHardenedRuntime).toBe(true);
      expect(artifact.checks.appHasNoSpeechEntitlement).toBe(true);
      expect(artifact.checks.sidecarHasNoSpeechEntitlement).toBe(true);
      expect(artifact.checks.sidecarHasNoForbiddenPrivileges).toBe(true);
      expect(artifact.checks.shortcutHelperHasNoSpeechEntitlement).toBe(true);
      expect(artifact.checks.shortcutHelperHasNoInheritedPrivileges).toBe(true);
      expect(artifact.checks.speechHelperHasSpeechEntitlement).toBe(true);
      expect(artifact.checks.speechHelperHasNoUnrelatedEntitlements).toBe(true);
      expect(artifact.checks.electronFusesReadable).toBe(true);
      expect(artifact.checks.fuseRunAsNodeDisabled).toBe(true);
      expect(artifact.checks.fuseNodeOptionsDisabled).toBe(true);
      expect(artifact.checks.fuseNodeCliInspectDisabled).toBe(true);
      expect(artifact.checks.fuseAsarIntegrityEnabled).toBe(true);
      expect(artifact.checks.fuseOnlyLoadAppFromAsarEnabled).toBe(true);
      expect(artifact.checks.fuseFileProtocolPrivilegesDisabled).toBe(true);
      expect(artifact.checks.dmgSignatureValid).toBe(true);
      expect(artifact.checks.dmgTicketStapled).toBe(true);
      expect(artifact.checks.appHasSecureTimestamp).toBe(true);
      expect(artifact.checks.sidecarHasSecureTimestamp).toBe(true);
      expect(artifact.checks.shortcutHelperHasSecureTimestamp).toBe(true);
      expect(artifact.checks.speechHelperHasSecureTimestamp).toBe(true);
      expect(artifact.checks.expectedTeamConfigured).toBe(true);
      expect(artifact.checks.appTeamMatchesExpected).toBe(true);
      expect(artifact.checks.sidecarTeamMatchesApp).toBe(true);
      expect(artifact.checks.shortcutHelperTeamMatchesApp).toBe(true);
      expect(artifact.checks.speechHelperTeamMatchesApp).toBe(true);
      expect(artifact.checks.appIsArm64).toBe(true);
      expect(artifact.checks.sidecarIsArm64).toBe(true);
      expect(artifact.checks.shortcutHelperIsArm64).toBe(true);
      expect(artifact.checks.speechHelperIsArm64).toBe(true);
      expect(artifact.checks.notarizationTicketStapled).toBe(true);
      expect(artifact.checks.gatekeeperAccepted).toBe(true);
      expect(artifact.checks.gatekeeperSourceIsNotarizedDeveloperId).toBe(true);
      expect(artifact.checks.zipPresent).toBe(true);
      expect(artifact.checks.zipArchiveExtracted).toBe(true);
      expect(artifact.checks.zipContainsSinglePlainsongApp).toBe(true);
      expect(artifact.checks.zipExtractionDirectoryCleaned).toBe(true);
      expect(artifact.checks.zipAppExists).toBe(true);
      expect(artifact.checks.zipMainExecutablePresent).toBe(true);
      expect(artifact.checks.zipSidecarExecutablePresent).toBe(true);
      expect(artifact.checks.zipShortcutHelperExecutablePresent).toBe(true);
      expect(artifact.checks.zipSpeechHelperExecutablePresent).toBe(true);
      expect(artifact.checks.zipAppSignatureValid).toBe(true);
      expect(artifact.checks.zipSidecarSignatureValid).toBe(true);
      expect(artifact.checks.zipShortcutHelperSignatureValid).toBe(true);
      expect(artifact.checks.zipSpeechHelperSignatureValid).toBe(true);
      expect(artifact.checks.zipAppUsesDeveloperId).toBe(true);
      expect(artifact.checks.zipSidecarUsesDeveloperId).toBe(true);
      expect(artifact.checks.zipShortcutHelperUsesDeveloperId).toBe(true);
      expect(artifact.checks.zipSpeechHelperUsesDeveloperId).toBe(true);
      expect(artifact.checks.zipAppUsesHardenedRuntime).toBe(true);
      expect(artifact.checks.zipSidecarUsesHardenedRuntime).toBe(true);
      expect(artifact.checks.zipShortcutHelperUsesHardenedRuntime).toBe(true);
      expect(artifact.checks.zipSpeechHelperUsesHardenedRuntime).toBe(true);
      expect(artifact.checks.zipAppHasSecureTimestamp).toBe(true);
      expect(artifact.checks.zipSidecarHasSecureTimestamp).toBe(true);
      expect(artifact.checks.zipSidecarHasNoForbiddenPrivileges).toBe(true);
      expect(artifact.checks.zipShortcutHelperHasSecureTimestamp).toBe(true);
      expect(artifact.checks.zipSpeechHelperHasSecureTimestamp).toBe(true);
      expect(artifact.checks.zipShortcutHelperHasNoInheritedPrivileges).toBe(true);
      expect(artifact.checks.zipAppTeamMatchesExpected).toBe(true);
      expect(artifact.checks.zipSidecarTeamMatchesApp).toBe(true);
      expect(artifact.checks.zipShortcutHelperTeamMatchesApp).toBe(true);
      expect(artifact.checks.zipSpeechHelperTeamMatchesApp).toBe(true);
      expect(artifact.checks.zipAppIsArm64).toBe(true);
      expect(artifact.checks.zipSidecarIsArm64).toBe(true);
      expect(artifact.checks.zipShortcutHelperIsArm64).toBe(true);
      expect(artifact.checks.zipSpeechHelperIsArm64).toBe(true);
      expect(artifact.checks.zipNotarizationTicketStapled).toBe(true);
      expect(artifact.checks.zipGatekeeperAccepted).toBe(true);
      expect(artifact.checks.zipGatekeeperSourceIsNotarizedDeveloperId).toBe(true);
      expect(artifact.checks.zipElectronFusesReadable).toBe(true);
      expect(artifact.checks.zipFuseRunAsNodeDisabled).toBe(true);
      expect(artifact.checks.zipFuseNodeOptionsDisabled).toBe(true);
      expect(artifact.checks.zipFuseNodeCliInspectDisabled).toBe(true);
      expect(artifact.checks.zipFuseAsarIntegrityEnabled).toBe(true);
      expect(artifact.checks.zipFuseOnlyLoadAppFromAsarEnabled).toBe(true);
      expect(artifact.checks.zipFuseFileProtocolPrivilegesDisabled).toBe(true);
      expect(artifact.checks.appHasLibraryValidationEnabled).toBe(true);
      expect(artifact.checks.zipAppHasLibraryValidationEnabled).toBe(true);
      expect(artifact.checks.electronHelperPresent).toBe(true);
      expect(artifact.checks.electronHelperGpuPresent).toBe(true);
      expect(artifact.checks.electronHelperRendererPresent).toBe(true);
      expect(artifact.checks.electronHelperPluginPresent).toBe(true);
      expect(
        artifact.checks.electronHelperGpuHasNoDeviceOrAutomationPrivileges,
      ).toBe(true);
      expect(
        artifact.checks.electronHelperRendererHasNoDeviceOrAutomationPrivileges,
      ).toBe(true);
      expect(
        artifact.checks.electronHelperPluginHasNoDeviceOrAutomationPrivileges,
      ).toBe(true);
      expect(artifact.checks.electronHelperHasNoAutomationPrivileges).toBe(true);
      expect(artifact.checks.zipElectronHelperRendererHasNoDeviceOrAutomationPrivileges).toBe(
        true,
      );
      expect(artifact.checks.zipTicketStapled).toBeUndefined();
      if (artifact.status) {
        expect(artifact.status).toMatch(/PASS|READY/);
      }

      const markdown = readFileSync(markdownPath, "utf8");
      expect(markdown).toMatch(/Status:\s+(PASS|READY)/);
      expect(markdown).toContain("## ZIP Extraction");
      expect(markdown).toContain("## Extracted ZIP App Gatekeeper");
      expect(markdown).toContain("zipExtractionDirectoryCleaned: PASS");
      expect(markdown).not.toContain("dummy-csc-link");
      expect(markdown).not.toContain("dummy-csc-key-password");
      expect(markdown).not.toContain("dummy-app-specific-password");
      expect(markdown).not.toContain("dummy@example.com");

      expect(mockedToolsTracePath).not.toBeNull();
      const trace = readFileSync(mockedToolsTracePath!, "utf8");
      expect(trace).toContain("/usr/bin/ditto -x -k");
      expect(trace).toContain("/usr/bin/codesign");
      expect(trace).toContain("/usr/bin/xcrun stapler validate");
      expect(trace).not.toMatch(/stapler validate .*\.zip/);
      expect(trace).toContain("/usr/sbin/spctl");
      expect(trace).toContain("/usr/bin/lipo");
      expect(trace).toContain(path.basename(mainExecutable));
      expect(trace).toContain(path.basename(sidecarExecutable));
      expect(trace).toContain(path.basename(helperExecutable));
      expect(trace).toContain(path.basename(speechHelperExecutable));
      expect(readFileSync(spoofedPathTracePath, "utf8")).toBe("");
      expect(readdirSync(zipTempParent)).toEqual([]);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails closed when the Electron fuses are left permissive", () => {
    // The security property this gate exists to hold. With default fuses,
    // `ELECTRON_RUN_AS_NODE=1` on the signed binary runs arbitrary Node under a
    // Developer ID carrying microphone and Apple Events entitlements plus the
    // app's Accessibility grant — and notarization cannot
    // be retracted. Valid signatures everywhere must NOT be enough to pass.
    const { tempRoot, tempScript } = createTempRepo("verify-macos-release-trust.mjs");
    try {
      const { appPath } = createFakeMacosApp(tempRoot, {
        fuseWire: PERMISSIVE_FUSE_WIRE,
      });
      const { outPath, result } = runTrustScript(
        tempScript,
        tempRoot,
        appPath,
        "accept",
      );

      expect(result.status).not.toBe(0);

      const artifact = JSON.parse(readFileSync(outPath, "utf8")) as {
        checks: Record<string, boolean>;
        pass?: boolean;
      };
      expect(artifact.pass).toBe(false);
      expect(artifact.checks.electronFusesReadable).toBe(true);
      expect(artifact.checks.fuseRunAsNodeDisabled).toBe(false);
      expect(artifact.checks.fuseNodeOptionsDisabled).toBe(false);
      expect(artifact.checks.fuseNodeCliInspectDisabled).toBe(false);
      expect(artifact.checks.fuseAsarIntegrityEnabled).toBe(false);
      expect(artifact.checks.fuseOnlyLoadAppFromAsarEnabled).toBe(false);
      expect(artifact.checks.zipFuseRunAsNodeDisabled).toBe(false);
      expect(artifact.checks.zipFuseNodeOptionsDisabled).toBe(false);
      expect(artifact.checks.zipFuseNodeCliInspectDisabled).toBe(false);
      expect(artifact.checks.zipFuseAsarIntegrityEnabled).toBe(false);
      expect(artifact.checks.zipFuseOnlyLoadAppFromAsarEnabled).toBe(false);
      // Signing is untouched, so this really is the fuses failing it.
      expect(artifact.checks.appSignatureValid).toBe(true);
      expect(artifact.checks.appUsesDeveloperId).toBe(true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails closed when the Speech helper inherits unrelated privileges", () => {
    const { tempRoot, tempScript } = createTempRepo("verify-macos-release-trust.mjs");
    try {
      const { appPath } = createFakeMacosApp(tempRoot);
      const { outPath, result } = runTrustScript(
        tempScript,
        tempRoot,
        appPath,
        "accept",
        "AJ9VWBRNZN",
        "mock-apple-tools",
        "overbroad",
      );

      expect(result.status).not.toBe(0);
      const artifact = JSON.parse(readFileSync(outPath, "utf8")) as {
        checks: Record<string, boolean>;
        pass: boolean;
      };
      expect(artifact.pass).toBe(false);
      expect(artifact.checks.speechHelperHasSpeechEntitlement).toBe(true);
      expect(artifact.checks.speechHelperHasNoUnrelatedEntitlements).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it.each([
    "com.apple.security.inherit",
    "com.apple.security.device.audio-input",
    "com.apple.security.device.microphone",
    "com.apple.security.automation.apple-events",
    "com.apple.security.temporary-exception.apple-events",
    "com.apple.security.cs.allow-jit",
    "com.apple.security.cs.allow-unsigned-executable-memory",
    "com.apple.security.cs.disable-library-validation",
    "com.apple.security.personal-information.speech-recognition",
  ])("fails closed when the shortcut helper receives %s", (forbiddenEntitlement) => {
    const { tempRoot, tempScript } = createTempRepo("verify-macos-release-trust.mjs");
    try {
      const { appPath } = createFakeMacosApp(tempRoot);
      const { outPath, result } = runTrustScript(
        tempScript,
        tempRoot,
        appPath,
        "accept",
        "AJ9VWBRNZN",
        "mock-apple-tools",
        "minimal",
        forbiddenEntitlement,
      );

      expect(result.status).not.toBe(0);
      const artifact = JSON.parse(readFileSync(outPath, "utf8")) as {
        checks: Record<string, boolean>;
        diagnostics: {
          shortcutHelperEntitlements: {
            forbiddenShortcutHelperEntitlements: string[];
          };
          zipApp: {
            shortcutHelperEntitlements: {
              forbiddenShortcutHelperEntitlements: string[];
            };
          };
        };
        pass: boolean;
      };
      expect(artifact.pass).toBe(false);
      expect(artifact.checks.shortcutHelperHasNoInheritedPrivileges).toBe(false);
      expect(artifact.checks.zipShortcutHelperHasNoInheritedPrivileges).toBe(false);
      expect(
        artifact.diagnostics.shortcutHelperEntitlements
          .forbiddenShortcutHelperEntitlements,
      ).toContain(forbiddenEntitlement);
      expect(
        artifact.diagnostics.zipApp.shortcutHelperEntitlements
          .forbiddenShortcutHelperEntitlements,
      ).toContain(forbiddenEntitlement);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it.each([
    "com.apple.security.inherit",
    "com.apple.security.device.audio-input",
    "com.apple.security.device.microphone",
    "com.apple.security.automation.apple-events",
    "com.apple.security.temporary-exception.apple-events",
    "com.apple.security.cs.allow-jit",
    "com.apple.security.cs.allow-unsigned-executable-memory",
    "com.apple.security.cs.disable-library-validation",
    "com.apple.security.personal-information.speech-recognition",
  ])("fails closed when the sidecar receives %s", (forbiddenEntitlement) => {
    const { tempRoot, tempScript } = createTempRepo("verify-macos-release-trust.mjs");
    try {
      const { appPath } = createFakeMacosApp(tempRoot);
      const { outPath, result } = runTrustScript(
        tempScript,
        tempRoot,
        appPath,
        "accept",
        "AJ9VWBRNZN",
        "mock-apple-tools",
        "minimal",
        "",
        forbiddenEntitlement,
      );

      expect(result.status).not.toBe(0);
      const artifact = JSON.parse(readFileSync(outPath, "utf8")) as {
        checks: Record<string, boolean>;
        diagnostics: {
          sidecarEntitlements: {
            forbiddenSidecarEntitlements: string[];
          };
          zipApp: {
            sidecarEntitlements: {
              forbiddenSidecarEntitlements: string[];
            };
          };
        };
        pass: boolean;
      };
      expect(artifact.pass).toBe(false);
      expect(artifact.checks.sidecarHasNoForbiddenPrivileges).toBe(false);
      expect(artifact.checks.zipSidecarHasNoForbiddenPrivileges).toBe(false);
      expect(
        artifact.diagnostics.sidecarEntitlements.forbiddenSidecarEntitlements,
      ).toContain(forbiddenEntitlement);
      expect(
        artifact.diagnostics.zipApp.sidecarEntitlements
          .forbiddenSidecarEntitlements,
      ).toContain(forbiddenEntitlement);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 15_000);

  it.each([
    "com.apple.security.device.audio-input",
    "com.apple.security.device.microphone",
    "com.apple.security.automation.apple-events",
    "com.apple.security.temporary-exception.apple-events",
    "com.apple.security.cs.disable-library-validation",
    "com.apple.security.personal-information.speech-recognition",
  ])(
    "fails closed when the GPU/Renderer/Plugin helpers receive %s",
    (forbiddenEntitlement) => {
      // These three shipped with the microphone, unscoped Apple Events and
      // disabled library validation because they were signed with a copy of the
      // main app's entitlements. None of them opens a device or drives another
      // application.
      const { tempRoot, tempScript } = createTempRepo(
        "verify-macos-release-trust.mjs",
      );
      try {
        const { appPath } = createFakeMacosApp(tempRoot);
        const { outPath, result } = runTrustScript(
          tempScript,
          tempRoot,
          appPath,
          "accept",
          "AJ9VWBRNZN",
          "mock-apple-tools",
          "minimal",
          "",
          "",
          null,
          { restricted: forbiddenEntitlement },
        );

        expect(result.status).not.toBe(0);
        const artifact = JSON.parse(readFileSync(outPath, "utf8")) as {
          checks: Record<string, boolean>;
          pass: boolean;
        };
        expect(artifact.pass).toBe(false);
        for (const helper of ["Gpu", "Renderer", "Plugin"]) {
          expect(
            artifact.checks[
              `electronHelper${helper}HasNoDeviceOrAutomationPrivileges`
            ],
          ).toBe(false);
          expect(
            artifact.checks[
              `zipElectronHelper${helper}HasNoDeviceOrAutomationPrivileges`
            ],
          ).toBe(false);
        }
        // The generic helper is unaffected: it is signed with its own policy.
        expect(artifact.checks.electronHelperHasNoAutomationPrivileges).toBe(true);
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it.each([
    "com.apple.security.automation.apple-events",
    "com.apple.security.cs.disable-library-validation",
  ])(
    "fails closed when the generic Electron helper receives %s",
    (forbiddenEntitlement) => {
      const { tempRoot, tempScript } = createTempRepo(
        "verify-macos-release-trust.mjs",
      );
      try {
        const { appPath } = createFakeMacosApp(tempRoot);
        const { outPath, result } = runTrustScript(
          tempScript,
          tempRoot,
          appPath,
          "accept",
          "AJ9VWBRNZN",
          "mock-apple-tools",
          "minimal",
          "",
          "",
          null,
          { generic: forbiddenEntitlement },
        );

        expect(result.status).not.toBe(0);
        const artifact = JSON.parse(readFileSync(outPath, "utf8")) as {
          checks: Record<string, boolean>;
          pass: boolean;
        };
        expect(artifact.pass).toBe(false);
        expect(artifact.checks.electronHelperHasNoAutomationPrivileges).toBe(false);
        // Audio on the generic helper is expected, not a failure: Chromium's
        // audio service runs there and the Settings microphone test reaches it.
        expect(
          artifact.checks.electronHelperGpuHasNoDeviceOrAutomationPrivileges,
        ).toBe(true);
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    },
  );

  it("fails closed when the app disables library validation", () => {
    // This bundle holds the microphone, Apple Events and the Accessibility
    // grant that lets Plainsong inject keystrokes anywhere. Library validation
    // is what stops that signature also being a loader for someone else's
    // dylib, and notarization cannot be retracted once it has shipped.
    const { tempRoot, tempScript } = createTempRepo("verify-macos-release-trust.mjs");
    try {
      const { appPath } = createFakeMacosApp(tempRoot);
      const { outPath, result } = runTrustScript(
        tempScript,
        tempRoot,
        appPath,
        "accept",
        "AJ9VWBRNZN",
        "mock-apple-tools",
        "minimal",
        "",
        "",
        null,
        { app: "com.apple.security.cs.disable-library-validation" },
      );

      expect(result.status).not.toBe(0);
      const artifact = JSON.parse(readFileSync(outPath, "utf8")) as {
        checks: Record<string, boolean>;
        pass: boolean;
      };
      expect(artifact.pass).toBe(false);
      expect(artifact.checks.appHasLibraryValidationEnabled).toBe(false);
      expect(artifact.checks.zipAppHasLibraryValidationEnabled).toBe(false);
      // Signing is untouched, so this really is the entitlement failing it.
      expect(artifact.checks.appSignatureValid).toBe(true);
      expect(artifact.checks.appUsesDeveloperId).toBe(true);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails closed when an Electron helper bundle is missing entirely", () => {
    // A productName change would move these paths; without a presence check the
    // entitlement checks above would go quietly unenforced.
    const { tempRoot, tempScript } = createTempRepo("verify-macos-release-trust.mjs");
    try {
      const { appPath } = createFakeMacosApp(tempRoot);
      rmSync(
        path.join(appPath, "Contents", "Frameworks", "Plainsong Helper (GPU).app"),
        { recursive: true, force: true },
      );
      const { outPath, result } = runTrustScript(tempScript, tempRoot, appPath, "accept");

      expect(result.status).not.toBe(0);
      const artifact = JSON.parse(readFileSync(outPath, "utf8")) as {
        checks: Record<string, boolean>;
        pass: boolean;
      };
      expect(artifact.pass).toBe(false);
      expect(artifact.checks.electronHelperGpuPresent).toBe(false);
      expect(artifact.checks.electronHelperRendererPresent).toBe(true);
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
