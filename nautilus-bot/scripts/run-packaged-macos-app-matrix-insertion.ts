#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const forwardedArgs = process.argv.slice(2);

function run(label: string, script: string): void {
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

run("app matrix insertion capture", "scripts/capture-packaged-macos-app-matrix-insertion.ts");
run("app matrix insertion verifier", "scripts/verify-packaged-macos-app-matrix-insertion.ts");
