import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const DEV_SERVER_URL = process.env.PLAINSONG_DEV_SERVER_URL ?? "http://127.0.0.1:1420";
const RENDERER_MODE = process.env.PLAINSONG_RENDERER_MODE ?? "file";
const devServer = new URL(DEV_SERVER_URL);
const devPort = Number(devServer.port || (devServer.protocol === "https:" ? 443 : 80));
const VITE_START_TIMEOUT_MS = 30_000;
const HEALTHCHECK_INTERVAL_MS = 400;

let viteProcess = null;
let electronProcess = null;
let shuttingDown = false;
const rendererEntryPath = path.join(process.cwd(), "dist", "index.html");

function spawnChild(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PLAINSONG_DEV_SERVER_URL: DEV_SERVER_URL,
      NODE_ENV: "development",
    },
    stdio: "inherit",
    ...options,
  });

  child.on("error", (error) => {
    console.error(`[dev] Failed to start ${command}:`, error);
  });

  return child;
}

function isPortListening(hostname, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: hostname, port });

    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });

    socket.once("error", () => {
      resolve(false);
    });
  });
}

async function isDevServerHealthy() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);

  try {
    const response = await fetch(DEV_SERVER_URL, {
      signal: controller.signal,
      headers: {
        Accept: "text/html",
      },
    });
    if (!response.ok) {
      return false;
    }

    const html = await response.text();
    return html.includes('<div id="root">') && html.includes("/src/main.tsx");
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForHealthyDevServer() {
  const deadline = Date.now() + VITE_START_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (await isDevServerHealthy()) {
      return;
    }

    if (viteProcess?.exitCode !== null && viteProcess?.exitCode !== undefined) {
      throw new Error(`Vite exited early with code ${viteProcess.exitCode}`);
    }

    await delay(HEALTHCHECK_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for dev server at ${DEV_SERVER_URL}`);
}

function shutdown(code = 0) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  if (electronProcess && !electronProcess.killed) {
    electronProcess.kill("SIGTERM");
  }

  if (viteProcess && !viteProcess.killed) {
    viteProcess.kill("SIGTERM");
  }

  process.exit(code);
}

function waitForExit(child, label) {
  return new Promise((resolve, reject) => {
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${label} exited via signal ${signal}`));
        return;
      }

      if ((code ?? 0) !== 0) {
        reject(new Error(`${label} exited with code ${code ?? 0}`));
        return;
      }

      resolve();
    });
  });
}

async function main() {
  if (RENDERER_MODE === "server") {
    if (await isDevServerHealthy()) {
      console.log(`[dev] Reusing existing renderer at ${DEV_SERVER_URL}`);
    } else if (await isPortListening(devServer.hostname, devPort)) {
      console.error(
        `[dev] Port ${devPort} is already in use, but ${DEV_SERVER_URL} is not serving Plainsong. Stop the stale process and retry.`
      );
      process.exit(1);
    } else {
      console.log(`[dev] Starting Vite on ${DEV_SERVER_URL}`);
      viteProcess = spawnChild("bun", [
        "x",
        "vite",
        "--host",
        devServer.hostname,
        "--port",
        String(devPort),
        "--strictPort",
      ]);
      await waitForHealthyDevServer();
    }
  } else {
    console.log(`[dev] Building renderer for file mode at ${rendererEntryPath}`);
    const buildProcess = spawnChild("bun", ["x", "vite", "build"]);
    await waitForExit(buildProcess, "Vite build");

    if (!fs.existsSync(rendererEntryPath)) {
      throw new Error("File-based Electron dev mode could not find dist/index.html after build.");
    }
    console.log(`[dev] Using built renderer at ${rendererEntryPath}`);
  }

  electronProcess = spawnChild("bun", ["x", "electron", "."]);

  electronProcess.on("exit", (code, signal) => {
    if (signal) {
      console.log(`[dev] Electron exited via signal ${signal}`);
      shutdown(0);
      return;
    }

    shutdown(code ?? 0);
  });
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

void main().catch((error) => {
  console.error("[dev] Electron startup failed:", error);
  shutdown(1);
});
