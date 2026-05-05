#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const bridgePath = path.join(repoRoot, "electron/ipc-bridge.ts");
const sidecarPath = path.join(repoRoot, "rust-sidecar/src/lib.rs");

function read(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function extractAllowedRendererCommands(source) {
  const match = source.match(/ALLOWED_RENDERER_COMMANDS\s*=\s*new Set<string>\(\[([\s\S]*?)\]\)/);
  if (!match) {
    throw new Error("Could not find ALLOWED_RENDERER_COMMANDS in electron/ipc-bridge.ts");
  }
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

function extractSidecarCommands(source) {
  return new Set([...source.matchAll(/^\s*"([^"]+)"\s*=>/gm)].map((entry) => entry[1]));
}

const electronLocalCommands = new Set([
  "__window_hide__",
  "__window_set_position__",
  "__window_set_size__",
  "__window_show__",
  "__window_start_drag__",
  "check_for_updates",
  "get_update_status",
  "install_update",
]);

const intentionallyPendingSidecarCommands = new Set([
  "__emit__",
]);

const bridge = read(bridgePath);
const sidecar = read(sidecarPath);
const allowed = extractAllowedRendererCommands(bridge);
const sidecarCommands = extractSidecarCommands(sidecar);

const missing = allowed.filter(
  (command) =>
    !electronLocalCommands.has(command) &&
    !intentionallyPendingSidecarCommands.has(command) &&
    !sidecarCommands.has(command),
);

const duplicates = allowed.filter((command, index) => allowed.indexOf(command) !== index);

if (missing.length > 0 || duplicates.length > 0) {
  if (missing.length > 0) {
    console.error("Renderer commands missing from sidecar dispatch:");
    for (const command of missing) {
      console.error(`- ${command}`);
    }
  }
  if (duplicates.length > 0) {
    console.error("Duplicate renderer command allowlist entries:");
    for (const command of [...new Set(duplicates)]) {
      console.error(`- ${command}`);
    }
  }
  process.exit(1);
}

console.log(
  `IPC contract validation passed: ${allowed.length} renderer commands checked, ${sidecarCommands.size} sidecar commands discovered.`,
);
