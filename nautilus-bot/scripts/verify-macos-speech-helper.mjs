#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
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

let probe = null;
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
    typeof probe.operating_system_version !== "string"
  ) {
    fail(`helper --probe does not match the Rust contract: ${JSON.stringify(probe)}`);
  }

  const malformed = run(helperPath, ["--not-a-command"], { allowFailure: true });
  if (malformed.status === 0) fail("malformed helper requests must exit non-zero");
  const malformedPayload = parseLastJsonLine(malformed.stdout, "malformed helper request");
  if (malformedPayload.type !== "error" || malformedPayload.code !== "malformed_request") {
    fail(`malformed request did not return its typed error: ${JSON.stringify(malformedPayload)}`);
  }

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
  }),
);
