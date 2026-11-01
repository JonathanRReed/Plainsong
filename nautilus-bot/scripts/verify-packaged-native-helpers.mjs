#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifySidecarBuildReceipt } from "./lib/sidecar-build-receipt.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const scriptPath = fileURLToPath(import.meta.url);
const SPEECH_HELPER_NAME =
  "nautilus-macos-speech-helper-aarch64-apple-darwin";
const SYSTEM_AUDIO_USAGE_DESCRIPTION =
  "In Me + Them meetings, Plainsong records your microphone and all audio playing on this Mac, including other apps and notification sounds. This works with headphones on macOS 14.7 or later. It never records your screen. Depending on your transcription settings, meeting audio is processed on this Mac or sent to the cloud provider you choose.";
const CALENDAR_USAGE_DESCRIPTION =
  "Plainsong reads your calendar to help you prepare for and capture meetings, and, if enabled, spell names locally. It does not change your calendar. If you choose cloud AI, selected meeting details may be sent to that provider.";
// macOS 13 reads the first key, macOS 14+ reads the second. The app supports
// both, so a packaged bundle carrying only one of them shows half its supported
// range an empty permission prompt — which is not a thing to discover after
// notarization.
const CALENDAR_USAGE_DESCRIPTION_KEYS = [
  "NSCalendarsUsageDescription",
  "NSCalendarsFullAccessUsageDescription",
];
const CALENDAR_HELPER_REQUIRED_ENTITLEMENT =
  "com.apple.security.personal-information.calendars";
// The calendar helper also reads contact names, only after the user turns on
// Contacts names for dictation.
const CONTACTS_USAGE_DESCRIPTION_KEY = "NSContactsUsageDescription";
const CONTACTS_USAGE_DESCRIPTION =
  "Plainsong uses names from Contacts to spell people's names in dictation. It reads only names, never changes Contacts, and they stay on this Mac.";
const CONTACTS_REQUIRED_ENTITLEMENT =
  "com.apple.security.personal-information.addressbook";
const CALENDAR_HELPER_FORBIDDEN_ENTITLEMENTS = [
  "com.apple.security.device.audio-input",
  "com.apple.security.device.microphone",
  "com.apple.security.automation.apple-events",
  "com.apple.security.temporary-exception.apple-events",
  "com.apple.security.personal-information.speech-recognition",
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.disable-library-validation",
];

function fail(message) {
  throw new Error(`Packaged native helper verification failed: ${message}`);
}

function valueFor(args, name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) return fallback;
  return args[index + 1];
}

function normalizeArchitecture(architecture) {
  return architecture === "x64" ? "x86_64" : architecture;
}

function appBundlePaths(appPath) {
  const executableName = path.basename(appPath, ".app");
  return {
    app: appPath,
    mainExecutable: path.join(
      appPath,
      "Contents",
      "MacOS",
      executableName,
    ),
    sidecar: path.join(
      appPath,
      "Contents",
      "Resources",
      "sidecar",
      "plainsong-sidecar",
    ),
    cli: path.join(
      appPath,
      "Contents",
      "Resources",
      "sidecar",
      "plainsong-cli",
    ),
    shortcutHelper: path.join(
      appPath,
      "Contents",
      "Resources",
      "shortcut-helper",
      "plainsong-native-shortcut-helper",
    ),
    calendarHelper: path.join(
      appPath,
      "Contents",
      "Resources",
      "calendar-helper",
      "plainsong-native-calendar-helper",
    ),
    languageModelHelper: path.join(
      appPath,
      "Contents",
      "Resources",
      "language-model-helper",
      "plainsong-native-language-model-helper",
    ),
    asrHelper: path.join(
      appPath,
      "Contents",
      "Resources",
      "asr-helper",
      "plainsong-native-asr-helper",
    ),
    textHelper: path.join(
      appPath,
      "Contents",
      "Resources",
      "text-helper",
      "plainsong-text-helper",
    ),
    speechHelper: path.join(
      appPath,
      "Contents",
      "Resources",
      "sidecar",
      SPEECH_HELPER_NAME,
    ),
  };
}

function requireAppBundle(appPath) {
  let metadata;
  try {
    metadata = fs.statSync(appPath);
  } catch (error) {
    fail(`app bundle is missing at ${appPath}: ${error.message}`);
  }
  if (!metadata.isDirectory()) {
    fail(`app bundle is not a directory at ${appPath}`);
  }
}

function requireExecutable(filePath, label) {
  let metadata;
  try {
    metadata = fs.statSync(filePath);
  } catch (error) {
    fail(`${label} is missing at ${filePath}: ${error.message}`);
  }
  if (!metadata.isFile() || metadata.size === 0) {
    fail(`${label} is not a non-empty regular file at ${filePath}`);
  }
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
  } catch {
    fail(`${label} is not executable at ${filePath}`);
  }
}

function requireArchitecture(filePath, label, expectedArchitecture) {
  const result = spawnSync("/usr/bin/lipo", ["-archs", filePath], {
    encoding: "utf8",
  });
  if (result.error) {
    fail(`could not inspect ${label} architecture: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(
      `lipo could not inspect ${label} at ${filePath}: ${(result.stderr || result.stdout).trim()}`,
    );
  }

  const architectures = result.stdout.trim().split(/\s+/).filter(Boolean);
  if (
    architectures.length !== 1 ||
    architectures[0] !== expectedArchitecture
  ) {
    fail(
      `${label} must be ${expectedArchitecture}-only, found: ${architectures.join(" ") || "none"}`,
    );
  }
  return architectures;
}

/**
 * Read `codesign -dv` for one file without deciding anything about it.
 *
 * @returns {{ status: number, output: string }}
 */
function readSignatureProbe(filePath, label) {
  const result = spawnSync("/usr/bin/codesign", ["-dv", filePath], {
    encoding: "utf8",
  });
  if (result.error) {
    fail(`could not inspect ${label} signature: ${result.error.message}`);
  }
  return {
    status: result.status ?? 1,
    output: `${result.stdout}\n${result.stderr}`,
  };
}

/**
 * Did somebody actually run `codesign` on this binary?
 *
 * Every assertion below about entitlements is an assertion about a signature,
 * and there are three states a Mach-O in this bundle can be in:
 *
 *   - `codesign -dv` exits non-zero ("code object is not signed at all"):
 *     nothing has signed it.
 *   - `flags=0x20002(adhoc,linker-signed)`: the *linker* stamped an ad-hoc
 *     signature while cargo built it. No codesign invocation happened, so
 *     there is no entitlement blob to read — `plainsong-sidecar` and
 *     `plainsong-cli` are both in this state until electron-builder signs them.
 *   - anything else — a deliberate `flags=0x2(adhoc)` from a build script, or
 *     a Developer ID signature: someone chose these entitlements, so what this
 *     gate reads back is a real claim about what will ship.
 *
 * Only the third state carries information. Asserting on the first two is
 * asserting on a signature that does not exist yet, which is what made
 * `bun run electron:pack` unrunnable on a machine with no signing identity:
 * the pack signs nothing, so the CLI's "empty entitlement set" check failed on
 * "has no readable entitlement property list" rather than on anything true
 * about the build.
 *
 * @param {{ status: number, output: string }} probe
 */
export function hasDeliberateSignature(probe) {
  if (probe.status !== 0) return false;
  const flags = /\bflags=(\S+)/.exec(probe.output)?.[1] ?? "";
  if (flags.includes("linker-signed")) return false;
  return true;
}

function readEntitlements(filePath, label) {
  const result = spawnSync(
    "/usr/bin/codesign",
    ["-d", "--entitlements", ":-", filePath],
    { encoding: "utf8" },
  );
  if (result.error) {
    fail(`could not inspect ${label} entitlements: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(
      `could not inspect ${label} entitlements: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  const output = `${result.stdout}\n${result.stderr}`;
  const start = output.indexOf("<?xml");
  const end = output.lastIndexOf("</plist>");
  if (start < 0 || end < start) {
    fail(`${label} has no readable entitlement property list`);
  }
  const plist = output.slice(start, end + "</plist>".length);
  const converted = spawnSync(
    "/usr/bin/plutil",
    ["-convert", "json", "-o", "-", "-"],
    { encoding: "utf8", input: plist },
  );
  if (converted.error || converted.status !== 0) {
    fail(
      `could not parse ${label} entitlements: ${
        converted.error?.message || converted.stderr.trim()
      }`,
    );
  }
  try {
    return JSON.parse(converted.stdout);
  } catch (error) {
    fail(`could not decode ${label} entitlements: ${error.message}`);
  }
}

/**
 * A helper binary that carries no entitlements at all.
 *
 * The shortcut helper and the `plainsong` CLI are both separate signatures for
 * the same reason: neither should inherit the app's microphone, Apple Events
 * or library-validation entitlements. The CLI in particular opens the user's
 * database from a terminal, where it is trivially invokable by anything on the
 * machine — an entitlement that leaked into its signature would be handing out
 * the app's own privileges. It reads with SQLite's read-only flag and needs
 * nothing beyond that.
 *
 * The Apple Foundation Models helper and the Neural Engine speech helper are
 * held to the same rule. FoundationModels is not TCC-guarded, and the speech
 * helper is fed 16 kHz audio by the sidecar on stdin rather than capturing it;
 * neither needs a network client, Apple Events or a JIT. If either comes back
 * non-empty it inherited the app's broad child-process set, which would hand a
 * process that sees dictation text or audio far more reach than it needs.
 *
 * The llama.cpp text helper reads a model file descriptor and JSON on stdin and
 * runs on Metal or the CPU, linking only system libraries, so it needs no
 * library-validation exception either.
 */
function requireEmptyEntitlements(filePath, label) {
  const entitlements = readEntitlements(filePath, label);
  const keys = Object.keys(entitlements);
  if (keys.length > 0) {
    fail(`${label} must have an empty entitlement set, found: ${keys.join(", ")}`);
  }
}

function readPackagedInfoString(appPath, key) {
  const plistPath = path.join(appPath, "Contents", "Info.plist");
  const result = spawnSync(
    "/usr/bin/plutil",
    ["-extract", key, "raw", "-o", "-", plistPath],
    { encoding: "utf8" },
  );
  if (result.error || result.status !== 0) {
    fail(
      `could not read ${key} from ${plistPath}: ${
        result.error?.message || result.stderr.trim()
      }`,
    );
  }
  return result.stdout.trim();
}

function requirePackagedSystemAudioUsageDescription(appPath) {
  if (
    readPackagedInfoString(appPath, "NSAudioCaptureUsageDescription") !==
    SYSTEM_AUDIO_USAGE_DESCRIPTION
  ) {
    fail("packaged NSAudioCaptureUsageDescription is missing or stale");
  }
}

/**
 * Both calendar usage strings, in the app bundle that owns the prompt.
 *
 * TCC attributes a spawned helper's prompt to the responsible process, so the
 * string a reader sees comes from THIS Info.plist and not from the helper's
 * embedded one. Which key is read depends on the macOS version, and the app
 * supports a range that spans the rename — so both have to be present and both
 * have to say the same thing.
 */
function requirePackagedCalendarUsageDescriptions(appPath) {
  for (const key of CALENDAR_USAGE_DESCRIPTION_KEYS) {
    if (readPackagedInfoString(appPath, key) !== CALENDAR_USAGE_DESCRIPTION) {
      fail(`packaged ${key} is missing or stale`);
    }
  }
  if (
    readPackagedInfoString(appPath, CONTACTS_USAGE_DESCRIPTION_KEY) !==
    CONTACTS_USAGE_DESCRIPTION
  ) {
    fail(`packaged ${CONTACTS_USAGE_DESCRIPTION_KEY} is missing or stale`);
  }
}

/**
 * The app itself must carry the calendar entitlement.
 *
 * TCC attributes the helper's calendar request to the responsible process —
 * the app — and the hardened runtime refuses to prompt for a responsible
 * process whose signature lacks the entitlement. 0.9.0-beta.6 shipped with it
 * on the helper only, and Connect calendar answered "no" without a prompt.
 */
function requireAppCalendarEntitlement(filePath) {
  const entitlements = readEntitlements(filePath, "app executable");
  if (entitlements[CALENDAR_HELPER_REQUIRED_ENTITLEMENT] !== true) {
    fail(
      `app must carry ${CALENDAR_HELPER_REQUIRED_ENTITLEMENT} or macOS will not show the calendar prompt the helper asks for`,
    );
  }
  if (entitlements[CONTACTS_REQUIRED_ENTITLEMENT] !== true) {
    fail(
      `app must carry ${CONTACTS_REQUIRED_ENTITLEMENT} or macOS will not show the Contacts prompt the helper asks for`,
    );
  }
}

/**
 * The calendar helper holds the calendar entitlement, and only that one.
 *
 * The point of compiling a separate binary was to keep calendar reading off the
 * signature that already carries microphone, Apple Events and the runtime
 * Accessibility grant. A helper that inherited the app's broad entitlement set
 * would have thrown that away silently, so the packaging gate refuses it.
 */
function requireCalendarHelperEntitlements(filePath) {
  const entitlements = readEntitlements(filePath, "calendar helper");
  if (entitlements[CALENDAR_HELPER_REQUIRED_ENTITLEMENT] !== true) {
    fail(
      `calendar helper must carry ${CALENDAR_HELPER_REQUIRED_ENTITLEMENT}, found: ${
        Object.keys(entitlements).join(", ") || "none"
      }`,
    );
  }
  if (entitlements[CONTACTS_REQUIRED_ENTITLEMENT] !== true) {
    fail(`calendar helper must carry ${CONTACTS_REQUIRED_ENTITLEMENT}`);
  }
  for (const forbidden of CALENDAR_HELPER_FORBIDDEN_ENTITLEMENTS) {
    if (forbidden in entitlements) {
      fail(`calendar helper must not inherit ${forbidden}`);
    }
  }
}

/**
 * The helper's own embedded usage strings.
 *
 * A helper compiled without its `__TEXT,__info_plist` section still runs, still
 * signs, and still packages — and then macOS kills it the moment it asks for
 * full calendar access. The failure is invisible until a user clicks Connect on
 * a notarized build, which is exactly the class of thing this gate exists for.
 */
function requireCalendarHelperEmbeddedUsageDescriptions(filePath) {
  const result = spawnSync(
    "/usr/bin/otool",
    ["-s", "__TEXT", "__info_plist", "-V", filePath],
    { encoding: "utf8" },
  );
  if (result.error || result.status !== 0) {
    fail(
      `could not read the calendar helper's embedded Info.plist: ${
        result.error?.message || result.stderr.trim()
      }`,
    );
  }
  for (const key of CALENDAR_USAGE_DESCRIPTION_KEYS) {
    if (!result.stdout.includes(key)) {
      fail(`calendar helper must embed ${key}`);
    }
  }
  if (!result.stdout.includes(CONTACTS_USAGE_DESCRIPTION_KEY)) {
    fail(`calendar helper must embed ${CONTACTS_USAGE_DESCRIPTION_KEY}`);
  }
  for (const forbidden of [
    "NSMicrophoneUsageDescription",
    "NSAppleEventsUsageDescription",
  ]) {
    if (result.stdout.includes(forbidden)) {
      fail(`calendar helper must not embed ${forbidden}`);
    }
  }
}

export function verifySpeechHelperContract(appPath) {
  const verifier = path.resolve(
    import.meta.dirname,
    "verify-macos-speech-helper.mjs",
  );
  const result = spawnSync(process.execPath, [verifier, "--app", appPath], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.error) {
    fail(`could not launch the Apple Speech helper verifier: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`Apple Speech helper verification exited ${result.status}`);
  }
}

export function checkSpeechHelperContract(
  appPath,
  { staticOnly = false, verifier = verifySpeechHelperContract } = {},
) {
  if (staticOnly) return false;
  verifier(appPath);
  return true;
}

/**
 * Decide whether this run may assert on `filePath`'s entitlements.
 *
 * In the default (strict) mode every binary must carry a deliberate signature,
 * and one that does not is a failure rather than a skip — that is the mode
 * `bun run gate:packaged:macos:native` uses against the signed `release/`
 * bundle, so an unsigned helper in a shipping build still stops the gate.
 *
 * `allowUnsigned` relaxes that to a per-binary skip. It is for bundles that
 * are not signed yet: the `afterPack` hook (which electron-builder runs before
 * signing, always) and `bun run electron:pack`, whose `--dir` output is never
 * signed at all.
 */
function entitlementChecksApply(filePath, label, allowUnsigned, skipped) {
  if (hasDeliberateSignature(readSignatureProbe(filePath, label))) return true;
  if (!allowUnsigned) {
    fail(
      `${label} is not signed at ${filePath}; a signed build must sign every ` +
        "native helper (pass --allow-unsigned to verify an unsigned --dir pack)",
    );
  }
  skipped.push(label);
  return false;
}

export function verifyAppBundle(
  appPath,
  expectedArchitecture,
  { allowUnsigned = false, staticOnly = false, speechContractVerifier } = {},
) {
  if (process.platform !== "darwin") {
    fail("Mach-O package verification requires macOS");
  }

  const paths = appBundlePaths(appPath);
  requireAppBundle(paths.app);

  const executables = [
    ["app executable", paths.mainExecutable],
    ["Rust sidecar", paths.sidecar],
    ["plainsong CLI", paths.cli],
    ["shortcut helper", paths.shortcutHelper],
    ["calendar helper", paths.calendarHelper],
    ["Apple Foundation Models helper", paths.languageModelHelper],
    ["Neural Engine speech helper", paths.asrHelper],
    ["text helper", paths.textHelper],
    ["Apple Speech helper", paths.speechHelper],
  ];
  const architectures = {};
  for (const [label, filePath] of executables) {
    requireExecutable(filePath, label);
    architectures[label] = requireArchitecture(
      filePath,
      label,
      expectedArchitecture,
    );
  }

  // Every check below this line reads a signature. The ones above it — the
  // file exists, is executable, and is arm64-only — read the Mach-O itself and
  // hold whether or not anything has signed the bundle, so they run in both
  // modes.
  const unsignedSkips = [];
  if (
    entitlementChecksApply(
      paths.shortcutHelper,
      "shortcut helper",
      allowUnsigned,
      unsignedSkips,
    )
  ) {
    requireEmptyEntitlements(paths.shortcutHelper, "shortcut helper");
  }
  if (entitlementChecksApply(paths.cli, "plainsong CLI", allowUnsigned, unsignedSkips)) {
    requireEmptyEntitlements(paths.cli, "plainsong CLI");
  }
  if (
    entitlementChecksApply(
      paths.languageModelHelper,
      "Apple Foundation Models helper",
      allowUnsigned,
      unsignedSkips,
    )
  ) {
    requireEmptyEntitlements(
      paths.languageModelHelper,
      "Apple Foundation Models helper",
    );
  }
  if (
    entitlementChecksApply(
      paths.asrHelper,
      "Neural Engine speech helper",
      allowUnsigned,
      unsignedSkips,
    )
  ) {
    requireEmptyEntitlements(paths.asrHelper, "Neural Engine speech helper");
  }
  if (
    entitlementChecksApply(
      paths.textHelper,
      "text helper",
      allowUnsigned,
      unsignedSkips,
    )
  ) {
    requireEmptyEntitlements(paths.textHelper, "text helper");
  }
  if (
    entitlementChecksApply(
      paths.calendarHelper,
      "calendar helper",
      allowUnsigned,
      unsignedSkips,
    )
  ) {
    requireCalendarHelperEntitlements(paths.calendarHelper);
  }
  if (
    entitlementChecksApply(
      paths.mainExecutable,
      "app executable",
      allowUnsigned,
      unsignedSkips,
    )
  ) {
    requireAppCalendarEntitlement(paths.mainExecutable);
  }
  // The helper's embedded `__TEXT,__info_plist` is compiled into the binary,
  // not attached by codesign, so it is readable before signing too.
  requireCalendarHelperEmbeddedUsageDescriptions(paths.calendarHelper);
  requirePackagedSystemAudioUsageDescription(appPath);
  requirePackagedCalendarUsageDescriptions(appPath);
  const speechContractChecked = checkSpeechHelperContract(appPath, {
    staticOnly,
    verifier: speechContractVerifier ?? verifySpeechHelperContract,
  });
  return {
    pass: true,
    appPath,
    expectedArchitecture,
    allowUnsigned,
    staticOnly,
    speechContractChecked,
    unsignedSkips,
    paths,
    architectures,
  };
}

/**
 * electron-builder `afterPack` hook.
 *
 * This runs BEFORE code signing on every path — app-builder-lib emits
 * `afterPack`, then flips the fuses, then signs (`platformPackager.js`
 * `doPack` → `emitAfterPack` → `doAddElectronFuses` → `doSignAfterPack`) — so
 * the bundle it is handed is never signed, not even during `release:mac`.
 * `allowUnsigned` therefore is not a weakening of the release path: it is the
 * only honest description of what is on disk at this point. The signed bundle
 * is checked strictly afterwards by `bun run gate:packaged:macos:native`.
 *
 * The helpers a build script signs itself (Speech, calendar, shortcut, Apple
 * Foundation Models, Neural Engine speech, text) are still fully asserted
 * here, because those signatures do exist by now. What is skipped is the
 * Rust binaries, which cargo leaves linker-signed until electron-builder
 * gets to them.
 */
export default function verifyPackagedNativeHelpers(
  context,
  { staticOnly = false } = {},
) {
  if (context.electronPlatformName !== "darwin") return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  const paths = appBundlePaths(appPath);
  verifySidecarBuildReceipt(context.packager.projectDir ?? repoRoot, new Map([
    ["plainsong-sidecar", paths.sidecar],
    ["plainsong-cli", paths.cli],
  ]));
  verifyAppBundle(appPath, normalizeArchitecture(process.arch), {
    allowUnsigned: true,
    staticOnly,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const args = process.argv.slice(2);
  const appValue = valueFor(
    args,
    "--app",
    "release/mac-arm64/Plainsong.app",
  );
  const expectedArchitecture = normalizeArchitecture(
    valueFor(args, "--arch", "arm64"),
  );
  // Default off: the gate script points at `release/mac-arm64/Plainsong.app`,
  // which after a real build is signed, and an unsigned binary there is a
  // release defect and not something to shrug at. Pass the flag to verify the
  // unsigned bundle `bun run electron:pack` leaves in the same place.
  const allowUnsigned = args.includes("--allow-unsigned");
  const staticOnly = args.includes("--static-only");

  try {
    const result = verifyAppBundle(
      path.resolve(repoRoot, appValue),
      expectedArchitecture,
      { allowUnsigned, staticOnly },
    );
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
