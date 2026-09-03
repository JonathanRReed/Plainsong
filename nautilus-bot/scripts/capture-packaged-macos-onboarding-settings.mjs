#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);

function valueFor(name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) return fallback;
  return args[index + 1];
}

const appPath = path.resolve(
  repoRoot,
  valueFor("--app", "release/mac-arm64/Plainsong.app")
);
const outPath = path.resolve(
  repoRoot,
  valueFor("--out", "artifacts/qa/macos/onboarding-settings.json")
);
const timeoutMs = Number(valueFor("--timeout-ms", "90000"));
const requestedProfileRoot = valueFor("--profile-root");
const ownedProfileRoot =
  !requestedProfileRoot && !process.env.PLAINSONG_CONFIG_DIR
    ? fs.mkdtempSync(path.join(os.tmpdir(), "plainsong-onboarding-"))
    : null;
const profileRoot = requestedProfileRoot
  ? path.resolve(requestedProfileRoot)
  : ownedProfileRoot ?? path.dirname(path.resolve(process.env.PLAINSONG_CONFIG_DIR));
const sidecarPath = path.join(
  appPath,
  "Contents",
  "Resources",
  "sidecar",
  "plainsong-sidecar"
);
const configRoot = process.env.PLAINSONG_CONFIG_DIR
  ? path.resolve(process.env.PLAINSONG_CONFIG_DIR)
  : path.join(profileRoot, "config");
const dataRoot = process.env.PLAINSONG_DATA_DIR
  ? path.resolve(process.env.PLAINSONG_DATA_DIR)
  : path.join(profileRoot, "data");
const settingsPath = path.join(
  configRoot,
  "Plainsong",
  "settings.json"
);
const originalSettingsBytes = fs.existsSync(settingsPath)
  ? fs.readFileSync(settingsPath)
  : null;

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (process.platform !== "darwin") {
  fail("capture-packaged-macos-onboarding-settings can only run on macOS.");
}

if (!fs.existsSync(sidecarPath)) {
  fail(`Packaged sidecar not found at ${sidecarPath}`);
}

function stableJson(value) {
  // A settings key the sidecar no longer emits reads back as undefined, and
  // Object.keys(undefined) throws — which turned "one check failed" into "the
  // whole run crashed" and hid stale expectations here for eleven days. A
  // missing key has to fail its own check and let the rest report.
  if (value === null || value === undefined) {
    return JSON.stringify(value ?? null);
  }
  if (typeof value !== "object") {
    return JSON.stringify(value);
  }
  return JSON.stringify(value, Object.keys(value).sort());
}

function hashSettings(settings) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(settings))
    .digest("hex");
}

function hashBytes(bytes) {
  if (!bytes) {
    return null;
  }
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildNormalProfile(base) {
  const next = clone(base);
  next.theme = "dark";
  next.defaultTemplate = "meeting";
  next.audio = {
    ...next.audio,
    captureMicrophone: true,
    captureSystemAudio: true,
    noiseSuppression: true,
    voiceActivityDetection: true,
    silenceTimeoutSeconds: 300,
    autoGainControl: true,
    manualGainDb: 0,
  };
  next.transcription = {
    ...next.transcription,
    defaultProvider: "distil_whisper",
    selectedModelId: "distil-large-v3.5",
    useSharedAsrSelection: true,
    dictationProvider: "distil_whisper",
    dictationModelId: "distil-large-v3.5",
    meetingProvider: "distil_whisper",
    meetingModelId: "distil-large-v3.5",
    providerModelIds: {
      ...(next.transcription?.providerModelIds ?? {}),
      distil_whisper: "distil-large-v3.5",
    },
    autoTranscribe: true,
    enableDiarization: true,
    intelligentPunctuation: true,
    dictationProfile: "normal_speed",
    dictationModePreset: "voice",
    dictationContextSource: "none",
    dictationInsertionMode: "paste",
    dictationRoutePreference: "local",
    dictationPushToTalk: false,
    dictationHandsFreeEnabled: false,
    dictationLivePreviewEnabled: true,
    dictationCopyToClipboard: true,
    dictationSaveToInbox: true,
    dictationAiFormatting: false,
    dictationCommandModeEnabled: true,
    dictationCommandPrefix: "command",
    dictationRetentionPreset: "never",
    meetingAudioStorageMode: "always",
    meetingRetentionPreset: "never",
    meetingRetentionDeleteMode: "audio_only",
    dictationSilenceTimeoutSeconds: 0,
  };
  next.privacy = {
    ...next.privacy,
    remoteProcessingEnabled: false,
    cloudSync: false,
    auditLogging: true,
  };
  next.shortcuts = {
    ...next.shortcuts,
    toggleDictation: "Cmd+Shift+Space",
  };
  return next;
}

function buildPowerProfile(base) {
  const next = clone(base);
  next.theme = "dark";
  next.defaultTemplate = "research";
  next.audio = {
    ...next.audio,
    captureMicrophone: true,
    captureSystemAudio: true,
    noiseSuppression: true,
    voiceActivityDetection: true,
    silenceTimeoutSeconds: 600,
    autoGainControl: true,
  };
  next.transcription = {
    ...next.transcription,
    defaultProvider: "parakeet",
    selectedModelId: "parakeet-tdt-0.6b-v3",
    useSharedAsrSelection: false,
    dictationProvider: "parakeet",
    dictationModelId: "parakeet-tdt-0.6b-v3",
    meetingProvider: "distil_whisper",
    meetingModelId: "distil-large-v3.5",
    providerModelIds: {
      ...(next.transcription?.providerModelIds ?? {}),
      parakeet: "parakeet-tdt-0.6b-v3",
      distil_whisper: "distil-large-v3.5",
    },
    autoTranscribe: true,
    enableDiarization: true,
    intelligentPunctuation: true,
    silenceSkipEnabled: true,
    dictationMlxEnabled: false,
    meetingMlxEnabled: false,
    dictationProfile: "power_rewrite",
    dictationModePreset: "meeting_follow_up",
    dictationContextSource: "selected_text",
    dictationInsertionMode: "auto",
    dictationRoutePreference: "local",
    dictationRouteOverrideEnabled: true,
    dictationKeepWarm: "on",
    dictationPushToTalk: false,
    dictationHandsFreeEnabled: true,
    dictationLivePreviewEnabled: true,
    dictationCopyToClipboard: true,
    dictationSaveToInbox: true,
    dictationAiFormatting: true,
    dictationCommandModeEnabled: true,
    dictationCommandPrefix: "command",
    dictationSnippetsEnabled: true,
    dictationAutoLearnCorrections: true,
    dictationRetentionPreset: "custom",
    dictationRetentionCustomHours: 72,
    meetingAudioStorageMode: "transcript_only",
    meetingRetentionPreset: "custom",
    meetingRetentionCustomMonths: 2,
    meetingRetentionDeleteMode: "audio_only",
    dictationSilenceTimeoutSeconds: 1.8,
    enableAutoAnalysis: true,
    platformOptimization: {
      mode: "auto",
      fallbackPolicy: "local_only",
      macos: {
        appleNativeEnabled: false,
        mlxEnabled: true,
      },
      windows: {
        foundryEnabled: false,
        windowsSdkDictationEnabled: false,
      },
      manualEnginePriority: [],
    },
  };
  next.privacy = {
    ...next.privacy,
    remoteProcessingEnabled: false,
    cloudSync: false,
    auditLogging: true,
  };
  return next;
}

function pick(settings, paths) {
  const selected = {};
  for (const keyPath of paths) {
    const parts = keyPath.split(".");
    let cursor = settings;
    for (const part of parts) {
      cursor = cursor?.[part];
    }
    selected[keyPath] = cursor;
  }
  return selected;
}

const normalChecks = {
  "theme": "dark",
  "transcription.defaultProvider": "distil_whisper",
  "transcription.selectedModelId": "distil-large-v3.5",
  "transcription.useSharedAsrSelection": true,
  "transcription.dictationProfile": "normal_speed",
  "transcription.dictationModePreset": "voice",
  "transcription.dictationInsertionMode": "auto",
  "transcription.dictationRetentionPreset": "never",
  "transcription.meetingAudioStorageMode": "always",
  "transcription.meetingRetentionPreset": "never",
  "privacy.remoteProcessingEnabled": false,
};

const powerChecks = {
  "theme": "dark",
  "transcription.defaultProvider": "parakeet",
  "transcription.selectedModelId": "parakeet-tdt-0.6b-v3",
  "transcription.useSharedAsrSelection": false,
  "transcription.dictationProvider": "parakeet",
  "transcription.dictationModelId": "parakeet-tdt-0.6b-v3",
  "transcription.meetingProvider": "distil_whisper",
  "transcription.dictationProfile": "power_rewrite",
  "transcription.dictationModePreset": "meeting_follow_up",
  "transcription.dictationContextSource": "selected_text",
  "transcription.dictationInsertionMode": "auto",
  "transcription.dictationKeepWarm": "on",
  "transcription.dictationHandsFreeEnabled": true,
  "transcription.dictationAiFormatting": true,
  "transcription.dictationRetentionPreset": "custom",
  "transcription.dictationRetentionCustomHours": 72,
  "transcription.meetingAudioStorageMode": "transcript_only",
  "transcription.meetingRetentionPreset": "custom",
  "transcription.meetingRetentionCustomMonths": 2,
  "transcription.meetingRetentionDeleteMode": "audio_only",
  "privacy.remoteProcessingEnabled": false,
};

function evaluateChecks(settings, expected) {
  return Object.entries(expected).map(([keyPath, expectedValue]) => {
    const actualValue = pick(settings, [keyPath])[keyPath];
    return {
      keyPath,
      expected: expectedValue,
      actual: actualValue,
      pass: stableJson(actualValue) === stableJson(expectedValue),
    };
  });
}

const child = spawn(sidecarPath, [], {
  cwd: repoRoot,
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    PLAINSONG_CONFIG_DIR: configRoot,
    PLAINSONG_DATA_DIR: dataRoot,
  },
});

const childExit = new Promise((resolve) => {
  child.on("exit", (code, signal) => {
    resolve({ code, signal });
  });
});

const stderr = [];
child.stderr.on("data", (chunk) => {
  stderr.push(String(chunk));
});

const rl = createInterface({ input: child.stdout });
const pending = new Map();
let nextId = 1;
let didTimeOut = false;

function sendCommand(method, params = {}) {
  const id = String(nextId++);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method });
  });
}

rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  const pendingCommand = pending.get(String(message.id));
  if (!pendingCommand) {
    return;
  }
  pending.delete(String(message.id));

  if (message.error) {
    pendingCommand.reject(new Error(message.error.message ?? String(message.error)));
  } else {
    pendingCommand.resolve(message.result);
  }
});

const timeout = setTimeout(() => {
  didTimeOut = true;
  child.kill("SIGTERM");
  for (const { reject, method } of pending.values()) {
    reject(new Error(`Timed out waiting for ${method}`));
  }
  pending.clear();
}, timeoutMs);

async function shutdown() {
  if (child.stdin.writable) {
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: String(nextId++),
        method: "shutdown",
        params: {},
      })}\n`
    );
  }

  const result = await Promise.race([
    childExit,
    new Promise((resolve) => setTimeout(() => resolve(null), 15000)),
  ]);
  if (!result) {
    child.kill("SIGTERM");
    return await childExit;
  }
  return result;
}

function restoreRawSettings(artifact) {
  if (originalSettingsBytes) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, originalSettingsBytes);
  } else if (fs.existsSync(settingsPath)) {
    fs.rmSync(settingsPath);
  }

  const restoredBytes = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath) : null;
  artifact.restoredRawSettingsHash = hashBytes(restoredBytes);
  artifact.rawRestored = artifact.restoredRawSettingsHash === artifact.originalRawSettingsHash;
}

async function writeArtifact(artifact) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(artifact, null, 2));
}

async function run() {
  const artifact = {
    generatedAt: new Date().toISOString(),
    appPath,
    sidecarPath,
    scope: "isolated-packaged-sidecar-settings",
    evidenceLevel: "component",
    isolatedProfile: Boolean(profileRoot),
    launchReady: false,
    launchReadyReason:
      "This isolated sidecar receipt proves settings persistence only. The clean-install renderer and macOS permission journey require a separate exact-app walkthrough.",
    pass: false,
    timedOut: false,
    restored: false,
    rawRestored: false,
    settingsPath,
    originalRawSettingsHash: hashBytes(originalSettingsBytes),
    restoredRawSettingsHash: null,
    originalSettingsHash: null,
    restoredSettingsHash: null,
    profiles: {},
    stderr: "",
  };

  let originalSettings = null;
  try {
    originalSettings = await sendCommand("get_settings", {});
    artifact.originalSettingsHash = hashSettings(originalSettings);

    const normalSettings = buildNormalProfile(originalSettings);
    await sendCommand("save_settings", { settings: normalSettings });
    const persistedNormal = await sendCommand("get_settings", {});
    const normalResult = {
      profile: "normal",
      settingsHash: hashSettings(persistedNormal),
      checks: evaluateChecks(persistedNormal, normalChecks),
    };
    normalResult.pass = normalResult.checks.every((check) => check.pass);
    normalResult.observed = pick(persistedNormal, Object.keys(normalChecks));
    artifact.profiles.normal = normalResult;

    const powerSettings = buildPowerProfile(originalSettings);
    await sendCommand("save_settings", { settings: powerSettings });
    const persistedPower = await sendCommand("get_settings", {});
    const powerResult = {
      profile: "power",
      settingsHash: hashSettings(persistedPower),
      checks: evaluateChecks(persistedPower, powerChecks),
    };
    powerResult.pass = powerResult.checks.every((check) => check.pass);
    powerResult.observed = pick(persistedPower, Object.keys(powerChecks));
    artifact.profiles.power = powerResult;
  } catch (error) {
    artifact.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (originalSettings) {
      try {
        await sendCommand("save_settings", { settings: originalSettings });
        const restoredSettings = await sendCommand("get_settings", {});
        artifact.restoredSettingsHash = hashSettings(restoredSettings);
        artifact.restored = artifact.restoredSettingsHash === artifact.originalSettingsHash;
      } catch (error) {
        artifact.restoreError = error instanceof Error ? error.message : String(error);
      }
    }

    artifact.timedOut = didTimeOut;
    artifact.stderr = stderr.join("").trim();
    const childResult = await shutdown();
    artifact.sidecarExit = childResult;
    restoreRawSettings(artifact);
    artifact.pass = Boolean(
      !didTimeOut &&
        artifact.rawRestored &&
        artifact.profiles.normal?.pass &&
        artifact.profiles.power?.pass
    );

    await writeArtifact(artifact);
    if (ownedProfileRoot) {
      fs.rmSync(ownedProfileRoot, { recursive: true, force: true });
    }
    clearTimeout(timeout);
    process.exit(artifact.pass ? 0 : 1);
  }
}

run().catch(async (error) => {
  clearTimeout(timeout);
  child.kill("SIGTERM");
  await writeArtifact({
    generatedAt: new Date().toISOString(),
    appPath,
    sidecarPath,
    pass: false,
    error: error instanceof Error ? error.message : String(error),
    stderr: stderr.join("").trim(),
  });
  if (ownedProfileRoot) {
    fs.rmSync(ownedProfileRoot, { recursive: true, force: true });
  }
  process.exit(1);
});
