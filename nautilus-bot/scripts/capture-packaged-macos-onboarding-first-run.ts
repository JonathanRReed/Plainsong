#!/usr/bin/env bun
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
 *   bun scripts/capture-packaged-macos-onboarding-first-run.ts \
 *     [--app release/mac-arm64/Plainsong.app] \
 *     [--out artifacts/qa/macos/onboarding-first-run.json]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);

function valueFor(name: string): string | null;
function valueFor(name: string, fallback: string): string;
function valueFor(name: string, fallback: string | null = null): string | null {
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

function fail(message: string): never {
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

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The renderer target, once Electron has one.
 *
 * The main window is the only page target this app opens at launch, but the
 * overlay windows appear shortly after, so the target is matched on its own
 * URL rather than on being first.
 */
interface CdpTargetInfo {
  targetId: string;
  type: string;
  url?: unknown;
}

async function attachToRenderer(cdp: Cdp, deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    const { targetInfos } = (await cdp.send("Target.getTargets")) as {
      targetInfos: CdpTargetInfo[];
    };
    const page = targetInfos.find(
      (target) =>
        target.type === "page" &&
        typeof target.url === "string" &&
        !target.url.includes("overlay") &&
        !target.url.startsWith("devtools://"),
    );
    if (page) {
      const { sessionId } = (await cdp.send("Target.attachToTarget", {
        targetId: page.targetId,
        flatten: true,
      })) as { sessionId: string };
      cdp.sessionId = sessionId;
      return;
    }
    await delay(250);
  }
  throw new Error("Electron never exposed a renderer target on the debug pipe");
}

/** A minimal CDP client over Chromium's private, inherited pipe transport. */
interface CdpMessage {
  id?: number;
  result?: unknown;
  error?: { message: string };
}

interface CdpEvaluateResult {
  exceptionDetails?: { text: string; exception?: { description?: string } };
  result: { value?: unknown };
}

class Cdp {
  input: Writable;
  output: Readable;
  nextId: number;
  pending: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>;
  sessionId: string | null;

  // fd 3 is the child's command pipe (written here) and fd 4 its response pipe.
  constructor(input: ChildProcess["stdio"][3], output: ChildProcess["stdio"][4]) {
    this.input = input as Writable;
    this.output = output as Readable;
    this.nextId = 1;
    this.pending = new Map();
    this.sessionId = null;
    let buffered = "";
    this.output.setEncoding("utf8");
    this.output.on("data", (chunk: string) => {
      buffered += chunk;
      // split() always returns at least one element, so pop() yields a string.
      const frames = buffered.split("\0") as { pop(): string } & string[];
      buffered = frames.pop();
      for (const frame of frames) {
        if (frame) this.receive(JSON.parse(frame));
      }
    });
  }

  receive(message: CdpMessage): void {
    const entry = this.pending.get(message.id as number);
    if (!entry) return;
    this.pending.delete(message.id as number);
    if (message.error) {
      entry.reject(new Error(message.error.message));
      return;
    }
    entry.resolve(message.result);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const message: {
        id: number;
        method: string;
        params: Record<string, unknown>;
        sessionId?: string;
      } = { id, method, params };
      if (this.sessionId) message.sessionId = this.sessionId;
      this.input.write(`${JSON.stringify(message)}\0`);
    });
  }

  async evaluate(expression: string): Promise<unknown> {
    const result = (await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })) as CdpEvaluateResult;
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text,
      );
    }
    return result.result.value;
  }

  close() {
    this.input.end();
    this.output.destroy();
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

interface FirstRunObservation {
  wizardVisible: boolean;
  heading: string | null;
  rubric: string | null;
  permissionRows: string[];
  splashVisible: boolean;
  workspaceVisible: boolean;
  legacyFlag: string | null;
}

interface LaunchOptions {
  profileRoot: string;
  label: string;
  afterObserve?: (cdp: Cdp) => Promise<void>;
}

interface LaunchResult {
  label: string;
  observation: FirstRunObservation | null;
  onboardingLog: string[];
}

async function launch({ profileRoot, label, afterObserve }: LaunchOptions): Promise<LaunchResult> {
  const dataDirectory = path.join(profileRoot, "data");
  const configDirectory = path.join(profileRoot, "config");
  const electronProfile = path.join(profileRoot, "electron-profile");
  for (const directory of [dataDirectory, configDirectory, electronProfile]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const child = spawn(
    binaryPath,
    [`--user-data-dir=${electronProfile}`, "--remote-debugging-pipe"],
    {
      detached: true,
      // Chromium reads CDP commands from fd 3 and writes responses to fd 4.
      // Inherited pipes keep the privileged renderer undiscoverable to other
      // local processes, unlike a loopback remote-debugging port.
      stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
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
  child.stdout!.on("data", (chunk: Buffer) => {
    stdout += String(chunk);
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr += String(chunk);
  });

  const deadline = Date.now() + launchTimeoutMs;
  let observation: FirstRunObservation | null = null;
  let cdp: Cdp | null = null;
  try {
    cdp = new Cdp(child.stdio[3], child.stdio[4]);
    await attachToRenderer(cdp, deadline);
    await cdp.send("Runtime.enable");

    // Poll until the launch has actually decided something, which is either
    // the wizard or the workspace. Waiting on "the splash is gone" is not the
    // same condition and gets this wrong twice: before React mounts there is
    // no splash either, and the gate holds the splash until settings,
    // providers and permissions have all answered, which on a loaded Mac is
    // several seconds.
    while (Date.now() < deadline) {
      observation = (await cdp.evaluate(OBSERVE_EXPRESSION)) as FirstRunObservation;
      if (observation.wizardVisible || observation.workspaceVisible) {
        break;
      }
      await delay(300);
    }
    // The workspace can mount a frame before the wizard settles over it.
    if (observation?.workspaceVisible && !observation.wizardVisible) {
      await delay(2000);
      observation = (await cdp.evaluate(OBSERVE_EXPRESSION)) as FirstRunObservation;
    }
    if (afterObserve) {
      await afterObserve(cdp);
    }
  } finally {
    cdp?.close();
    try {
      process.kill(-child.pid!, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    await delay(1500);
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      // Already gone.
    }
  }

  const onboardingLog = [...`${stdout}\n${stderr}`.matchAll(/\[onboarding\][^\n]*/g)]
    .map((match) => match[0].trim())
    .filter((line, index, all) => all.indexOf(line) === index);

  return { label, observation, onboardingLog };
}

function settingsPath(profileRoot: string): string {
  return path.join(profileRoot, "config", "Plainsong", "settings.json");
}

interface OnboardingSettings {
  onboarding?: {
    deferredAt?: unknown;
    deferredUnmet?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function readSettings(profileRoot: string): OnboardingSettings | null {
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
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  const runs: LaunchResult[] = [];

  function check(name: string, ok: boolean, detail: string): void {
    checks.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  }

  // 1. A genuinely fresh install.
  const fresh = await launch({
    profileRoot,
    label: "fresh",
    // Leave the retired flag behind for the next launch, exactly as a Mac that
    // had run a development build would have carried it.
    afterObserve: async (cdp: Cdp) => {
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
    afterObserve: async (cdp: Cdp) => {
      // Full onboarding opens on the model step, whose ghost button is "Skip
      // model download"; "Skip setup for now" is the ghost button on every
      // step after it. Click whichever is in front until setup is deferred.
      const clickSkip = (pattern: string) =>
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
