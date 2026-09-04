#!/usr/bin/env node
/**
 * Packaged macOS app matrix insertion capture.
 *
 * The verdict of this harness is a MACHINE READ-BACK: the sample text is read back out of the
 * target surface by something that is not the app under test (an HTTP beacon from a browser page,
 * a file's bytes on disk, or the system clipboard seeded with a sentinel Plainsong did not write).
 *
 * What the sidecar says about itself - `pasted`, the frontmost app it thinks it targeted, the fact
 * that the RPC returned - is recorded under `selfReported` as corroboration and CANNOT make a run
 * pass. `qa_smoke_test_cursor_insert` reports `pasted: true` as soon as CGEvent::post returns, and
 * CGEvent::post returns nothing at all.
 *
 * `--observed` survives only as an optional operator note. It is recorded, it is never gating, and
 * its absence no longer blocks a non-interactive run.
 *
 * A run that satisfies every gating check but whose read-back did NOT happen inside the product
 * the matrix row names terminates as PASS_OUT_OF_SCOPE, never PASS. Nothing else may pair a frozen
 * row name with the word PASS.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

import {
  VERIFY_MODES,
  createReadBackSession,
  isBrowserApp,
  makeNonce,
  normalizeReadBackValue,
  readFrontmostApplication,
} from "./lib/app-matrix-readback.mjs";
import { createPackagedQaProfile } from "./lib/packaged-qa-profile.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const qaProfile = createPackagedQaProfile({
  args,
  prefix: "plainsong-app-matrix-qa-",
});

function valueFor(name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) return fallback;
  return args[index + 1];
}

const appPath = path.resolve(
  repoRoot,
  valueFor("--app", "release/mac-arm64/Plainsong.app")
);
const sidecarPath = path.join(
  appPath,
  "Contents",
  "Resources",
  "sidecar",
  "plainsong-sidecar"
);
const targetApp = valueFor("--target-app", "")?.trim() ?? "";
const verifyMode = valueFor("--verify-mode", "")?.trim().toLowerCase() ?? "";
const observedArg = valueFor("--observed", "")?.trim().toLowerCase() ?? "";
const notesArg = valueFor("--notes", "")?.trim() ?? "";
const scratchTargetArg = valueFor("--scratch-target", "")?.trim() ?? "";
const timeoutMs = Number(valueFor("--timeout-ms", "45000"));
const prepareDelayMs = Number(valueFor("--prepare-delay-ms", "4000"));
const readyTimeoutMs = Number(valueFor("--ready-timeout-ms", "20000"));
const readBackTimeoutMs = Number(valueFor("--readback-timeout-ms", "20000"));
const postInsertSettleMs = Number(valueFor("--post-insert-settle-ms", "1000"));
const browserAppArg = valueFor("--browser-app", "")?.trim() ?? "";
const editorAppArg = valueFor("--editor-app", "")?.trim() ?? "";
const activateTarget = !args.includes("--no-activate-target");
const keepProbeTab = args.includes("--keep-probe-tab");
const suppressPrompt = args.includes("--no-prompt");
const runNonce = makeNonce();
const generatedAt = new Date().toISOString();
const sampleText =
  valueFor("--text", `Plainsong app matrix smoke ${generatedAt.replaceAll(/[:.]/g, "-")}`)
    ?.trim() ?? "";

function slugFor(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function envNameForScratchTarget(app) {
  return `PLAINSONG_QA_SCRATCH_${String(app ?? "")
    .replace(/\s+\((Chrome|Edge\/Chrome)\)$/i, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")}`;
}

const targetSlug = slugFor(targetApp) || "unknown-target";
/**
 * A local-http-probe run reads back a harness-owned page, so it can never close the row it names.
 * It is therefore filed under a distinct name and is not allowed to overwrite the canonical
 * artifact that a real in-application capture writes.
 */
const artifactSlug =
  verifyMode === "local-http-probe" ? `${targetSlug}-local-http-probe` : targetSlug;
const outPath = path.resolve(
  repoRoot,
  valueFor("--out", `artifacts/qa/macos/app-matrix-insertion-${artifactSlug}.json`)
);
const markdownPath = path.resolve(
  repoRoot,
  valueFor("--markdown", `artifacts/qa/macos/app-matrix-insertion-${artifactSlug}.md`)
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

const bundleIds = {
  "Apple Notes": ["com.apple.Notes"],
  "Google Docs (Chrome)": ["com.google.Chrome"],
  Slack: ["com.tinyspeck.slackmacgap"],
  Notion: ["notion.id"],
  "VS Code": ["com.microsoft.VSCode"],
  Cursor: ["com.todesktop.230313mzl4w4u92"],
  Messages: ["com.apple.MobileSMS"],
  "HubSpot (Chrome)": ["com.google.Chrome"],
};

/** Editor rows are the only ones whose surface is a file the harness can read off disk. */
const editorTargets = new Set(["VS Code", "Cursor"]);

/**
 * Rows whose application is only a HOST. "Chrome is frontmost" does not make a field Google Docs,
 * so these rows additionally require an external read of the front tab's URL. Without it the row
 * cannot be closed - the run is still honest evidence about a Chrome text field, but it is filed
 * as PASS_OUT_OF_SCOPE.
 */
const browserHostedRows = {
  "Google Docs (Chrome)": {
    urlPattern: /^https:\/\/docs\.google\.com\/document\//i,
    describe: "an open Google Docs document (https://docs.google.com/document/...)",
  },
  "HubSpot (Chrome)": {
    urlPattern: /^https:\/\/app(-[a-z0-9]+)?\.hubspot\.com\//i,
    describe: "an open HubSpot editor or record (https://app.hubspot.com/...)",
  },
};

const recommendedVerifyModes = {
  "Apple Notes": "native-accessibility",
  "Google Docs (Chrome)": "clipboard-sentinel",
  Slack: "clipboard-sentinel",
  Notion: "clipboard-sentinel",
  "VS Code": "file-on-disk",
  Cursor: "file-on-disk",
  Messages: "clipboard-sentinel",
  "HubSpot (Chrome)": "clipboard-sentinel",
};

/* The snapshot/restore below is defense in depth inside a disposable profile. */
const dataRoot = qaProfile.dataRoot;
const configRoot = qaProfile.configRoot;
const dataDir = path.join(dataRoot, "Plainsong");
const configDir = path.join(configRoot, "Plainsong");
const settingsPath = path.join(configDir, "settings.json");
const dbPath = path.join(dataDir, "plainsong.db");
const dbSidecarPaths = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
const dbBackups = new Map();
let originalSettingsBytes = null;
let userStateSnapshotTaken = false;
let userStateRestoreResult = null;

function hashBytes(bytes) {
  if (!bytes) return null;
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function componentDigestsForApp(bundlePath) {
  const components = {
    appAsar: path.join(bundlePath, "Contents", "Resources", "app.asar"),
    sidecar: path.join(
      bundlePath,
      "Contents",
      "Resources",
      "sidecar",
      "plainsong-sidecar",
    ),
    shortcutHelper: path.join(
      bundlePath,
      "Contents",
      "Resources",
      "shortcut-helper",
      "plainsong-native-shortcut-helper",
    ),
    speechHelper: path.join(
      bundlePath,
      "Contents",
      "Resources",
      "sidecar",
      "nautilus-macos-speech-helper-aarch64-apple-darwin",
    ),
  };
  return Object.fromEntries(
    Object.entries(components).map(([name, filePath]) => [
      name,
      fs.existsSync(filePath) && fs.statSync(filePath).isFile()
        ? hashBytes(fs.readFileSync(filePath))
        : null,
    ]),
  );
}

const candidateComponents = componentDigestsForApp(appPath);

function snapshotDbFiles() {
  for (const filePath of dbSidecarPaths) {
    dbBackups.set(filePath, fs.existsSync(filePath) ? fs.readFileSync(filePath) : null);
  }
}

function snapshotSettings() {
  originalSettingsBytes = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath) : null;
}

function restoreDbFiles() {
  for (const [filePath, bytes] of dbBackups.entries()) {
    if (bytes) {
      fs.writeFileSync(filePath, bytes);
    } else if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true });
    }
  }
}

function restoreSettings() {
  if (originalSettingsBytes) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, originalSettingsBytes);
  } else if (fs.existsSync(settingsPath)) {
    fs.rmSync(settingsPath, { force: true });
  }
}

function dbHashes() {
  return Object.fromEntries(
    dbSidecarPaths.map((filePath) => [
      filePath,
      fs.existsSync(filePath) ? hashBytes(fs.readFileSync(filePath)) : null,
    ])
  );
}

function snapshotUserState() {
  snapshotDbFiles();
  snapshotSettings();
  userStateSnapshotTaken = true;
  return {
    originalDbHashes: Object.fromEntries(
      [...dbBackups.entries()].map(([filePath, bytes]) => [filePath, hashBytes(bytes)])
    ),
    originalSettingsHash: hashBytes(originalSettingsBytes),
  };
}

/** Idempotent: safe to call from both the `finally` and the outer catch. */
function restoreUserState() {
  if (!userStateSnapshotTaken) return null;
  if (userStateRestoreResult) return userStateRestoreResult;
  restoreDbFiles();
  restoreSettings();
  const restoredDbHashes = dbHashes();
  const restoredSettingsHash = fs.existsSync(settingsPath)
    ? hashBytes(fs.readFileSync(settingsPath))
    : null;
  const originalDbHashes = Object.fromEntries(
    [...dbBackups.entries()].map(([filePath, bytes]) => [filePath, hashBytes(bytes)])
  );
  userStateRestoreResult = {
    restoredDbHashes,
    restoredSettingsHash,
    dbRestored: JSON.stringify(restoredDbHashes) === JSON.stringify(originalDbHashes),
    settingsRestored: restoredSettingsHash === hashBytes(originalSettingsBytes),
  };
  return userStateRestoreResult;
}

function applyRestoreToArtifact(artifact) {
  const restored = restoreUserState();
  if (!restored) {
    artifact.userStateSnapshotTaken = false;
    return;
  }
  artifact.userStateSnapshotTaken = true;
  artifact.restoredDbHashes = restored.restoredDbHashes;
  artifact.restoredSettingsHash = restored.restoredSettingsHash;
  artifact.dbRestored = restored.dbRestored;
  artifact.settingsRestored = restored.settingsRestored;
  if (artifact.checks) {
    artifact.checks.dbRestored = restored.dbRestored;
    artifact.checks.settingsRestored = restored.settingsRestored;
  }
}

function writeText(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${body.trimEnd()}\n`, "utf8");
}

function writeJson(filePath, value) {
  writeText(filePath, JSON.stringify(value, null, 2));
}

function yesNo(value) {
  return value ? "yes" : "no";
}

function markdownFor(report) {
  const checks = report.checks ?? {};
  const selfReported = report.selfReported ?? {};
  const readBack = report.readBack ?? {};
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
    `- Read-back mode: \`${report.verifyMode || "not selected"}\``,
    `- Read-back surface: ${readBack.surfaceDescription || "not staged"}`,
    "",
    "## Machine Read-Back (this is the verification)",
    "",
    "Every line in this section is an external fact: a value read back out of the target surface",
    "by something other than the app under test.",
    "",
    `- Read-back mode recognized: ${yesNo(checks.readBackModeRecognized)}`,
    `- Pre-insert field empty: ${yesNo(checks.readBackPreInsertEmpty)}`,
    `- Read-back matched sample: ${yesNo(checks.readBackMatchedSample)}`,
    ...(checks.targetSurfaceRestored === undefined
      ? []
      : [`- Disposable target restored to empty: ${yesNo(checks.targetSurfaceRestored)}`]),
    `- External frontmost matched target: ${yesNo(checks.externalFrontmostMatchedTarget)}`,
    `- Sidecar exited cleanly: ${yesNo(checks.sidecarExitedCleanly)}`,
    `- User database restored: ${yesNo(checks.dbRestored)}`,
    `- User settings restored: ${yesNo(checks.settingsRestored)}`,
    `- Pre-insert value: ${JSON.stringify(readBack.preInsertValue ?? null)}`,
    `- Observed value: ${JSON.stringify(readBack.observedValue ?? null)}`,
    "",
    "## Self-Reported by the App Under Test (NOT verification)",
    "",
    "These are things Plainsong said about itself. `pasted: true` only means CGEvent::post returned,",
    "and CGEvent::post returns nothing. They are corroboration and cannot carry a pass.",
    "",
    `- Sidecar command completed (self-reported): ${yesNo(selfReported.sidecarCommandCompleted)}`,
    `- Frontmost app matched target (self-reported): ${yesNo(selfReported.frontmostMatchedTarget)}`,
    `- Paste reported by sidecar (self-reported): ${yesNo(selfReported.pasteReported)}`,
  ];

  if (report.externalFrontmost) {
    lines.push(
      "",
      "## External Frontmost Read (System Events, not the app under test)",
      "",
      `- Name: \`${report.externalFrontmost.name ?? "unavailable"}\``,
      `- Bundle id: \`${report.externalFrontmost.bundleId ?? "unavailable"}\``,
      `- Matched target: ${yesNo(report.externalFrontmostMatchedTarget)}`,
      "- This is a System Events read, not a self-report, so it is gating: it is the only thing",
      "  tying the read-back to the application this row names."
    );
  }

  if (report.surfaceIdentity) {
    lines.push(
      "",
      "## Surface Identity (is this the row's surface, not just its application?)",
      "",
      `- Status: \`${report.surfaceIdentity.status}\``,
      `- ${report.surfaceIdentity.detail ?? "No detail recorded."}`
    );
  }

  if (report.rowClosure) {
    lines.push(
      "",
      "## Scope",
      "",
      `- Read-back surface is the real target application: ${yesNo(report.rowClosure.surfaceIsRealTargetApplication)}`,
      `- Closes the matrix row for ${report.targetApp}: ${yesNo(report.rowClosure.closesMatrixRow)}`,
      `- ${report.rowClosure.reason}`
    );
  }

  if (report.userState) {
    lines.push(
      "",
      "## User State",
      "",
      `- Snapshotted before the sidecar started: ${yesNo(report.userStateSnapshotTaken)}`,
      `- plainsong.db (+ -wal/-shm) restored: ${yesNo(report.dbRestored)}`,
      `- settings.json restored: ${yesNo(report.settingsRestored)}`,
      `- ${report.userState.note}`
    );
  }

  if (Array.isArray(report.scopeCaveats) && report.scopeCaveats.length > 0) {
    lines.push("", "## Scope Caveats", "");
    for (const caveat of report.scopeCaveats) {
      lines.push(`- ${caveat}`);
    }
  }

  if (report.reason) {
    lines.push("", "## Blocking Detail", "", `- ${report.reason}`);
  }

  if (report.operatorNote) {
    lines.push(
      "",
      "## Operator Note (optional, non-gating)",
      "",
      `- Result: \`${report.operatorNote.result || "none"}\``,
      `- Notes: ${report.operatorNote.notes || "none"}`,
      `- ${report.operatorNote.note}`
    );
  }

  lines.push(
    "",
    "## Follow-Up",
    "",
    "- Promote the target app in `docs/dictation-app-compatibility-matrix.md` only when this artifact shows `PASS` AND `Closes the matrix row` is yes.",
    "- `PASS_OUT_OF_SCOPE` means every gating check passed but the read-back did not happen inside the product this row names. It promotes nothing.",
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

function blockedReport(reason, extra = {}) {
  const commandTarget = targetApp || "Apple Notes";
  const scratchTargetEnv = envNameForScratchTarget(commandTarget);
  const recommendedMode = recommendedVerifyModes[commandTarget] ?? "clipboard-sentinel";
  return {
    generatedAt,
    appPath,
    sidecarPath,
    candidateComponents,
    targetApp,
    verifyMode,
    sampleText,
    scratchTarget: scratchTargetArg,
    pass: false,
    status: "BLOCKED",
    reason,
    command:
      `bun run qa:packaged:macos:app-matrix:insertion -- --target-app "${commandTarget.replaceAll('"', '\\"')}" ` +
      `--verify-mode ${recommendedMode} --scratch-target "$${scratchTargetEnv}"`,
    interactiveNote:
      "clipboard-sentinel needs a human-prepared, EMPTY, focused field in the target app before the " +
      "prepare delay ends. native-accessibility reads the focused native field directly. " +
      "local-http-probe and file-on-disk stage their own surface.",
    verifyModes: VERIFY_MODES,
    recommendedVerifyMode: recommendedMode,
    targetOptions: matrixTargets,
    ...extra,
  };
}

function normalize(value) {
  return String(value ?? "")
    .replace(/\s+\((Chrome|Edge\/Chrome)\)$/i, "")
    .trim()
    .toLowerCase();
}

function targetMatches(frontmost, target, bundleId) {
  const expectedBundleIds = bundleIds[target] ?? [];
  if (
    typeof bundleId === "string" &&
    expectedBundleIds.some((expected) => expected.toLowerCase() === bundleId.toLowerCase())
  ) {
    return true;
  }
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

/**
 * Thrown when a check could not be made externally. It unwinds through the `finally` so the
 * clipboard, the probe server, and the sidecar are always cleaned up before the artifact is
 * written, and it produces BLOCKED rather than a FAIL that would read like a product defect.
 */
class BlockedError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "BlockedError";
    this.reason = reason;
  }
}

/**
 * Activates the row's application. A non-zero exit means the application is not installed, is not
 * scriptable, or Automation permission was denied - in every one of those cases nothing was
 * brought to the front, so the caller must BLOCK rather than sail on into an insert that would
 * land in whatever happened to be frontmost.
 */
function activateTargetApp(app) {
  const activationName = activationNames[app];
  if (!activationName) {
    return {
      app: null,
      status: null,
      stderr: "",
      blockedReason:
        `No activation name is registered for ${app}, so the harness cannot bring it to the ` +
        "front and cannot prove the insert would land in it.",
    };
  }
  const result = spawnSync("osascript", [
    "-e",
    `tell application "${activationName.replaceAll('"', '\\"')}" to activate`,
  ], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const status = result.status;
  return {
    app: activationName,
    status,
    stderr: (result.stderr ?? "").trim(),
    blockedReason:
      status === 0
        ? null
        : `Could not activate ${activationName} (osascript exited ${status}). Nothing was brought ` +
          "to the front, so an insert now would land in an unrelated application. A human must " +
          "confirm the application is installed and running, and that the terminal running this " +
          "harness holds Automation permission for it (System Settings > Privacy & Security). " +
          `Detail: ${(result.stderr ?? "").trim() || result.error?.message || "no stderr"}`,
  };
}

function urlOrigin(value) {
  try {
    return new URL(String(value)).origin;
  } catch {
    return null;
  }
}

/**
 * Reads the front tab/document URL out of the browser itself. The browser is not the app under
 * test - Plainsong is - so this is an external read, not a self-report.
 */
function readFrontBrowserUrl(appName) {
  const name = String(appName ?? "").trim();
  const chromeLike = /chrome|chromium|edge|brave|arc|vivaldi|opera/i.test(name);
  const safariLike = /safari/i.test(name);
  if (!name || (!chromeLike && !safariLike)) {
    return {
      ok: false,
      url: null,
      error: `${name || "The frontmost application"} exposes no AppleScript hook for its front tab URL.`,
    };
  }
  const escaped = name.replaceAll('"', '\\"');
  const script = chromeLike
    ? `tell application "${escaped}" to return URL of active tab of front window`
    : `tell application "${escaped}" to return URL of front document`;
  const result = spawnSync("osascript", ["-e", script], { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) {
    return {
      ok: false,
      url: null,
      error:
        (result.stderr ?? "").trim() ||
        result.error?.message ||
        `osascript exited ${result.status}`,
    };
  }
  return { ok: true, url: (result.stdout ?? "").trim(), error: null };
}

/**
 * For rows whose application only HOSTS the surface (a Chrome tab), "Chrome is frontmost" is not
 * enough to claim the row. Returns a verifier the read-back session calls before it touches the
 * field. A URL that does not belong to the row is BLOCKED - the harness must not paste into
 * somebody's unrelated tab. A URL that cannot be read leaves the row open (PASS_OUT_OF_SCOPE).
 */
function makeSurfaceIdentityVerifier(app) {
  const requirement = browserHostedRows[app];
  if (!requirement) return null;
  return async ({ frontmost }) => {
    const hostName = frontmost?.name || activationNames[app] || "";
    const read = readFrontBrowserUrl(hostName);
    if (!read.ok) {
      return {
        status: "unavailable",
        hostApplication: hostName,
        expected: requirement.describe,
        detail:
          `Could not read the front tab URL from ${hostName}, so the harness cannot prove the ` +
          `focused field belongs to ${app} rather than to some other page in the same browser. ` +
          `The run continues, but it cannot close this row. Detail: ${read.error}`,
      };
    }
    const origin = urlOrigin(read.url);
    if (!requirement.urlPattern.test(read.url)) {
      return {
        status: "mismatch",
        hostApplication: hostName,
        expected: requirement.describe,
        observedOrigin: origin,
        blockedReason:
          `${hostName} is frontmost, but its front tab is ${origin ?? "an unreadable URL"}, not ` +
          `${requirement.describe}. Nothing was inserted: pasting into whatever page happens to be ` +
          "open would both corrupt it and prove nothing about this matrix row. A human must open " +
          "the staged empty document, focus it, and re-run.",
        detail:
          "Only the origin is recorded. The harness does not copy the operator's document URLs " +
          "into a QA artifact.",
      };
    }
    return {
      status: "matched",
      hostApplication: hostName,
      expected: requirement.describe,
      observedOrigin: origin,
      observedUrlSha256: crypto.createHash("sha256").update(read.url).digest("hex"),
      detail:
        `${hostName} is frontmost and its front tab is ${origin}, which matches ` +
        `${requirement.describe}. Only the origin and a SHA-256 of the full URL are recorded.`,
    };
  };
}

function launchSidecar() {
  const child = spawn(sidecarPath, [], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ...qaProfile.env,
      PLAINSONG_PACKAGED_QA_APP_MATRIX: "1",
    },
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
      new Promise((resolve) => setTimeout(() => resolve(null), 15000)),
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
if (!Number.isFinite(postInsertSettleMs) || postInsertSettleMs < 0) {
  finish(blockedReport("--post-insert-settle-ms must be a non-negative number."), 1);
}
if (!verifyMode) {
  finish(
    blockedReport(
      `Select the machine read-back strategy with \`--verify-mode <${VERIFY_MODES.join("|")}>\`. ` +
        `Recommended for ${targetApp}: ${recommendedVerifyModes[targetApp]}. This flag is required ` +
        "on purpose: the harness no longer accepts a human attestation, so it has to know how it " +
        "is going to read the text back."
    )
  );
}
if (!VERIFY_MODES.includes(verifyMode)) {
  finish(
    blockedReport(
      `Unknown verify mode: ${verifyMode}. Expected one of: ${VERIFY_MODES.join(", ")}.`
    )
  );
}

const browserApp = browserAppArg || activationNames[targetApp] || "";
if (verifyMode === "local-http-probe" && !isBrowserApp(browserApp)) {
  finish(
    blockedReport(
      `local-http-probe needs a browser to render the probe page, but ${targetApp} resolves to ` +
        `"${browserApp || "no application"}". Pass --browser-app "Google Chrome" or pick another verify mode.`
    )
  );
}
// A probe run is filed under a frozen matrix row name. It may not name a row whose application is
// not even the one hosting the probe page: the artifact would then pair a row with evidence from
// an application that row has nothing to do with.
if (verifyMode === "local-http-probe" && !targetMatches(browserApp, targetApp, null)) {
  finish(
    blockedReport(
      `local-http-probe would render the probe page in ${browserApp}, which is not the application ` +
        `behind the ${targetApp} row. A probe run is already unable to close the row it names; it ` +
        "must at least be hosted by that row's own application. Use a browser-hosted row (" +
        `${Object.keys(browserHostedRows).join(", ")}) or pick another verify mode.`
    )
  );
}

const editorApp = editorAppArg || activationNames[targetApp] || "";
if (verifyMode === "file-on-disk" && !editorTargets.has(targetApp) && !editorAppArg) {
  finish(
    blockedReport(
      `file-on-disk expects an editor row (${[...editorTargets].join(", ")}), but the target is ` +
        `${targetApp}. Pass --editor-app explicitly only if that application is the one this row ` +
        "names and really does open and save a plain text file. The frontmost application is still " +
        "checked against this row's bundle identifier, so an override that opens a different " +
        "application is BLOCKED, not quietly accepted."
    )
  );
}

// clipboard-sentinel is the only mode where a human stages the surface, so it is the only mode
// that still needs the operator to name the disposable document being used.
if (verifyMode === "clipboard-sentinel") {
  if (!scratchTargetArg) {
    finish(
      blockedReport(
        "Provide `--scratch-target` with the disposable document, note, channel, message, or field " +
          "being used for this capture. It must be EMPTY and focused when the insert fires."
      )
    );
  }
  if (/^(DISPOSABLE QA TARGET|QA scratch note)$/i.test(scratchTargetArg)) {
    finish(
      blockedReport(
        "Replace the placeholder scratch target with the actual disposable document, note, channel, message, or field name."
      )
    );
  }
}

async function run() {
  const scopeCaveats = [];
  if (verifyMode === "local-http-probe") {
    scopeCaveats.push(
      "The read-back surface is a local 127.0.0.1 textarea, not the product named in this row. " +
        "It proves browser-process insertion only."
    );
  }
  if (verifyMode === "file-on-disk" && !editorTargets.has(targetApp)) {
    scopeCaveats.push(
      `file-on-disk was used against ${targetApp} with an explicit --editor-app override (${editorApp}).`
    );
  }
  if (verifyMode === "clipboard-sentinel") {
    scopeCaveats.push(
      "Pre-insert emptiness is established positively: the harness collapses the selection, types " +
        "a probe token into the focused field, and requires select-all/copy to return exactly that " +
        "token before deleting it. An unchanged clipboard is BLOCKED, never recorded as an empty " +
        "field. The probe token is typed into, and deleted from, the operator's scratch target."
    );
  }
  if (verifyMode === "clipboard-sentinel" && browserHostedRows[targetApp]) {
    scopeCaveats.push(
      `${targetApp} is hosted in a browser, so the frontmost-application read only proves the ` +
        "browser. The front tab URL is read out of the browser as well; if it cannot be read, the " +
        "run cannot close this row."
    );
  }
  if (verifyMode === "native-accessibility") {
    scopeCaveats.push(
      "Pre-insert emptiness and post-insert content are read directly from the focused native " +
        "accessibility text field. The field identifier must remain stable across both reads."
    );
  }

  const artifact = {
    generatedAt,
    appPath,
    sidecarPath,
    candidateComponents,
    targetApp,
    verifyMode,
    runNonce,
    scratchTarget: scratchTargetArg,
    scratchTargetSource: scratchTargetArg ? "operator" : "harness-staged",
    sampleText,
    prepareDelayMs,
    postInsertSettleMs,
    activateTarget,
    activationResult: null,
    promptShown: false,
    pass: false,
    status: "FAIL",
    reason: null,
    sidecarResult: null,
    readBack: {
      mode: verifyMode,
      surface: null,
      surfaceDescription: null,
      preInsertValue: null,
      preInsertValueRaw: null,
      observedValue: null,
      observedValueRaw: null,
      prepareEvidence: null,
      readBackEvidence: null,
      cleanupEvidence: null,
    },
    // Every key here is an EXTERNAL fact. externalFrontmostMatchedTarget is a System Events read
    // of the frontmost process, not something the app under test said about itself, so it is
    // legitimate pass-carrying evidence - and it is the only thing tying a read-back to this row.
    checks: {
      readBackModeRecognized: VERIFY_MODES.includes(verifyMode),
      readBackPreInsertEmpty: false,
      readBackMatchedSample: false,
      externalFrontmostMatchedTarget: false,
      sidecarExitedCleanly: false,
      dbRestored: false,
      settingsRestored: false,
    },
    selfReported: {
      note:
        "Reported by the app under test about itself. `pasted` is true as soon as CGEvent::post " +
        "returns, and CGEvent::post returns nothing. Corroboration only - these can never make a " +
        "run pass.",
      sidecarCommandCompleted: false,
      frontmostMatchedTarget: false,
      pasteReported: false,
    },
    externalFrontmost: null,
    externalFrontmostMatchedTarget: false,
    surfaceIdentity: null,
    userState: {
      configDir,
      settingsPath,
      dbPaths: dbSidecarPaths,
      note:
        "The harness uses isolated data and configuration roots. settings.json, plainsong.db, " +
        "and its -wal/-shm are still snapshotted and restored inside that profile on every exit path.",
    },
    userStateSnapshotTaken: false,
    originalDbHashes: null,
    originalSettingsHash: null,
    restoredDbHashes: null,
    restoredSettingsHash: null,
    dbRestored: false,
    settingsRestored: false,
    operatorNote: observedArg || notesArg
      ? {
          result: observedArg,
          notes: notesArg,
          note:
            "Operator commentary recorded verbatim. It is NOT verification and has no effect on " +
            "pass, status, or exit code.",
        }
      : null,
    rowClosure: null,
    scopeCaveats,
    sidecarExit: null,
    sidecarStderr: "",
  };

  let session = null;
  let sidecar = null;

  try {
    // Snapshot and warm the sidecar before the operator has to hold a focused
    // scratch field. Cold model discovery can take several seconds and must
    // not sit between the pre-insert read and the actual insertion.
    const snapshot = snapshotUserState();
    artifact.userStateSnapshotTaken = true;
    artifact.originalDbHashes = snapshot.originalDbHashes;
    artifact.originalSettingsHash = snapshot.originalSettingsHash;

    sidecar = launchSidecar();
    await sidecar.sendCommand("get_settings", {});

    if (verifyMode === "clipboard-sentinel" && process.stdin.isTTY && !suppressPrompt) {
      artifact.promptShown = true;
      console.log(`Prepare this EMPTY scratch target in ${targetApp}: ${scratchTargetArg}`);
      console.log(`The helper will paste this exact text: ${sampleText}`);
      console.log(
        "To prove the field is empty rather than assume it, the helper first types a throwaway " +
          "probe token into it and deletes it again. Use a disposable target."
      );
      await question(`Press Enter, then refocus ${targetApp} within ${prepareDelayMs} ms: `);
      await sleep(Math.max(0, prepareDelayMs));
    } else if (verifyMode === "clipboard-sentinel") {
      await sleep(Math.max(0, prepareDelayMs));
    }

    if (activateTarget) {
      artifact.activationResult = activateTargetApp(targetApp);
      // A failed activation is not a no-op to sail past: nothing came to the front, so the
      // insert would be delivered to whatever application happens to be frontmost.
      if (artifact.activationResult?.blockedReason) {
        throw new BlockedError(artifact.activationResult.blockedReason);
      }
      await sleep(500);
    }

    // The frontmost application is checked against THIS ROW's bundle identifiers in every mode.
    // An --editor-app / --browser-app override changes which application is launched, never which
    // application the evidence is allowed to come from.
    session = await createReadBackSession(verifyMode, {
      nonce: runNonce,
      sampleText,
      targetLabel: targetApp,
      browserApp,
      browserBundleId:
        verifyMode === "local-http-probe" && !browserAppArg
          ? bundleIds[targetApp]?.[0] ?? null
          : null,
      editorApp,
      editorBundleId:
        verifyMode === "file-on-disk" && !editorAppArg ? bundleIds[targetApp]?.[0] ?? null : null,
      expectedBundleIds: bundleIds[targetApp] ?? [],
      verifySurfaceIdentity: makeSurfaceIdentityVerifier(targetApp),
      accessibilityApp: activationNames[targetApp] || "",
      acceptedPreInsertBlankValues: targetApp === "Google Docs (Chrome)" ? [" "] : [],
      readyTimeoutMs,
      readBackTimeoutMs,
      closeTab: !keepProbeTab,
    });

    artifact.readBack.surface = session.surface;
    artifact.readBack.surfaceDescription = session.surfaceDescription;
    // Provisional until the external reads below say otherwise. Nothing claims row closure on the
    // strength of a strategy-declared literal.
    artifact.rowClosure = {
      surfaceIsRealTargetApplication: session.surfaceIsRealTargetApplication,
      closesMatrixRow: false,
      reason:
        "Row closure has not been established yet: the external frontmost read and the surface " +
        "identity check had not run when this artifact was written.",
    };

    const prepared = await session.prepare();
    artifact.readBack.prepareEvidence = prepared.evidence ?? null;
    artifact.surfaceIdentity =
      prepared.surfaceIdentity ?? prepared.evidence?.surfaceIdentity ?? null;
    if (!prepared.ok) {
      throw new BlockedError(prepared.blockedReason);
    }

    artifact.readBack.preInsertValue = prepared.preInsertValue ?? "";
    artifact.readBack.preInsertValueRaw = prepared.preInsertValueRaw ?? "";
    artifact.checks.readBackPreInsertEmpty = normalizeReadBackValue(prepared.preInsertValue) === "";

    if (!artifact.scratchTarget) {
      artifact.scratchTarget = session.surface;
      artifact.scratchTargetSource = "harness-staged";
    }

    artifact.externalFrontmost = readFrontmostApplication();
    if (!artifact.externalFrontmost.ok) {
      throw new BlockedError(
        "System Events could not report the frontmost application immediately before the insert, " +
          "so there is no external proof of which application received it. A human must grant the " +
          "terminal running this harness Accessibility and Automation permission (System Settings " +
          `> Privacy & Security), then re-run. Detail: ${artifact.externalFrontmost.error}`
      );
    }
    artifact.externalFrontmostMatchedTarget = targetMatches(
      artifact.externalFrontmost?.name,
      targetApp,
      artifact.externalFrontmost?.bundleId
    );
    artifact.checks.externalFrontmostMatchedTarget = artifact.externalFrontmostMatchedTarget;

    // Whether this run may be read as closing the row: the strategy's surface has to be inside the
    // application under test, System Events has to agree that application is frontmost, and the
    // surface itself has to have been identified as this row's surface.
    const surfaceIdentityEstablished = prepared.surfaceIdentityEstablished === true;
    const closesMatrixRow =
      session.surfaceIsRealTargetApplication === true &&
      artifact.externalFrontmostMatchedTarget === true &&
      surfaceIdentityEstablished;
    artifact.rowClosure = {
      surfaceIsRealTargetApplication: session.surfaceIsRealTargetApplication,
      surfaceIdentityEstablished,
      externalFrontmostMatchedTarget: artifact.externalFrontmostMatchedTarget,
      closesMatrixRow,
      reason: closesMatrixRow
        ? `The read-back happened inside ${targetApp} itself: System Events reported ` +
          `${artifact.externalFrontmost.name} / ${artifact.externalFrontmost.bundleId} frontmost ` +
          "and the staged surface was identified as this row's surface. A PASS here is evidence " +
          "about this row."
        : session.surfaceIsRealTargetApplication !== true
          ? `The read-back surface is owned by the harness, NOT by ${targetApp}. It is evidence ` +
            "that insertion works in the surface's host application; it does not close this " +
            "matrix row."
          : !artifact.externalFrontmostMatchedTarget
            ? `System Events reported ${artifact.externalFrontmost.name ?? "an unknown process"} ` +
              `frontmost, not ${targetApp}, so this run says nothing about this row.`
            : `The application was confirmed frontmost, but the surface inside it could not be ` +
              `identified as ${targetApp}'s own surface, so this run does not close the row. ` +
              `Detail: ${artifact.surfaceIdentity?.detail ?? "no detail recorded"}`,
    };
    if (!closesMatrixRow && artifact.rowClosure.reason) {
      scopeCaveats.push(artifact.rowClosure.reason);
    }

    artifact.sidecarResult = await sidecar.sendCommand("qa_smoke_test_cursor_insert", {
      text: sampleText,
    });
    artifact.selfReported.sidecarCommandCompleted = true;
    artifact.selfReported.frontmostMatchedTarget = targetMatches(
      artifact.sidecarResult?.targetApp,
      targetApp,
      artifact.sidecarResult?.targetBundleId
    );
    artifact.selfReported.pasteReported = Boolean(artifact.sidecarResult?.pasted);

    // CGEvent::post returning does not mean an asynchronous target has consumed
    // the clipboard yet. Slack in particular may read it on a later event-loop
    // turn. The read-back seeds its own clipboard sentinel, so wait before that
    // evidence step can replace the staged insertion text.
    await sleep(Math.max(0, postInsertSettleMs));
    const observed = await session.readBack();
    artifact.readBack.readBackEvidence = observed.evidence ?? null;
    if (!observed.ok) {
      throw new BlockedError(observed.blockedReason);
    }

    artifact.readBack.observedValue = observed.observedValue ?? "";
    artifact.readBack.observedValueRaw = observed.observedValueRaw ?? "";
    artifact.checks.readBackMatchedSample =
      normalizeReadBackValue(observed.observedValue) === normalizeReadBackValue(sampleText) &&
      normalizeReadBackValue(sampleText).length > 0;
  } catch (error) {
    if (error instanceof BlockedError) {
      artifact.status = "BLOCKED";
      artifact.reason = error.reason;
    } else {
      artifact.error = error instanceof Error ? error.message : String(error);
    }
  } finally {
    if (sidecar && !artifact.sidecarExit) {
      artifact.sidecarExit = await sidecar.shutdown();
      artifact.sidecarStderr = sidecar.stderr.join("").trim().slice(-12000);
    }
    if (session && !artifact.readBack.cleanupEvidence) {
      try {
        artifact.readBack.cleanupEvidence = await session.cleanup();
      } catch (cleanupError) {
        artifact.readBack.cleanupEvidence = {
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        };
      }
    }
    // After the sidecar is down, put the operator's data back the way it was found.
    applyRestoreToArtifact(artifact);
  }

  artifact.checks.sidecarExitedCleanly = artifact.sidecarExit?.code === 0;
  if (["native-accessibility", "clipboard-sentinel"].includes(verifyMode)) {
    artifact.checks.targetSurfaceRestored =
      artifact.readBack.cleanupEvidence?.targetSurfaceRestored === true;
  }
  const allChecksPassed = Object.values(artifact.checks).every(Boolean);
  artifact.checksAllPassed = allChecksPassed;
  const closesMatrixRow = artifact.rowClosure?.closesMatrixRow === true;

  // A BLOCKED run never becomes a FAIL and never becomes a PASS: it says the check could not be
  // made externally, which is a materially different claim from "the product is broken".
  if (artifact.status === "BLOCKED") {
    artifact.pass = false;
    finish(artifact, 1);
  }
  if (!allChecksPassed) {
    artifact.pass = false;
    artifact.status = "FAIL";
    finish(artifact, 1);
  }
  if (!closesMatrixRow) {
    // Every gating check passed, but the read-back did not happen inside the product this row
    // names. Such a run must never carry the word PASS next to a frozen matrix row name, so it
    // gets its own terminal status and `pass` stays false.
    artifact.pass = false;
    artifact.status = "PASS_OUT_OF_SCOPE";
    finish(artifact, 0);
  }
  artifact.pass = true;
  artifact.status = "PASS";
  finish(artifact, 0);
}

run().catch((error) => {
  // Covers throws outside the try/finally above (and anything thrown while writing the artifact),
  // so no path can leave the operator's data directory in the state the sidecar left it in.
  const restored = restoreUserState();
  finish(
    {
      generatedAt,
      appPath,
      sidecarPath,
      candidateComponents,
      targetApp,
      verifyMode,
      scratchTarget: scratchTargetArg,
      sampleText,
      pass: false,
      status: "FAIL",
      error: error instanceof Error ? error.message : String(error),
      userStateSnapshotTaken: Boolean(restored),
      dbRestored: restored?.dbRestored ?? false,
      settingsRestored: restored?.settingsRestored ?? false,
      restoredDbHashes: restored?.restoredDbHashes ?? null,
      restoredSettingsHash: restored?.restoredSettingsHash ?? null,
    },
    1
  );
});
