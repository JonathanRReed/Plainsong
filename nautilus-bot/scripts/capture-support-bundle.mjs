#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);

function valueFor(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 && index < args.length - 1 ? args[index + 1] : fallback;
}

const settingsPath = valueFor("--settings");
const diagnosticsPath = valueFor("--diagnostics");
const inventoryRoot = valueFor("--inventory-root");
const outPath = path.resolve(
  repoRoot,
  valueFor("--out", "artifacts/qa/macos/support-bundle.json"),
);
const errors = [];

function readRequestedJson(filePath, label) {
  if (!filePath) return null;
  if (!fs.existsSync(filePath)) {
    errors.push(`${label} source is missing.`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    errors.push(
      `${label} source is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function safeIdentifier(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^[0-9A-Za-z._-]{1,80}$/.test(trimmed)) return "redacted";
  return trimmed;
}

function booleanOrNull(value) {
  return typeof value === "boolean" ? value : null;
}

function integerOrNull(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function buildSafeSettings(settings) {
  if (!settings) return null;
  return {
    theme: safeIdentifier(settings.theme),
    transcription: {
      dictationProvider: safeIdentifier(settings.transcription?.dictationProvider),
      dictationModelId: safeIdentifier(settings.transcription?.dictationModelId),
      meetingProvider: safeIdentifier(settings.transcription?.meetingProvider),
      meetingModelId: safeIdentifier(settings.transcription?.meetingModelId),
      useSharedAsrSelection: booleanOrNull(
        settings.transcription?.useSharedAsrSelection,
      ),
      dictationProfile: safeIdentifier(settings.transcription?.dictationProfile),
      dictationRoutePreference: safeIdentifier(
        settings.transcription?.dictationRoutePreference,
      ),
      meetingAudioStorageMode: safeIdentifier(
        settings.transcription?.meetingAudioStorageMode,
      ),
      meetingRetentionPreset: safeIdentifier(
        settings.transcription?.meetingRetentionPreset,
      ),
    },
    privacy: {
      remoteProcessingEnabled: booleanOrNull(
        settings.privacy?.remoteProcessingEnabled,
      ),
      cloudSync: booleanOrNull(settings.privacy?.cloudSync),
    },
    updates: {
      channel: safeIdentifier(settings.updates?.channel),
      autoCheck: booleanOrNull(settings.updates?.autoCheck),
    },
  };
}

function buildSafeReadiness(diagnostics) {
  if (!diagnostics) return null;
  const keys = [
    "microphoneReady",
    "microphonePermissionReady",
    "speechRecognitionReady",
    "accessibilityReady",
    "postEventReady",
    "cursorInsertionReady",
    "runningFromDiskImage",
  ];
  return Object.fromEntries(
    keys.map((key) => [key, booleanOrNull(diagnostics[key])]),
  );
}

function emptyInventory() {
  return {
    totalFiles: 0,
    totalBytes: 0,
    audioFiles: 0,
    textLikeFiles: 0,
    databaseFiles: 0,
    otherFiles: 0,
    scanTruncated: false,
  };
}

function inventory(rootPath) {
  const result = emptyInventory();
  if (!rootPath) return result;
  if (!fs.existsSync(rootPath)) {
    errors.push("Inventory root is missing.");
    return result;
  }
  const pending = [rootPath];
  const maxEntries = 50_000;
  while (pending.length > 0) {
    const current = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      errors.push("Inventory root contains an unreadable directory.");
      continue;
    }
    for (const entry of entries) {
      if (result.totalFiles >= maxEntries) {
        result.scanTruncated = true;
        return result;
      }
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      let bytes = 0;
      try {
        bytes = fs.statSync(entryPath).size;
      } catch {
        errors.push("Inventory root contains an unreadable file.");
      }
      result.totalFiles += 1;
      result.totalBytes += bytes;
      const extension = path.extname(entry.name).toLowerCase();
      if ([".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg"].includes(extension)) {
        result.audioFiles += 1;
      } else if ([".txt", ".md", ".rtf", ".json", ".csv"].includes(extension)) {
        result.textLikeFiles += 1;
      } else if ([".db", ".sqlite", ".sqlite3", ".wal", ".shm"].includes(extension)) {
        result.databaseFiles += 1;
      } else {
        result.otherFiles += 1;
      }
    }
  }
  return result;
}

const settings = readRequestedJson(settingsPath, "Settings");
const diagnostics = readRequestedJson(diagnosticsPath, "Diagnostics");
const packageJson = readRequestedJson(path.join(repoRoot, "package.json"), "Package");

const bundle = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  safeToShare: false,
  app: {
    name: "Plainsong",
    version: safeIdentifier(packageJson?.version),
  },
  system: {
    platform: safeIdentifier(process.platform),
    release: safeIdentifier(os.release()),
    arch: safeIdentifier(process.arch),
    logicalCpus: integerOrNull(os.cpus()?.length),
    memoryGiB: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
  },
  settings: buildSafeSettings(settings),
  readiness: buildSafeReadiness(diagnostics),
  inventory: inventory(inventoryRoot),
  excludedByDesign: [
    "audio bytes and filenames",
    "dictated text and transcripts",
    "meeting titles, notes, summaries, and action items",
    "custom prompts, dictionary entries, and snippets",
    "API keys, tokens, cookies, and keychain contents",
    "clipboard and selected text",
    "log message bodies",
    "full filesystem paths, account names, and hostnames",
  ],
  errors,
};

const serializedBeforeDecision = JSON.stringify(bundle);
const unsafePathPattern =
  /(?:\/Users\/[^/\s"]+|\/home\/[^/\s"]+|[A-Za-z]:\\Users\\[^\\\s"]+)/;
if (unsafePathPattern.test(serializedBeforeDecision)) {
  errors.push("Generated bundle contained a full user path and was blocked.");
}
bundle.safeToShare = errors.length === 0;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
console.log(JSON.stringify(bundle, null, 2));
process.exit(bundle.safeToShare ? 0 : 1);
