#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const scriptPath = fileURLToPath(import.meta.url);
const SPEECH_HELPER_NAME =
  "nautilus-macos-speech-helper-aarch64-apple-darwin";
const SYSTEM_AUDIO_USAGE_DESCRIPTION =
  "Plainsong captures audio playing on your Mac to record and transcribe meetings. Depending on your transcription settings, meeting audio may be processed on this Mac or sent to the cloud provider you choose.";
const CALENDAR_USAGE_DESCRIPTION =
  "Plainsong reads your calendar on this Mac so it can offer to start capturing the meeting you are about to join. Nothing is written to your calendar and nothing leaves your Mac.";
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

function requireEmptyShortcutHelperEntitlements(filePath) {
  const entitlements = readEntitlements(filePath, "shortcut helper");
  const keys = Object.keys(entitlements);
  if (keys.length > 0) {
    fail(
      `shortcut helper must have an empty entitlement set, found: ${keys.join(", ")}`,
    );
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
  for (const forbidden of [
    "NSMicrophoneUsageDescription",
    "NSAppleEventsUsageDescription",
  ]) {
    if (result.stdout.includes(forbidden)) {
      fail(`calendar helper must not embed ${forbidden}`);
    }
  }
}

function verifySpeechHelperContract(appPath) {
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

function verifyAppBundle(appPath, expectedArchitecture) {
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

  requireEmptyShortcutHelperEntitlements(paths.shortcutHelper);
  requireCalendarHelperEntitlements(paths.calendarHelper);
  requireCalendarHelperEmbeddedUsageDescriptions(paths.calendarHelper);
  requirePackagedSystemAudioUsageDescription(appPath);
  requirePackagedCalendarUsageDescriptions(appPath);
  verifySpeechHelperContract(appPath);
  return {
    pass: true,
    appPath,
    expectedArchitecture,
    paths,
    architectures,
  };
}

export default function verifyPackagedNativeHelpers(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  verifyAppBundle(appPath, normalizeArchitecture(process.arch));
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

  try {
    const result = verifyAppBundle(
      path.resolve(repoRoot, appValue),
      expectedArchitecture,
    );
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
