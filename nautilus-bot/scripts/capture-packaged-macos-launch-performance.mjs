#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const OPEN_BINARY = "/usr/bin/open";
const PROFILE_STAMP_FILE = "launch-candidate.json";
const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const valueFor = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 && index < args.length - 1 ? args[index + 1] : fallback;
};
const appPath = path.resolve(
  repoRoot,
  valueFor("--app", "release/mac-arm64/Plainsong.app"),
);
const outPath = path.resolve(
  repoRoot,
  valueFor("--out", "artifacts/qa/macos/packaged-launch-performance.json"),
);
const timeoutMs = Number(valueFor("--timeout-ms", "15000"));
const thresholdMs = Number(valueFor("--threshold-ms", "1500"));
const profileCondition = valueFor("--profile-condition", "fresh");
const requestedProfileRoot = valueFor("--profile-root");
const verifyDomContract = args.includes("--verify-dom-contract");
const diagnosticAllowUnqualified = args.includes(
  "--diagnostic-allow-unqualified",
);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (process.platform !== "darwin") {
  throw new Error(
    "The packaged macOS launch-performance gate only runs on macOS.",
  );
}
if (!fs.existsSync(appPath) || !["fresh", "warm"].includes(profileCondition)) {
  throw new Error(
    "Pass an existing --app and --profile-condition fresh or warm.",
  );
}

function commandResult(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { encoding: "utf8" });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim(),
    error: result.error?.message ?? null,
  };
}

function commandOutput(command, commandArgs) {
  return commandResult(command, commandArgs).output;
}

function sha256(file) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
}

async function sha256Bundle(root) {
  const digest = crypto.createHash("sha256");
  async function visit(directory) {
    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      const relative = path.relative(root, fullPath);
      digest.update(
        `${entry.isDirectory() ? "d" : entry.isSymbolicLink() ? "l" : "f"}\0${relative}\0`,
      );
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isSymbolicLink())
        digest.update(`${fs.readlinkSync(fullPath)}\0`);
      else
        for await (const chunk of fs.createReadStream(fullPath))
          digest.update(chunk);
    }
  }
  await visit(root);
  return digest.digest("hex");
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
  throw new Error(
    "LaunchServices app never exposed its main renderer on the inherited CDP pipe.",
  );
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
    [
      `--user-data-dir=${path.join(profileRoot, "electron-profile")}`,
      "--remote-debugging-pipe",
    ],
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
      if (observation.workspaceVisible || observation.wizardVisible) {
        await cdp.send("Browser.close").catch(() => undefined);
        return observation;
      }
      await delay(20);
    }
    throw new Error(
      "Private-pipe DOM verification did not observe the Plainsong shell.",
    );
  } finally {
    child.stdio[3].end();
    child.stdio[4].destroy();
  }
}

async function main() {
  const appBundleSha256 = await sha256Bundle(appPath);
  if (
    profileCondition === "warm" &&
    (!requestedProfileRoot || !fs.existsSync(requestedProfileRoot))
  ) {
    throw new Error(
      "Warm measurements require an existing candidate-stamped --profile-root.",
    );
  }
  const ownsProfileRoot = !requestedProfileRoot;
  const profileRoot = requestedProfileRoot
    ? path.resolve(requestedProfileRoot)
    : fs.mkdtempSync(path.join(os.tmpdir(), "plainsong-launch-performance-"));
  const profileStampPath = path.join(profileRoot, PROFILE_STAMP_FILE);
  if (profileCondition === "warm") {
    let stamp;
    try {
      stamp = JSON.parse(fs.readFileSync(profileStampPath, "utf8"));
    } catch {
      throw new Error(
        "Warm measurements require an existing candidate-stamped --profile-root.",
      );
    }
    if (stamp.appBundleSha256 !== appBundleSha256) {
      throw new Error(
        "Warm profile was primed by a different packaged candidate.",
      );
    }
  }
  const electronProfile = path.join(profileRoot, "electron-profile");
  const dataRoot = path.join(profileRoot, "data");
  const configRoot = path.join(profileRoot, "config");
  const chromiumLog = path.join(profileRoot, "electron-launch.log");
  const runId = randomUUID();
  const milestoneLog = path.join(
    profileRoot,
    `launch-milestones-${runId}.jsonl`,
  );
  for (const directory of [electronProfile, dataRoot, configRoot]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const executable = path.join(appPath, "Contents", "MacOS", "Plainsong");
  const launchedAtWallTimeMs = Date.now();
  const child = spawn(
    OPEN_BINARY,
    [
      "-n",
      "-W",
      appPath,
      "--env",
      `PLAINSONG_QA_MODE=1`,
      "--env",
      `PLAINSONG_DATA_DIR=${dataRoot}`,
      "--env",
      `PLAINSONG_CONFIG_DIR=${configRoot}`,
      "--env",
      `ELECTRON_ENABLE_LOGGING=1`,
      "--args",
      `--user-data-dir=${electronProfile}`,
      `--log-file=${chromiumLog}`,
      `--plainsong-launch-metrics-file=${milestoneLog}`,
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
  let childClosed = false;
  const childCompletion = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      childClosed = true;
      resolve();
      return;
    }
    child.once("close", () => {
      childClosed = true;
      resolve();
    });
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const deadline = Date.now() + timeoutMs;
  let firstPresentedMs = null;
  let interactiveMs = null;
  let finalObservation = null;
  while (Date.now() < deadline) {
    if (childClosed) break;
    const output = fs.existsSync(milestoneLog)
      ? fs.readFileSync(milestoneLog, "utf8")
      : "";
    const milestones = [
      ...output.matchAll(/\[launch-milestone\] (\{[^\n]+\})/g),
    ].map((match) => JSON.parse(match[1]));
    const presented = milestones.find(
      (entry) => entry.name === "renderer-post-commit-frame",
    );
    const interactive = milestones.find(
      (entry) => entry.name === "workspace-or-wizard-interactive",
    );
    if (presented)
      firstPresentedMs = presented.wallTimeMs - launchedAtWallTimeMs;
    if (interactive) {
      interactiveMs = interactive.wallTimeMs - launchedAtWallTimeMs;
      finalObservation = { source: "typed-renderer-milestone" };
      break;
    }
    await delay(20);
  }
  if (interactiveMs === null) child.kill("SIGTERM");
  await childCompletion;

  const chromiumOutput = fs.existsSync(chromiumLog)
    ? fs.readFileSync(chromiumLog, "utf8")
    : "";
  const mainMilestoneOutput = fs.existsSync(milestoneLog)
    ? fs.readFileSync(milestoneLog, "utf8")
    : "";
  const milestoneLogs =
    `${stdout}\n${stderr}\n${chromiumOutput}\n${mainMilestoneOutput}`
      .split(/\r?\n/)
      .filter((line) => line.includes("[launch-milestone] "));
  const codesignDisplay = commandResult("/usr/bin/codesign", [
    "-dv",
    "--verbose=4",
    appPath,
  ]);
  const codesignVerify = commandResult("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    appPath,
  ]);
  const spctlAssessment = commandResult("/usr/sbin/spctl", [
    "-a",
    "-vv",
    "-t",
    "exec",
    appPath,
  ]);
  const staplerValidation = commandResult("/usr/bin/xcrun", [
    "stapler",
    "validate",
    appPath,
  ]);
  const display = commandOutput("/usr/sbin/system_profiler", [
    "SPDisplaysDataType",
    "-json",
  ]);
  const displayRefreshRateHz =
    Number(
      display.match(/"spdisplays_refresh-rate"\s*:\s*"?(\d+)/)?.[1] ?? 0,
    ) || null;
  const domContractObservation = verifyDomContract
    ? await verifyRendererDomOverPrivatePipe(executable, profileRoot)
    : null;
  const signingIdentity =
    codesignDisplay.output.match(/Authority=(.+)/)?.[1] ?? null;
  const developerIdSigned =
    signingIdentity?.startsWith("Developer ID Application:") === true;
  const notarized =
    spctlAssessment.status === 0 &&
    /Notarized Developer ID/i.test(spctlAssessment.output);
  const stapled =
    staplerValidation.status === 0 &&
    /validate action worked/i.test(staplerValidation.output);
  const signatureValid = codesignVerify.status === 0;
  const architecture =
    commandOutput("/usr/bin/file", [executable]).match(
      /\b(?:arm64|x86_64|universal)\b/,
    )?.[0] ?? null;
  const timingPass = interactiveMs !== null && interactiveMs < thresholdMs;
  const trustPass =
    signatureValid &&
    spctlAssessment.status === 0 &&
    staplerValidation.status === 0 &&
    developerIdSigned &&
    notarized &&
    stapled &&
    architecture === "arm64";
  const releaseQualifiedPass = timingPass && trustPass;
  const report = {
    generatedAt: new Date().toISOString(),
    sourceSha: commandOutput("/usr/bin/git", [
      "-C",
      repoRoot,
      "rev-parse",
      "HEAD",
    ]),
    appPath,
    appSha256: sha256(executable),
    appBundleSha256,
    sourceProvenance: {
      kind: "complete-packaged-bundle-sha256",
      value: appBundleSha256,
    },
    signingIdentity,
    developerIdSigned,
    signatureValid,
    notarized,
    stapled,
    architecture,
    macosVersion: commandOutput("/usr/bin/sw_vers", ["-productVersion"]),
    hardwareModel: commandOutput("/usr/sbin/sysctl", ["-n", "hw.model"]),
    displayRefreshRateHz,
    loadAverage: os.loadavg(),
    profileCondition,
    thresholdMs,
    firstPresentedMs,
    interactiveMs,
    timingPass,
    trustPass,
    releaseQualifiedPass: timingPass && trustPass,
    mode: diagnosticAllowUnqualified ? "diagnostic" : "release",
    pass: diagnosticAllowUnqualified ? timingPass : releaseQualifiedPass,
    observation: finalObservation,
    milestoneLogs,
    domContractVerifiedWithPrivatePipe: domContractObservation !== null,
    domContractObservation,
    rawLaunchOutput: {
      stdout,
      stderr,
      chromium: chromiumOutput,
      mainMilestones: mainMilestoneOutput,
    },
    trustCommands: {
      codesignDisplay,
      codesignVerify,
      spctlAssessment,
      staplerValidation,
    },
  };
  if (profileCondition === "fresh") {
    fs.writeFileSync(
      profileStampPath,
      `${JSON.stringify({ appBundleSha256 }, null, 2)}\n`,
    );
  }
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
