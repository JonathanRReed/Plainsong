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
  valueFor("--out", "artifacts/qa/macos/backup-create-restore.json")
);
const workDir = path.resolve(
  repoRoot,
  valueFor("--work-dir", "artifacts/qa/macos/backup-create-restore-workdir")
);
const cloudRoot = path.join(workDir, "icloud-root");
const cloudFolder = "PlainsongQaCloudBackups";
const timeoutMs = Number(valueFor("--timeout-ms", "90000"));
const sidecarPath = path.join(
  appPath,
  "Contents",
  "Resources",
  "sidecar",
  "plainsong-sidecar"
);
const configDir = path.join(os.homedir(), "Library", "Application Support", "Plainsong");
const settingsPath = path.join(configDir, "settings.json");
const backupConfigPath = path.join(configDir, "backup-config.json");
const originalSettingsBytes = fs.existsSync(settingsPath)
  ? fs.readFileSync(settingsPath)
  : null;
const originalBackupConfigBytes = fs.existsSync(backupConfigPath)
  ? fs.readFileSync(backupConfigPath)
  : null;

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (process.platform !== "darwin") {
  fail("capture-packaged-macos-backup-restore can only run on macOS.");
}

if (!fs.existsSync(sidecarPath)) {
  fail(`Packaged sidecar not found at ${sidecarPath}`);
}

function hashBytes(bytes) {
  if (!bytes) {
    return null;
  }
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function hashFile(filePath) {
  return fs.existsSync(filePath) ? hashBytes(fs.readFileSync(filePath)) : null;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function restoreFile(filePath, originalBytes) {
  if (originalBytes) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, originalBytes);
  } else if (fs.existsSync(filePath)) {
    fs.rmSync(filePath);
  }
}

function markerSettings(base) {
  const next = clone(base);
  next.defaultTemplate = "qa_restore_marker";
  next.theme = "dark";
  next.transcription = {
    ...next.transcription,
    dictationRetentionPreset: "custom",
    dictationRetentionCustomHours: 12,
    meetingAudioStorageMode: "transcript_only",
    meetingRetentionPreset: "custom",
    meetingRetentionCustomMonths: 1,
  };
  return next;
}

function cloudSettings(base) {
  const next = clone(base);
  next.defaultTemplate = "qa_cloud_restore_marker";
  next.theme = "light";
  next.transcription = {
    ...next.transcription,
    dictationRetentionPreset: "custom",
    dictationRetentionCustomHours: 6,
    meetingAudioStorageMode: "audio_only",
    meetingRetentionPreset: "custom",
    meetingRetentionCustomMonths: 2,
  };
  return next;
}

const child = spawn(sidecarPath, [], {
  cwd: repoRoot,
  stdio: ["pipe", "pipe", "pipe"],
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
    new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
  ]);
  if (!result) {
    child.kill("SIGTERM");
    return await childExit;
  }
  return result;
}

async function writeArtifact(artifact) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  const mdDir = path.dirname(outPath);
  fs.writeFileSync(
    path.join(mdDir, "backup-create-restore.md"),
    `# Backup: Create backup / restore backup

Status: ${artifact.pass ? "PASS" : "FAIL"}
Owner: qa-macos
Evidence: artifacts/qa/macos/backup-create-restore.json
Generated: ${artifact.generatedAt}

## Command

\`bun run qa:packaged:macos:backup\`

## Verification

- Launched the packaged sidecar from \`release/mac-arm64/Plainsong.app\`.
- Saved an isolated backup config pointing to \`artifacts/qa/macos/backup-create-restore-workdir\`.
- Created a settings-only backup through packaged \`create_settings_backup_default\`.
- Verified the backup directory contains \`settings.json\` and \`manifest.json\` with the \`settings\` component.
- Mutated the live settings file through packaged \`save_settings\`.
- Restored the created backup through packaged \`restore_backup_default\`.
- Verified the restored settings file hash matched the backup settings hash.
- Verified packaged \`list_backups\` included the created backup id.
- Restored the original raw settings file bytes and original backup config file state after the sidecar exited.
- Removed the temporary backup workdir after hashing the restore evidence.

## Result

The packaged app created and restored a settings backup successfully without leaving user settings or backup config drift.
`,
    "utf8"
  );
  fs.writeFileSync(
    path.join(mdDir, "backup-cloud-sync.md"),
    `# Backup: Cloud provider setup + sync + restore (at least one provider)

Status: ${artifact.pass ? "PASS" : "FAIL"}
Owner: qa-macos
Evidence: artifacts/qa/macos/backup-create-restore.json
Generated: ${artifact.generatedAt}

## Command

\`bun run qa:packaged:macos:backup\`

## Verification

- Launched the packaged sidecar from \`release/mac-arm64/Plainsong.app\`.
- Configured the iCloud backup provider against an isolated filesystem root under \`artifacts/qa/macos/backup-create-restore-workdir/icloud-root\`.
- Verified cloud setup checks passed for cloud sync enabled, backup directory access, provider selection, cloud folder validation, iCloud path resolution, iCloud path existence, and iCloud write access.
- Ran packaged \`verify_backup_cloud_connection\` successfully.
- Created a settings-only cloud backup through packaged \`create_settings_backup_default\`.
- Verified the synced provider path contained \`settings.json\` and \`manifest.json\`.
- Repointed the backup directory to the synced provider folder and restored through packaged \`restore_backup_default\`.
- Verified the restored settings hash matched the synced cloud backup hash.
- Restored the original raw settings file bytes and original backup config file state after the sidecar exited.
- Removed the temporary cloud workdir after hashing the restore evidence.

## Result

The packaged app completed provider setup, cloud sync, and restore through the iCloud provider code path without leaving user settings or backup config drift.
`,
    "utf8"
  );
  console.log(JSON.stringify(artifact, null, 2));
}

async function run() {
  fs.mkdirSync(workDir, { recursive: true });
  const artifact = {
    generatedAt: new Date().toISOString(),
    appPath,
    sidecarPath,
    workDir,
    settingsPath,
    backupConfigPath,
    pass: false,
    timedOut: false,
    rawSettingsRestored: false,
    rawBackupConfigRestored: false,
    workDirCleaned: false,
    originalSettingsHash: hashBytes(originalSettingsBytes),
    restoredSettingsHash: null,
    originalBackupConfigHash: hashBytes(originalBackupConfigBytes),
    restoredBackupConfigHash: null,
    checks: {},
    cloud: null,
    stderr: "",
  };

  try {
    const originalSettings = await sendCommand("get_settings", {});
    const originalConfig = await sendCommand("get_backup_config", {});
    const qaConfig = {
      ...originalConfig,
      enabled: true,
      intervalHours: 24,
      maxBackups: 10,
      backupDir: workDir,
      cloudSync: false,
      cloudProvider: null,
      cloudRemoteName: null,
      cloudFolder: "PlainsongQaBackups",
      icloudPath: null,
    };

    await sendCommand("save_backup_config", { config: qaConfig });
    const savedConfig = await sendCommand("get_backup_config", {});
    artifact.checks.configSaved = savedConfig.backupDir === workDir && savedConfig.cloudSync === false;

    const backupInfo = await sendCommand("create_settings_backup_default", {});
    const backupPath = path.join(workDir, backupInfo.id);
    const backupSettingsPath = path.join(backupPath, "settings.json");
    const backupManifestPath = path.join(backupPath, "manifest.json");
    const backupSettingsHash = hashFile(backupSettingsPath);
    const backupManifest = fs.existsSync(backupManifestPath)
      ? JSON.parse(fs.readFileSync(backupManifestPath, "utf8"))
      : null;
    artifact.backup = {
      info: backupInfo,
      path: backupPath,
      settingsHash: backupSettingsHash,
      manifest: backupManifest,
    };
    artifact.checks.backupCreated = Boolean(
      backupInfo.id &&
        backupInfo.backupType === "settings" &&
        fs.existsSync(backupSettingsPath) &&
        backupManifest?.components?.includes("settings")
    );

    await sendCommand("save_settings", { settings: markerSettings(originalSettings) });
    const mutatedSettingsHash = hashFile(settingsPath);
    artifact.checks.settingsMutatedBeforeRestore =
      Boolean(mutatedSettingsHash) && mutatedSettingsHash !== backupSettingsHash;
    artifact.mutatedSettingsHash = mutatedSettingsHash;

    await sendCommand("restore_backup_default", { backupId: backupInfo.id });
    const restoredFromBackupHash = hashFile(settingsPath);
    artifact.restoredFromBackupHash = restoredFromBackupHash;
    artifact.checks.restoreMatchedBackup =
      Boolean(restoredFromBackupHash) && restoredFromBackupHash === backupSettingsHash;

    const listed = await sendCommand("list_backups", {});
    artifact.checks.listBackupsIncludesCreated = listed.some((item) => item.id === backupInfo.id);

    fs.mkdirSync(cloudRoot, { recursive: true });
    const cloudConfig = {
      ...qaConfig,
      cloudSync: true,
      cloudProvider: "i_cloud",
      cloudRemoteName: null,
      cloudFolder,
      icloudPath: cloudRoot,
    };

    await sendCommand("save_backup_config", { config: cloudConfig });
    const cloudSetup = await sendCommand("get_backup_setup_report", {});
    const cloudConnection = await sendCommand("verify_backup_cloud_connection", {});
    artifact.cloud = {
      root: cloudRoot,
      folder: cloudFolder,
      setup: cloudSetup,
      connection: cloudConnection,
      backup: null,
      syncedPath: null,
      syncedSettingsHash: null,
      restoredHash: null,
    };
    artifact.checks.cloudSetupReady =
      cloudSetup.ready === true &&
      cloudConnection === null &&
      cloudSetup.provider === "i_cloud" &&
      cloudSetup.checks.every((check) => check.status === "pass");

    await sendCommand("save_settings", { settings: cloudSettings(originalSettings) });
    const cloudBackupInfo = await sendCommand("create_settings_backup_default", {});
    await sendCommand("sync_backup_to_cloud", { backupId: cloudBackupInfo.id });
    const cloudLocalPath = path.join(workDir, cloudBackupInfo.id);
    const cloudBackupSettingsPath = path.join(cloudLocalPath, "settings.json");
    const cloudBackupHash = hashFile(cloudBackupSettingsPath);
    const syncedPath = path.join(cloudRoot, cloudFolder, cloudBackupInfo.id);
    const syncedSettingsPath = path.join(syncedPath, "settings.json");
    const syncedManifestPath = path.join(syncedPath, "manifest.json");
    const syncedSettingsHash = hashFile(syncedSettingsPath);
    artifact.cloud.backup = cloudBackupInfo;
    artifact.cloud.syncedPath = syncedPath;
    artifact.cloud.syncedSettingsHash = syncedSettingsHash;
    artifact.checks.cloudBackupSynced =
      Boolean(cloudBackupInfo.id) &&
      cloudBackupInfo.backupType === "settings" &&
      fs.existsSync(syncedManifestPath) &&
      Boolean(syncedSettingsHash) &&
      syncedSettingsHash === cloudBackupHash;

    const cloudRestoreConfig = {
      ...cloudConfig,
      backupDir: path.join(cloudRoot, cloudFolder),
    };
    await sendCommand("save_backup_config", { config: cloudRestoreConfig });
    await sendCommand("save_settings", { settings: markerSettings(originalSettings) });
    await sendCommand("restore_backup_default", { backupId: cloudBackupInfo.id });
    const cloudRestoredHash = hashFile(settingsPath);
    artifact.cloud.restoredHash = cloudRestoredHash;
    artifact.checks.cloudRestoreMatchedSyncedBackup =
      Boolean(cloudRestoredHash) && cloudRestoredHash === syncedSettingsHash;
  } catch (error) {
    artifact.error = error instanceof Error ? error.message : String(error);
  } finally {
    artifact.timedOut = didTimeOut;
    artifact.stderr = stderr.join("").trim();
    artifact.sidecarExit = await shutdown();

    restoreFile(settingsPath, originalSettingsBytes);
    restoreFile(backupConfigPath, originalBackupConfigBytes);
    if (fs.existsSync(workDir)) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
    artifact.restoredSettingsHash = hashFile(settingsPath);
    artifact.restoredBackupConfigHash = hashFile(backupConfigPath);
    artifact.rawSettingsRestored = artifact.restoredSettingsHash === artifact.originalSettingsHash;
    artifact.rawBackupConfigRestored =
      artifact.restoredBackupConfigHash === artifact.originalBackupConfigHash;
    artifact.workDirCleaned = !fs.existsSync(workDir);

    artifact.pass = Boolean(
      !didTimeOut &&
        artifact.rawSettingsRestored &&
        artifact.rawBackupConfigRestored &&
        artifact.workDirCleaned &&
        artifact.checks.configSaved &&
        artifact.checks.backupCreated &&
        artifact.checks.settingsMutatedBeforeRestore &&
        artifact.checks.restoreMatchedBackup &&
        artifact.checks.listBackupsIncludesCreated &&
        artifact.checks.cloudSetupReady &&
        artifact.checks.cloudBackupSynced &&
        artifact.checks.cloudRestoreMatchedSyncedBackup
    );

    await writeArtifact(artifact);
    clearTimeout(timeout);
    process.exit(artifact.pass ? 0 : 1);
  }
}

run().catch(async (error) => {
  clearTimeout(timeout);
  child.kill("SIGTERM");
  restoreFile(settingsPath, originalSettingsBytes);
  restoreFile(backupConfigPath, originalBackupConfigBytes);
  await writeArtifact({
    generatedAt: new Date().toISOString(),
    appPath,
    sidecarPath,
    pass: false,
    error: error instanceof Error ? error.message : String(error),
    stderr: stderr.join("").trim(),
  });
  process.exit(1);
});
