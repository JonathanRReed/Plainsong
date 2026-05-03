#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);

function valueFor(name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) return fallback;
  return args[index + 1];
}

const appPath = path.resolve(
  repoRoot,
  valueFor("--app", "release/mac-arm64/Nautilus.app")
);
const sidecarPath = path.join(
  appPath,
  "Contents",
  "Resources",
  "sidecar",
  "nautilus-sidecar"
);
const targetApp = valueFor("--target-app", "")?.trim() ?? "";
const observedArg = valueFor("--observed", "")?.trim().toLowerCase() ?? "";
const notesArg = valueFor("--notes", "")?.trim() ?? "";
const scratchTarget = valueFor("--scratch-target", "")?.trim() ?? "";
const timeoutMs = Number(valueFor("--timeout-ms", "45000"));
const prepareDelayMs = Number(valueFor("--prepare-delay-ms", "4000"));
const activateTarget = !args.includes("--no-activate-target");
const generatedAt = new Date().toISOString();
const sampleText =
  valueFor("--text", `Nautilus app matrix smoke ${generatedAt.replaceAll(/[:.]/g, "-")}`)
    ?.trim() ?? "";

function slugFor(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function envNameForScratchTarget(app) {
  return `NAUTILUS_QA_SCRATCH_${String(app ?? "")
    .replace(/\s+\((Chrome|Edge\/Chrome)\)$/i, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")}`;
}

const targetSlug = slugFor(targetApp) || "unknown-target";
const outPath = path.resolve(
  repoRoot,
  valueFor("--out", `artifacts/qa/macos/app-matrix-insertion-${targetSlug}.json`)
);
const markdownPath = path.resolve(
  repoRoot,
  valueFor("--markdown", `artifacts/qa/macos/app-matrix-insertion-${targetSlug}.md`)
);

const matrixTargets = [
  "Apple Notes",
  "Google Docs (Chrome)",
  "Slack",
  "Notion",
  "VS Code",
  "Cursor",
  "Messages",
  "HubSpot (Chrome)",
];

const activationNames = {
  "Apple Notes": "Notes",
  "Google Docs (Chrome)": "Google Chrome",
  Slack: "Slack",
  Notion: "Notion",
  "VS Code": "Visual Studio Code",
  Cursor: "Cursor",
  Messages: "Messages",
  "HubSpot (Chrome)": "Google Chrome",
};

function writeText(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${body.trimEnd()}\n`, "utf8");
}

function writeJson(filePath, value) {
  writeText(filePath, JSON.stringify(value, null, 2));
}

function markdownFor(report) {
  const checks = report.checks ?? {};
  const lines = [
    "# macOS Dictation App Matrix Insertion Capture",
    "",
    `Status: ${report.status}`,
    `Generated: ${report.generatedAt}`,
    "",
    "## Evidence",
    "",
    `- Artifact: \`${path.relative(repoRoot, outPath)}\``,
    `- App: \`${report.targetApp || "not selected"}\``,
    `- Scratch target: \`${report.scratchTarget || "not provided"}\``,
    `- Sidecar: \`${path.relative(repoRoot, sidecarPath)}\``,
    `- Sample: \`${report.sampleText || "not run"}\``,
    "",
    "## Checks",
    "",
    `- Sidecar command completed: ${checks.sidecarCommandCompleted ? "yes" : "no"}`,
    `- Frontmost app matched target: ${checks.frontmostMatchedTarget ? "yes" : "no"}`,
    `- Paste reported by sidecar: ${checks.pasteReported ? "yes" : "no"}`,
    `- Manual observation accepted: ${checks.manualObservationAccepted ? "yes" : "no"}`,
  ];

  if (report.reason) {
    lines.push("", "## Blocking Detail", "", `- ${report.reason}`);
  }

  if (report.observation) {
    lines.push(
      "",
      "## Manual Observation",
      "",
      `- Result: \`${report.observation.result}\``,
      `- Notes: ${report.observation.notes || "none"}`
    );
  }

  lines.push(
    "",
    "## Follow-Up",
    "",
    "- Promote the target app in `docs/dictation-app-compatibility-matrix.md` only when this artifact shows `PASS`.",
    "- Close related entries in `docs/dictation-blocked-app-register.md` only when the required evidence matches the entry."
  );

  return lines.join("\n");
}

function finish(report, exitCode = report.pass ? 0 : 1) {
  writeJson(outPath, report);
  writeText(markdownPath, markdownFor(report));
  console.log(JSON.stringify(report, null, 2));
  process.exit(exitCode);
}

function blockedReport(reason) {
  const commandTarget = targetApp || "Apple Notes";
  const scratchTargetEnv = envNameForScratchTarget(commandTarget);
  return {
    generatedAt,
    appPath,
    sidecarPath,
    targetApp,
    sampleText,
    scratchTarget,
    pass: false,
    status: "BLOCKED",
    reason,
    command:
      `bun run qa:packaged:macos:app-matrix:insertion -- --target-app "${commandTarget.replaceAll('"', '\\"')}" --scratch-target "$${scratchTargetEnv}"`,
    interactiveNote:
      "After pressing Enter, refocus the named scratch target before the prepare delay ends.",
    targetOptions: matrixTargets,
  };
}

function normalize(value) {
  return String(value ?? "")
    .replace(/\s+\((Chrome|Edge\/Chrome)\)$/i, "")
    .trim()
    .toLowerCase();
}

function targetMatches(frontmost, target) {
  const front = normalize(frontmost);
  const expected = normalize(target);
  if (!front || !expected) return false;
  if (expected === "google docs" || expected === "hubspot") {
    return front.includes("chrome");
  }
  if (expected === "vs code") {
    return front.includes("visual studio code") || front.includes("code");
  }
  return front.includes(expected) || expected.includes(front);
}

function question(prompt) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function activateTargetApp(app) {
  const activationName = activationNames[app];
  if (!activationName) return null;
  const result = spawnSync("osascript", [
    "-e",
    `tell application "${activationName.replaceAll('"', '\\"')}" to activate`,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return {
    app: activationName,
    status: result.status,
    stderr: result.stderr.trim(),
  };
}

function launchSidecar() {
  const child = spawn(sidecarPath, [], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const childExit = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  const pending = new Map();
  const rl = createInterface({ input: child.stdout });
  let nextId = 1;
  let didTimeOut = false;

  function sendCommand(method, params = {}) {
    const id = String(nextId++);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method });
    });
  }

  rl.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const pendingCommand = pending.get(String(message.id));
    if (!pendingCommand) return;
    pending.delete(String(message.id));
    if (message.error) {
      pendingCommand.reject(new Error(message.error.message ?? String(message.error)));
    } else {
      pendingCommand.resolve(message.result);
    }
  });

  const timeout = setTimeout(() => {
    didTimeOut = true;
    child.kill("SIGTERM");
    for (const { reject, method } of pending.values()) {
      reject(new Error(`Timed out waiting for ${method}`));
    }
    pending.clear();
  }, timeoutMs);

  async function shutdown() {
    clearTimeout(timeout);
    if (child.stdin.writable) {
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: String(nextId++),
          method: "shutdown",
          params: {},
        })}\n`
      );
    }
    const result = await Promise.race([
      childExit,
      new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
    ]);
    if (!result) {
      child.kill("SIGTERM");
      return await childExit;
    }
    return result;
  }

  return {
    sendCommand,
    shutdown,
    stderr,
    didTimeOut: () => didTimeOut,
  };
}

if (process.platform !== "darwin") {
  finish(blockedReport("Run this helper on macOS with a packaged macOS build."));
}
if (!fs.existsSync(sidecarPath)) {
  finish(blockedReport(`Packaged sidecar not found at ${sidecarPath}`));
}
if (!targetApp) {
  finish(blockedReport("Select one target app with `--target-app`."));
}
if (!matrixTargets.includes(targetApp)) {
  finish(blockedReport(`Unknown target app: ${targetApp}`));
}
if (!sampleText) {
  finish(blockedReport("Smoke test text cannot be empty."), 1);
}
if (!scratchTarget) {
  finish(
    blockedReport(
      "Provide `--scratch-target` with the disposable document, note, channel, message, or field being used for this capture."
    )
  );
}
if (/^(DISPOSABLE QA TARGET|QA scratch note)$/i.test(scratchTarget)) {
  finish(
    blockedReport(
      "Replace the placeholder scratch target with the actual disposable document, note, channel, message, or field name."
    )
  );
}
if (!observedArg && !process.stdin.isTTY) {
  finish(
    blockedReport("Interactive confirmation is required unless `--observed exact|partial|fail` is provided.")
  );
}

async function run() {
  const artifact = {
    generatedAt,
    appPath,
    sidecarPath,
    targetApp,
    scratchTarget,
    sampleText,
    prepareDelayMs,
    activateTarget,
    activationResult: null,
    pass: false,
    status: "FAIL",
    sidecarResult: null,
    observation: null,
    checks: {
      sidecarCommandCompleted: false,
      frontmostMatchedTarget: false,
      pasteReported: false,
      manualObservationAccepted: false,
    },
    sidecarExit: null,
    sidecarStderr: "",
  };

  if (!observedArg) {
    console.log(`Prepare this scratch target in ${targetApp}: ${scratchTarget}`);
    console.log(`The helper will paste this exact text: ${sampleText}`);
    await question(
      `Press Enter, then refocus ${targetApp} within ${prepareDelayMs} ms: `
    );
    await sleep(Math.max(0, prepareDelayMs));
  }

  if (activateTarget) {
    artifact.activationResult = activateTargetApp(targetApp);
    await sleep(500);
  }

  const sidecar = launchSidecar();
  try {
    artifact.sidecarResult = await sidecar.sendCommand("smoke_test_cursor_insert", {
      text: sampleText,
    });
    artifact.checks.sidecarCommandCompleted = true;
    artifact.checks.frontmostMatchedTarget = targetMatches(
      artifact.sidecarResult?.targetApp,
      targetApp
    );
    artifact.checks.pasteReported = Boolean(artifact.sidecarResult?.pasted);

    let observed = observedArg;
    let notes = notesArg;
    if (!observed) {
      observed = (
        await question("Did the exact sample text land in the target field? [exact/partial/fail]: ")
      ).toLowerCase();
      notes = await question("Notes or caveats for this app row: ");
    }

    artifact.observation = {
      result: observed,
      notes,
    };
    artifact.checks.manualObservationAccepted = observed === "exact" || observed === "partial";
    artifact.pass = Boolean(
      artifact.checks.sidecarCommandCompleted &&
        artifact.checks.frontmostMatchedTarget &&
        artifact.checks.pasteReported &&
        artifact.checks.manualObservationAccepted
    );
    artifact.status = artifact.pass ? "PASS" : "FAIL";
  } catch (error) {
    artifact.error = error instanceof Error ? error.message : String(error);
  } finally {
    artifact.sidecarExit = await sidecar.shutdown();
    artifact.sidecarStderr = sidecar.stderr.join("").trim().slice(-12000);
  }

  finish(artifact, artifact.pass ? 0 : 1);
}

run().catch((error) => {
  finish(
    {
      generatedAt,
      appPath,
      sidecarPath,
      targetApp,
      scratchTarget,
      sampleText,
      pass: false,
      status: "FAIL",
      error: error instanceof Error ? error.message : String(error),
    },
    1
  );
});
