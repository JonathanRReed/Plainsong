#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  collectAppBundleIdentity,
  collectReleaseCandidateIdentity,
  type AppBundleIdentity,
} from "./lib/release-candidate-identity.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);

function valueFor(name: string, fallback: string): string;
function valueFor(name: string, fallback?: string | null): string | null;
function valueFor(name: string, fallback: string | null = null): string | null {
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
  valueFor("--out", "artifacts/qa/macos/macos-trust.json"),
);
const markdownPath = path.resolve(
  repoRoot,
  valueFor("--markdown", "artifacts/qa/macos/macos-trust.md"),
);
const expectedTeam = valueFor("--expected-team", process.env.APPLE_TEAM_ID ?? null);
const requestedReleaseDir = path.resolve(
  repoRoot,
  valueFor("--release-dir", "release"),
);
const releaseDir = fs.existsSync(requestedReleaseDir)
  ? fs.realpathSync(requestedReleaseDir)
  : requestedReleaseDir;
const candidateIdentity = collectReleaseCandidateIdentity({
  candidatePath: releaseDir,
  appPath,
});

/**
 * The Electron child-process bundles, keyed by the entitlement policy each one
 * is signed with.
 *
 * `electron` is the generic "<Product> Helper", which hosts Chromium's utility
 * processes including the audio service; scripts/sign-macos.mjs gives it
 * entitlements.mac.helper.plist, which is the inherit set plus audio. The other
 * three carry entitlements.mac.inherit.plist and must hold no device or
 * automation authority at all.
 */
const ELECTRON_HELPER_SUFFIXES = {
  electronHelper: "",
  electronHelperGpu: " (GPU)",
  electronHelperRenderer: " (Renderer)",
  electronHelperPlugin: " (Plugin)",
};

/** The three helpers with no legitimate use for the device or Apple Events. */
type ElectronHelperKey = keyof typeof ELECTRON_HELPER_SUFFIXES;

const RESTRICTED_ELECTRON_HELPERS: ElectronHelperKey[] = [
  "electronHelperGpu",
  "electronHelperRenderer",
  "electronHelperPlugin",
];

function electronHelperPaths(bundlePath: string): Record<ElectronHelperKey, string> {
  const productName = path.basename(bundlePath, ".app");
  return Object.fromEntries(
    Object.entries(ELECTRON_HELPER_SUFFIXES).map(([key, suffix]) => {
      const helperName = `${productName} Helper${suffix}`;
      return [
        key,
        path.join(
          bundlePath,
          "Contents",
          "Frameworks",
          `${helperName}.app`,
          "Contents",
          "MacOS",
          helperName,
        ),
      ];
    }),
  ) as Record<ElectronHelperKey, string>;
}

function appBundlePaths(bundlePath: string) {
  return {
    ...electronHelperPaths(bundlePath),
    cli: path.join(bundlePath, "Contents", "Resources", "sidecar", "plainsong-cli"),
    languageModelHelper: path.join(bundlePath, "Contents", "Resources", "language-model-helper", "plainsong-native-language-model-helper"),
    asrHelper: path.join(bundlePath, "Contents", "Resources", "asr-helper", "plainsong-native-asr-helper"),
    textHelper: path.join(bundlePath, "Contents", "Resources", "text-helper", "plainsong-text-helper"),
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
    calendarHelper: path.join(
      bundlePath,
      "Contents",
      "Resources",
      "calendar-helper",
      "plainsong-native-calendar-helper",
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

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

interface CommandResult {
  ok: boolean;
  status: number | null;
  signal: NodeJS.Signals | null;
  error: string | null;
  stdout?: string;
  output: string;
}

interface RunResult extends CommandResult {
  stdout: string;
}

function run(
  command: string,
  commandArgs: string[],
  { input, timeout }: { input?: string; timeout?: number } = {},
): RunResult {
  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    input,
    timeout,
    killSignal: "SIGKILL",
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    signal: result.signal,
    error: result.error?.message ?? null,
    stdout: result.stdout ?? "",
    output,
  };
}

function syntheticResult(ok: boolean, output = "", error: string | null = null): CommandResult {
  return {
    ok,
    status: ok ? 0 : null,
    signal: null,
    error,
    output,
  };
}

function signingDetails(targetPath: string) {
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
const CALENDARS_ENTITLEMENT = "com.apple.security.personal-information.calendars";
const ADDRESS_BOOK_ENTITLEMENT =
  "com.apple.security.personal-information.addressbook";
const FORBIDDEN_INHERITED_ENTITLEMENTS = [
  "com.apple.security.inherit",
  "com.apple.security.device.audio-input",
  "com.apple.security.device.microphone",
  "com.apple.security.automation.apple-events",
  "com.apple.security.temporary-exception.apple-events",
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.disable-library-validation",
];
const FORBIDDEN_SIDECAR_ENTITLEMENTS = [
  ...FORBIDDEN_INHERITED_ENTITLEMENTS,
  SPEECH_RECOGNITION_ENTITLEMENT,
  CALENDARS_ENTITLEMENT,
  ADDRESS_BOOK_ENTITLEMENT,
];
const FORBIDDEN_SHORTCUT_HELPER_ENTITLEMENTS = [
  ...FORBIDDEN_INHERITED_ENTITLEMENTS,
  SPEECH_RECOGNITION_ENTITLEMENT,
  CALENDARS_ENTITLEMENT,
  ADDRESS_BOOK_ENTITLEMENT,
];
// The read-only EventKit helper: calendars, and nothing that would make it a
// more interesting thing to compromise than a JSON printer. Speech is listed
// because the two personal-information grants are the ones most likely to be
// copied across helpers by a careless entitlements edit.
const FORBIDDEN_CALENDAR_HELPER_ENTITLEMENTS = [
  ...FORBIDDEN_INHERITED_ENTITLEMENTS,
  SPEECH_RECOGNITION_ENTITLEMENT,
];

// The GPU, Renderer and Plugin helpers need JIT, writable-executable memory and
// `inherit` — and nothing else. They shipped with the microphone, unscoped Apple
// Events and disabled library validation because they were signed with a copy of
// the main app's entitlements; none of the three ever opens a device or drives
// another application.
const FORBIDDEN_RESTRICTED_HELPER_ENTITLEMENTS = [
  "com.apple.security.device.audio-input",
  "com.apple.security.device.microphone",
  "com.apple.security.automation.apple-events",
  "com.apple.security.temporary-exception.apple-events",
  "com.apple.security.cs.disable-library-validation",
  SPEECH_RECOGNITION_ENTITLEMENT,
  CALENDARS_ENTITLEMENT,
  ADDRESS_BOOK_ENTITLEMENT,
];

// The generic helper keeps audio (Chromium's audio service runs there, and the
// Settings microphone test reaches it through getUserMedia) but has no more
// business with Apple Events or unsigned libraries than the other three.
const FORBIDDEN_GENERIC_HELPER_ENTITLEMENTS = [
  "com.apple.security.automation.apple-events",
  "com.apple.security.temporary-exception.apple-events",
  "com.apple.security.cs.disable-library-validation",
  SPEECH_RECOGNITION_ENTITLEMENT,
  CALENDARS_ENTITLEMENT,
  ADDRESS_BOOK_ENTITLEMENT,
];

function entitlementDetails(targetPath: string) {
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
  const forbiddenSidecarEntitlements = FORBIDDEN_SIDECAR_ENTITLEMENTS.filter(
    (entitlement) => result.output.includes(entitlement),
  );
  const forbiddenRestrictedHelperEntitlements =
    FORBIDDEN_RESTRICTED_HELPER_ENTITLEMENTS.filter((entitlement) =>
      result.output.includes(entitlement),
    );
  const forbiddenGenericHelperEntitlements =
    FORBIDDEN_GENERIC_HELPER_ENTITLEMENTS.filter((entitlement) =>
      result.output.includes(entitlement),
    );
  const forbiddenCalendarHelperEntitlements =
    FORBIDDEN_CALENDAR_HELPER_ENTITLEMENTS.filter((entitlement) =>
      result.output.includes(entitlement),
    );
  return {
    ...result,
    hasEmptyEntitlements: result.ok && /<plist\b[^>]*>\s*(?:<dict\s*\/>|<dict>\s*<\/dict>)\s*<\/plist>/.test(result.output.replace(/<!--[\s\S]*?-->/g, "")),
    hasSpeechRecognition:
      result.ok && result.output.includes(SPEECH_RECOGNITION_ENTITLEMENT),
    hasCalendars: result.ok && result.output.includes(CALENDARS_ENTITLEMENT),
    hasAddressBook:
      result.ok && result.output.includes(ADDRESS_BOOK_ENTITLEMENT),
    hasLibraryValidationDisabled: result.output.includes(
      "com.apple.security.cs.disable-library-validation",
    ),
    forbiddenInheritedEntitlements,
    forbiddenSidecarEntitlements,
    forbiddenShortcutHelperEntitlements,
    forbiddenRestrictedHelperEntitlements,
    forbiddenGenericHelperEntitlements,
    forbiddenCalendarHelperEntitlements,
  };
}

function architectureDetails(targetPath: string) {
  const result = run("/usr/bin/lipo", ["-archs", targetPath]);
  const architectures = result.output.split(/\s+/).filter(Boolean);
  return {
    ...result,
    architectures,
    arm64: result.ok && architectures.includes("arm64"),
  };
}

type SigningDetails = ReturnType<typeof signingDetails>;
type EntitlementDetails = ReturnType<typeof entitlementDetails>;
type ArchitectureDetails = ReturnType<typeof architectureDetails>;

function commandDiagnostic(result: CommandResult | null) {
  if (!result) return null;
  return {
    ok: result.ok,
    status: result.status,
    signal: result.signal,
    error: result.error,
    output: result.output,
  };
}

function signingDiagnostic(result: SigningDetails) {
  return {
    ...commandDiagnostic(result),
    authority: result.authority,
    teamIdentifier: result.teamIdentifier,
    developerId: result.developerId,
    hardenedRuntime: result.hardenedRuntime,
    secureTimestamp: result.secureTimestamp,
  };
}

function entitlementDiagnostic(result: EntitlementDetails) {
  return {
    ...commandDiagnostic(result),
    hasEmptyEntitlements: result.hasEmptyEntitlements,
    hasSpeechRecognition: result.hasSpeechRecognition,
    hasLibraryValidationDisabled: result.hasLibraryValidationDisabled,
    forbiddenInheritedEntitlements: result.forbiddenInheritedEntitlements,
    forbiddenSidecarEntitlements: result.forbiddenSidecarEntitlements,
    forbiddenShortcutHelperEntitlements:
      result.forbiddenShortcutHelperEntitlements,
    forbiddenRestrictedHelperEntitlements:
      result.forbiddenRestrictedHelperEntitlements,
    forbiddenGenericHelperEntitlements:
      result.forbiddenGenericHelperEntitlements,
  };
}

function architectureDiagnostic(result: ArchitectureDetails) {
  return {
    ...commandDiagnostic(result),
    architectures: result.architectures,
    arm64: result.arm64,
  };
}

function resolveReleaseArtifact(pattern: RegExp): string | null {
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

function fuseBinaryPath(bundlePath: string): string {
  return path.join(
    bundlePath,
    "Contents",
    "Frameworks",
    "Electron Framework.framework",
    "Electron Framework",
  );
}

interface ElectronFuses {
  found: boolean;
  wireVersion?: number;
  wireLength?: number;
  values: Record<string, number>;
  error: string | null;
}

function readElectronFuses(bundlePath: string): ElectronFuses {
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
    const values: Record<string, number> = {};
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
function fuseDisabled(fuses: ElectronFuses, name: string): boolean {
  const value = fuses.values?.[name];
  return value === FUSE_STATE.DISABLE || value === FUSE_STATE.REMOVED;
}

function fuseEnabled(fuses: ElectronFuses, name: string): boolean {
  return fuses.values?.[name] === FUSE_STATE.ENABLE;
}

function inspectAppBundle(bundlePath: string) {
  const paths = appBundlePaths(bundlePath);
  const presence = {
    app: fs.existsSync(paths.app),
    cli: isExecutable(paths.cli),
    languageModelHelper: isExecutable(paths.languageModelHelper),
    asrHelper: isExecutable(paths.asrHelper),
    textHelper: isExecutable(paths.textHelper),
    mainExecutable: isExecutable(paths.mainExecutable),
    sidecar: isExecutable(paths.sidecar),
    shortcutHelper: isExecutable(paths.shortcutHelper),
    calendarHelper: isExecutable(paths.calendarHelper),
    speechHelper: isExecutable(paths.speechHelper),
    ...(Object.fromEntries(
      (Object.keys(ELECTRON_HELPER_SUFFIXES) as ElectronHelperKey[]).map((key) => [
        key,
        isExecutable(paths[key]),
      ]),
    ) as Record<ElectronHelperKey, boolean>),
  };
  const signatures = {
    languageModelHelper: run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", paths.languageModelHelper]),
    asrHelper: run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", paths.asrHelper]),
    textHelper: run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", paths.textHelper]),
    cli: run("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", paths.cli]),
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
    calendarHelper: run("/usr/bin/codesign", [
      "--verify",
      "--strict",
      "--verbose=2",
      paths.calendarHelper,
    ]),
    speechHelper: run("/usr/bin/codesign", [
      "--verify",
      "--strict",
      "--verbose=2",
      paths.speechHelper,
    ]),
  };
  const signing = {
    languageModelHelper: signingDetails(paths.languageModelHelper),
    asrHelper: signingDetails(paths.asrHelper),
    textHelper: signingDetails(paths.textHelper),
    cli: signingDetails(paths.cli),
    app: signingDetails(paths.app),
    sidecar: signingDetails(paths.sidecar),
    shortcutHelper: signingDetails(paths.shortcutHelper),
    calendarHelper: signingDetails(paths.calendarHelper),
    speechHelper: signingDetails(paths.speechHelper),
  };
  const entitlements = {
    languageModelHelper: entitlementDetails(paths.languageModelHelper),
    asrHelper: entitlementDetails(paths.asrHelper),
    textHelper: entitlementDetails(paths.textHelper),
    cli: entitlementDetails(paths.cli),
    app: entitlementDetails(paths.app),
    sidecar: entitlementDetails(paths.sidecar),
    shortcutHelper: entitlementDetails(paths.shortcutHelper),
    calendarHelper: entitlementDetails(paths.calendarHelper),
    speechHelper: entitlementDetails(paths.speechHelper),
    ...(Object.fromEntries(
      (Object.keys(ELECTRON_HELPER_SUFFIXES) as ElectronHelperKey[]).map((key) => [
        key,
        entitlementDetails(paths[key]),
      ]),
    ) as Record<ElectronHelperKey, EntitlementDetails>),
  };
  const architectures = {
    languageModelHelper: architectureDetails(paths.languageModelHelper),
    asrHelper: architectureDetails(paths.asrHelper),
    textHelper: architectureDetails(paths.textHelper),
    cli: architectureDetails(paths.cli),
    app: architectureDetails(paths.mainExecutable),
    sidecar: architectureDetails(paths.sidecar),
    shortcutHelper: architectureDetails(paths.shortcutHelper),
    calendarHelper: architectureDetails(paths.calendarHelper),
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

type AppBundleInspection = ReturnType<typeof inspectAppBundle>;

function checksForAppBundle(inspection: AppBundleInspection) {
  const { presence, signatures, signing, entitlements, architectures, stapler, gatekeeper } =
    inspection;
  return {
    cliExecutablePresent: presence.cli,
    cliSignatureValid: signatures.cli.ok,
    cliUsesDeveloperId: signing.cli.developerId,
    cliUsesHardenedRuntime: signing.cli.hardenedRuntime,
    cliHasSecureTimestamp: signing.cli.secureTimestamp,
    cliTeamMatchesExpected: Boolean(expectedTeam) && signing.cli.teamIdentifier === expectedTeam,
    cliIsArm64: architectures.cli.arm64,
    cliHasEmptyEntitlements: entitlements.cli.hasEmptyEntitlements,
    languageModelHelperExecutablePresent: presence.languageModelHelper,
    languageModelHelperSignatureValid: signatures.languageModelHelper.ok,
    languageModelHelperUsesDeveloperId: signing.languageModelHelper.developerId,
    languageModelHelperUsesHardenedRuntime: signing.languageModelHelper.hardenedRuntime,
    languageModelHelperHasSecureTimestamp: signing.languageModelHelper.secureTimestamp,
    languageModelHelperTeamMatchesExpected: Boolean(expectedTeam) && signing.languageModelHelper.teamIdentifier === expectedTeam,
    languageModelHelperIsArm64: architectures.languageModelHelper.arm64,
    languageModelHelperHasEmptyEntitlements: entitlements.languageModelHelper.hasEmptyEntitlements,
    asrHelperExecutablePresent: presence.asrHelper,
    asrHelperSignatureValid: signatures.asrHelper.ok,
    asrHelperUsesDeveloperId: signing.asrHelper.developerId,
    asrHelperUsesHardenedRuntime: signing.asrHelper.hardenedRuntime,
    asrHelperHasSecureTimestamp: signing.asrHelper.secureTimestamp,
    asrHelperTeamMatchesExpected: Boolean(expectedTeam) && signing.asrHelper.teamIdentifier === expectedTeam,
    asrHelperIsArm64: architectures.asrHelper.arm64,
    asrHelperHasEmptyEntitlements: entitlements.asrHelper.hasEmptyEntitlements,
    textHelperExecutablePresent: presence.textHelper,
    textHelperSignatureValid: signatures.textHelper.ok,
    textHelperUsesDeveloperId: signing.textHelper.developerId,
    textHelperUsesHardenedRuntime: signing.textHelper.hardenedRuntime,
    textHelperHasSecureTimestamp: signing.textHelper.secureTimestamp,
    textHelperTeamMatchesExpected: Boolean(expectedTeam) && signing.textHelper.teamIdentifier === expectedTeam,
    textHelperIsArm64: architectures.textHelper.arm64,
    textHelperHasEmptyEntitlements: entitlements.textHelper.hasEmptyEntitlements,
    appExists: presence.app,
    mainExecutablePresent: presence.mainExecutable,
    sidecarExecutablePresent: presence.sidecar,
    shortcutHelperExecutablePresent: presence.shortcutHelper,
    calendarHelperExecutablePresent: presence.calendarHelper,
    speechHelperExecutablePresent: presence.speechHelper,
    appSignatureValid: signatures.app.ok,
    sidecarSignatureValid: signatures.sidecar.ok,
    shortcutHelperSignatureValid: signatures.shortcutHelper.ok,
    calendarHelperSignatureValid: signatures.calendarHelper.ok,
    speechHelperSignatureValid: signatures.speechHelper.ok,
    appUsesDeveloperId: signing.app.developerId,
    sidecarUsesDeveloperId: signing.sidecar.developerId,
    shortcutHelperUsesDeveloperId: signing.shortcutHelper.developerId,
    calendarHelperUsesDeveloperId: signing.calendarHelper.developerId,
    speechHelperUsesDeveloperId: signing.speechHelper.developerId,
    appUsesHardenedRuntime: signing.app.hardenedRuntime,
    sidecarUsesHardenedRuntime: signing.sidecar.hardenedRuntime,
    shortcutHelperUsesHardenedRuntime: signing.shortcutHelper.hardenedRuntime,
    calendarHelperUsesHardenedRuntime: signing.calendarHelper.hardenedRuntime,
    speechHelperUsesHardenedRuntime: signing.speechHelper.hardenedRuntime,
    appHasSecureTimestamp: signing.app.secureTimestamp,
    sidecarHasSecureTimestamp: signing.sidecar.secureTimestamp,
    shortcutHelperHasSecureTimestamp: signing.shortcutHelper.secureTimestamp,
    calendarHelperHasSecureTimestamp: signing.calendarHelper.secureTimestamp,
    speechHelperHasSecureTimestamp: signing.speechHelper.secureTimestamp,
    appHasNoSpeechEntitlement:
      entitlements.app.ok && !entitlements.app.hasSpeechRecognition,
    // The app bundle holds the microphone, Apple Events and the Accessibility
    // grant that lets it inject keystrokes anywhere. Library validation is the
    // thing that stops that signature also being a loader for someone else's
    // dylib, and notarization cannot be retracted once it has shipped.
    appHasLibraryValidationEnabled:
      entitlements.app.ok && !entitlements.app.hasLibraryValidationDisabled,

    // Every Electron child bundle must exist where sign-macos.mjs expects it —
    // a productName change that moved these would otherwise leave their
    // entitlement checks silently unenforced.
    ...Object.fromEntries(
      (Object.keys(ELECTRON_HELPER_SUFFIXES) as ElectronHelperKey[]).map((key) => [
        `${key}Present`,
        presence[key],
      ]),
    ),
    // The GPU, Renderer and Plugin helpers hold no device or automation
    // authority and cannot load unsigned libraries.
    ...Object.fromEntries(
      RESTRICTED_ELECTRON_HELPERS.map((key) => [
        `${key}HasNoDeviceOrAutomationPrivileges`,
        entitlements[key].ok &&
          entitlements[key].forbiddenRestrictedHelperEntitlements.length === 0,
      ]),
    ),
    // The generic helper keeps audio (Chromium's audio service runs there) but
    // nothing else the other three gave up.
    electronHelperHasNoAutomationPrivileges:
      entitlements.electronHelper.ok &&
      entitlements.electronHelper.forbiddenGenericHelperEntitlements.length === 0,
    sidecarHasNoSpeechEntitlement:
      entitlements.sidecar.ok && !entitlements.sidecar.hasSpeechRecognition,
    sidecarHasNoForbiddenPrivileges:
      entitlements.sidecar.ok &&
      entitlements.sidecar.forbiddenSidecarEntitlements.length === 0,
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
    // TCC attributes the calendar helper's request to the responsible
    // process — this app — and the hardened runtime will not prompt for a
    // responsible process whose signature lacks the entitlement. 0.9.0-beta.6
    // shipped with it on the helper only and Connect calendar silently did
    // nothing, so the app's copy is required, not assumed from the plist.
    // Calendar reading itself still happens only in the helper.
    appHasCalendarEntitlement:
      entitlements.app.ok && entitlements.app.hasCalendars,
    calendarHelperHasCalendarEntitlement:
      entitlements.calendarHelper.hasCalendars,
    // The same helper reads contact names once the user turns on Contacts
    // names for dictation; the app's copy lets macOS show that prompt.
    appHasAddressBookEntitlement:
      entitlements.app.ok && entitlements.app.hasAddressBook,
    calendarHelperHasAddressBookEntitlement:
      entitlements.calendarHelper.hasAddressBook,
    calendarHelperHasNoUnrelatedEntitlements:
      entitlements.calendarHelper.ok &&
      entitlements.calendarHelper.forbiddenCalendarHelperEntitlements.length === 0,
    expectedTeamConfigured: Boolean(expectedTeam),
    appTeamMatchesExpected:
      Boolean(expectedTeam) && signing.app.teamIdentifier === expectedTeam,
    sidecarTeamMatchesApp:
      Boolean(signing.app.teamIdentifier) &&
      signing.sidecar.teamIdentifier === signing.app.teamIdentifier,
    shortcutHelperTeamMatchesApp:
      Boolean(signing.app.teamIdentifier) &&
      signing.shortcutHelper.teamIdentifier === signing.app.teamIdentifier,
    calendarHelperTeamMatchesApp:
      Boolean(signing.app.teamIdentifier) &&
      signing.calendarHelper.teamIdentifier === signing.app.teamIdentifier,
    speechHelperTeamMatchesApp:
      Boolean(signing.app.teamIdentifier) &&
      signing.speechHelper.teamIdentifier === signing.app.teamIdentifier,
    appIsArm64: architectures.app.arm64,
    sidecarIsArm64: architectures.sidecar.arm64,
    shortcutHelperIsArm64: architectures.shortcutHelper.arm64,
    calendarHelperIsArm64: architectures.calendarHelper.arm64,
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

function diagnosticsForAppBundle(inspection: AppBundleInspection) {
  return {
    cliSignature: commandDiagnostic(inspection.signatures.cli),
    cliSigning: signingDiagnostic(inspection.signing.cli),
    cliEntitlements: entitlementDiagnostic(inspection.entitlements.cli),
    cliArchitecture: architectureDiagnostic(inspection.architectures.cli),
    languageModelHelperSignature: commandDiagnostic(inspection.signatures.languageModelHelper),
    languageModelHelperSigning: signingDiagnostic(inspection.signing.languageModelHelper),
    languageModelHelperEntitlements: entitlementDiagnostic(inspection.entitlements.languageModelHelper),
    languageModelHelperArchitecture: architectureDiagnostic(inspection.architectures.languageModelHelper),
    asrHelperSignature: commandDiagnostic(inspection.signatures.asrHelper),
    asrHelperSigning: signingDiagnostic(inspection.signing.asrHelper),
    asrHelperEntitlements: entitlementDiagnostic(inspection.entitlements.asrHelper),
    asrHelperArchitecture: architectureDiagnostic(inspection.architectures.asrHelper),
    textHelperSignature: commandDiagnostic(inspection.signatures.textHelper),
    textHelperSigning: signingDiagnostic(inspection.signing.textHelper),
    textHelperEntitlements: entitlementDiagnostic(inspection.entitlements.textHelper),
    textHelperArchitecture: architectureDiagnostic(inspection.architectures.textHelper),
    presence: inspection.presence,
    appSignature: commandDiagnostic(inspection.signatures.app),
    sidecarSignature: commandDiagnostic(inspection.signatures.sidecar),
    shortcutHelperSignature: commandDiagnostic(
      inspection.signatures.shortcutHelper,
    ),
    calendarHelperSignature: commandDiagnostic(
      inspection.signatures.calendarHelper,
    ),
    speechHelperSignature: commandDiagnostic(inspection.signatures.speechHelper),
    appSigning: signingDiagnostic(inspection.signing.app),
    sidecarSigning: signingDiagnostic(inspection.signing.sidecar),
    shortcutHelperSigning: signingDiagnostic(inspection.signing.shortcutHelper),
    calendarHelperSigning: signingDiagnostic(inspection.signing.calendarHelper),
    speechHelperSigning: signingDiagnostic(inspection.signing.speechHelper),
    appEntitlements: entitlementDiagnostic(inspection.entitlements.app),
    sidecarEntitlements: entitlementDiagnostic(inspection.entitlements.sidecar),
    shortcutHelperEntitlements: entitlementDiagnostic(
      inspection.entitlements.shortcutHelper,
    ),
    calendarHelperEntitlements: entitlementDiagnostic(
      inspection.entitlements.calendarHelper,
    ),
    speechHelperEntitlements: entitlementDiagnostic(
      inspection.entitlements.speechHelper,
    ),
    ...Object.fromEntries(
      (Object.keys(ELECTRON_HELPER_SUFFIXES) as ElectronHelperKey[]).map((key) => [
        `${key}Entitlements`,
        entitlementDiagnostic(inspection.entitlements[key]),
      ]),
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

function prefixedChecks(prefix: string, source: Record<string, boolean>) {
  return Object.fromEntries(
    Object.entries(source).map(([name, value]) => [
      `${prefix}${name[0].toUpperCase()}${name.slice(1)}`,
      value,
    ]),
  );
}

function findPlainsongAppBundles(rootPath: string): string[] {
  const matches: string[] = [];
  const pending = [rootPath];
  while (pending.length > 0) {
    const current = pending.pop() as string;
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

interface ZipVerification {
  extractionRoot: string | null;
  extraction: CommandResult;
  cleanup: CommandResult;
  appCandidates: string[];
  appBundle: AppBundleIdentity | null;
  appPath: string | null;
  app: AppBundleInspection | null;
}

function inspectZipArchive(zipPath: string | null): ZipVerification {
  const verification: ZipVerification = {
    extractionRoot: null,
    extraction: zipPath
      ? syntheticResult(false, "", "ZIP extraction did not run")
      : syntheticResult(false, "", "ZIP artifact is missing"),
    cleanup: syntheticResult(true, "No temporary extraction directory was created"),
    appCandidates: [],
    appBundle: null,
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
        verification.appBundle = collectAppBundleIdentity(verification.appPath);
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

interface DiskImageVerification {
  temporaryRoot: string | null;
  mountPoint: string | null;
  mount: CommandResult;
  metadata: RunResult | null;
  mountPointVerified: boolean;
  detach: CommandResult;
  cleanup: CommandResult;
  appCandidates: string[];
  appPath: string | null;
  app: AppBundleInspection | null;
  appBundle: AppBundleIdentity | null;
  error: string | null;
}

function inspectDiskImage(
  dmgPath: string | null,
  outerTrustPassed: boolean,
): DiskImageVerification {
  const verification: DiskImageVerification = {
    temporaryRoot: null,
    mountPoint: null,
    mount: syntheticResult(false, "", "DMG mount did not run"),
    metadata: null,
    mountPointVerified: false,
    detach: syntheticResult(false, "", "DMG detach did not run"),
    cleanup: syntheticResult(true, "No temporary mount directory was created"),
    appCandidates: [],
    appPath: null,
    app: null,
    appBundle: null,
    error: null,
  };
  if (!dmgPath) return verification;
  if (!outerTrustPassed) {
    verification.error = "DMG inspection skipped because its signature, stapled ticket or Gatekeeper check failed";
    return verification;
  }

  try {
    verification.temporaryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "plainsong-release-dmg-"),
    );
    verification.mountPoint = path.join(verification.temporaryRoot, "mount");
    fs.mkdirSync(verification.mountPoint);
    verification.mount = run("/usr/bin/hdiutil", [
      "attach", dmgPath, "-readonly", "-nobrowse", "-noautoopen", "-plist",
      "-mountpoint", verification.mountPoint,
    ], { timeout: 60_000 });
    if (verification.mount.ok) {
      verification.metadata = run("/usr/bin/plutil", [
        "-convert", "json", "-o", "-", "--", "-",
      ], { input: verification.mount.stdout, timeout: 10_000 });
      if (!verification.metadata.ok) throw new Error("DMG mount metadata is unreadable");
      const metadata = JSON.parse(verification.metadata.stdout);
      const entities = metadata["system-entities"];
      if (!Array.isArray(entities)) throw new Error("DMG mount metadata has no system entities");
      const mounts = entities.filter((entry) => entry && typeof entry["mount-point"] === "string");
      if (mounts.length !== 1 ||
          fs.realpathSync(mounts[0]["mount-point"]) !== fs.realpathSync(verification.mountPoint)) {
        throw new Error("DMG did not mount only at its owned mount point");
      }
      verification.mountPointVerified = true;
      verification.appCandidates = findPlainsongAppBundles(verification.mountPoint);
      if (verification.appCandidates.length === 1) {
        verification.appPath = verification.appCandidates[0];
        verification.app = inspectAppBundle(verification.appPath);
        verification.appBundle = collectAppBundleIdentity(verification.appPath);
      }
    }
  } catch (error) {
    verification.error = String(error);
  } finally {
    if (verification.mountPoint) {
      verification.detach = run("/usr/bin/hdiutil", [
        "detach", verification.mountPoint,
      ], { timeout: 30_000 });
    }
    if (verification.temporaryRoot) {
      try {
        // Never recursively remove a mount, even after a failed detach.
        fs.rmdirSync(verification.mountPoint as string);
        fs.rmdirSync(verification.temporaryRoot);
        verification.cleanup = syntheticResult(true, "Removed owned mount directories");
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
const dmgVerification = inspectDiskImage(
  dmgPath,
  Boolean(dmgSignature?.ok && dmgStapler?.ok && dmgGatekeeper?.ok),
);
const zipVerification = inspectZipArchive(zipPath);
const failedZipAppChecks = Object.fromEntries(
  Object.keys(releaseAppChecks).map((name) => [name, false]),
);
const zipAppChecks = zipVerification.app
  ? checksForAppBundle(zipVerification.app)
  : failedZipAppChecks;

const dmgAppChecks = dmgVerification.app
  ? checksForAppBundle(dmgVerification.app)
  : failedZipAppChecks;

const checks = {
  ...releaseAppChecks,

  // The disk image every user downloads, not just the bundle inside it.
  dmgPresent: Boolean(dmgPath),
  dmgSignatureValid: Boolean(dmgSignature?.ok),
  dmgTicketStapled: Boolean(dmgStapler?.ok),
  dmgGatekeeperAccepted: Boolean(dmgGatekeeper?.ok),
  dmgArchiveMounted: dmgVerification.mount.ok,
  dmgMountPointVerified: dmgVerification.mountPointVerified,
  dmgContainsSinglePlainsongApp: dmgVerification.appCandidates.length === 1,
  dmgAppMatchesReleaseApp: Boolean(
    candidateIdentity.appBundle && dmgVerification.appBundle &&
    candidateIdentity.appBundle.sha256 === dmgVerification.appBundle.sha256,
  ),
  dmgUnmounted: dmgVerification.detach.ok,
  dmgMountDirectoryCleaned: dmgVerification.cleanup.ok,
  ...prefixedChecks("dmgPayload", dmgAppChecks),

  // The ZIP is verified by inspecting its extracted app, never by asking
  // stapler to validate an archive format it does not support.
  zipPresent: Boolean(zipPath),
  zipArchiveExtracted: zipVerification.extraction.ok,
  zipContainsSinglePlainsongApp: zipVerification.appCandidates.length === 1,
  zipAppMatchesReleaseApp: Boolean(
    candidateIdentity.appBundle &&
    zipVerification.appBundle &&
    candidateIdentity.appBundle.sha256 === zipVerification.appBundle.sha256,
  ),
  zipExtractionDirectoryCleaned: zipVerification.cleanup.ok,
  ...prefixedChecks("zip", zipAppChecks),
};

const artifact = {
  generatedAt: new Date().toISOString(),
  candidateIdentity,
  status: Object.values(checks).every(Boolean) ? "PASS" : "FAIL",
  pass: Object.values(checks).every(Boolean),
  paths: {
    ...releaseApp.paths,
    releaseDir,
    dmg: dmgPath,
    dmgApp: dmgVerification.appPath,
    dmgMountPoint: dmgVerification.mountPoint,
    dmgTemporaryRoot: dmgVerification.temporaryRoot,
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
    calendarHelperTeamIdentifier:
      releaseApp.signing.calendarHelper.teamIdentifier,
    speechHelperTeamIdentifier: releaseApp.signing.speechHelper.teamIdentifier,
    zipAppAuthority: zipVerification.app?.signing.app.authority ?? null,
    zipAppTeamIdentifier:
      zipVerification.app?.signing.app.teamIdentifier ?? null,
    zipSidecarTeamIdentifier:
      zipVerification.app?.signing.sidecar.teamIdentifier ?? null,
    zipShortcutHelperTeamIdentifier:
      zipVerification.app?.signing.shortcutHelper.teamIdentifier ?? null,
    zipCalendarHelperTeamIdentifier:
      zipVerification.app?.signing.calendarHelper.teamIdentifier ?? null,
    zipSpeechHelperTeamIdentifier:
      zipVerification.app?.signing.speechHelper.teamIdentifier ?? null,
  },
  architectures: {
    app: releaseApp.architectures.app.architectures,
    sidecar: releaseApp.architectures.sidecar.architectures,
    shortcutHelper: releaseApp.architectures.shortcutHelper.architectures,
    calendarHelper: releaseApp.architectures.calendarHelper.architectures,
    speechHelper: releaseApp.architectures.speechHelper.architectures,
    zipApp: zipVerification.app?.architectures.app.architectures ?? [],
    zipSidecar: zipVerification.app?.architectures.sidecar.architectures ?? [],
    zipShortcutHelper:
      zipVerification.app?.architectures.shortcutHelper.architectures ?? [],
    zipCalendarHelper:
      zipVerification.app?.architectures.calendarHelper.architectures ?? [],
    zipSpeechHelper:
      zipVerification.app?.architectures.speechHelper.architectures ?? [],
  },
  checks,
  diagnostics: {
    ...diagnosticsForAppBundle(releaseApp),
    dmgSignature: commandDiagnostic(dmgSignature),
    dmgStapler: commandDiagnostic(dmgStapler),
    dmgGatekeeper: commandDiagnostic(dmgGatekeeper),
    dmgMount: commandDiagnostic(dmgVerification.mount),
    dmgMountMetadata: commandDiagnostic(dmgVerification.metadata),
    dmgDetach: commandDiagnostic(dmgVerification.detach),
    dmgCleanup: commandDiagnostic(dmgVerification.cleanup),
    dmgInspectionError: dmgVerification.error,
    dmgAppCandidates: dmgVerification.appCandidates,
    dmgAppBundle: dmgVerification.appBundle,
    dmgApp: dmgVerification.app ? diagnosticsForAppBundle(dmgVerification.app) : null,
    zipExtraction: commandDiagnostic(zipVerification.extraction),
    zipCleanup: commandDiagnostic(zipVerification.cleanup),
    zipAppCandidates: zipVerification.appCandidates,
    zipAppBundle: zipVerification.appBundle,
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

- Release directory: ${releaseDir}
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
