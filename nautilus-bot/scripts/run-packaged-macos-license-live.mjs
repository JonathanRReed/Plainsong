#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const forwardedArgs = process.argv.slice(2);

function run(label, script) {
  const result = spawnSync(process.execPath, [script, ...forwardedArgs], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`${label} failed to start: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run("live license capture", "scripts/capture-packaged-macos-license-activation.mjs");
run("live license verifier", "scripts/verify-packaged-macos-license-live.mjs");
