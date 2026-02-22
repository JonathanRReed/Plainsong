#!/usr/bin/env node
import { spawn } from "node:child_process";

const args = process.argv.slice(2);

function valueFor(name, fallback = null) {
  const idx = args.indexOf(name);
  if (idx < 0 || idx === args.length - 1) return fallback;
  return args[idx + 1];
}

const thresholdMs = Number(valueFor("--threshold-ms", "2500"));
const pollIntervalMs = Number(valueFor("--poll-interval-ms", "120"));
const readyCommand = valueFor("--ready-command");
const sep = args.indexOf("--");

if (sep < 0 || sep === args.length - 1) {
  console.error("Usage: node scripts/cold-start-gate.mjs [--threshold-ms 2500] [--ready-command \"<shell command>\"] -- <launch command> [args...]");
  process.exit(1);
}

const cmd = args[sep + 1];
const cmdArgs = args.slice(sep + 2);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runReadyCommand(shellCommand) {
  return new Promise((resolve) => {
    const child = spawn(process.platform === "win32" ? "cmd" : "bash", process.platform === "win32" ? ["/C", shellCommand] : ["-lc", shellCommand], {
      stdio: "ignore",
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

async function waitForReadiness(startedAt, launchState) {
  if (!readyCommand) {
    return Date.now();
  }

  while (Date.now() - startedAt < thresholdMs) {
    if (launchState.code !== null && launchState.code !== 0) {
      throw new Error(`Launch command exited before readiness check completed (code ${launchState.code})`);
    }

    const ready = await runReadyCommand(readyCommand);
    if (ready) return Date.now();
    await delay(Math.max(40, pollIntervalMs));
  }

  throw new Error(`Readiness command did not succeed within ${thresholdMs}ms`);
}

async function main() {
  if (readyCommand) {
    const alreadyReady = await runReadyCommand(readyCommand);
    if (alreadyReady) {
      console.error("Cold-start gate invalid: readiness command already succeeds before launch. Ensure the app is fully closed before running the gate.");
      process.exit(1);
    }
  }

  const started = Date.now();
  const launch = spawn(cmd, cmdArgs, { stdio: "pipe" });

  const launchState = {
    code: null,
    stderr: "",
  };

  launch.stderr.on("data", (chunk) => {
    launchState.stderr += String(chunk);
  });

  launch.on("error", (err) => {
    console.error(`Failed to execute cold start command: ${err.message}`);
    process.exit(1);
  });

  launch.on("close", (code) => {
    launchState.code = code;
  });

  try {
    if (!readyCommand) {
      await new Promise((resolve, reject) => {
        launch.on("close", (code) => {
          if (code !== 0) {
            reject(new Error(`Cold start command exited with code ${code}`));
            return;
          }
          resolve();
        });
      });
    }

    const readyAt = await waitForReadiness(started, launchState);
    const elapsedMs = readyAt - started;

    if (elapsedMs >= thresholdMs) {
      console.error(`Cold-start gate failed: ${elapsedMs}ms >= ${thresholdMs}ms`);
      process.exit(1);
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          generatedAt: new Date().toISOString(),
          command: [cmd, ...cmdArgs].join(" "),
          readinessCommand: readyCommand || null,
          elapsedMs,
          thresholdMs,
        },
        null,
        2
      )
    );
  } catch (error) {
    console.error(String(error?.message || error));
    if (launchState.stderr.trim()) {
      console.error(launchState.stderr.trim());
    }
    process.exit(1);
  }
}

await main();
