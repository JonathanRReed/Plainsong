#!/usr/bin/env node
import fs from "node:fs";
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
  valueFor("--app", "release/mac-arm64/Nautilus.app")
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
  "nautilus-sidecar"
);

const commands = [
  { key: "permissions", method: "get_permission_diagnostics", params: {} },
  { key: "dictationSetup", method: "verify_dictation_setup", params: {} },
  { key: "meetingSetup", method: "verify_meeting_setup", params: {} },
  { key: "settings", method: "get_settings", params: {} },
];

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

const child = spawn(sidecarPath, [], {
  cwd: repoRoot,
  stdio: ["pipe", "pipe", "pipe"],
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

  const permissions = results.permissions ?? {};
  const dictationSetup = results.dictationSetup ?? {};
  const meetingSetup = results.meetingSetup ?? {};
  const pass = Boolean(
    code === 0 &&
      !didTimeOut &&
      permissions.microphoneReady &&
      permissions.accessibilityReady &&
      permissions.postEventReady &&
      permissions.cursorInsertionReady &&
      dictationSetup.ok &&
      meetingSetup.ok
  );

  const artifact = {
    generatedAt: new Date().toISOString(),
    appPath,
    sidecarPath,
    pass,
    timedOut: didTimeOut,
    pendingCommands: [...pending.values()].map((command) => command.method),
    checks: {
      microphoneReady: Boolean(permissions.microphoneReady),
      accessibilityReady: Boolean(permissions.accessibilityReady),
      postEventReady: Boolean(permissions.postEventReady),
      cursorInsertionReady: Boolean(permissions.cursorInsertionReady),
      dictationSetupOk: Boolean(dictationSetup.ok),
      meetingSetupOk: Boolean(meetingSetup.ok),
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

  process.exit(pass ? 0 : 1);
});

for (const command of commands) {
  sendCommand(command);
}
