#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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

function appBundlePaths(bundlePath) {
  return {
    app: bundlePath,
    mainExecutable: path.join(bundlePath, "Contents", "MacOS", "Plainsong"),
    sidecar: path.join(
      bundlePath,
      "Contents",
      "Resources",
      "sidecar",
      "plainsong-sidecar",
    ),
    shortcutHelper: path.join(
      bundlePath,
      "Contents",
      "Resources",
      "shortcut-helper",
      "plainsong-native-shortcut-helper",
    ),
    speechHelper: path.join(
      bundlePath,
      "Contents",
      "Resources",
      "sidecar",
      "nautilus-macos-speech-helper-aarch64-apple-darwin",
    ),
  };
}

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

function syntheticResult(ok, output = "", error = null) {
  return {
    ok,
    status: ok ? 0 : null,
    signal: null,
    error,
    output,
  };
}

function signingDetails(targetPath) {
  const result = run("/usr/bin/codesign", ["-dv", "--verbose=4", targetPath]);
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

const SPEECH_RECOGNITION_ENTITLEMENT =
  "com.apple.security.personal-information.speech-recognition";
const FORBIDDEN_INHERITED_ENTITLEMENTS = [
  "com.apple.security.device.audio-input",
  "com.apple.security.device.microphone",
  "com.apple.security.automation.apple-events",
  "com.apple.security.temporary-exception.apple-events",
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.disable-library-validation",
];
const FORBIDDEN_SHORTCUT_HELPER_ENTITLEMENTS = [
  ...FORBIDDEN_INHERITED_ENTITLEMENTS,
  SPEECH_RECOGNITION_ENTITLEMENT,
];

function entitlementDetails(targetPath) {
  const result = run("/usr/bin/codesign", [
    "-d",
    "--entitlements",
    ":-",
    targetPath,
  ]);
  const forbiddenInheritedEntitlements = FORBIDDEN_INHERITED_ENTITLEMENTS.filter(
    (entitlement) => result.output.includes(entitlement),
  );
  const forbiddenShortcutHelperEntitlements =
    FORBIDDEN_SHORTCUT_HELPER_ENTITLEMENTS.filter((entitlement) =>
      result.output.includes(entitlement),
    );
  return {
    ...result,
    hasSpeechRecognition:
      result.ok && result.output.includes(SPEECH_RECOGNITION_ENTITLEMENT),
    forbiddenInheritedEntitlements,
    forbiddenShortcutHelperEntitlements,
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
  if (!result) return null;
  return {
    ok: result.ok,
    status: result.status,
    signal: result.signal,
    error: result.error,
    output: result.output,
  };
}

function signingDiagnostic(result) {
  return {
    ...commandDiagnostic(result),
    authority: result.authority,
    teamIdentifier: result.teamIdentifier,
    developerId: result.developerId,
    hardenedRuntime: result.hardenedRuntime,
    secureTimestamp: result.secureTimestamp,
  };
}

function entitlementDiagnostic(result) {
  return {
    ...commandDiagnostic(result),
    hasSpeechRecognition: result.hasSpeechRecognition,
    forbiddenInheritedEntitlements: result.forbiddenInheritedEntitlements,
    forbiddenShortcutHelperEntitlements:
      result.forbiddenShortcutHelperEntitlements,
  };
}

function architectureDiagnostic(result) {
  return {
    ...commandDiagnostic(result),
    architectures: result.architectures,
    arm64: result.arm64,
  };
}

function resolveReleaseArtifact(pattern) {
  const releaseDir = path.resolve(repoRoot, "release");
  if (!fs.existsSync(releaseDir)) return null;
  const match = fs
    .readdirSync(releaseDir)
    .filter((name) => pattern.test(name))
    .sort()
    .pop();
  return match ? path.join(releaseDir, match) : null;
}

/**
 * Read the Electron fuse wire straight out of the packaged binary.
 *
 * Layout, matching @electron/fuses: a sentinel string, a version byte, a
 * fuse-count byte, then one ASCII state byte per fuse ('0' disabled, '1'
 * enabled, 'r' removed). The wire lives in Electron Framework, not the app's
 * main executable, which on macOS is only a small launcher stub.
 *
 * Parsed here rather than shelling out to @electron/fuses so the gate stays
 * dependency-free on a release machine.
 */
const FUSE_SENTINEL = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";
const FUSE_STATE = { DISABLE: 0x30, ENABLE: 0x31, REMOVED: 0x72 };
const FUSE_V1_ORDER = [
  "runAsNode",
  "enableCookieEncryption",
  "enableNodeOptionsEnvironmentVariable",
  "enableNodeCliInspectArguments",
  "enableEmbeddedAsarIntegrityValidation",
  "onlyLoadAppFromAsar",
  "loadBrowserProcessSpecificV8Snapshot",
  "grantFileProtocolExtraPrivileges",
];

function fuseBinaryPath(bundlePath) {
  return path.join(
    bundlePath,
    "Contents",
    "Frameworks",
    "Electron Framework.framework",
    "Electron Framework",
  );
}

function readElectronFuses(bundlePath) {
  const binaryPath = fuseBinaryPath(bundlePath);
  try {
    if (!fs.existsSync(binaryPath)) {
      return { found: false, values: {}, error: `missing ${binaryPath}` };
    }
    const buffer = fs.readFileSync(binaryPath);
    const index = buffer.indexOf(Buffer.from(FUSE_SENTINEL, "utf8"));
    if (index < 0) {
      return { found: false, values: {}, error: "sentinel not found" };
    }
    const wirePosition = index + FUSE_SENTINEL.length;
    const wireVersion = buffer[wirePosition];
    const wireLength = buffer[wirePosition + 1];
    const values = {};
    FUSE_V1_ORDER.forEach((name, offset) => {
      if (offset < wireLength) {
        values[name] = buffer[wirePosition + 2 + offset];
      }
    });
    return { found: true, wireVersion, wireLength, values, error: null };
  } catch (error) {
    return { found: false, values: {}, error: String(error) };
  }
}

/** Satisfied when the fuse is explicitly disabled, or removed by Electron. */
function fuseDisabled(fuses, name) {
  const value = fuses.values?.[name];
  return value === FUSE_STATE.DISABLE || value === FUSE_STATE.REMOVED;
}

function fuseEnabled(fuses, name) {
  return fuses.values?.[name] === FUSE_STATE.ENABLE;
}

function inspectAppBundle(bundlePath) {
  const paths = appBundlePaths(bundlePath);
  const presence = {
    app: fs.existsSync(paths.app),
    mainExecutable: isExecutable(paths.mainExecutable),
    sidecar: isExecutable(paths.sidecar),
    shortcutHelper: isExecutable(paths.shortcutHelper),
    speechHelper: isExecutable(paths.speechHelper),
  };
  const signatures = {
    app: run("/usr/bin/codesign", [
      "--verify",
      "--deep",
      "--strict",
      "--verbose=2",
      paths.app,
    ]),
    sidecar: run("/usr/bin/codesign", [
      "--verify",
      "--strict",
      "--verbose=2",
      paths.sidecar,
    ]),
    shortcutHelper: run("/usr/bin/codesign", [
      "--verify",
      "--strict",
      "--verbose=2",
      paths.shortcutHelper,
    ]),
    speechHelper: run("/usr/bin/codesign", [
      "--verify",
      "--strict",
      "--verbose=2",
      paths.speechHelper,
    ]),
  };
  const signing = {
    app: signingDetails(paths.app),
    sidecar: signingDetails(paths.sidecar),
    shortcutHelper: signingDetails(paths.shortcutHelper),
    speechHelper: signingDetails(paths.speechHelper),
  };
  const entitlements = {
    app: entitlementDetails(paths.app),
    sidecar: entitlementDetails(paths.sidecar),
    shortcutHelper: entitlementDetails(paths.shortcutHelper),
    speechHelper: entitlementDetails(paths.speechHelper),
  };
  const architectures = {
    app: architectureDetails(paths.mainExecutable),
    sidecar: architectureDetails(paths.sidecar),
    shortcutHelper: architectureDetails(paths.shortcutHelper),
    speechHelper: architectureDetails(paths.speechHelper),
  };
  const stapler = run("/usr/bin/xcrun", ["stapler", "validate", paths.app]);
  const gatekeeper = run("/usr/sbin/spctl", [
    "--assess",
    "--type",
    "execute",
    "--verbose=4",
    paths.app,
  ]);
  const fuses = readElectronFuses(paths.app);

  return {
    paths,
    presence,
    signatures,
    signing,
    entitlements,
    architectures,
    stapler,
    gatekeeper,
    fuses,
  };
}

function checksForAppBundle(inspection) {
  const { presence, signatures, signing, entitlements, architectures, stapler, gatekeeper } =
    inspection;
  return {
    appExists: presence.app,
    mainExecutablePresent: presence.mainExecutable,
    sidecarExecutablePresent: presence.sidecar,
    shortcutHelperExecutablePresent: presence.shortcutHelper,
    speechHelperExecutablePresent: presence.speechHelper,
    appSignatureValid: signatures.app.ok,
    sidecarSignatureValid: signatures.sidecar.ok,
    shortcutHelperSignatureValid: signatures.shortcutHelper.ok,
    speechHelperSignatureValid: signatures.speechHelper.ok,
    appUsesDeveloperId: signing.app.developerId,
    sidecarUsesDeveloperId: signing.sidecar.developerId,
    shortcutHelperUsesDeveloperId: signing.shortcutHelper.developerId,
    speechHelperUsesDeveloperId: signing.speechHelper.developerId,
    appUsesHardenedRuntime: signing.app.hardenedRuntime,
    sidecarUsesHardenedRuntime: signing.sidecar.hardenedRuntime,
    shortcutHelperUsesHardenedRuntime: signing.shortcutHelper.hardenedRuntime,
    speechHelperUsesHardenedRuntime: signing.speechHelper.hardenedRuntime,
    appHasSecureTimestamp: signing.app.secureTimestamp,
    sidecarHasSecureTimestamp: signing.sidecar.secureTimestamp,
    shortcutHelperHasSecureTimestamp: signing.shortcutHelper.secureTimestamp,
    speechHelperHasSecureTimestamp: signing.speechHelper.secureTimestamp,
    appHasNoSpeechEntitlement:
      entitlements.app.ok && !entitlements.app.hasSpeechRecognition,
    sidecarHasNoSpeechEntitlement:
      entitlements.sidecar.ok && !entitlements.sidecar.hasSpeechRecognition,
    shortcutHelperHasNoSpeechEntitlement:
      entitlements.shortcutHelper.ok &&
      !entitlements.shortcutHelper.hasSpeechRecognition,
    shortcutHelperHasNoInheritedPrivileges:
      entitlements.shortcutHelper.ok &&
      entitlements.shortcutHelper.forbiddenShortcutHelperEntitlements.length === 0,
    speechHelperHasSpeechEntitlement:
      entitlements.speechHelper.hasSpeechRecognition,
    speechHelperHasNoUnrelatedEntitlements:
      entitlements.speechHelper.ok &&
      entitlements.speechHelper.forbiddenInheritedEntitlements.length === 0,
    expectedTeamConfigured: Boolean(expectedTeam),
    appTeamMatchesExpected:
      Boolean(expectedTeam) && signing.app.teamIdentifier === expectedTeam,
    sidecarTeamMatchesApp:
      Boolean(signing.app.teamIdentifier) &&
      signing.sidecar.teamIdentifier === signing.app.teamIdentifier,
    shortcutHelperTeamMatchesApp:
      Boolean(signing.app.teamIdentifier) &&
      signing.shortcutHelper.teamIdentifier === signing.app.teamIdentifier,
    speechHelperTeamMatchesApp:
      Boolean(signing.app.teamIdentifier) &&
      signing.speechHelper.teamIdentifier === signing.app.teamIdentifier,
    appIsArm64: architectures.app.arm64,
    sidecarIsArm64: architectures.sidecar.arm64,
    shortcutHelperIsArm64: architectures.shortcutHelper.arm64,
    speechHelperIsArm64: architectures.speechHelper.arm64,
    notarizationTicketStapled: stapler.ok,
    gatekeeperAccepted: gatekeeper.ok,
    gatekeeperSourceIsNotarizedDeveloperId:
      gatekeeper.ok && /source=Notarized Developer ID/i.test(gatekeeper.output),

    // Electron fuse hardening, read off the shipped binary.
    electronFusesReadable: inspection.fuses.found,
    fuseRunAsNodeDisabled: fuseDisabled(inspection.fuses, "runAsNode"),
    fuseNodeOptionsDisabled: fuseDisabled(
      inspection.fuses,
      "enableNodeOptionsEnvironmentVariable",
    ),
    fuseNodeCliInspectDisabled: fuseDisabled(
      inspection.fuses,
      "enableNodeCliInspectArguments",
    ),
    fuseAsarIntegrityEnabled: fuseEnabled(
      inspection.fuses,
      "enableEmbeddedAsarIntegrityValidation",
    ),
    fuseOnlyLoadAppFromAsarEnabled: fuseEnabled(
      inspection.fuses,
      "onlyLoadAppFromAsar",
    ),
    fuseFileProtocolPrivilegesDisabled: fuseDisabled(
      inspection.fuses,
      "grantFileProtocolExtraPrivileges",
    ),
  };
}

function diagnosticsForAppBundle(inspection) {
  return {
    presence: inspection.presence,
    appSignature: commandDiagnostic(inspection.signatures.app),
    sidecarSignature: commandDiagnostic(inspection.signatures.sidecar),
    shortcutHelperSignature: commandDiagnostic(
      inspection.signatures.shortcutHelper,
    ),
    speechHelperSignature: commandDiagnostic(inspection.signatures.speechHelper),
    appSigning: signingDiagnostic(inspection.signing.app),
    sidecarSigning: signingDiagnostic(inspection.signing.sidecar),
    shortcutHelperSigning: signingDiagnostic(inspection.signing.shortcutHelper),
    speechHelperSigning: signingDiagnostic(inspection.signing.speechHelper),
    appEntitlements: entitlementDiagnostic(inspection.entitlements.app),
    sidecarEntitlements: entitlementDiagnostic(inspection.entitlements.sidecar),
    shortcutHelperEntitlements: entitlementDiagnostic(
      inspection.entitlements.shortcutHelper,
    ),
    speechHelperEntitlements: entitlementDiagnostic(
      inspection.entitlements.speechHelper,
    ),
    appArchitecture: architectureDiagnostic(inspection.architectures.app),
    sidecarArchitecture: architectureDiagnostic(inspection.architectures.sidecar),
    shortcutHelperArchitecture: architectureDiagnostic(
      inspection.architectures.shortcutHelper,
    ),
    speechHelperArchitecture: architectureDiagnostic(
      inspection.architectures.speechHelper,
    ),
    stapler: commandDiagnostic(inspection.stapler),
    gatekeeper: commandDiagnostic(inspection.gatekeeper),
    electronFuses: inspection.fuses,
  };
}

function prefixedChecks(prefix, source) {
  return Object.fromEntries(
    Object.entries(source).map(([name, value]) => [
      `${prefix}${name[0].toUpperCase()}${name.slice(1)}`,
      value,
    ]),
  );
}

function findPlainsongAppBundles(rootPath) {
  const matches = [];
  const pending = [rootPath];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      const entryPath = path.join(current, entry.name);
      if (entry.name === "Plainsong.app") {
        matches.push(entryPath);
      } else {
        pending.push(entryPath);
      }
    }
  }
  return matches.sort();
}

function inspectZipArchive(zipPath) {
  const verification = {
    extractionRoot: null,
    extraction: zipPath
      ? syntheticResult(false, "", "ZIP extraction did not run")
      : syntheticResult(false, "", "ZIP artifact is missing"),
    cleanup: syntheticResult(true, "No temporary extraction directory was created"),
    appCandidates: [],
    appPath: null,
    app: null,
  };
  if (!zipPath) return verification;

  try {
    verification.extractionRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "plainsong-release-zip-"),
    );
    verification.extraction = run("/usr/bin/ditto", [
      "-x",
      "-k",
      zipPath,
      verification.extractionRoot,
    ]);
    if (verification.extraction.ok) {
      verification.appCandidates = findPlainsongAppBundles(
        verification.extractionRoot,
      );
      if (verification.appCandidates.length === 1) {
        verification.appPath = verification.appCandidates[0];
        verification.app = inspectAppBundle(verification.appPath);
      }
    }
  } catch (error) {
    verification.extraction = syntheticResult(false, "", String(error));
  } finally {
    if (verification.extractionRoot) {
      try {
        fs.rmSync(verification.extractionRoot, { recursive: true, force: true });
        verification.cleanup = syntheticResult(
          true,
          `Removed temporary extraction directory ${verification.extractionRoot}`,
        );
      } catch (error) {
        verification.cleanup = syntheticResult(false, "", String(error));
      }
    }
  }

  return verification;
}

// Electron's fuses ship permissive. Left that way, a notarized Plainsong is a
// reusable gadget: ELECTRON_RUN_AS_NODE=1 runs arbitrary Node under our
// Developer ID, which holds microphone and Apple Events entitlements plus the
// app's Accessibility grant. Notarization cannot be retracted, so this is
// asserted on every release build and again on the app extracted from the ZIP.
const releaseApp = inspectAppBundle(appPath);
const releaseAppChecks = checksForAppBundle(releaseApp);

// The DMG is the primary download, and electron-builder notarizes the .app
// only. Checking the bundle alone reported green while the disk image every
// user actually opens shipped unsigned and unstapled.
const dmgPath = resolveReleaseArtifact(/^Plainsong-.*\.dmg$/);
const zipPath = resolveReleaseArtifact(/^Plainsong-.*-mac\.zip$/);
const dmgSignature = dmgPath
  ? run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", dmgPath])
  : null;
const dmgStapler = dmgPath
  ? run("/usr/bin/xcrun", ["stapler", "validate", dmgPath])
  : null;
const dmgGatekeeper = dmgPath
  ? run("/usr/sbin/spctl", [
      "--assess",
      "--type",
      "open",
      "--context",
      "context:primary-signature",
      "--verbose=4",
      dmgPath,
    ])
  : null;

// ZIP archives cannot carry a stapled ticket and `stapler validate` rejects
// them. Extract the actual downloadable archive, inspect its Plainsong.app with
// the same trust checks as the release bundle, then remove the temporary copy.
const zipVerification = inspectZipArchive(zipPath);
const failedZipAppChecks = Object.fromEntries(
  Object.keys(releaseAppChecks).map((name) => [name, false]),
);
const zipAppChecks = zipVerification.app
  ? checksForAppBundle(zipVerification.app)
  : failedZipAppChecks;

const checks = {
  ...releaseAppChecks,

  // The disk image every user downloads, not just the bundle inside it.
  dmgPresent: Boolean(dmgPath),
  dmgSignatureValid: Boolean(dmgSignature?.ok),
  dmgTicketStapled: Boolean(dmgStapler?.ok),
  dmgGatekeeperAccepted: Boolean(dmgGatekeeper?.ok),

  // The ZIP is verified by inspecting its extracted app, never by asking
  // stapler to validate an archive format it does not support.
  zipPresent: Boolean(zipPath),
  zipArchiveExtracted: zipVerification.extraction.ok,
  zipContainsSinglePlainsongApp: zipVerification.appCandidates.length === 1,
  zipExtractionDirectoryCleaned: zipVerification.cleanup.ok,
  ...prefixedChecks("zip", zipAppChecks),
};

const artifact = {
  generatedAt: new Date().toISOString(),
  status: Object.values(checks).every(Boolean) ? "PASS" : "FAIL",
  pass: Object.values(checks).every(Boolean),
  paths: {
    ...releaseApp.paths,
    dmg: dmgPath,
    zip: zipPath,
    zipApp: zipVerification.appPath,
    zipExtractionRoot: zipVerification.extractionRoot,
  },
  identity: {
    expectedTeam,
    appAuthority: releaseApp.signing.app.authority,
    appTeamIdentifier: releaseApp.signing.app.teamIdentifier,
    sidecarTeamIdentifier: releaseApp.signing.sidecar.teamIdentifier,
    shortcutHelperTeamIdentifier:
      releaseApp.signing.shortcutHelper.teamIdentifier,
    speechHelperTeamIdentifier: releaseApp.signing.speechHelper.teamIdentifier,
    zipAppAuthority: zipVerification.app?.signing.app.authority ?? null,
    zipAppTeamIdentifier:
      zipVerification.app?.signing.app.teamIdentifier ?? null,
    zipSidecarTeamIdentifier:
      zipVerification.app?.signing.sidecar.teamIdentifier ?? null,
    zipShortcutHelperTeamIdentifier:
      zipVerification.app?.signing.shortcutHelper.teamIdentifier ?? null,
    zipSpeechHelperTeamIdentifier:
      zipVerification.app?.signing.speechHelper.teamIdentifier ?? null,
  },
  architectures: {
    app: releaseApp.architectures.app.architectures,
    sidecar: releaseApp.architectures.sidecar.architectures,
    shortcutHelper: releaseApp.architectures.shortcutHelper.architectures,
    speechHelper: releaseApp.architectures.speechHelper.architectures,
    zipApp: zipVerification.app?.architectures.app.architectures ?? [],
    zipSidecar: zipVerification.app?.architectures.sidecar.architectures ?? [],
    zipShortcutHelper:
      zipVerification.app?.architectures.shortcutHelper.architectures ?? [],
    zipSpeechHelper:
      zipVerification.app?.architectures.speechHelper.architectures ?? [],
  },
  checks,
  diagnostics: {
    ...diagnosticsForAppBundle(releaseApp),
    dmgSignature: commandDiagnostic(dmgSignature),
    dmgStapler: commandDiagnostic(dmgStapler),
    dmgGatekeeper: commandDiagnostic(dmgGatekeeper),
    zipExtraction: commandDiagnostic(zipVerification.extraction),
    zipCleanup: commandDiagnostic(zipVerification.cleanup),
    zipAppCandidates: zipVerification.appCandidates,
    zipApp: zipVerification.app
      ? diagnosticsForAppBundle(zipVerification.app)
      : null,
  },
};

const markdown = `# macOS Release Trust

Status: ${artifact.status}
Generated: ${artifact.generatedAt}

## Command

\`bun run gate:release:macos:trust\`

## Identity

- Expected Apple team: ${expectedTeam ?? "missing"}
- Release app authority: ${releaseApp.signing.app.authority ?? "missing"}
- Release app team: ${releaseApp.signing.app.teamIdentifier ?? "missing"}
- Release sidecar team: ${releaseApp.signing.sidecar.teamIdentifier ?? "missing"}
- Release shortcut helper team: ${releaseApp.signing.shortcutHelper.teamIdentifier ?? "missing"}
- Release Speech helper team: ${releaseApp.signing.speechHelper.teamIdentifier ?? "missing"}
- ZIP app authority: ${zipVerification.app?.signing.app.authority ?? "missing"}
- ZIP app team: ${zipVerification.app?.signing.app.teamIdentifier ?? "missing"}
- ZIP sidecar team: ${zipVerification.app?.signing.sidecar.teamIdentifier ?? "missing"}
- ZIP shortcut helper team: ${zipVerification.app?.signing.shortcutHelper.teamIdentifier ?? "missing"}
- ZIP Speech helper team: ${zipVerification.app?.signing.speechHelper.teamIdentifier ?? "missing"}

## Artifacts

- Release app: ${appPath}
- DMG: ${dmgPath ?? "missing"}
- ZIP: ${zipPath ?? "missing"}
- Extracted ZIP app: ${zipVerification.appPath ?? "missing"}
- ZIP extraction directory cleaned: ${zipVerification.cleanup.ok ? "yes" : "no"}

## Checks

${Object.entries(checks)
  .map(([key, value]) => `- ${key}: ${value ? "PASS" : "FAIL"}`)
  .join("\n")}

## Release App Gatekeeper

${releaseApp.gatekeeper.output || releaseApp.gatekeeper.error || "No output"}

## Release App Stapler

${releaseApp.stapler.output || releaseApp.stapler.error || "No output"}

## DMG Gatekeeper

${dmgGatekeeper?.output || dmgGatekeeper?.error || "No output"}

## DMG Stapler

${dmgStapler?.output || dmgStapler?.error || "No output"}

## ZIP Extraction

${zipVerification.extraction.output || zipVerification.extraction.error || "No output"}

## Extracted ZIP App Gatekeeper

${zipVerification.app?.gatekeeper.output || zipVerification.app?.gatekeeper.error || "No output"}

## Extracted ZIP App Stapler

${zipVerification.app?.stapler.output || zipVerification.app?.stapler.error || "No output"}

## ZIP Cleanup

${zipVerification.cleanup.output || zipVerification.cleanup.error || "No output"}
`;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
fs.writeFileSync(markdownPath, `${markdown}\n`, "utf8");
console.log(JSON.stringify(artifact, null, 2));
process.exitCode = artifact.pass ? 0 : 1;
