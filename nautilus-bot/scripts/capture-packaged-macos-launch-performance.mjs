#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const OPEN_BINARY = "/usr/bin/open";
const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const valueFor = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 && index < args.length - 1 ? args[index + 1] : fallback;
};
const appPath = path.resolve(repoRoot, valueFor("--app", "release/mac-arm64/Plainsong.app"));
const outPath = path.resolve(
  repoRoot,
  valueFor("--out", "artifacts/qa/macos/packaged-launch-performance.json"),
);
const timeoutMs = Number(valueFor("--timeout-ms", "15000"));
const thresholdMs = Number(valueFor("--threshold-ms", "1500"));
const profileCondition = valueFor("--profile-condition", "fresh");
const requestedProfileRoot = valueFor("--profile-root");
const verifyDomContract = args.includes("--verify-dom-contract");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (process.platform !== "darwin") {
  throw new Error("The packaged macOS launch-performance gate only runs on macOS.");
}
if (!fs.existsSync(appPath) || !["fresh", "warm"].includes(profileCondition)) {
  throw new Error("Pass an existing --app and --profile-condition fresh or warm.");
}

function commandOutput(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { encoding: "utf8" });
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

class Cdp {
  constructor(input, output) {
    this.input = input;
    this.output = output;
    this.nextId = 1;
    this.pending = new Map();
    this.sessionId = null;
    let buffered = "";
    output.setEncoding("utf8");
    output.on("data", (chunk) => {
      buffered += chunk;
      const frames = buffered.split("\0");
      buffered = frames.pop();
      for (const frame of frames) if (frame) this.receive(JSON.parse(frame));
    });
  }
  receive(message) {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const message = { id, method, params };
      if (this.sessionId) message.sessionId = this.sessionId;
      this.input.write(`${JSON.stringify(message)}\0`);
    });
  }
  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  }
}

async function attachToMainRenderer(cdp, deadline) {
  while (Date.now() < deadline) {
    const { targetInfos } = await cdp.send("Target.getTargets");
    const page = targetInfos.find(
      (target) =>
        target.type === "page" &&
        typeof target.url === "string" &&
        !target.url.includes("overlay") &&
        !target.url.startsWith("devtools://"),
    );
    if (page) {
      const { sessionId } = await cdp.send("Target.attachToTarget", {
        targetId: page.targetId,
        flatten: true,
      });
      cdp.sessionId = sessionId;
      return;
    }
    await delay(25);
  }
  throw new Error("LaunchServices app never exposed its main renderer on the inherited CDP pipe.");
}

const OBSERVE_EXPRESSION = `(() => ({
  firstContentfulPaintMs:
    performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null,
  splashVisible: Boolean(
    document.querySelector('[aria-label="Checking first-run setup"]'),
  ),
  workspaceVisible: Boolean(document.querySelector("main#main-content")),
  wizardVisible: Boolean(
    document.querySelector('[role="dialog"][aria-modal="true"]'),
  ),
}))()`;

async function verifyRendererDomOverPrivatePipe(executable, profileRoot) {
  const child = spawn(
    executable,
    [`--user-data-dir=${path.join(profileRoot, "electron-profile")}`, "--remote-debugging-pipe"],
    {
      detached: true,
      stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PLAINSONG_DATA_DIR: path.join(profileRoot, "data"),
        PLAINSONG_CONFIG_DIR: path.join(profileRoot, "config"),
        PLAINSONG_QA_MODE: "1",
      },
    },
  );
  const cdp = new Cdp(child.stdio[3], child.stdio[4]);
  const deadline = Date.now() + timeoutMs;
  try {
    await attachToMainRenderer(cdp, deadline);
    await cdp.send("Runtime.enable");
    while (Date.now() < deadline) {
      const observation = await cdp.evaluate(OBSERVE_EXPRESSION);
      if (observation.splashVisible || observation.workspaceVisible || observation.wizardVisible) {
        await cdp.send("Browser.close").catch(() => undefined);
        return observation;
      }
      await delay(20);
    }
    throw new Error("Private-pipe DOM verification did not observe the Plainsong shell.");
  } finally {
    child.stdio[3].end();
    child.stdio[4].destroy();
  }
}

async function main() {
  if (profileCondition === "warm" && !requestedProfileRoot) {
    throw new Error("Warm measurements require an existing --profile-root primed by this candidate.");
  }
  const ownsProfileRoot = !requestedProfileRoot;
  const profileRoot = requestedProfileRoot
    ? path.resolve(requestedProfileRoot)
    : fs.mkdtempSync(path.join(os.tmpdir(), "plainsong-launch-performance-"));
  const electronProfile = path.join(profileRoot, "electron-profile");
  const dataRoot = path.join(profileRoot, "data");
  const configRoot = path.join(profileRoot, "config");
  const chromiumLog = path.join(profileRoot, "electron-launch.log");
  for (const directory of [electronProfile, dataRoot, configRoot]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const executable = path.join(appPath, "Contents", "MacOS", "Plainsong");
  const launchedAtWallTimeMs = Date.now();
  const child = spawn(
    OPEN_BINARY,
    [
      "-W",
      "-na", appPath, "--args",
      `--user-data-dir=${electronProfile}`,
      `--log-file=${chromiumLog}`,
      "--plainsong-quit-after-launch-metrics",
    ],
    {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PLAINSONG_DATA_DIR: dataRoot,
        PLAINSONG_CONFIG_DIR: configRoot,
        PLAINSONG_QA_MODE: "1",
        ELECTRON_ENABLE_LOGGING: "1",
      },
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });

  const deadline = Date.now() + timeoutMs;
  let firstPresentedMs = null;
  let interactiveMs = null;
  let finalObservation = null;
  while (Date.now() < deadline) {
    const output = fs.existsSync(chromiumLog) ? fs.readFileSync(chromiumLog, "utf8") : "";
    const milestones = [...output.matchAll(/\[launch-milestone\] (\{[^\n]+\})/g)]
      .map((match) => JSON.parse(match[1]));
    const presented = milestones.find((entry) => entry.name === "renderer-post-commit-frame");
    const interactive = milestones.find(
      (entry) => entry.name === "workspace-or-wizard-interactive",
    );
    if (presented) firstPresentedMs = presented.wallTimeMs - launchedAtWallTimeMs;
    if (interactive) {
      interactiveMs = interactive.wallTimeMs - launchedAtWallTimeMs;
      finalObservation = { source: "typed-renderer-milestone" };
      break;
    }
    await delay(20);
  }
  if (interactiveMs === null) child.kill("SIGTERM");
  await new Promise((resolve) => child.once("close", resolve));

  const chromiumOutput = fs.existsSync(chromiumLog) ? fs.readFileSync(chromiumLog, "utf8") : "";
  const milestoneLogs = `${stdout}\n${stderr}\n${chromiumOutput}`
    .split(/\r?\n/)
    .filter((line) => line.includes("[launch-milestone] "));
  const codesign = commandOutput("/usr/bin/codesign", ["-dv", "--verbose=4", appPath]);
  const spctl = commandOutput("/usr/sbin/spctl", ["-a", "-vv", "-t", "exec", appPath]);
  const stapler = commandOutput("/usr/bin/xcrun", ["stapler", "validate", appPath]);
  const display = commandOutput("/usr/sbin/system_profiler", ["SPDisplaysDataType", "-json"]);
  const displayRefreshRateHz = Number(display.match(/"spdisplays_refresh-rate"\s*:\s*"?(\d+)/)?.[1] ?? 0) || null;
  const domContractObservation = verifyDomContract
    ? await verifyRendererDomOverPrivatePipe(executable, profileRoot)
    : null;
  const report = {
    generatedAt: new Date().toISOString(),
    sourceSha: commandOutput("/usr/bin/git", ["-C", repoRoot, "rev-parse", "HEAD"]),
    appPath,
    appSha256: sha256(executable),
    signingIdentity: codesign.match(/Authority=(.+)/)?.[1] ?? null,
    notarized: /Notarized Developer ID/i.test(spctl),
    stapled: /validate action worked/i.test(stapler),
    architecture: commandOutput("/usr/bin/file", [executable]).match(/\b(?:arm64|x86_64|universal)\b/)?.[0] ?? null,
    macosVersion: commandOutput("/usr/bin/sw_vers", ["-productVersion"]),
    hardwareModel: commandOutput("/usr/sbin/sysctl", ["-n", "hw.model"]),
    displayRefreshRateHz,
    loadAverage: os.loadavg(),
    profileCondition,
    thresholdMs,
    firstPresentedMs,
    interactiveMs,
    pass: interactiveMs !== null && interactiveMs < thresholdMs,
    observation: finalObservation,
    milestoneLogs,
    domContractVerifiedWithPrivatePipe: domContractObservation !== null,
    domContractObservation,
    rawLaunchOutput: { stdout, stderr, chromium: chromiumOutput },
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  if (ownsProfileRoot) fs.rmSync(profileRoot, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.pass ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
