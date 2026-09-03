#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const sourceOnly = args.includes("--source-only");

function valueFor(name) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
}

function fail(message) {
  console.error(`macOS Speech helper gate failed: ${message}`);
  process.exit(1);
}

function requireFile(filePath, label) {
  let metadata;
  try {
    metadata = fs.statSync(filePath);
  } catch (error) {
    fail(`${label} is missing at ${filePath}: ${error.message}`);
  }
  if (!metadata.isFile() || metadata.size === 0) {
    fail(`${label} is not a non-empty regular file at ${filePath}`);
  }
}

function requireMatch(text, pattern, message) {
  if (!pattern.test(text)) fail(message);
}

function forbidMatch(text, pattern, message) {
  if (pattern.test(text)) fail(message);
}

function run(program, commandArgs, { allowFailure = false } = {}) {
  const result = spawnSync(program, commandArgs, {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error) fail(`could not launch ${program}: ${result.error.message}`);
  if (!allowFailure && result.status !== 0) {
    fail(
      `${program} ${commandArgs.join(" ")} exited ${result.status}: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result;
}

function parseLastJsonLine(output, label) {
  const line = output
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .filter(Boolean)
    .pop();
  if (!line) fail(`${label} returned no JSON line`);
  try {
    return JSON.parse(line);
  } catch (error) {
    fail(`${label} returned malformed JSON: ${error.message}: ${line}`);
  }
}

const nativeDir = path.join(repoRoot, "rust-sidecar", "native");
const sourcePath = path.join(nativeDir, "macos_speech_helper.swift");
const infoPlistPath = path.join(nativeDir, "macos_speech_helper.Info.plist");
const entitlementsPath = path.join(nativeDir, "macos_speech_helper.entitlements.plist");
const appEntitlementsPath = path.join(
  repoRoot,
  "build-resources",
  "entitlements.mac.plist",
);
const inheritedEntitlementsPath = path.join(
  repoRoot,
  "build-resources",
  "entitlements.mac.inherit.plist",
);
const buildScriptPath = path.join(repoRoot, "rust-sidecar", "build.rs");
const builderPath = path.join(repoRoot, "electron-builder.yml");
const signScriptPath = path.join(repoRoot, "scripts", "sign-macos.mjs");
const sidecarEnvPath = path.join(repoRoot, "electron", "sidecar-env.ts");
const rustBridgePath = path.join(
  repoRoot,
  "rust-sidecar",
  "src",
  "asr",
  "platform",
  "macos_speech.rs",
);
const dictationParityPath = path.join(
  repoRoot,
  "rust-sidecar",
  "src",
  "dictation_parity.rs",
);

for (const [filePath, label] of [
  [sourcePath, "Swift helper source"],
  [infoPlistPath, "helper Info.plist"],
  [entitlementsPath, "helper entitlements"],
  [appEntitlementsPath, "Electron app entitlements"],
  [inheritedEntitlementsPath, "inherited child entitlements"],
  [buildScriptPath, "Rust build script"],
  [signScriptPath, "macOS signing adapter"],
  [sidecarEnvPath, "Electron sidecar environment allowlist"],
  [rustBridgePath, "Rust macOS Speech bridge"],
  [dictationParityPath, "Rust dictation parity rules"],
]) {
  requireFile(filePath, label);
}

const source = fs.readFileSync(sourcePath, "utf8");
const infoPlist = fs.readFileSync(infoPlistPath, "utf8");
const entitlements = fs.readFileSync(entitlementsPath, "utf8");
const appEntitlements = fs.readFileSync(appEntitlementsPath, "utf8");
const inheritedEntitlements = fs.readFileSync(inheritedEntitlementsPath, "utf8");
const buildScript = fs.readFileSync(buildScriptPath, "utf8");
const builder = fs.readFileSync(builderPath, "utf8");
const signScript = fs.readFileSync(signScriptPath, "utf8");
const sidecarEnv = fs.readFileSync(sidecarEnvPath, "utf8");
const rustBridge = fs.readFileSync(rustBridgePath, "utf8");
const dictationParity = fs.readFileSync(dictationParityPath, "utf8");

requireMatch(
  buildScript,
  /SWIFT_TARGET:\s*&str\s*=\s*"arm64-apple-macosx13\.0"/,
  "build.rs must compile the helper for arm64-apple-macosx13.0",
);
requireMatch(
  buildScript,
  /\[&source,\s*&helper_plist,\s*&helper_entitlements\]/,
  "build.rs must include helper entitlements in its required source inputs",
);
requireMatch(
  buildScript,
  /require_regular_file\(path\)/,
  "build.rs must hard-require every helper source input",
);
requireMatch(
  buildScript,
  /ensure_executable\(&helper_path\)/,
  "build.rs must explicitly mark the generated helper executable",
);
forbidMatch(
  buildScript,
  /if\s*!source\.exists\(\)[\s\S]{0,160}return;/,
  "build.rs must not silently omit the helper when its source is missing",
);

requireMatch(
  source,
  /SFSpeechRecognizer\.authorizationStatus\(\)/,
  "helper probe must read authorization status without prompting",
);
requireMatch(
  source,
  /SFSpeechRecognizer\.supportedLocales\(\)/,
  "helper probe must inspect supported locales",
);
requireMatch(
  source,
  /supportsOnDeviceRecognition/,
  "helper probe must inspect on-device capability",
);
const onDeviceAssignments = source.match(/requiresOnDeviceRecognition\s*=\s*true/g) ?? [];
if (onDeviceAssignments.length < 2) {
  fail("batch and live requests must unconditionally require on-device recognition");
}
forbidMatch(
  source,
  /requiresOnDeviceRecognition\s*=\s*[^t\s]/,
  "helper must not conditionally allow Apple server fallback",
);

// SpeechAnalyzer (macOS 26+) additions. The helper still has to build and run
// with a 13.0 deployment target, so every use has to sit behind an
// `#available` guard, and the analyzer path has to be as strict about staying
// on-device as the SFSpeechRecognizer path: no download it was not asked for,
// and a refusal rather than a fallback when the locale's assets are missing.
requireMatch(
  source,
  /if #available\(macOS 26, \*\)/,
  "SpeechAnalyzer use must be guarded by #available(macOS 26, *)",
);
// `#available` is a runtime guard only: the symbols still have to resolve at
// compile time, so an SDK older than macOS 26 needs the section compiled out
// entirely or the whole app stops building.
requireMatch(
  source,
  /#if !NO_SPEECH_ANALYZER/,
  "SpeechAnalyzer sources must be compilable out with -D NO_SPEECH_ANALYZER for older SDKs",
);
requireMatch(
  buildScript,
  /"--sdk",\s*"macosx",\s*"--show-sdk-version"/,
  "build.rs must probe the macOS SDK version before compiling the SpeechAnalyzer section",
);
requireMatch(
  buildScript,
  /"-D",\s*"NO_SPEECH_ANALYZER"/,
  "build.rs must pass -D NO_SPEECH_ANALYZER when the SDK predates the SpeechAnalyzer API",
);
requireMatch(
  source,
  /SpeechTranscriber\.supportedLocales/,
  "helper probe must report the SpeechAnalyzer locale list from the framework",
);
requireMatch(
  source,
  /AssetInventory\.status\(/,
  "helper probe must check SpeechAnalyzer asset state through AssetInventory",
);
requireMatch(
  source,
  /attributeOptions: \[\.audioTimeRange/,
  "SpeechAnalyzer transcription must request audio time ranges for segment timestamps",
);
requireMatch(
  source,
  /guard facts\.assetsInstalled else \{[\s\S]{0,400}code: \.assetsNotInstalled/,
  "SpeechAnalyzer must refuse when the locale's assets are not installed",
);
requireMatch(
  source,
  /engine: engine \?\? \.sfSpeechRecognizer/,
  "--live must keep the SFSpeechRecognizer event protocol unless SpeechAnalyzer is named outright",
);
// The SpeechAnalyzer branches never return, so an authorization check that
// only lives inside `recognitionContext` covers SFSpeechRecognizer alone --
// the helper would transcribe with permission still `not_determined`. Both
// transcription entry points have to check before choosing an engine.
requireMatch(
  source,
  /private func requireSpeechAuthorization\(\) -> SFSpeechRecognizerAuthorizationStatus/,
  "the helper must have one shared Speech authorization gate",
);
for (const [entryPoint, label] of [
  ["runFileRecognition", "--transcribe-file"],
  ["runLiveRecognition", "--live"],
]) {
  const start = source.indexOf(`private func ${entryPoint}(`);
  if (start < 0) fail(`${entryPoint} must exist`);
  const analyzerBranch = source.indexOf("#if !NO_SPEECH_ANALYZER", start);
  const authorizationCheck = source.indexOf("requireSpeechAuthorization()", start);
  if (authorizationCheck < 0 || analyzerBranch < 0 || authorizationCheck > analyzerBranch) {
    fail(`${label} must check Speech authorization before it can reach SpeechAnalyzer`);
  }
}
// Vocabulary hints (contextual strings). The terms are the user's own
// dictionary entries, so the contract has two halves: they must reach both
// engines, and they must never travel as command-line arguments, where every
// process on the machine can read them out of the argument list.
requireMatch(
  source,
  /--contextual-strings-file/,
  "the helper must accept vocabulary terms through a file, not inline arguments",
);
requireMatch(
  source,
  /private func loadContextualStrings\(path: String\?\) -> \[String\][\s\S]{0,400}Data\(contentsOf: url\)/,
  "the helper must read vocabulary terms from the file it was pointed at",
);
requireMatch(
  source,
  /context\.contextualStrings\[\.general\] = contextualStrings/,
  "SpeechAnalyzer must receive the vocabulary terms through AnalysisContext",
);
const sfContextualAssignments =
  source.match(/request\.contextualStrings = contextualStrings/g) ?? [];
if (sfContextualAssignments.length < 2) {
  fail(
    "both SFSpeechRecognizer requests (file and live) must receive the vocabulary terms",
  );
}
// The caps are the whisper prompt's, and they live in Rust. The helper repeats
// them because it is a separate binary; the two copies must stay equal.
const rustTermCap = dictationParity.match(
  /VOCABULARY_HINT_MAX_TERMS:\s*usize\s*=\s*(\d+)/,
);
const rustCharCap = dictationParity.match(
  /VOCABULARY_HINT_MAX_CHARS:\s*usize\s*=\s*(\d+)/,
);
if (!rustTermCap || !rustCharCap) {
  fail("could not read the Rust vocabulary hint caps from dictation_parity.rs");
}
const helperTermCap = source.match(/contextualStringsMaxTerms\s*=\s*(\d+)/);
const helperCharCap = source.match(/contextualStringsMaxCharacters\s*=\s*(\d+)/);
if (!helperTermCap || !helperCharCap) {
  fail("the helper must declare its own vocabulary term and character caps");
}
if (helperTermCap[1] !== rustTermCap[1] || helperCharCap[1] !== rustCharCap[1]) {
  fail(
    `helper vocabulary caps (${helperTermCap[1]} terms / ${helperCharCap[1]} chars) must match the Rust caps (${rustTermCap[1]} / ${rustCharCap[1]})`,
  );
}
// The count the app reports has to be the helper's own answer, not the number
// of terms the app sent, or the audit log would claim the dictionary reached a
// recognizer that never saw it.
requireMatch(
  rustBridge,
  /vocabulary_hint_terms_applied:\s*payload\.contextual_strings_applied/,
  "the Rust bridge must report the applied term count the helper returned",
);
requireMatch(
  rustBridge,
  /options\.mode\(0o600\)/,
  "the staged vocabulary file must be created private to the user",
);
forbidMatch(
  sidecarEnv,
  /PLAINSONG_MACOS_SPEECH_HELPER_PATH/,
  "Electron must not forward a macOS Speech helper path override to the sidecar",
);
forbidMatch(
  rustBridge,
  /std::env::var\("PLAINSONG_MACOS_SPEECH_HELPER_PATH"\)/,
  "the Rust bridge must not accept a macOS Speech helper path override",
);
requireMatch(
  rustBridge,
  /join\("Contents"\)[\s\S]{0,240}join\("Resources"\)[\s\S]{0,240}join\("sidecar"\)[\s\S]{0,240}join\(HELPER_TARGET_NAME\)/,
  "packaged Speech lookup must use the fixed Contents/Resources/sidecar path",
);
requireMatch(
  rustBridge,
  /verify_code_signature\(executable,[\s\S]{0,240}verify_code_signature\(helper/,
  "packaged Speech lookup must validate both sidecar and helper signatures",
);
requireMatch(
  rustBridge,
  /sidecar_team\s*!=\s*helper_team/,
  "packaged Speech lookup must require the helper to match the sidecar Team ID",
);

for (const code of [
  "assets_not_installed",
  "asset_install_failed",
  "authorization_denied",
  "authorization_restricted",
  "authorization_not_determined",
  "unsupported_locale",
  "on_device_unavailable",
  "malformed_request",
  "timeout",
  "cancelled",
  "recognition_failed",
]) {
  requireMatch(source, new RegExp(`"${code}"`), `helper must emit typed ${code} errors`);
}

requireMatch(
  infoPlist,
  /<key>NSSpeechRecognitionUsageDescription<\/key>/,
  "helper Info.plist must contain the Speech usage string",
);
requireMatch(
  infoPlist,
  /<key>LSMinimumSystemVersion<\/key>\s*<string>13\.0<\/string>/,
  "helper Info.plist must declare macOS 13.0",
);
forbidMatch(
  infoPlist,
  /NSMicrophoneUsageDescription|NSAppleEventsUsageDescription/,
  "helper Info.plist must not claim microphone or Apple Events access",
);
requireMatch(
  entitlements,
  /<key>com\.apple\.security\.personal-information\.speech-recognition<\/key>\s*<true\/>/,
  "helper entitlements must grant Speech recognition",
);
for (const forbidden of [
  "com.apple.security.device.audio-input",
  "com.apple.security.device.microphone",
  "com.apple.security.automation.apple-events",
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.disable-library-validation",
]) {
  forbidMatch(
    entitlements,
    new RegExp(forbidden.replaceAll(".", "\\.")),
    `helper entitlements must not include ${forbidden}`,
  );
}
for (const [contents, label] of [
  [appEntitlements, "Electron app entitlements"],
  [inheritedEntitlements, "inherited child entitlements"],
]) {
  forbidMatch(
    contents,
    /com\.apple\.security\.personal-information\.speech-recognition/,
    `${label} must not grant Speech recognition; only the dedicated helper may hold it`,
  );
}

requireMatch(
  builder,
  /mac:[\s\S]*?extraResources:[\s\S]*?from:\s*rust-sidecar\/binaries\/[\s\S]{0,240}nautilus-macos-speech-helper-aarch64-apple-darwin/,
  "electron-builder must package the generated Speech helper through macOS-only resources",
);
requireMatch(
  builder,
  /binaries:[\s\S]{0,240}Contents\/Resources\/sidecar\/nautilus-macos-speech-helper-aarch64-apple-darwin/,
  "electron-builder must explicitly sign the packaged Speech helper",
);
requireMatch(
  builder,
  /sign:\s*scripts\/sign-macos\.mjs/,
  "electron-builder must select per-file helper entitlements while signing",
);
requireMatch(
  signScript,
  /macos_speech_helper\.entitlements\.plist/,
  "signing adapter must use the helper-specific entitlements",
);
requireMatch(
  signScript,
  /path\.basename\(filePath\)\s*!==\s*speechHelperName/,
  "signing adapter must scope minimal entitlements to the Speech helper only",
);

if (process.platform === "darwin") {
  run("/usr/bin/plutil", ["-lint", infoPlistPath]);
  run("/usr/bin/plutil", ["-lint", entitlementsPath]);
  run("/usr/bin/plutil", ["-lint", appEntitlementsPath]);
  run("/usr/bin/plutil", ["-lint", inheritedEntitlementsPath]);
}

let helperPath = valueFor("--helper");
const appValue = valueFor("--app");
if (appValue) {
  helperPath = path.join(
    path.resolve(repoRoot, appValue),
    "Contents",
    "Resources",
    "sidecar",
    "nautilus-macos-speech-helper-aarch64-apple-darwin",
  );
}
if (!helperPath && !sourceOnly) {
  helperPath = path.join(
    repoRoot,
    "rust-sidecar",
    "binaries",
    "nautilus-macos-speech-helper-aarch64-apple-darwin",
  );
}

/**
 * Compile the helper the way a machine with a pre-macOS-26 SDK would, and
 * check the binary that comes out.
 *
 * This is the only proof that the older-SDK path is real: on this Mac the SDK
 * is new, so the normal build never exercises it, and the failure it guards
 * against (`cannot find 'SpeechAnalyzer' in scope`) stops the whole app from
 * building on someone else's machine. The fallback binary must also be honest
 * about what it can do -- `speech_analyzer_available: false` -- rather than
 * claiming a capability whose symbols it does not contain.
 *
 * @returns {{ compiled: true, engine: string, speechAnalyzerAvailable: boolean }}
 */
function verifyOlderSdkFallbackBuild() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "plainsong-speech-helper-"));
  const fallbackPath = path.join(scratch, "macos-speech-helper-no-speech-analyzer");
  try {
    run("/usr/bin/xcrun", [
      "swiftc",
      "-target",
      "arm64-apple-macosx13.0",
      "-D",
      "NO_SPEECH_ANALYZER",
      sourcePath,
      "-framework",
      "Speech",
      "-framework",
      "Foundation",
      "-framework",
      "AVFoundation",
      "-o",
      fallbackPath,
    ]);
    const fallbackProbe = parseLastJsonLine(
      run(fallbackPath, ["--probe"]).stdout,
      "older-SDK helper --probe",
    );
    if (fallbackProbe.speech_analyzer_available !== false) {
      fail(
        `the older-SDK helper must report speech_analyzer_available: false, got ${JSON.stringify(
          fallbackProbe.speech_analyzer_available,
        )}`,
      );
    }
    if (fallbackProbe.engine !== "sf_speech_recognizer") {
      fail(`the older-SDK helper must resolve SFSpeechRecognizer, got ${fallbackProbe.engine}`);
    }
    const analyzerRequest = run(fallbackPath, ["--live", "--sample-rate", "16000", "--engine", "speech_analyzer"], {
      allowFailure: true,
    });
    if (analyzerRequest.status === 0) {
      fail("the older-SDK helper must refuse an explicit SpeechAnalyzer request");
    }
    const analyzerPayload = parseLastJsonLine(
      analyzerRequest.stdout,
      "older-SDK helper SpeechAnalyzer request",
    );
    // Which refusal comes first depends on this machine's Speech
    // authorization -- the helper checks that before it chooses an engine --
    // so any of the typed refusals is correct here. What must never happen is
    // the request proceeding; `speech_analyzer_available: false` above is what
    // proves the symbols are gone.
    const acceptableRefusals = new Set([
      "on_device_unavailable",
      "authorization_not_determined",
      "authorization_denied",
      "authorization_restricted",
    ]);
    if (
      analyzerPayload.type !== "error" ||
      !acceptableRefusals.has(analyzerPayload.code)
    ) {
      fail(
        `the older-SDK helper must refuse SpeechAnalyzer with a typed error: ${JSON.stringify(
          analyzerPayload,
        )}`,
      );
    }
    return {
      compiled: true,
      engine: fallbackProbe.engine,
      speechAnalyzerAvailable: fallbackProbe.speech_analyzer_available,
    };
  } finally {
    fs.rmSync(scratch, { force: true, recursive: true });
  }
}

let probe = null;
let olderSdkFallback = null;
if (!sourceOnly) {
  if (process.platform !== "darwin") {
    fail("Mach-O helper auditing requires macOS; pass --source-only on other platforms");
  }
  helperPath = path.resolve(repoRoot, helperPath);
  requireFile(helperPath, "compiled macOS Speech helper");
  try {
    fs.accessSync(helperPath, fs.constants.X_OK);
  } catch {
    fail(`compiled helper is not executable at ${helperPath}`);
  }

  const architectures = run("/usr/bin/lipo", ["-archs", helperPath]).stdout.trim().split(/\s+/);
  if (architectures.length !== 1 || architectures[0] !== "arm64") {
    fail(`helper must be arm64-only, found: ${architectures.join(" ")}`);
  }
  requireMatch(
    run("/usr/bin/xcrun", ["vtool", "-show-build", helperPath]).stdout,
    /minos\s+13\.0(?:\.0)?\b/,
    "compiled helper must declare macOS 13.0",
  );
  const links = run("/usr/bin/otool", ["-L", helperPath]).stdout;
  for (const framework of ["Speech.framework", "Foundation.framework", "AVFoundation.framework"]) {
    requireMatch(links, new RegExp(framework.replace(".", "\\.")), `helper must link ${framework}`);
  }
  const embeddedInfo = run("/usr/bin/otool", ["-s", "__TEXT", "__info_plist", "-V", helperPath]).stdout;
  requireMatch(
    embeddedInfo,
    /NSSpeechRecognitionUsageDescription/,
    "compiled helper must embed its Speech usage string",
  );
  forbidMatch(
    embeddedInfo,
    /NSMicrophoneUsageDescription|NSAppleEventsUsageDescription/,
    "compiled helper must not embed microphone or Apple Events usage strings",
  );

  const probeResult = run(helperPath, ["--probe"]);
  probe = parseLastJsonLine(probeResult.stdout, "helper --probe");
  if (
    probe.protocol_version !== 1 ||
    probe.type !== "probe" ||
    typeof probe.authorization !== "string" ||
    typeof probe.locale !== "string" ||
    typeof probe.locale_supported !== "boolean" ||
    typeof probe.on_device_available !== "boolean" ||
    typeof probe.speech_analyzer_available !== "boolean" ||
    typeof probe.speech_analyzer_locale_supported !== "boolean" ||
    typeof probe.speech_analyzer_assets_installed !== "boolean" ||
    typeof probe.speech_analyzer_asset_status !== "string" ||
    !Array.isArray(probe.speech_analyzer_locales) ||
    !Array.isArray(probe.speech_analyzer_installed_locales) ||
    typeof probe.engine !== "string" ||
    typeof probe.operating_system_version !== "string"
  ) {
    fail(`helper --probe does not match the Rust contract: ${JSON.stringify(probe)}`);
  }
  if (!["speech_analyzer", "sf_speech_recognizer"].includes(probe.engine)) {
    fail(`helper --probe reported an unknown engine: ${probe.engine}`);
  }
  if (probe.engine === "speech_analyzer" && !probe.speech_analyzer_available) {
    fail("helper --probe resolved SpeechAnalyzer while reporting it unavailable");
  }
  if (
    probe.speech_analyzer_locales.some((locale) => typeof locale !== "string") ||
    probe.speech_analyzer_installed_locales.some((locale) => typeof locale !== "string")
  ) {
    fail("helper --probe locale lists must contain strings only");
  }

  const malformed = run(helperPath, ["--not-a-command"], { allowFailure: true });
  if (malformed.status === 0) fail("malformed helper requests must exit non-zero");
  const malformedPayload = parseLastJsonLine(malformed.stdout, "malformed helper request");
  if (malformedPayload.type !== "error" || malformedPayload.code !== "malformed_request") {
    fail(`malformed request did not return its typed error: ${JSON.stringify(malformedPayload)}`);
  }

  const badEngine = run(
    helperPath,
    ["--transcribe-file", "/nonexistent.wav", "--engine", "not-an-engine"],
    { allowFailure: true },
  );
  if (badEngine.status === 0) fail("an unknown --engine must exit non-zero");
  const badEnginePayload = parseLastJsonLine(badEngine.stdout, "unknown --engine request");
  if (badEnginePayload.type !== "error" || badEnginePayload.code !== "malformed_request") {
    fail(`unknown --engine did not return its typed error: ${JSON.stringify(badEnginePayload)}`);
  }

  // Argument parsing runs before the authorization gate, so these are the
  // only vocabulary-hint checks that give the same answer on a machine whose
  // Speech Recognition permission is still undecided.
  for (const [label, commandArgs] of [
    [
      "--transcribe-file --contextual-strings-file with no path",
      ["--transcribe-file", "/nonexistent.wav", "--contextual-strings-file"],
    ],
    [
      "--transcribe-file --contextual-strings-file twice",
      [
        "--transcribe-file",
        "/nonexistent.wav",
        "--contextual-strings-file",
        "/a.json",
        "--contextual-strings-file",
        "/b.json",
      ],
    ],
    [
      "--live --contextual-strings-file with no path",
      [
        "--live",
        "--sample-rate",
        "16000",
        "--engine",
        "speech_analyzer",
        "--contextual-strings-file",
      ],
    ],
  ]) {
    const result = run(helperPath, commandArgs, { allowFailure: true });
    if (result.status === 0) fail(`${label} must exit non-zero`);
    const payload = parseLastJsonLine(result.stdout, label);
    if (payload.type !== "error" || payload.code !== "malformed_request") {
      fail(`${label} did not return its typed error: ${JSON.stringify(payload)}`);
    }
  }

  // Live mode does not auto-select: the two engines emit different event
  // shapes, so a caller has to name one.
  const liveAuto = run(
    helperPath,
    ["--live", "--sample-rate", "16000", "--engine", "auto"],
    { allowFailure: true },
  );
  if (liveAuto.status === 0) fail("--live --engine auto must exit non-zero");
  const liveAutoPayload = parseLastJsonLine(liveAuto.stdout, "--live --engine auto");
  if (liveAutoPayload.type !== "error" || liveAutoPayload.code !== "malformed_request") {
    fail(`--live --engine auto did not return its typed error: ${JSON.stringify(liveAutoPayload)}`);
  }

  olderSdkFallback = verifyOlderSdkFallbackBuild();

  const signature = run("/usr/bin/codesign", ["-d", "--entitlements", ":-", helperPath], {
    allowFailure: true,
  });
  if (signature.status !== 0) {
    fail("packaged helper has no readable entitlement payload");
  }
  const signedEntitlements = `${signature.stdout}\n${signature.stderr}`;
  requireMatch(
    signedEntitlements,
    /com\.apple\.security\.personal-information\.speech-recognition/,
    "packaged helper must retain the Speech recognition entitlement",
  );
  for (const forbidden of [
    "com.apple.security.device.audio-input",
    "com.apple.security.device.microphone",
    "com.apple.security.automation.apple-events",
    "com.apple.security.temporary-exception.apple-events",
    "com.apple.security.cs.allow-jit",
    "com.apple.security.cs.allow-unsigned-executable-memory",
    "com.apple.security.cs.disable-library-validation",
  ]) {
    forbidMatch(
      signedEntitlements,
      new RegExp(forbidden.replaceAll(".", "\\.")),
      `packaged helper must not inherit ${forbidden}`,
    );
  }
}

console.log(
  JSON.stringify({
    pass: true,
    sourceOnly,
    helperPath: sourceOnly ? null : helperPath,
    deploymentTarget: "13.0",
    architecture: "arm64",
    strictOnDevice: true,
    probe,
    engine: probe ? probe.engine : null,
    olderSdkFallback,
  }),
);
