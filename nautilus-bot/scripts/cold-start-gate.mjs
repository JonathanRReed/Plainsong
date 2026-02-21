#!/usr/bin/env node
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const thresholdIdx = args.indexOf("--threshold-ms");
const thresholdMs = thresholdIdx >= 0 ? Number(args[thresholdIdx + 1]) : 2500;
const sep = args.indexOf("--");
if (sep < 0 || sep === args.length - 1) {
  console.error("Usage: node scripts/cold-start-gate.mjs [--threshold-ms 2500] -- <command> [args...]");
  process.exit(1);
}

const cmd = args[sep + 1];
const cmdArgs = args.slice(sep + 2);

const started = Date.now();
const child = spawn(cmd, cmdArgs, { stdio: "pipe" });

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += String(chunk);
});

child.on("error", (err) => {
  console.error(`Failed to execute cold start command: ${err.message}`);
  process.exit(1);
});

child.on("close", (code) => {
  const elapsedMs = Date.now() - started;
  if (code !== 0) {
    console.error(`Cold start command exited with code ${code}`);
    if (stderr.trim()) {
      console.error(stderr.trim());
    }
    process.exit(code ?? 1);
  }

  if (elapsedMs >= thresholdMs) {
    console.error(`Cold-start gate failed: ${elapsedMs}ms >= ${thresholdMs}ms`);
    process.exit(1);
  }

  console.log(JSON.stringify({ ok: true, elapsedMs, thresholdMs }, null, 2));
});
