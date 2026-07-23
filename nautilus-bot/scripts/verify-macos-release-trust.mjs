#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);

function valueFor(name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) return fallback;
  return args[index + 1];
}

const appPath = path.resolve(
  repoRoot,
  valueFor("--app", "release/mac-arm64/Plainsong.app"),
);
const outPath = path.resolve(
  repoRoot,
  valueFor("--out", "artifacts/release/macos-trust.json"),
);
const markdownPath = path.resolve(
  repoRoot,
  valueFor("--markdown", "artifacts/release/macos-trust.md"),
);
const expectedTeam = valueFor("--expected-team", process.env.APPLE_TEAM_ID ?? null);
const mainExecutable = path.join(appPath, "Contents", "MacOS", "Plainsong");
const sidecar = path.join(
  appPath,
  "Contents",
  "Resources",
  "sidecar",
  "plainsong-sidecar",
);
const shortcutHelper = path.join(
  appPath,
  "Contents",
  "Resources",
  "shortcut-helper",
  "plainsong-native-shortcut-helper",
);

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    signal: result.signal,
    error: result.error?.message ?? null,
    output,
  };
}

function signingDetails(targetPath) {
  const result = run("/usr/bin/codesign", [
    "-dv",
    "--verbose=4",
    targetPath,
  ]);
  const authority = result.output.match(/^Authority=(.+)$/m)?.[1]?.trim() ?? null;
  const teamIdentifier =
    result.output.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() ?? null;
  return {
    ...result,
    authority,
    teamIdentifier,
    developerId: Boolean(authority?.startsWith("Developer ID Application:")),
    hardenedRuntime:
      /CodeDirectory .+\bflags=.*\(runtime\)/m.test(result.output) ||
      /^Runtime Version=/m.test(result.output),
    secureTimestamp: /^Timestamp=.+$/m.test(result.output),
  };
}

function architectureDetails(targetPath) {
  const result = run("/usr/bin/lipo", ["-archs", targetPath]);
  const architectures = result.output.split(/\s+/).filter(Boolean);
  return {
    ...result,
    architectures,
    arm64: result.ok && architectures.includes("arm64"),
  };
}

function commandDiagnostic(result) {
  return {
    ok: result.ok,
    status: result.status,
    signal: result.signal,
    error: result.error,
    output: result.output,
  };
}

const appSignature = run("/usr/bin/codesign", [
  "--verify",
  "--deep",
  "--strict",
  "--verbose=2",
  appPath,
]);
const sidecarSignature = run("/usr/bin/codesign", [
  "--verify",
  "--strict",
  "--verbose=2",
  sidecar,
]);
const helperSignature = run("/usr/bin/codesign", [
  "--verify",
  "--strict",
  "--verbose=2",
  shortcutHelper,
]);

const appSigning = signingDetails(appPath);
const sidecarSigning = signingDetails(sidecar);
const helperSigning = signingDetails(shortcutHelper);

const appArchitecture = architectureDetails(mainExecutable);
const sidecarArchitecture = architectureDetails(sidecar);
const helperArchitecture = architectureDetails(shortcutHelper);

const stapler = run("/usr/bin/xcrun", ["stapler", "validate", appPath]);
const gatekeeper = run("/usr/sbin/spctl", [
  "--assess",
  "--type",
  "execute",
  "--verbose=4",
  appPath,
]);

const checks = {
  appExists: fs.existsSync(appPath),
  mainExecutablePresent: isExecutable(mainExecutable),
  sidecarExecutablePresent: isExecutable(sidecar),
  shortcutHelperExecutablePresent: isExecutable(shortcutHelper),
  appSignatureValid: appSignature.ok,
  sidecarSignatureValid: sidecarSignature.ok,
  shortcutHelperSignatureValid: helperSignature.ok,
  appUsesDeveloperId: appSigning.developerId,
  sidecarUsesDeveloperId: sidecarSigning.developerId,
  shortcutHelperUsesDeveloperId: helperSigning.developerId,
  appUsesHardenedRuntime: appSigning.hardenedRuntime,
  sidecarUsesHardenedRuntime: sidecarSigning.hardenedRuntime,
  shortcutHelperUsesHardenedRuntime: helperSigning.hardenedRuntime,
  appHasSecureTimestamp: appSigning.secureTimestamp,
  sidecarHasSecureTimestamp: sidecarSigning.secureTimestamp,
  shortcutHelperHasSecureTimestamp: helperSigning.secureTimestamp,
  expectedTeamConfigured: Boolean(expectedTeam),
  appTeamMatchesExpected:
    Boolean(expectedTeam) && appSigning.teamIdentifier === expectedTeam,
  sidecarTeamMatchesApp:
    Boolean(appSigning.teamIdentifier) &&
    sidecarSigning.teamIdentifier === appSigning.teamIdentifier,
  shortcutHelperTeamMatchesApp:
    Boolean(appSigning.teamIdentifier) &&
    helperSigning.teamIdentifier === appSigning.teamIdentifier,
  appIsArm64: appArchitecture.arm64,
  sidecarIsArm64: sidecarArchitecture.arm64,
  shortcutHelperIsArm64: helperArchitecture.arm64,
  notarizationTicketStapled: stapler.ok,
  gatekeeperAccepted: gatekeeper.ok,
  gatekeeperSourceIsNotarizedDeveloperId:
    gatekeeper.ok && /source=Notarized Developer ID/i.test(gatekeeper.output),
};

const artifact = {
  generatedAt: new Date().toISOString(),
  pass: Object.values(checks).every(Boolean),
  paths: {
    app: appPath,
    mainExecutable,
    sidecar,
    shortcutHelper,
  },
  identity: {
    expectedTeam,
    appAuthority: appSigning.authority,
    appTeamIdentifier: appSigning.teamIdentifier,
    sidecarTeamIdentifier: sidecarSigning.teamIdentifier,
    shortcutHelperTeamIdentifier: helperSigning.teamIdentifier,
  },
  architectures: {
    app: appArchitecture.architectures,
    sidecar: sidecarArchitecture.architectures,
    shortcutHelper: helperArchitecture.architectures,
  },
  checks,
  diagnostics: {
    appSignature: commandDiagnostic(appSignature),
    sidecarSignature: commandDiagnostic(sidecarSignature),
    shortcutHelperSignature: commandDiagnostic(helperSignature),
    appSigning: commandDiagnostic(appSigning),
    sidecarSigning: commandDiagnostic(sidecarSigning),
    shortcutHelperSigning: commandDiagnostic(helperSigning),
    appArchitecture: commandDiagnostic(appArchitecture),
    sidecarArchitecture: commandDiagnostic(sidecarArchitecture),
    shortcutHelperArchitecture: commandDiagnostic(helperArchitecture),
    stapler: commandDiagnostic(stapler),
    gatekeeper: commandDiagnostic(gatekeeper),
  },
};

const markdown = `# macOS Release Trust

Status: ${artifact.pass ? "PASS" : "FAIL"}
Generated: ${artifact.generatedAt}

## Command

\`bun run gate:release:macos:trust\`

## Identity

- Expected Apple team: ${expectedTeam ?? "missing"}
- App authority: ${appSigning.authority ?? "missing"}
- App team: ${appSigning.teamIdentifier ?? "missing"}
- Sidecar team: ${sidecarSigning.teamIdentifier ?? "missing"}
- Shortcut helper team: ${helperSigning.teamIdentifier ?? "missing"}

## Checks

${Object.entries(checks)
  .map(([key, value]) => `- ${key}: ${value ? "PASS" : "FAIL"}`)
  .join("\n")}

## Gatekeeper

${gatekeeper.output || gatekeeper.error || "No output"}

## Stapler

${stapler.output || stapler.error || "No output"}
`;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
fs.writeFileSync(markdownPath, `${markdown}\n`, "utf8");
console.log(JSON.stringify(artifact, null, 2));
process.exitCode = artifact.pass ? 0 : 1;
