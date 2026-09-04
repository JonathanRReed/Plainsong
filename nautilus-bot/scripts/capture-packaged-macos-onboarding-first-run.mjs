#!/usr/bin/env node
/**
 * Does the packaged app actually show first-run setup?
 *
 * The reported failure could not have been caught by a unit test: a signed DMG
 * was installed onto a Mac that had run development builds, the renderer's
 * `nautilus_onboarding_complete` flag was already `true` in the shared Electron
 * user-data directory, and the wizard never appeared. So this drives the real
 * packaged app over the Chrome DevTools Protocol, against isolated data
 * directories, and reads the real DOM.
 *
 * Four launches against one profile root, in order:
 *
 *   1. fresh          — nothing recorded anywhere. The wizard must appear.
 *   2. legacy-flag    — the same profile, now carrying the retired renderer
 *                       flag. The wizard must STILL appear, because this Mac
 *                       cannot dictate. This is the reported bug.
 *   3. stale-record   — settings.json already says setup completed in June.
 *                       The wizard must still appear, for the same reason.
 *   4. defer          — the reader presses "Skip setup for now"; settings.json
 *                       must come back with a deferral naming what was unmet.
 *
 * What it cannot prove headlessly: the "record present, Mac genuinely ready,
 * wizard correctly stays shut" case. That needs a granted macOS microphone and
 * a downloaded model for this exact bundle, which is a user-present, on-device
 * step. The decision itself is covered by src/__tests__/onboarding-gate.test.ts.
 *
 * Usage:
 *   node scripts/capture-packaged-macos-onboarding-first-run.mjs \
 *     [--app release/mac-arm64/Plainsong.app] \
 *     [--out artifacts/qa/macos/onboarding-first-run.json]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);

function valueFor(name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) return fallback;
  return args[index + 1];
}

const appPath = path.resolve(
  repoRoot,
  valueFor("--app", "release/mac-arm64/Plainsong.app"),
);
const outPath = path.resolve(
  repoRoot,
  valueFor("--out", "artifacts/qa/macos/onboarding-first-run.json"),
);
const launchTimeoutMs = Number(valueFor("--timeout-ms", "60000"));

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (process.platform !== "darwin") {
  fail("capture-packaged-macos-onboarding-first-run can only run on macOS.");
}

const binaryPath = path.join(appPath, "Contents", "MacOS", "Plainsong");
if (!fs.existsSync(binaryPath)) {
  fail(`Packaged app not found at ${binaryPath}`);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * The renderer target, once Electron has one.
 *
 * The main window is the only page target this app opens at launch, but the
 * overlay windows appear shortly after, so the target is matched on its own
 * URL rather than on being first.
 */
async function waitForRendererTarget(port, deadline) {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find(
        (target) =>
          target.type === "page" &&
          typeof target.url === "string" &&
          !target.url.includes("overlay") &&
          !target.url.startsWith("devtools://"),
      );
      if (page?.webSocketDebuggerUrl) {
        return page;
      }
    } catch {
      // The debugger port is not listening yet.
    }
    await delay(250);
  }
  throw new Error("Electron never exposed a renderer target on the debug port");
}

/** A minimal CDP client over the Node 22+ global WebSocket. */
class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) {
        entry.reject(new Error(message.error.message));
        return;
      }
      entry.resolve(message.result);
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    return new Cdp(socket);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text,
      );
    }
    return result.result.value;
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // Already gone.
    }
  }
}

/**
 * Whether the first-run wizard is on screen, and what it says.
 *
 * Read off the real DOM: the wizard is the only `role="dialog"` the shell
 * mounts at launch, and its heading is the current step's name.
 */
const OBSERVE_EXPRESSION = `(() => {
  const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
  const heading = dialog?.querySelector("h2");
  const rubric = dialog?.querySelector(".rubric");
  const rows = dialog
    ? [...dialog.querySelectorAll("li")].map((row) =>
        row.textContent.replace(/\\s+/g, " ").trim(),
      )
    : [];
  return {
    wizardVisible: Boolean(dialog),
    heading: heading?.textContent?.trim() ?? null,
    rubric: rubric?.textContent?.trim() ?? null,
    permissionRows: rows,
    splashVisible: Boolean(
      document.querySelector('[aria-label="Checking first-run setup"]'),
    ),
    workspaceVisible: Boolean(document.querySelector("main#main-content")),
    legacyFlag: (() => {
      try {
        return localStorage.getItem("nautilus_onboarding_complete");
      } catch {
        return "unreadable";
      }
    })(),
  };
})()`;

async function launch({ profileRoot, label, afterObserve }) {
  const port = await freePort();
  const dataDirectory = path.join(profileRoot, "data");
  const configDirectory = path.join(profileRoot, "config");
  const electronProfile = path.join(profileRoot, "electron-profile");
  for (const directory of [dataDirectory, configDirectory, electronProfile]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const child = spawn(
    binaryPath,
    [`--user-data-dir=${electronProfile}`, `--remote-debugging-port=${port}`],
    {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PLAINSONG_DATA_DIR: dataDirectory,
        PLAINSONG_CONFIG_DIR: configDirectory,
        PLAINSONG_QA_MODE: "1",
        ELECTRON_ENABLE_LOGGING: "1",
      },
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const deadline = Date.now() + launchTimeoutMs;
  let observation = null;
  let cdp = null;
  try {
    const target = await waitForRendererTarget(port, deadline);
    cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    await cdp.send("Runtime.enable");

    // Poll until the launch has actually decided something, which is either
    // the wizard or the workspace. Waiting on "the splash is gone" is not the
    // same condition and gets this wrong twice: before React mounts there is
    // no splash either, and the gate holds the splash until settings,
    // providers and permissions have all answered, which on a loaded Mac is
    // several seconds.
    while (Date.now() < deadline) {
      observation = await cdp.evaluate(OBSERVE_EXPRESSION);
      if (observation.wizardVisible || observation.workspaceVisible) {
        break;
      }
      await delay(300);
    }
    // The workspace can mount a frame before the wizard settles over it.
    if (observation?.workspaceVisible && !observation.wizardVisible) {
      await delay(2000);
      observation = await cdp.evaluate(OBSERVE_EXPRESSION);
    }
    if (afterObserve) {
      await afterObserve(cdp);
    }
  } finally {
    cdp?.close();
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    await delay(1500);
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }

  const onboardingLog = [...`${stdout}\n${stderr}`.matchAll(/\[onboarding\][^\n]*/g)]
    .map((match) => match[0].trim())
    .filter((line, index, all) => all.indexOf(line) === index);

  return { label, observation, onboardingLog };
}

function settingsPath(profileRoot) {
  return path.join(profileRoot, "config", "Plainsong", "settings.json");
}

function readSettings(profileRoot) {
  const file = settingsPath(profileRoot);
  if (!fs.existsSync(file)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function main() {
  const profileRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "plainsong-onboarding-first-run-"),
  );
  const checks = [];
  const runs = [];

  function check(name, ok, detail) {
    checks.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  }

  // 1. A genuinely fresh install.
  const fresh = await launch({
    profileRoot,
    label: "fresh",
    // Leave the retired flag behind for the next launch, exactly as a Mac that
    // had run a development build would have carried it.
    afterObserve: async (cdp) => {
      await cdp.evaluate(
        `localStorage.setItem("nautilus_onboarding_complete", "true"), "ok"`,
      );
    },
  });
  runs.push(fresh);
  check(
    "fresh data directory shows the first-run wizard",
    fresh.observation?.wizardVisible === true,
    fresh.observation?.heading ?? "no dialog",
  );

  // 2. The reported bug: the retired renderer flag says setup happened.
  const legacy = await launch({ profileRoot, label: "legacy-flag" });
  runs.push(legacy);
  check(
    "the retired localStorage flag is present for this launch",
    legacy.observation?.legacyFlag === "true",
    `nautilus_onboarding_complete=${legacy.observation?.legacyFlag}`,
  );
  check(
    "a stale renderer flag no longer skips setup on a Mac that cannot dictate",
    legacy.observation?.wizardVisible === true,
    legacy.onboardingLog[0] ?? "no gate log line",
  );

  // 3. A durable record that has gone stale.
  const staleSettingsFile = settingsPath(profileRoot);
  const staleSettings = readSettings(profileRoot) ?? {};
  staleSettings.onboarding = {
    completedAt: "2026-06-19T10:04:00Z",
    completedVersion: "0.9.0-beta.1",
    grantedAtCompletion: { microphone: true, accessibility: true },
    deferredUnmet: [],
  };
  fs.mkdirSync(path.dirname(staleSettingsFile), { recursive: true });
  fs.writeFileSync(staleSettingsFile, JSON.stringify(staleSettings, null, 2));

  const stale = await launch({ profileRoot, label: "stale-record" });
  runs.push(stale);
  check(
    "a completed record does not override a Mac that cannot dictate now",
    stale.observation?.wizardVisible === true,
    stale.onboardingLog[0] ?? "no gate log line",
  );

  // 4. The escape hatch writes a durable deferral.
  const deferred = await launch({
    profileRoot,
    label: "defer",
    afterObserve: async (cdp) => {
      // Full onboarding opens on the model step, whose ghost button is "Skip
      // model download"; "Skip setup for now" is the ghost button on every
      // step after it. Click whichever is in front until setup is deferred.
      const clickSkip = (pattern) =>
        cdp.evaluate(`(() => {
          const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
          const button = [...(dialog?.querySelectorAll("button") ?? [])].find(
            (candidate) => ${pattern}.test(candidate.textContent ?? ""),
          );
          if (!button) return false;
          button.click();
          return true;
        })()`);

      for (let attempt = 0; attempt < 4; attempt += 1) {
        if (await clickSkip("/skip setup for now/i")) {
          break;
        }
        if (!(await clickSkip("/skip model download/i"))) {
          throw new Error("neither skip button was on screen");
        }
        await delay(800);
      }
      await delay(2500);
    },
  });
  runs.push(deferred);
  const afterDefer = readSettings(profileRoot);
  check(
    "Skip setup for now records a durable deferral in settings.json",
    Boolean(afterDefer?.onboarding?.deferredAt),
    `deferredAt=${afterDefer?.onboarding?.deferredAt ?? "absent"}`,
  );
  check(
    "the deferral names what was unmet",
    Array.isArray(afterDefer?.onboarding?.deferredUnmet) &&
      afterDefer.onboarding.deferredUnmet.length > 0,
    JSON.stringify(afterDefer?.onboarding?.deferredUnmet ?? null),
  );

  const report = {
    capturedAt: new Date().toISOString(),
    app: appPath,
    profileRoot,
    runs,
    settingsAfterDefer: afterDefer?.onboarding ?? null,
    checks,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nWrote ${path.relative(repoRoot, outPath)}`);

  const failed = checks.filter((entry) => !entry.ok);
  if (failed.length > 0) {
    console.error(`${failed.length} check(s) failed.`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
