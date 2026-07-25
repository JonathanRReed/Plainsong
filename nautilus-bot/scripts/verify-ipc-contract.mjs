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

/**
 * The arms of `dispatch_command`'s own `match method` block.
 *
 * `extractSidecarCommands` matches every match arm in lib.rs, which is fine
 * for "does this renderer command exist?" but useless in reverse: it would
 * report enum-parsing arms like "paste" or "zoom" as unreachable RPCs. The
 * reverse check needs the dispatcher's arms and nothing else, so the block is
 * sliced out by its signature and read at its own indentation.
 */
function extractDispatchedSidecarCommands(source) {
  const start = source.indexOf("pub async fn dispatch_command(");
  if (start === -1) {
    throw new Error("Could not find dispatch_command in rust-sidecar/src/lib.rs");
  }
  const matchStart = source.indexOf("    match method {", start);
  if (matchStart === -1) {
    throw new Error("Could not find the `match method` block in dispatch_command");
  }
  const end = source.indexOf('        _ => Err(format!("Unknown command: {}", method)),', matchStart);
  if (end === -1) {
    throw new Error("Could not find the fallback arm of dispatch_command's match");
  }
  const block = source.slice(matchStart, end);
  return [...block.matchAll(/^ {8}"([a-z0-9_:]+)"(?:\s*\|\s*"[a-z0-9_:]+")*\s*=>/gm)].map(
    (entry) => entry[1],
  );
}

const electronLocalCommands = new Set([
  "__overlay_placement__",
  "__overlay_set_display_mode__",
  "__window_hide__",
  "__window_set_ignore_mouse_events__",
  "__window_set_position__",
  "__window_set_size__",
  "__window_show__",
  "__window_start_drag__",
  "check_for_updates",
  "get_dictation_shortcut_capability_status",
  "get_shortcut_conflicts",
  "get_update_status",
  "install_update",
]);

const intentionallyPendingSidecarCommands = new Set([
  "__emit__",
]);

// Sidecar RPCs the renderer is not expected to reach: they are called by the
// CLI/headless entry points or by the sidecar itself. Anything else the
// dispatcher answers but no renderer can call is dead weight — either add it
// to the bridge allowlist or delete the arm.
const intentionallyUnreachableSidecarCommands = new Set([]);

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

// The reverse direction: an RPC the sidecar answers that nothing can reach.
// Only the forward direction was checked before, so unreachable arms had to be
// found by hand.
const allowedSet = new Set(allowed);
const dispatched = extractDispatchedSidecarCommands(sidecar);
const unreachable = dispatched.filter(
  (command) =>
    !allowedSet.has(command) && !intentionallyUnreachableSidecarCommands.has(command),
);

if (missing.length > 0 || duplicates.length > 0 || unreachable.length > 0) {
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
  if (unreachable.length > 0) {
    console.error(
      "Sidecar commands no renderer can reach (add to ALLOWED_RENDERER_COMMANDS or delete the arm):",
    );
    for (const command of [...new Set(unreachable)]) {
      console.error(`- ${command}`);
    }
  }
  process.exit(1);
}

console.log(
  `IPC contract validation passed: ${allowed.length} renderer commands checked, ` +
    `${sidecarCommands.size} sidecar commands discovered, ` +
    `${dispatched.length} dispatched commands all reachable.`,
);
