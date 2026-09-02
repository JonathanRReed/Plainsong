#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const bridgePath = path.join(repoRoot, "electron/ipc-bridge.ts");
const mainPath = path.join(repoRoot, "electron/main.ts");
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

/**
 * The commands `handleLocalCommand` answers in the Electron main process,
 * read out of main.ts itself.
 *
 * This used to be a hand-maintained literal, and it drifted in both directions
 * at once: it listed commands the switch no longer had, and the switch answered
 * `app:set_minimize_to_tray`, which was not on the renderer allowlist and so
 * could never be reached. Neither was visible to a gate that only compared
 * hand-written lists to each other.
 *
 * The switch is sliced from `switch (command) {` to its `default:` arm and read
 * at the arms' own indentation, so a nested switch inside a case body cannot
 * contribute labels — the same technique `extractDispatchedSidecarCommands`
 * uses on the Rust side.
 */
function extractElectronLocalCommands(source) {
  const start = source.indexOf("async function handleLocalCommand(");
  if (start === -1) {
    throw new Error("Could not find handleLocalCommand in electron/main.ts");
  }
  const switchStart = source.indexOf("  switch (command) {", start);
  if (switchStart === -1) {
    throw new Error("Could not find the `switch (command)` block in handleLocalCommand");
  }
  const end = source.indexOf("\n    default:", switchStart);
  if (end === -1) {
    throw new Error("Could not find the default arm of handleLocalCommand's switch");
  }
  const block = source.slice(switchStart, end);
  const commands = [...block.matchAll(/^ {4}case "([^"]+)":/gm)].map((entry) => entry[1]);
  if (commands.length === 0) {
    throw new Error("handleLocalCommand's switch produced no case labels");
  }
  return commands;
}

// Renderer commands the allowlist admits ahead of their sidecar implementation.
// Empty by design: an entry here is a command nothing can answer yet, so it is
// a deliberate, temporary exception and never a resting state.
const intentionallyPendingSidecarCommands = new Set([]);

// Sidecar RPCs the renderer is not expected to reach: they are called by the
// CLI/headless entry points or by the sidecar itself. Anything else the
// dispatcher answers but no renderer can call is dead weight — either add it
// to the bridge allowlist or delete the arm.
const intentionallyUnreachableSidecarCommands = new Set([
  "approve_backup_location_privileged",
  "approve_cloud_backup_location_privileged",
  "approve_export_location_privileged",
  // Takes a filesystem path, so only the Electron main process may call it —
  // and only with a path the user just chose in a native open dialog.
  "import_audio_file",
  "start_recording",
  "stop_recording",
]);

const bridge = read(bridgePath);
const main = read(mainPath);
const sidecar = read(sidecarPath);
const allowed = extractAllowedRendererCommands(bridge);
const localCommands = extractElectronLocalCommands(main);
const electronLocalCommands = new Set(localCommands);
const sidecarCommands = extractSidecarCommands(sidecar);

const missing = allowed.filter(
  (command) =>
    !electronLocalCommands.has(command) &&
    !intentionallyPendingSidecarCommands.has(command) &&
    !sidecarCommands.has(command),
);

const duplicates = allowed.filter((command, index) => allowed.indexOf(command) !== index);

// A local case the renderer allowlist does not admit is dead code: the bridge
// rejects the command before handleLocalCommand ever sees it. This is the
// direction the old hand-maintained list could not check at all.
const allowedSetForLocal = new Set(allowed);
const unreachableLocal = localCommands.filter(
  (command) => !allowedSetForLocal.has(command),
);

const duplicateLocal = localCommands.filter(
  (command, index) => localCommands.indexOf(command) !== index,
);

// The reverse direction: an RPC the sidecar answers that nothing can reach.
// Only the forward direction was checked before, so unreachable arms had to be
// found by hand.
const allowedSet = new Set(allowed);
const dispatched = extractDispatchedSidecarCommands(sidecar);
const unreachable = dispatched.filter(
  (command) =>
    !allowedSet.has(command) && !intentionallyUnreachableSidecarCommands.has(command),
);

if (
  missing.length > 0 ||
  duplicates.length > 0 ||
  unreachable.length > 0 ||
  unreachableLocal.length > 0 ||
  duplicateLocal.length > 0
) {
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
  if (unreachableLocal.length > 0) {
    console.error(
      "Electron local commands no renderer can reach (add to ALLOWED_RENDERER_COMMANDS or delete the case):",
    );
    for (const command of [...new Set(unreachableLocal)]) {
      console.error(`- ${command}`);
    }
  }
  if (duplicateLocal.length > 0) {
    console.error("Duplicate case labels in handleLocalCommand:");
    for (const command of [...new Set(duplicateLocal)]) {
      console.error(`- ${command}`);
    }
  }
  process.exit(1);
}

console.log(
  `IPC contract validation passed: ${allowed.length} renderer commands checked, ` +
    `${localCommands.length} Electron local commands derived from main.ts, ` +
    `${sidecarCommands.size} sidecar commands discovered, ` +
    `${dispatched.length} dispatched commands all reachable.`,
);
