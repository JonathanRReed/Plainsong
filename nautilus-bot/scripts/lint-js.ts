// Runs Bun's built-in linter over the app sources.
//
// `bun lint` ships only in Bun canary builds so far. On a stable Bun it falls
// back to the package's "lint" script, which calls this one again, so check
// for the command first and fail with a clear message instead of recursing.
import { spawnSync } from "node:child_process";
import os from "node:os";

const bun = process.execPath;
// Probe outside the project so a stable Bun cannot fall back to a package script.
const probe = spawnSync(bun, ["lint", "--help"], { cwd: os.tmpdir(), encoding: "utf8", env: { ...process.env, PLAINSONG_LINT_PROBE: "1" } });
if (process.env.PLAINSONG_LINT_PROBE || !`${probe.stdout}${probe.stderr}`.includes("--no-script")) {
  console.error(`bun lint is not available in Bun ${process.versions.bun ?? "unknown"}. Install a canary build with \`bun upgrade --canary\`.`);
  process.exit(1);
}

const targets = ["src", "electron", "scripts", "vite.config.ts", "vitest.config.ts"];
const run = spawnSync(bun, ["lint", "--no-script", "--quiet", ...targets], { stdio: "inherit" });
process.exit(run.status ?? 1);
