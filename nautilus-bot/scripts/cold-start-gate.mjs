#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);

function valueFor(name, fallback = null) {
  const idx = args.indexOf(name);
  if (idx < 0 || idx === args.length - 1) return fallback;
  return args[idx + 1];
}

const thresholdMs = Number(valueFor("--threshold-ms", "2500"));
const pollIntervalMs = Number(valueFor("--poll-interval-ms", "120"));
const readyCommand = valueFor("--ready-command");
const readyOutputPattern = valueFor("--ready-output-pattern");
const enableElectronLogging = args.includes("--electron-logging");
const isolatePlainsongData = args.includes("--isolate-plainsong-data");
const sep = args.indexOf("--");

if (sep < 0 || sep === args.length - 1) {
  console.error("Usage: node scripts/cold-start-gate.mjs [--threshold-ms 2500] [--ready-command \"<shell command>\"] [--ready-output-pattern \"text\"] [--electron-logging] [--isolate-plainsong-data] -- <launch command> [args...]");
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
  if (!readyCommand && !readyOutputPattern) {
    return Date.now();
  }

  while (Date.now() - startedAt < thresholdMs) {
    if (launchState.closed) {
      const exitReason = launchState.code !== null
        ? `code ${launchState.code}`
        : `signal ${launchState.signal || "unknown"}`;
      throw new Error(`Launch command exited before readiness check completed (${exitReason})`);
    }

    const commandReady = readyCommand ? await runReadyCommand(readyCommand) : true;
    const outputReady = readyOutputPattern
      ? `${launchState.stdout}\n${launchState.stderr}`.includes(readyOutputPattern)
      : true;
    if (commandReady && outputReady) return Date.now();
    await delay(Math.max(40, pollIntervalMs));
  }

  throw new Error(`Readiness signal did not succeed within ${thresholdMs}ms`);
}

function processGroupExists(pid) {
  if (process.platform === "win32" || !pid) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function signalLaunch(launch, signal) {
  if (process.platform !== "win32" && launch.pid) {
    try {
      process.kill(-launch.pid, signal);
      return;
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  if (!launch.killed) {
    launch.kill(signal);
  }
}

async function stopLaunch(launch, launchState) {
  if (launchState.closed && !processGroupExists(launch.pid)) return;
  signalLaunch(launch, "SIGTERM");
  const deadline = Date.now() + 3000;
  while (
    (!launchState.closed || processGroupExists(launch.pid)) &&
    Date.now() < deadline
  ) {
    await delay(50);
  }
  if (!launchState.closed || processGroupExists(launch.pid)) {
    signalLaunch(launch, "SIGKILL");
  }
  launch.stdout?.destroy();
  launch.stderr?.destroy();
}

async function main() {
  if (readyCommand) {
    const alreadyReady = await runReadyCommand(readyCommand);
    if (alreadyReady) {
      console.error("Cold-start gate invalid: readiness command already succeeds before launch. Ensure the app is fully closed before running the gate.");
      process.exit(1);
    }
  }

  let isolationRoot = null;
  let launchArgs = cmdArgs;
  const launchEnv = {
    ...process.env,
    ...(enableElectronLogging ? { ELECTRON_ENABLE_LOGGING: "1" } : {}),
  };
  if (isolatePlainsongData) {
    isolationRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "plainsong-cold-start-"),
    );
    const dataDirectory = path.join(isolationRoot, "data");
    const configDirectory = path.join(isolationRoot, "config");
    const electronProfile = path.join(isolationRoot, "electron-profile");
    await Promise.all([
      fs.mkdir(dataDirectory, { recursive: true }),
      fs.mkdir(configDirectory, { recursive: true }),
      fs.mkdir(electronProfile, { recursive: true }),
    ]);
    launchEnv.PLAINSONG_DATA_DIR = dataDirectory;
    launchEnv.PLAINSONG_CONFIG_DIR = configDirectory;
    launchEnv.PLAINSONG_QA_MODE = "1";
    launchArgs = [...cmdArgs, `--user-data-dir=${electronProfile}`];
  }

  const started = Date.now();
  const launch = spawn(cmd, launchArgs, {
    detached: process.platform !== "win32",
    stdio: "pipe",
    env: launchEnv,
  });

  const launchState = {
    closed: false,
    code: null,
    signal: null,
    stdout: "",
    stderr: "",
  };

  launch.stdout.on("data", (chunk) => {
    launchState.stdout += String(chunk);
  });
  launch.stderr.on("data", (chunk) => {
    launchState.stderr += String(chunk);
  });

  launch.on("error", (err) => {
    console.error(`Failed to execute cold start command: ${err.message}`);
    process.exit(1);
  });

  launch.on("close", (code, signal) => {
    launchState.closed = true;
    launchState.code = code;
    launchState.signal = signal;
  });

  try {
    if (!readyCommand && !readyOutputPattern) {
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

    await stopLaunch(launch, launchState);
    if (isolationRoot) {
      await fs.rm(isolationRoot, { recursive: true, force: true });
      isolationRoot = null;
    }
    console.log(
      JSON.stringify(
        {
          ok: true,
          generatedAt: new Date().toISOString(),
          command: [cmd, ...launchArgs].join(" "),
          readinessCommand: readyCommand || null,
          readinessOutputPattern: readyOutputPattern || null,
          isolatedPlainsongData: isolatePlainsongData,
          elapsedMs,
          thresholdMs,
        },
        null,
        2
      )
    );
  } catch (error) {
    await stopLaunch(launch, launchState);
    if (isolationRoot) {
      await fs.rm(isolationRoot, { recursive: true, force: true });
      isolationRoot = null;
    }
    console.error(String(error?.message || error));
    if (launchState.stderr.trim()) {
      console.error(launchState.stderr.trim());
    }
    process.exit(1);
  }
}

await main();
