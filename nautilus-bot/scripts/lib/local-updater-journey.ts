import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { isMonotonicUpdateCandidate } from "../../electron/updater-channel.ts";
import { macAppSignatureIsUpdatable } from "../../electron/macos-code-signature.ts";
import { hashFile, startLocalUpdateFeed, type FeedScenario } from "./local-update-feed.ts";
import { terminateProfileProcesses } from "./launch-process-cleanup.ts";
import { updaterTrustReceiptMatches } from "./updater-trust-receipt.ts";
import { UpdaterQaCdp } from "./updater-qa-cdp.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");
function requireValue(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Required: ${name}`);
  return value;
}
function run(file: string, args: string[], input?: string) {
  const result = spawnSync(file, args, { input, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${file} failed: ${result.stderr || result.error?.message || result.stdout}`);
  return result.stdout.trim();
}
function appVersion(app: string) {
  const plist = path.join(app, "Contents/Info.plist");
  const result = spawnSync("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", plist], { encoding: "utf8" });
  if (result.status === 0) return result.stdout.trim();
  const version = fs.readFileSync(plist, "utf8").match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
  if (!version) throw new Error("App version missing from Info.plist");
  return version;
}
function verifySignature(app: string) {
  run("/usr/bin/codesign", ["--verify", "--strict", "--deep", app]);
  const display = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", app], { encoding: "utf8" });
  if (!macAppSignatureIsUpdatable({ verified: true, displayOutput: `${display.stdout}\n${display.stderr}` })) {
    throw new Error("Candidate needs the verified Plainsong Developer ID signature");
  }
}
function jsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return Object.fromEntries(Object.entries(value));
}
function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
async function portAvailable() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No QA CDP port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
/** Names the snapshot fields that changed, so a failed readback says what moved. */
function snapshotDiff(before: Record<string, unknown>, after: Record<string, unknown>): string {
  const changed: string[] = [];
  const walk = (a: unknown, b: unknown, at: string) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
      a.forEach((item, index) => walk(item, b[index], `${at}[${index}]`));
      return;
    }
    if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) walk((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${at}.${key}`);
      return;
    }
    changed.push(`${at}: ${JSON.stringify(a)?.slice(0, 200)} -> ${JSON.stringify(b)?.slice(0, 200)}`);
  };
  walk(before, after, "snapshot");
  return changed.slice(0, 20).join("; ");
}
function assertRuntimeVersion(userAgent: unknown, expected: string) {
  if (typeof userAgent !== "string" || !userAgent.split(" ").some((part) => part.toLowerCase() === `plainsong/${expected}`.toLowerCase())) {
    throw new Error(`Running app did not report Plainsong/${expected}: ${String(userAgent)}`);
  }
}

/** No live profiles, LaunchServices launch, /Applications writes or network configuration changes. */
export async function runLocalUpdaterJourney(args: string[]) {
  const dryRun = args.includes("--dry-run");
  const beforeApp = fs.realpathSync(requireValue(args, "--before-app"));
  const afterApp = fs.realpathSync(requireValue(args, "--after-app"));
  for (const app of [beforeApp, afterApp]) {
    if (app === "/Applications" || app.startsWith("/Applications/")) throw new Error("Use candidates outside /Applications");
  }
  const beforeArtifact = path.resolve(requireValue(args, "--before-artifact"));
  const afterArtifact = path.resolve(requireValue(args, "--after-artifact"));
  const beforeTrust = path.resolve(requireValue(args, "--before-trust"));
  const afterTrust = path.resolve(requireValue(args, "--after-trust"));
  const manifest = path.resolve(requireValue(args, "--manifest"));
  const beforeVersion = requireValue(args, "--expected-before-version");
  const afterVersion = requireValue(args, "--expected-after-version");
  if (!isMonotonicUpdateCandidate(beforeVersion, afterVersion)) throw new Error("Journey requires a strictly newer SemVer version, not build metadata alone");
  if (appVersion(beforeApp) !== beforeVersion || appVersion(afterApp) !== afterVersion) throw new Error("Candidate app versions differ from expected versions");
  const beforeHash = await hashFile(beforeArtifact, "sha256", "hex");
  const afterHash = await hashFile(afterArtifact, "sha256", "hex");
  for (const [file, version, hash, candidateApp, artifact] of [[beforeTrust, beforeVersion, beforeHash, beforeApp, beforeArtifact], [afterTrust, afterVersion, afterHash, afterApp, afterArtifact]]) {
    const receipt: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!updaterTrustReceiptMatches(receipt, version, hash, candidateApp, artifact)) throw new Error("Trust receipt does not match candidate bytes and version");
  }
  const selected = args.includes("--scenario") ? requireValue(args, "--scenario") : "all";
  if (!["all", "success", "interrupted", "corrupt"].includes(selected)) throw new Error("Unknown scenario");
  const scenarios: FeedScenario[] = selected === "all" ? ["corrupt", "interrupted", "success"] : selected === "corrupt" ? ["corrupt"] : selected === "interrupted" ? ["interrupted"] : ["success"];
  if (!dryRun) {
    if (process.platform !== "darwin") throw new Error("Packaged updater journey requires macOS");
    verifySignature(beforeApp);
    verifySignature(afterApp);
  }
  // A dry run validates all feed inputs and fault serving without launching any app.
  if (dryRun) {
    for (const scenario of scenarios) {
      const feed = await startLocalUpdateFeed(manifest, scenario);
      try {
        if (feed.version !== afterVersion) throw new Error("Feed version differs from after candidate");
        const response = await fetch(new URL("beta-mac.yml", feed.url));
        if (!response.ok) throw new Error("Local manifest unavailable");
      } finally { await feed.close(); }
    }
    console.log(JSON.stringify({ mode: "dry-run", pass: false, inputsValid: true, scenarios, beforeVersion, afterVersion, packagedJourneyRun: false }));
    return;
  }
  const out = path.resolve(args.includes("--out") ? requireValue(args, "--out") : "artifacts/qa/macos/local-updater");
  fs.mkdirSync(out, { recursive: true });
  for (const scenario of scenarios) {
    await captureScenario({ scenario, beforeApp, afterApp, beforeArtifact, afterArtifact, beforeTrust, afterTrust, manifest, beforeVersion, afterVersion, beforeHash, afterHash, out });
  }
}

type ScenarioOptions = {
  scenario: FeedScenario; beforeApp: string; afterApp: string; beforeArtifact: string; afterArtifact: string;
  beforeTrust: string; afterTrust: string; manifest: string; beforeVersion: string; afterVersion: string;
  beforeHash: string; afterHash: string; out: string;
};
async function captureScenario(options: ScenarioOptions) {
  const { scenario, beforeVersion, afterVersion } = options;
  // Not os.tmpdir(): /var is a symlink to /private/var, and Squirrel records the
  // target as /var/... while the app compares against its real /private/var path,
  // so staging never matched. Installs live under /Applications or ~/Applications.
  const qaParent = path.join(os.homedir(), "Library", "Caches", "Plainsong-Updater-QA");
  fs.mkdirSync(qaParent, { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(qaParent, `${scenario}-`)));
  const app = path.join(root, "Plainsong.app");
  const home = path.join(root, "home");
  const profile = path.join(root, "electron");
  for (const dir of [home, profile, path.join(root, "config"), path.join(root, "data"), path.join(root, "tmp")]) fs.mkdirSync(dir);
  run("/usr/bin/ditto", [options.beforeApp, app]);
  verifySignature(app);
  const feed = await startLocalUpdateFeed(options.manifest, scenario);
  const port = await portAvailable();
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("PLAINSONG_"))),
    HOME: home, CFFIXED_USER_HOME: home, TMPDIR: root,
    XDG_CACHE_HOME: path.join(home, ".cache"), XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
    PLAINSONG_QA_MODE: "1", PLAINSONG_QA_ELECTRON_PROFILE: profile,
    PLAINSONG_CONFIG_DIR: path.join(root, "config"), PLAINSONG_DATA_DIR: path.join(root, "data"),
    PLAINSONG_QA_UPDATE_FEED_URL: feed.url,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const events: string[] = [];
  let log = "";
  let child: ChildProcess | undefined;
  let cdp: UpdaterQaCdp | undefined;
  const logPath = path.join(options.out, `${scenario}.log`);
  const launch = () => {
    const started = spawn(path.join(app, "Contents/MacOS/Plainsong"), [
      `--user-data-dir=${profile}`, "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${port}`,
    ], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    started.on("error", (error) => { log += `Launch error: ${error.message}\n`; });
    started.stdout?.on("data", (chunk: Buffer) => {
      log += chunk.toString();
      // Parse complete lines only, including events split across chunks.
      const observed = [...log.matchAll(/\[qa:updater\] ([a-z-]+)\r?\n/g)].map((match) => match[1]);
      events.splice(0, events.length, ...observed);
    });
    started.stderr?.on("data", (chunk: Buffer) => { fs.appendFileSync(logPath, chunk); });
    child = started;
  };
  const snapshot = async (connection: UpdaterQaCdp) => ({
    settings: jsonObject(await connection.invoke("get_settings")),
    // History details come from audit and insertion records that a SQL fixture
    // lacks, so read the dictation's text back through history search instead.
    // Keep the stable fields: the score moves with the index and the snippet
    // marks matches as [[word]].
    dictation: (await connection.invoke("search_dictation_history", { query: "QA dictation sentinel", limit: 5, offset: 0 }) as Array<Record<string, unknown>>)
      .map((hit) => ({ recordingId: hit.recordingId, matchedField: hit.matchedField, text: String(hit.snippet).replace(/\[\[|\]\]/g, "") })),
    meetings: await connection.invoke("get_recordings", { projectId: "inbox" }),
  });
  const stop = async () => {
    cdp?.close(); cdp = undefined;
    const remaining = await terminateProfileProcesses(profile);
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (remaining.length) throw new Error("Owned QA app processes remain alive");
  };
  try {
    if (feed.version !== afterVersion) throw new Error("Feed version differs from target");
    launch();
    cdp = await UpdaterQaCdp.connect(port);
    assertRuntimeVersion(await cdp.evaluate("navigator.userAgent"), beforeVersion);
    await cdp.invoke("save_settings", { patch: [{ op: "set", path: ["theme"], value: "dark" }], preserveSavedPrompts: true });
    await cdp.invoke("record_onboarding_state", { event: "completed", meetingsCompleted: true, unmet: [] });
    // Synthetic rows only, in the new profile initialized by this candidate.
    run("/usr/bin/sqlite3", [path.join(root, "data/Plainsong/plainsong.db")], `
      PRAGMA busy_timeout=5000;
      BEGIN IMMEDIATE;
      INSERT INTO recordings (id,title,project_id,created_at,updated_at,source_type,status,meeting_notes,audio_path)
        VALUES ('qa-updater-dictation','QA updater dictation','inbox',strftime('%Y-%m-%dT%H:%M:%S+00:00','now'),strftime('%Y-%m-%dT%H:%M:%S+00:00','now'),'dictation','completed',NULL,''),
               ('qa-updater-meeting','QA updater meeting','inbox',strftime('%Y-%m-%dT%H:%M:%S+00:00','now'),strftime('%Y-%m-%dT%H:%M:%S+00:00','now'),'meeting','completed','QA meeting sentinel','');
      INSERT INTO dictation_history_text (recording_id,final_text,raw_text,created_at)
        VALUES ('qa-updater-dictation','QA dictation sentinel','QA dictation sentinel',strftime('%Y-%m-%dT%H:%M:%S+00:00','now'));
      -- The app indexes history as it saves, so the fixture does too.
      INSERT INTO dictation_history_fts (recording_id,final_text,raw_text)
        VALUES ('qa-updater-dictation','QA dictation sentinel','QA dictation sentinel');
      COMMIT;
    `);
    const before = await snapshot(cdp);
    if (!JSON.stringify(before.dictation).includes("QA dictation sentinel") || !JSON.stringify(before.meetings).includes("QA updater meeting")) throw new Error(`Synthetic state did not read back through the app: ${JSON.stringify({ dictation: before.dictation, meetings: before.meetings }).slice(0, 4000)}`);
    const update = jsonObject(await cdp.invoke("check_for_updates"));
    if (update.version !== afterVersion) throw new Error("App check did not select the candidate");
    const beginInstall = async () => {
      await cdp!.evaluate(`window.__qaInstall = {state:'pending'}; window.electronAPI.invoke('install_update').then(() => {window.__qaInstall={state:'resolved'}}, error => {window.__qaInstall={state:'rejected',error:String(error)}}); true`);
    };
    await beginInstall();
    let interruptionObserved = false;
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline && child?.exitCode === null && child?.signalCode === null) {
      let state: Record<string, unknown>;
      try { state = jsonObject(await cdp.evaluate("window.__qaInstall")); }
      catch (error) {
        // The quit can close CDP just before Node receives the process exit.
        await delay(500);
        if (child?.exitCode !== null || child?.signalCode !== null) break;
        throw error;
      }
      if (state.state === "rejected") {
        if (scenario === "interrupted" && !interruptionObserved && feed.requests.some((request) => request.dropped)) {
          interruptionObserved = true;
          await beginInstall();
        } else if (scenario === "corrupt" && /checksum|sha512/i.test(String(state.error))) {
          if (events.includes("update-downloaded") || appVersion(app) !== beforeVersion) throw new Error("Corrupt ZIP reached installation");
          await stop();
          launch();
          cdp = await UpdaterQaCdp.connect(port);
          assertRuntimeVersion(await cdp.evaluate("navigator.userAgent"), beforeVersion);
          const after = await snapshot(cdp);
          if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error(`Old app failed synthetic state readback after corruption: ${snapshotDiff(before, after)}`);
          writeJson(path.join(options.out, "corrupt.json"), { pass: true, scenario, oldVersion: beforeVersion, error: state.error, beforeArtifactSha256: options.beforeHash, afterArtifactSha256: options.afterHash, oldVersionRelaunched: true, syntheticStatePreserved: true, requests: feed.requests, root });
          return;
        } else throw new Error(`Install rejected: ${String(state.error)}`);
      }
      await delay(200);
    }
    if (scenario === "corrupt") throw new Error("Corrupt ZIP was not rejected by checksum verification");
    if (child?.exitCode === null && child?.signalCode === null) throw new Error("App did not quit for installation before the deadline");
    if (scenario === "interrupted" && (!interruptionObserved || feed.requests.filter((request) => request.name === feed.zipName).length < 2)) throw new Error("Interrupted download retry was not observed");
    cdp.close();
    cdp = await UpdaterQaCdp.connect(port, 90_000);
    assertRuntimeVersion(await cdp.evaluate("navigator.userAgent"), afterVersion);
    events.push("relaunch");
    if (appVersion(app) !== afterVersion) throw new Error("Installed bundle version mismatch");
    verifySignature(app);
    // Bind the installed bytes to the supplied after candidate, not just its version.
    for (const component of ["Contents/Info.plist", "Contents/Resources/app.asar"]) {
      if (await hashFile(path.join(app, component), "sha256", "hex") !== await hashFile(path.join(options.afterApp, component), "sha256", "hex")) throw new Error(`Installed ${component} differs from candidate`);
    }
    const after = await snapshot(cdp);
    const preservation = {
      settings: before.settings.theme === after.settings.theme,
      onboarding: JSON.stringify(before.settings.onboarding) === JSON.stringify(after.settings.onboarding),
      dictationHistory: JSON.stringify(before.dictation) === JSON.stringify(after.dictation),
      meetings: JSON.stringify(before.meetings) === JSON.stringify(after.meetings),
    };
    const journeyPath = path.join(options.out, `${scenario}-journey.json`);
    writeJson(journeyPath, {
      scope: "local-signed-update-mechanism", feed: { provider: "generic", production: false, baseUrl: feed.url },
      beforeVersion, afterVersion, beforeArtifactSha256: options.beforeHash, afterArtifactSha256: options.afterHash,
      observedAt: new Date().toISOString(), installedThroughUpdater: true, installHandoff: "managed-macos-install-on-quit",
      events, relaunchObserved: true, preservation,
      observations: { settingsSentinel: after.settings.theme, onboardingSentinel: JSON.stringify(after.settings.onboarding), dictationSentinel: JSON.stringify(after.dictation), meetingSentinel: JSON.stringify(after.meetings) },
      interruptionObserved, requests: feed.requests, root,
    });
    run("bun", [path.join(repoRoot, "scripts/capture-packaged-macos-beta-update.ts"),
      "--before-app", options.beforeApp, "--after-app", app,
      "--before-artifact", options.beforeArtifact, "--after-artifact", options.afterArtifact,
      "--before-trust", options.beforeTrust, "--after-trust", options.afterTrust,
      "--expected-before-version", beforeVersion, "--expected-after-version", afterVersion,
      "--journey", journeyPath, "--out", path.join(options.out, `${scenario}.json`),
    ]);
  } catch (error) {
    writeJson(path.join(options.out, `${scenario}.json`), { pass: false, scenario, error: String(error), events, requests: feed.requests, root });
    throw error;
  } finally {
    fs.appendFileSync(logPath, log);
    try { await stop(); } finally { await feed.close(); }
    console.log(`QA ${scenario} files: ${options.out}; isolated candidate: ${root}`);
  }
}
