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
  valueFor("--out", "artifacts/qa/macos/packaged-smoke.json")
);
const timeoutMs = Number(valueFor("--timeout-ms", "90000"));
const sidecarPath = path.join(
  appPath,
  "Contents",
  "Resources",
  "sidecar",
  "plainsong-sidecar"
);
const executablePath = path.join(appPath, "Contents", "MacOS", "Plainsong");
const appSha256 = fs.existsSync(executablePath)
  ? crypto.createHash("sha256").update(fs.readFileSync(executablePath)).digest("hex")
  : null;
const requestedProfileRoot = valueFor("--profile-root");
const ownsProfileRoot = !requestedProfileRoot;
const profileRoot = requestedProfileRoot
  ? path.resolve(requestedProfileRoot)
  : fs.mkdtempSync(path.join(os.tmpdir(), "plainsong-packaged-smoke-"));
const configRoot = path.join(profileRoot, "config");
const dataRoot = path.join(profileRoot, "data");
const sourceProfileDir = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Plainsong",
);

function cloneTree(source, destination) {
  const sourceStat = fs.lstatSync(source);
  if (sourceStat.isSymbolicLink()) {
    throw new Error(`Refusing to clone a symlinked smoke fixture: ${source}`);
  }
  if (sourceStat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true, mode: sourceStat.mode });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      cloneTree(path.join(source, entry.name), path.join(destination, entry.name));
    }
    return;
  }
  if (!sourceStat.isFile()) {
    throw new Error(`Unsupported smoke fixture entry: ${source}`);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_FICLONE);
}

function prepareIsolatedProfile() {
  const configDir = path.join(configRoot, "Plainsong");
  const dataDir = path.join(dataRoot, "Plainsong");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  const sourceSettings = path.join(sourceProfileDir, "settings.json");
  if (fs.existsSync(sourceSettings)) {
    cloneTree(sourceSettings, path.join(configDir, "settings.json"));
  }

  const sourceModels = path.join(sourceProfileDir, "models");
  if (fs.existsSync(sourceModels)) {
    cloneTree(sourceModels, path.join(dataDir, "models"));
  }
}

const commands = [
  { key: "permissions", method: "get_permission_diagnostics", params: {} },
  { key: "dictationSetup", method: "verify_dictation_setup", params: {} },
  { key: "meetingSetup", method: "verify_meeting_setup", params: {} },
  { key: "settings", method: "get_settings", params: {} },
];

// This is a component-level smoke test. It launches the sidecar binary from
// inside the packaged app, but it does not launch the Electron app itself.
// On macOS, TCC can attribute Accessibility access to the responsible parent
// process, so direct sidecar results must not be used as proof that the
// packaged app has its own user-granted Accessibility permission.

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (process.platform !== "darwin") {
  fail("capture-packaged-macos-smoke can only run on macOS.");
}

if (!fs.existsSync(sidecarPath)) {
  fail(`Packaged sidecar not found at ${sidecarPath}`);
}

try {
  prepareIsolatedProfile();
} catch (error) {
  if (ownsProfileRoot) {
    fs.rmSync(profileRoot, { recursive: true, force: true });
  }
  fail(`Could not prepare an isolated smoke profile: ${String(error)}`);
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

const stderr = [];
child.stderr.on("data", (chunk) => {
  stderr.push(String(chunk));
});

const rl = createInterface({ input: child.stdout });
const pending = new Map();
const results = {};
let nextId = 1;

function sendCommand(command) {
  const id = String(nextId++);
  pending.set(id, command);
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: command.method,
      params: command.params,
    })}\n`
  );
}

let didTimeOut = false;

const timeout = setTimeout(() => {
  didTimeOut = true;
  child.kill("SIGTERM");
}, timeoutMs);

rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (!message?.id || !pending.has(String(message.id))) {
    return;
  }

  const command = pending.get(String(message.id));
  pending.delete(String(message.id));

  if (message.error) {
    results[command.key] = {
      ok: false,
      error: message.error.message ?? String(message.error),
    };
  } else {
    results[command.key] = message.result;
  }

  if (pending.size === 0 && Object.keys(results).length === commands.length) {
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: String(nextId++),
        method: "shutdown",
        params: {},
      })}\n`
    );
  }
});

child.on("exit", (code) => {
  clearTimeout(timeout);

  let profileCleaned = !ownsProfileRoot;
  if (ownsProfileRoot) {
    try {
      fs.rmSync(profileRoot, { recursive: true, force: true });
      profileCleaned = !fs.existsSync(profileRoot);
    } catch {
      profileCleaned = false;
    }
  }

  const permissions = results.permissions ?? {};
  const dictationSetup = results.dictationSetup ?? {};
  const meetingSetup = results.meetingSetup ?? {};
  const componentPass = Boolean(
    code === 0 &&
      !didTimeOut &&
      permissions.microphoneReady &&
      permissions.accessibilityReady &&
      permissions.postEventReady &&
      permissions.cursorInsertionReady &&
      dictationSetup.ok &&
      meetingSetup.ok &&
      profileCleaned
  );

  const artifact = {
    generatedAt: new Date().toISOString(),
    scope: "bundled-sidecar-direct",
    evidenceLevel: "component",
    candidate: {
      executableSha256: appSha256,
      executableBytes: fs.existsSync(executablePath)
        ? fs.statSync(executablePath).size
        : null,
    },
    appPath,
    sidecarPath,
    pass: componentPass,
    componentPass,
    launchReady: false,
    launchReadyReason:
      "Direct sidecar diagnostics do not prove the packaged Electron app's user-granted TCC permissions or a real cursor insertion.",
    excludedClaims: [
      "packaged app Accessibility permission",
      "packaged app cursor insertion",
      "first-run permission flow",
      "launch readiness",
    ],
    timedOut: didTimeOut,
    pendingCommands: [...pending.values()].map((command) => command.method),
    checks: {
      microphoneReady: Boolean(permissions.microphoneReady),
      accessibilityReady: Boolean(permissions.accessibilityReady),
      postEventReady: Boolean(permissions.postEventReady),
      cursorInsertionReady: Boolean(permissions.cursorInsertionReady),
      dictationSetupOk: Boolean(dictationSetup.ok),
      meetingSetupOk: Boolean(meetingSetup.ok),
      exactExecutableIdentified: Boolean(appSha256),
      profileIsolated: true,
      profileCleaned,
      systemAudioAvailable: Boolean(meetingSetup.details?.some((detail) =>
        /system audio: available/i.test(String(detail))
      )),
    },
    results,
    stderr: stderr.join("").trim(),
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(artifact, null, 2));

  if (didTimeOut) {
    console.error("Timed out waiting for packaged sidecar smoke responses.");
  }

  process.exit(componentPass ? 0 : 1);
});

for (const command of commands) {
  sendCommand(command);
}
