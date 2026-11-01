#!/usr/bin/env bun
/**
 * Packaged memory-footprint gate: `bun run qa:packaged:macos:footprint`.
 *
 * Launches the packaged app in a throwaway QA profile, tells it to plan for a
 * smaller Mac (`PLAINSONG_SIMULATE_PHYSICAL_MEMORY_GB`, default 8), and sums
 * the `phys_footprint` of the main process and every descendant (renderers,
 * GPU and utility helpers, the sidecar and native helpers) once a second
 * while it drives the app through idle, dictation, a live meeting and the
 * work that follows the meeting. A state whose peak is over the
 * `hardware_tier` budget for the simulated Mac fails the gate.
 *
 * Speech on the Neural Engine also costs memory outside the process tree:
 * the kernel driver and the ANE services wire it when the helper loads its
 * Core ML model. (On the Light tier the helper decodes on the CPU instead
 * and wires nothing.) The gate samples system wired and compressor memory
 * and the services' footprint against a pre-launch baseline, waits for the
 * speech model's idle release after the call, and adds the rise to an
 * "effective" figure. That figure fails a state only when the rise came and
 * went with the helper's model; otherwise it warns (see
 * `lib/system-memory-gate.ts`).
 *
 * Everything is driven through the app's own commands over a private
 * Chromium debugging pipe: no global hotkeys, no clicks outside the app.
 * Spoken fixtures go to a virtual input (BlackHole by default) with
 * `say -a`, so nothing is played aloud and the owner's output device and
 * volume are never touched. The QA profile has remote processing turned off,
 * so no audio or text leaves the Mac, and receipts keep only measurements,
 * never transcript text.
 */
import fs from "node:fs";
import path from "node:path";
import { execFile, spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { createPackagedQaProfile } from "./lib/packaged-qa-profile.ts";
import { waitForPackagedQaUi } from "./lib/packaged-qa-ui.ts";
import { terminateProfileProcesses } from "./lib/launch-process-cleanup.ts";
import { matchSpokenFixture } from "./lib/spoken-fixture-match.ts";
import { captureAppReceiptBinding, bindAppReceipt } from "./lib/app-receipt-binding.ts";
import { collectReleaseCandidateIdentity } from "./lib/release-candidate-identity.ts";
import {
  buildSystemMemoryReport,
  findNeuralEngineServices,
  parseTopMemory,
  parseVmStat,
  speechModelKeepReadyMs,
  type ServiceFootprint,
  type SystemMemorySample,
} from "./lib/system-memory-gate.ts";
import {
  descendantsOf,
  FOOTPRINT_PROBE_SOURCE,
  NEURAL_ENGINE_ASR_LABEL,
  helperCompletionSample,
  helperCompletionState,
  budgetBytes,
  measurementComplete,
  gatePassed,
  installedOllamaNotesModel,
  livingPids,
  simulatedMemoryReached,
  simulatedAvailableReached,
  parseSimulatedAvailableGb,
  parseCpuTimeMs,
  type ComponentAttribution,
  parseFootprintOutput,
  parseProcessTable,
  processLabel,
  renderFootprintMarkdown,
  searchIndexExpected,
  searchIndexSettled,
  speechRouteEvidence,
  summarizeProcessPeaks,
  summarizeState,
  tierForPhysicalGb,
  type AppReportedSpeechRoute,
  type BudgetKind,
  type FootprintSample,
  type ProcessRow,
  type SampleProcess,
  type StateResult,
  type StateWindow,
} from "./lib/footprint-gate.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);

function valueFor(name: string): string | null;
function valueFor(name: string, fallback: string): string;
function valueFor(name: string, fallback: string | null = null): string | null {
  const index = args.indexOf(name);
  return index >= 0 && index < args.length - 1 ? args[index + 1] : fallback;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const simulateGb = Number(valueFor("--simulate-gb", "8"));
if (!Number.isFinite(simulateGb) || simulateGb <= 0) fail("--simulate-gb must be a positive number.");
const parsedAvailableGb = parseSimulatedAvailableGb(valueFor("--simulate-available-gb"), simulateGb);
if (typeof parsedAvailableGb === "string") fail(parsedAvailableGb);
const simulateAvailableGb: number | null = parsedAvailableGb;
const appPath = path.resolve(repoRoot, valueFor("--app", "release/mac-arm64/Plainsong.app"));
const candidatePath = path.resolve(repoRoot, valueFor("--candidate", path.resolve(appPath, "../..")));
const outPath = path.resolve(
  repoRoot,
  valueFor("--out", `artifacts/qa/macos/footprint-${simulateGb}gb${
    simulateAvailableGb === null ? "" : `-available-${simulateAvailableGb}gb`
  }.json`),
);
const markdownPath = path.resolve(
  repoRoot,
  valueFor("--markdown", outPath.replace(/\.json$/, ".md")),
);
if (markdownPath === outPath) fail("--markdown must differ from --out.");
const sampleIntervalMs = Number(valueFor("--sample-interval-ms", "1000"));
const idleSettleMs = Number(valueFor("--idle-settle-ms", "60000"));
const idleSampleMs = Number(valueFor("--idle-sample-ms", "30000"));
const hiddenSettleMs = Number(valueFor("--hidden-settle-ms", "15000"));
const dictationCount = Number(valueFor("--dictations", "2"));
const dictationMs = Number(valueFor("--dictation-ms", "9000"));
const meetingMs = Number(valueFor("--meeting-ms", "120000"));
const postCallTimeoutMs = Number(valueFor("--post-call-timeout-ms", "900000"));
const launchTimeoutMs = Number(valueFor("--launch-timeout-ms", "90000"));
const systemSampleIntervalMs = Number(valueFor("--system-sample-interval-ms", "2000"));
const systemBaselineSamples = Number(valueFor("--system-baseline-samples", "5"));
// How long to keep sampling after the speech model's idle release.
const releaseSampleMs = Number(valueFor("--release-sample-ms", "20000"));
const speechReleaseTimeoutArg = valueFor("--speech-release-timeout-ms");
const speechReleaseTimeoutOverride = speechReleaseTimeoutArg === null ? null : Number(speechReleaseTimeoutArg);
const standardWorkload = sampleIntervalMs === 1000 && idleSettleMs >= 60000 &&
  idleSampleMs >= 30000 && meetingMs >= 120000 && dictationCount >= 2 && dictationMs >= 9000;
const attributionPath = valueFor("--attribution");
const attribution: ComponentAttribution[] = attributionPath
  ? JSON.parse(fs.readFileSync(path.resolve(attributionPath), "utf8")) : [];
if (!Array.isArray(attribution) || !attribution.every((row) =>
  row && [row.component, row.measurement, row.evidence, row.owner].every((value) => typeof value === "string"))) {
  fail("--attribution must contain an array of component, measurement, evidence and owner strings.");
}
const fixtureDevice = valueFor("--fixture-device", "BlackHole 2ch");
const includeSystemAudio = !args.includes("--mic-only");
const notesMode = valueFor("--notes", "auto");
const captureFrames = args.includes("--capture-frames");
// Optional meeting route override, "provider/model", e.g. parakeet/parakeet-tdt-0.6b-v3.
const meetingRoute = valueFor("--meeting-route");
if (meetingRoute && !/^[a-z_]+\/[\w.-]+$/.test(meetingRoute)) fail("--meeting-route must be provider/model.");
// Extra Chromium or app switches, for experiments only; a release receipt
// records them so it cannot pass as a measurement of the shipped defaults.
const extraAppArgs = args.flatMap((value, index) =>
  args[index - 1] === "--app-arg" ? [value] : [],
);
// Settings changed in the QA profile, "dotted.path=<json>", experiments only.
const extraSettings = args.flatMap((value, index) => {
  if (args[index - 1] !== "--set") return [];
  const at = value.indexOf("=");
  if (at <= 0) fail("--set takes dotted.path=<json value>.");
  return [{ op: "set", path: value.slice(0, at).split("."), value: JSON.parse(value.slice(at + 1)) }];
});
if (extraSettings.some((entry) => entry.path.some((key) =>
  ["privacy", "__proto__", "prototype", "constructor"].includes(key)))) {
  fail("--set cannot override privacy or object prototypes.");
}
if (!["auto", "skip"].includes(notesMode)) fail("--notes must be auto or skip.");
for (const [label, value] of [
  ["--sample-interval-ms", sampleIntervalMs],
  ["--idle-settle-ms", idleSettleMs],
  ["--idle-sample-ms", idleSampleMs],
  ["--hidden-settle-ms", hiddenSettleMs],
  ["--dictations", dictationCount],
  ["--dictation-ms", dictationMs],
  ["--meeting-ms", meetingMs],
  ["--post-call-timeout-ms", postCallTimeoutMs],
  ["--launch-timeout-ms", launchTimeoutMs],
  ["--system-sample-interval-ms", systemSampleIntervalMs],
  ["--system-baseline-samples", systemBaselineSamples],
  ["--release-sample-ms", releaseSampleMs],
  ["--speech-release-timeout-ms", speechReleaseTimeoutOverride ?? 0],
] as const) {
  if (!Number.isFinite(value) || value < 0) fail(`Invalid ${label} value.`);
}
if (sampleIntervalMs < 250) fail("--sample-interval-ms must be at least 250.");
if (systemSampleIntervalMs < 500) fail("--system-sample-interval-ms must be at least 500.");
if (!Number.isInteger(systemBaselineSamples) || systemBaselineSamples < 1) fail("--system-baseline-samples must be a whole number of at least 1.");

const executable = path.join(appPath, "Contents", "MacOS", "Plainsong");
if (process.platform !== "darwin") fail("The packaged footprint gate only runs on macOS.");
if (!fs.existsSync(executable)) fail(`Packaged app executable not found at ${executable}`);

const DICTATION_FIXTURE =
  "Send the quarterly report to Maria Lopez by Friday at three, but do not send it if the budget changes.";
const MEETING_FIXTURE =
  "Plainsong footprint fixture. We agreed to ship the beta on the fourteenth if the memory gate passes, and Priya will review the notes.";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ── Private CDP pipe ─────────────────────────────────────────────────────────

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class PipeCdp {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  sessionId: string | null = null;

  constructor(private input: Writable, output: Readable) {
    let buffered = "";
    output.setEncoding("utf8");
    const closed = () => this.rejectAll("CDP pipe closed");
    output.once("close", closed);
    output.once("error", closed);
    output.on("data", (chunk: string) => {
      buffered += chunk;
      const frames = buffered.split("\0");
      buffered = frames.pop() ?? "";
      for (const frame of frames) {
        if (!frame) continue;
        const message = JSON.parse(frame) as { id?: number; error?: { message: string }; result?: unknown };
        if (typeof message.id !== "number") continue;
        const entry = this.pending.get(message.id);
        if (!entry) continue;
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(message.error.message));
        else entry.resolve(message.result);
      }
    });
  }

  private rejectAll(reason: string) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }

  // CDP results are untyped JSON shaped by the method called.
  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000, browserLevel = false): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const message: Record<string, unknown> = { id, method, params };
      if (this.sessionId && !browserLevel) message.sessionId = this.sessionId;
      this.input.write(`${JSON.stringify(message)}\0`);
    });
  }

  async evaluate(expression: string, timeoutMs = 30_000): Promise<any> {
    const result = await this.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      timeoutMs,
    );
    if (result.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(String(description).split("\n")[0]);
    }
    return result.result?.value;
  }

  invoke(command: string, commandArgs: object = {}, timeoutMs = 120_000): Promise<any> {
    return this.evaluate(
      `window.electronAPI.invoke(${JSON.stringify(command)}, ${JSON.stringify(commandArgs)})`,
      timeoutMs,
    );
  }

  /** A real key event delivered to the app's own window, never a global one. */
  async pressShiftInWindow() {
    for (const type of ["rawKeyDown", "keyUp"]) {
      await this.send("Input.dispatchKeyEvent", {
        type,
        key: "Shift",
        code: "ShiftLeft",
        windowsVirtualKeyCode: 16,
        nativeVirtualKeyCode: 56,
      });
    }
  }
}

async function attachToMainRenderer(cdp: PipeCdp, deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    try {
      const { targetInfos } = await cdp.send("Target.getTargets", {}, 5_000, true);
      const page = (targetInfos as Array<{ type?: string; url?: string; targetId: string }>).find(
        (target) =>
          target.type === "page" &&
          typeof target.url === "string" &&
          !target.url.includes("overlay") &&
          !target.url.startsWith("devtools://") &&
          target.url !== "about:blank",
      );
      if (page) {
        const { sessionId } = await cdp.send(
          "Target.attachToTarget",
          { targetId: page.targetId, flatten: true },
          5_000,
          true,
        );
        cdp.sessionId = sessionId;
        return;
      }
    } catch {
      // The browser may still be starting.
    }
    await delay(250);
  }
  throw new Error("The packaged app never exposed its main window on the private debugging pipe.");
}

async function captureFrame(cdp: PipeCdp, state: string): Promise<void> {
  if (!captureFrames) return;
  const result = await cdp.send("Page.captureScreenshot", { format: "png" });
  if (typeof result.data !== "string" || result.data.length === 0) {
    throw new Error(`No painted ${state} frame.`);
  }
  const destination = `${outPath.replace(/\.json$/, "")}-${state}.png`;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, Buffer.from(result.data, "base64"));
}

async function captureOverlayFrame(cdp: PipeCdp, kind: "dictation" | "recording"): Promise<void> {
  if (!captureFrames) return;
  const { targetInfos } = await cdp.send("Target.getTargets", {}, 5000, true);
  const target = targetInfos.find((entry: { type?: string; url?: string }) =>
    entry.type === "page" && entry.url?.includes(`overlay=${kind}`));
  if (!target) return;
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true }, 5000, true);
  const mainSession = cdp.sessionId;
  try {
    cdp.sessionId = sessionId;
    await captureFrame(cdp, `${kind}-overlay`);
  } finally {
    cdp.sessionId = mainSession;
    await cdp.send("Target.detachFromTarget", { sessionId }, 5000, true);
  }
}

async function waitForBackend(cdp: PipeCdp, deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    try {
      const ready = await cdp.evaluate(
        'typeof window.electronAPI?.invoke === "function" && window.electronAPI.invoke("get_settings").then(() => true, () => false)',
        5_000,
      );
      if (ready === true) return;
    } catch {
      // The renderer or sidecar is not ready yet.
    }
    await delay(500);
  }
  throw new Error("The app's backend never answered get_settings.");
}

// ── Sampler ──────────────────────────────────────────────────────────────────

let currentState = "launch";
const samples: FootprintSample[] = [];
const startedAt = Date.now();
let rootPid: number | null = null;
let sampling = true;
const measurementErrors: string[] = [];
let previousNativeCpu: { at: number; times: Map<number, number> } | null = null;
let recentNativeCpu: number | null = null;

function run(command: string, commandArgs: string[]): string {
  const result = spawnSync(command, commandArgs, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? String(result.stdout) : "";
}

function takeSample(): FootprintSample | null {
  if (rootPid === null) return null;
  const rows = parseProcessTable(run("/bin/ps", ["-axo", "pid=,ppid=,pcpu=,command="]));
  const tree = descendantsOf(rootPid, rows);
  if (tree.length === 0) {
    measurementErrors.push(`App process tree missing during ${currentState}.`);
    return null;
  }
  const footprintArgs = ["-f", "bytes"];
  for (const row of tree) footprintArgs.push("-p", String(row.pid));
  const measured = new Map(
    parseFootprintOutput(run("/usr/bin/footprint", footprintArgs)).map((entry) => [entry.pid, entry]),
  );
  if (measured.size !== tree.length) {
    const alive = parseProcessTable(run("/bin/ps", ["-axo", "pid=,ppid=,pcpu=,command="]));
    if (!measurementComplete(tree.map((row) => row.pid), [...measured.keys()], livingPids(alive))) {
      measurementErrors.push(`Unmeasured live app process during ${currentState}.`);
    }
  }
  const labels = new Map(tree.map((row) => [row.pid, processLabel(row.command)]));
  const processes: SampleProcess[] = tree
    .filter((row) => measured.has(row.pid))
    .map((row) => {
      const entry = measured.get(row.pid)!;
      let label = labels.get(row.pid)!;
      if (label === "sidecar" && labels.get(row.ppid) === "sidecar") label = "sidecar-child";
      return { pid: row.pid, label, bytes: entry.bytes, peakBytes: entry.peakBytes, cpuPct: row.cpuPct, categories: entry.categories };
    });
  const native = processes.filter((entry) => /sidecar|speech|asr|embedding|language-model|text-helper|llm|python/.test(entry.label));
  const times = new Map<number, number>();
  for (const line of run("/bin/ps", ["-o", "pid=,time=", "-p", native.map((entry) => entry.pid).join(",")]).split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    const ms = match ? parseCpuTimeMs(match[2]) : null;
    if (match && ms !== null) times.set(Number(match[1]), ms);
  }
  const at = Date.now();
  const previous = previousNativeCpu;
  recentNativeCpu = previous && at > previous.at && times.size === native.length && times.size > 0 &&
    [...times.keys()].every((pid) => previous.times.has(pid))
    ? [...times].reduce((total, [pid, ms]) => total + Math.max(0, ms - previous.times.get(pid)!), 0) /
      (at - previous.at) * 100 : null;
  previousNativeCpu = { at, times };
  for (const entry of native) {
    const ms = times.get(entry.pid);
    if (ms !== undefined) entry.cpuMs = ms;
  }
  return {
    at: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    state: currentState,
    totalBytes: processes.reduce((sum, entry) => sum + entry.bytes, 0),
    processes,
  };
}

async function samplerLoop() {
  while (sampling) {
    const began = Date.now();
    const sample = takeSample();
    if (sample) samples.push(sample);
    await delay(Math.max(0, sampleIntervalMs - (Date.now() - began)));
  }
}

// ── System memory outside the app ───────────────────────────────────────────

const systemSamples: SystemMemorySample[] = [];
const systemNotes = new Set<string>();
// null until tried; false once footprint has refused the services (root-owned).
let serviceFootprintReadable: boolean | null = null;

/** Never blocks the event loop, so the app-tree sampler keeps its cadence. */
function runAsync(command: string, commandArgs: string[]): Promise<string> {
  return new Promise((resolve) => {
    // footprint exits non-zero when it can read only some of the pids, and
    // still prints those; the parsers drop anything unusable.
    execFile(command, commandArgs, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }, (_error, stdout) => resolve(String(stdout ?? "")));
  });
}

function neuralEngineHelperAlive(rows: ProcessRow[]): boolean {
  return rootPid !== null && descendantsOf(rootPid, rows).some((row) => processLabel(row.command) === NEURAL_ENGINE_ASR_LABEL);
}

async function readNeuralEngineServices(rows: ProcessRow[]): Promise<ServiceFootprint[]> {
  const services = findNeuralEngineServices(rows);
  if (services.length === 0) return [];
  const measured = new Map<number, { bytes: number; source: "footprint" | "top" }>();
  if (serviceFootprintReadable !== false) {
    const footprintArgs = ["-f", "bytes"];
    for (const service of services) footprintArgs.push("-p", String(service.pid));
    const parsed = parseFootprintOutput(await runAsync("/usr/bin/footprint", footprintArgs));
    for (const entry of parsed) measured.set(entry.pid, { bytes: entry.bytes, source: "footprint" });
    if (serviceFootprintReadable === null) {
      serviceFootprintReadable = parsed.length > 0;
      if (!serviceFootprintReadable) systemNotes.add("footprint cannot read the Neural Engine services without root; their physical footprint comes from top's mem column.");
    }
  }
  const missing = services.filter((service) => !measured.has(service.pid));
  if (missing.length > 0) {
    const topArgs = ["-l", "1", "-s", "0", "-stats", "pid,mem"];
    for (const service of missing) topArgs.push("-pid", String(service.pid));
    for (const [pid, bytes] of parseTopMemory(await runAsync("/usr/bin/top", topArgs))) {
      if (missing.some((service) => service.pid === pid)) measured.set(pid, { bytes, source: "top" });
    }
  }
  const unread = services.filter((service) => !measured.has(service.pid));
  // A service that exited in between (ANECompilerService runs on demand)
  // holds nothing; only a live, unreadable one is an unknown.
  const stillAlive = unread.length === 0 ? new Set<number>() : new Set(parseProcessTable(
    await runAsync("/bin/ps", ["-o", "pid=,ppid=,pcpu=,command=", "-p", unread.map((service) => service.pid).join(",")]),
  ).map((row) => row.pid));
  return services.flatMap((service): ServiceFootprint[] => {
    const entry = measured.get(service.pid);
    if (entry) return [{ ...service, bytes: entry.bytes, source: entry.source }];
    return stillAlive.has(service.pid) ? [{ ...service, bytes: null, source: null }] : [];
  });
}

async function takeSystemSample(state: string): Promise<SystemMemorySample | null> {
  const began = Date.now();
  const vm = parseVmStat(await runAsync("/usr/bin/vm_stat", []));
  const rows = parseProcessTable(await runAsync("/bin/ps", ["-axo", "pid=,ppid=,pcpu=,command="]));
  if (!vm || rows.length === 0) {
    systemNotes.add("Some system memory samples could not read vm_stat or the process table and were dropped.");
    return null;
  }
  return {
    at: new Date(began).toISOString(),
    elapsedMs: began - startedAt,
    state,
    wiredBytes: vm.wiredBytes,
    compressorBytes: vm.compressorBytes,
    neuralEngineHelperAlive: neuralEngineHelperAlive(rows),
    services: await readNeuralEngineServices(rows),
  };
}

async function systemSamplerLoop() {
  while (sampling) {
    const began = Date.now();
    const sample = await takeSystemSample(currentState);
    if (sample && sampling) systemSamples.push(sample);
    await delay(Math.max(0, systemSampleIntervalMs - (Date.now() - began)));
  }
}

function nativeWorkCpu(): number | null {
  return recentNativeCpu;
}

async function holdState(state: string, ms: number) {
  currentState = state;
  await delay(ms);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

function sayToFixtureDevice(text: string): ChildProcess {
  return spawn("/usr/bin/say", ["-a", fixtureDevice, text], { stdio: "ignore" });
}

function startFixtureLoop(text: string, gapMs: number) {
  let stopped = false;
  let active: ChildProcess | null = null;
  const loop = (async () => {
    while (!stopped) {
      active = sayToFixtureDevice(text);
      await new Promise((resolve) => active!.once("exit", resolve));
      active = null;
      if (!stopped) await delay(gapMs);
    }
  })();
  return async () => {
    stopped = true;
    active?.kill("SIGTERM");
    await Promise.race([loop, delay(3_000)]);
  };
}

// ── Run ──────────────────────────────────────────────────────────────────────

interface DictationRun {
  started: boolean;
  textChars: number;
  fixtureCoverage: number | null;
  error: string | null;
}

async function main() {
  const tier = tierForPhysicalGb(simulateGb);
  const binding = captureAppReceiptBinding(appPath);
  const candidateIdentity = collectReleaseCandidateIdentity({ candidatePath, appPath });
  const qaProfile = createPackagedQaProfile({ args, prefix: "plainsong-footprint-qa-" });
  const notes: string[] = [];

  // Throwaway profile only: nothing leaves the Mac during the gate.
  const settingsPath = path.join(qaProfile.configDir, "settings.json");
  const profileSettings = fs.existsSync(settingsPath)
    ? JSON.parse(fs.readFileSync(settingsPath, "utf8"))
    : {};
  profileSettings.privacy = { ...(profileSettings.privacy ?? {}), remoteProcessingEnabled: false };
  if (notesMode === "skip" && profileSettings.transcription) {
    profileSettings.transcription.enableAutoAnalysis = false;
  }
  for (const entry of extraSettings) {
    let node = profileSettings;
    for (const key of entry.path.slice(0, -1)) node = node[key] ??= {};
    node[entry.path.at(-1)!] = entry.value;
  }
  const autoAnalysis = profileSettings.transcription?.enableAutoAnalysis === true;
  let notesExpected = false;
  let notesMemoryAttributed = true;
  let notesSkipReason = "no downloaded local notes model";
  fs.writeFileSync(settingsPath, `${JSON.stringify(profileSettings, null, 2)}\n`);
  const transcription = profileSettings.transcription ?? {};
  notes.push(
    `Profile routes: dictation ${transcription.dictationProvider ?? "default"}/${transcription.dictationModelId ?? "default"}, meeting ${transcription.meetingProvider ?? "default"}/${transcription.meetingModelId ?? "default"}, diarization ${transcription.enableDiarization === false ? "off" : "on"}, auto notes ${autoAnalysis ? "on" : "off"}, remote processing forced off.`,
  );

  const states: StateWindow[] = [];
  const dictations: DictationRun[] = [];
  let launchPeakBytes: number | null = null;
  let reopenFromHiddenMs: number | null = null;
  let simulationReachedSidecar: boolean | null = null;
  let meeting: Record<string, unknown> = {};
  let windowMetrics: { width: number; height: number; scale: number; workspace: string | null } | null = null;
  let launchUi: "wizard" | "workspace" | null = null;
  let error: string | null = null;
  let dictationRoutes: AppReportedSpeechRoute[] = [];
  let cpuIdleExpected = false;
  let meetingReportedRoute: AppReportedSpeechRoute | null = null;

  const env: Record<string, string | undefined> = {
    ...process.env,
    ...qaProfile.env,
    PLAINSONG_SIMULATE_PHYSICAL_MEMORY_GB: String(simulateGb),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.PLAINSONG_SIMULATE_AVAILABLE_GB;
  if (simulateAvailableGb !== null) {
    env.PLAINSONG_SIMULATE_AVAILABLE_GB = String(simulateAvailableGb);
    notes.push(`Stress run: the sidecar plans as if other apps left ${simulateAvailableGb} GB free when it started, less whatever Plainsong loads. Memory pressure is this Mac's own.`);
  }
  if (extraAppArgs.length > 0) notes.push(`Experimental app switches: ${extraAppArgs.join(" ")}.`);
  if (extraSettings.length > 0) {
    notes.push(`Experimental settings: ${extraSettings.map((entry) => `${entry.path.join(".")}=${JSON.stringify(entry.value)}`).join(", ")}.`);
  }
  // System memory with this app not running, to measure the run against.
  const baselineRows = parseProcessTable(run("/bin/ps", ["-axo", "pid=,ppid=,pcpu=,command="]));
  const otherInstanceRunning = baselineRows.some((row) =>
    ["main", "sidecar", NEURAL_ENGINE_ASR_LABEL].includes(processLabel(row.command)));
  const baselineSystemSamples: SystemMemorySample[] = [];
  for (let index = 0; index < systemBaselineSamples; index += 1) {
    const sample = await takeSystemSample("baseline");
    if (sample) baselineSystemSamples.push(sample);
    if (index < systemBaselineSamples - 1) await delay(1_000);
  }

  const child = spawn(executable, [...qaProfile.appArgs, ...extraAppArgs, "--remote-debugging-pipe"], {
    detached: true,
    // Chromium reads CDP from fd 3 and answers on fd 4. An inherited pipe keeps
    // the privileged renderer unreachable from other local processes.
    stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
    env,
  });
  rootPid = child.pid ?? null;
  const sampler = samplerLoop();
  const systemSampler = systemSamplerLoop();
  const cdp = new PipeCdp(child.stdio[3] as Writable, child.stdio[4] as Readable);

  try {
    const deadline = Date.now() + launchTimeoutMs;
    await attachToMainRenderer(cdp, deadline);
    await cdp.send("Runtime.enable");
    await waitForBackend(cdp, deadline);

    const sidecarPid = takeSample()?.processes.find((entry) => entry.label === "sidecar")?.pid;
    if (sidecarPid) {
      const environment = run("/bin/ps", ["-E", "-ww", "-o", "command=", "-p", String(sidecarPid)]);
      simulationReachedSidecar = simulatedMemoryReached(environment, simulateGb);
      if (!simulationReachedSidecar) {
        notes.push("This candidate does not pass PLAINSONG_SIMULATE_PHYSICAL_MEMORY_GB to its sidecar, so the sidecar planned for this Mac's real memory. Budgets are still those of the simulated Mac.");
      }
      if (simulateAvailableGb !== null && !simulatedAvailableReached(environment, simulateAvailableGb)) {
        simulationReachedSidecar = false;
        notes.push("This candidate does not pass PLAINSONG_SIMULATE_AVAILABLE_GB to its sidecar, so admission saw this Mac's real free memory. Rebuild from a source that allows it before reading this run as a stress test.");
      }
    }

    // A fresh profile opens on the setup wizard; a returning user does not.
    launchUi = await waitForPackagedQaUi({ evaluate: expression => cdp.evaluate(expression), deadline });
    if (launchUi === "wizard") {
      await cdp.invoke("record_onboarding_state", { event: "completed", meetingsCompleted: true, unmet: [] });
      await cdp.send("Page.reload", {});
      await waitForBackend(cdp, Date.now() + launchTimeoutMs);
    }
    await waitForPackagedQaUi({
      evaluate: expression => cdp.evaluate(expression),
      deadline: Date.now() + launchTimeoutMs,
      workspaceOnly: true,
    });

    const effectiveSettings = await cdp.invoke("get_settings");
    const notesLane = effectiveSettings?.privacy?.meetingsAi;
    if (notesMode === "auto") {
      if (notesLane?.provider === "native_text") {
        const status = await cdp.invoke("get_native_text_model_status");
        notesExpected = status?.ready === true;
      } else if (notesLane?.provider === "ollama") {
        const models = await cdp.invoke("list_ollama_models").catch(() => []);
        const selected = notesLane.modelId || "qwen3.5:4b";
        notesExpected = installedOllamaNotesModel(models, selected);
      }
    } else {
      notesSkipReason = "notes explicitly skipped for this experiment";
    }
    notes.push(`Notes route: ${notesLane?.provider ?? "unknown"}/${notesLane?.modelId ?? "default"}; ${notesExpected ? "downloaded model will run after the call" : notesSkipReason}.`);
    notesMemoryAttributed = !notesExpected || notesLane?.provider === "native_text";
    if (!notesMemoryAttributed) {
      notes.push("The selected notes model runs in an external Ollama service. Its memory is outside the app process tree, so this run cannot qualify the notes budget.");
    }

    // Route both fixtures through the virtual input in this profile only.
    const inventory = await cdp.invoke("list_audio_input_devices");
    const device = (inventory?.devices ?? []).find(
      (entry: { deviceName?: string; isAvailable?: boolean }) =>
        entry?.deviceName === fixtureDevice && entry?.isAvailable !== false,
    );
    if (!device) throw new Error(`Fixture input "${fixtureDevice}" is not available. Install BlackHole or pass --fixture-device.`);
    const preference = { deviceId: device.deviceId, deviceName: device.deviceName, transportType: device.transportType ?? null };
    const routePatch = meetingRoute
      ? (() => {
          const [provider, model] = meetingRoute.split("/");
          notes.push(`Meeting route overridden to ${meetingRoute}.`);
          return [
            { op: "set", path: ["transcription", "useSharedAsrSelection"], value: false },
            { op: "set", path: ["transcription", "meetingProvider"], value: provider },
            { op: "set", path: ["transcription", "meetingModelId"], value: model },
            { op: "set", path: ["transcription", "providerModelIds", provider], value: model },
          ];
        })()
      : [];
    await cdp.invoke("save_settings", {
      patch: [
        { op: "set", path: ["transcription", "enableAutoAnalysis"], value: notesExpected },
        { op: "set", path: ["audio", "dictationInputOverrideEnabled"], value: true },
        { op: "set", path: ["audio", "dictationInputDevice"], value: preference },
        { op: "set", path: ["audio", "meetingInputOverrideEnabled"], value: true },
        { op: "set", path: ["audio", "meetingInputDevice"], value: preference },
        ...routePatch,
        ...extraSettings,
      ],
      preserveSavedPrompts: true,
    });
    launchPeakBytes = samples.reduce((peak, sample) => Math.max(peak, sample.totalBytes), 0);

    windowMetrics = await cdp.evaluate('({ width: innerWidth, height: innerHeight, scale: devicePixelRatio, workspace: document.getElementById("main-content")?.getAttribute("aria-label") ?? null })');
    // (a) Idle with the window open, then with it closed to the menu bar.
    await holdState("idle-settling", idleSettleMs);
    await holdState("idle", idleSampleMs);
    await captureFrame(cdp, "idle");
    states.push({ state: "idle", budgetKind: "idle", exercised: true, exercisedDetail: `Window open, ${idleSettleMs / 1000} s after launch settled.` });
    await cdp.invoke("__window_hide__");
    await holdState("idle-hidden-settling", hiddenSettleMs);
    await holdState("idle-hidden", idleSampleMs);
    states.push({ state: "idle-hidden", budgetKind: "idle", exercised: true, exercisedDetail: "Window closed to the menu bar." });

    // Installed before dictation so the probe sees each dictation's route.
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: FOOTPRINT_PROBE_SOURCE });
    await cdp.evaluate(FOOTPRINT_PROBE_SOURCE);

    // (b) Dictation from the menu bar, kept in Plainsong (no insertion).
    currentState = "dictation";
    for (let index = 0; index < dictationCount; index += 1) {
      const runRecord: DictationRun = { started: false, textChars: 0, fixtureCoverage: null, error: null };
      dictations.push(runRecord);
      try {
        await cdp.invoke("start_dictation", { options: { deliveryMode: "preview", saveToInbox: false } });
        runRecord.started = true;
        await delay(600);
        await captureOverlayFrame(cdp, "dictation");
        const speaker = sayToFixtureDevice(DICTATION_FIXTURE);
        await Promise.race([new Promise((resolve) => speaker.once("exit", resolve)), delay(dictationMs)]);
        await delay(Math.max(0, dictationMs - 7_000));
        const result = await cdp.invoke("stop_dictation", {}, 180_000);
        const text = typeof result === "string" ? result : typeof result?.text === "string" ? result.text : "";
        runRecord.textChars = text.trim().length;
        runRecord.fixtureCoverage = matchSpokenFixture(text, DICTATION_FIXTURE).coverage;
      } catch (dictationError) {
        runRecord.error = dictationError instanceof Error ? dictationError.message : String(dictationError);
        await cdp.invoke("force_stop_dictation").catch(() => undefined);
      }
      await delay(5_000);
    }
    const dictationOk = dictations.length > 0 && dictations.every((entry) => entry.started && (entry.fixtureCoverage ?? 0) >= 0.5);
    states.push({
      state: "dictation",
      budgetKind: "dictation",
      exercised: dictationOk,
      exercisedDetail: dictations
        .map((entry, index) => `Run ${index + 1}: ${entry.error ? `error: ${entry.error}` : `${entry.textChars} chars, fixture coverage ${entry.fixtureCoverage}`}.`)
        .join(" "),
    });

    // Reopen as the tray does, and time it to the first painted frame.
    currentState = "between";
    const reopenStarted = Date.now();
    await cdp.invoke("__window_show__");
    const painted = await cdp.evaluate(
      'new Promise((resolve) => { const check = () => document.visibilityState === "visible" && document.querySelector("main#main-content") ? requestAnimationFrame(() => resolve(true)) : setTimeout(check, 5); check(); setTimeout(() => resolve(false), 10000); })',
      15_000,
    );
    reopenFromHiddenMs = painted ? Date.now() - reopenStarted : null;
    if (!painted) throw new Error("The workspace did not paint after reopening from the tray.");
    await delay(10_000);

    dictationRoutes = (await cdp.evaluate("window.__footprintDictationRoutes")) ?? [];

    // LAT-01 changes only Light-tier CPU residency. Keep the other routes'
    // qualification workload unchanged.
    cpuIdleExpected = tier === "light" && (
      dictationRoutes.some((route) => route.engine === "coreml_cpu") ||
      speechRouteEvidence(samples, "dictation", dictationRoutes, "cpu").route === "coreml-cpu"
    );
    if (cpuIdleExpected) {
      await holdState("idle-after-dictation", idleSampleMs);
      const retainedSpeechObserved = samples.some((sample) =>
        sample.state === "idle-after-dictation" &&
        sample.processes.some((process) => process.label === NEURAL_ENGINE_ASR_LABEL),
      );
      states.push({
        state: "idle-after-dictation",
        budgetKind: "idle",
        exercised: dictationOk && retainedSpeechObserved,
        exercisedDetail: `Workspace reopened after CPU dictation; retained speech helper observed: ${retainedSpeechObserved}. All helper memory counts against idle.`,
      });
    }

    // (c) A live meeting with spoken fixtures on the virtual input.
    if (includeSystemAudio) {
      const verification = await cdp.invoke("test_system_audio_capture", {}, 60_000);
      if (verification?.capability?.ready !== true) {
        throw new Error("System audio is not ready for Me + Them capture in this session. Grant system audio recording or pass --mic-only.");
      }
    }
    const setup = await cdp.invoke("verify_meeting_setup", {}, 120_000);
    if (!setup?.ok) throw new Error(`Meeting setup is not ready: ${setup?.summary ?? "unknown"}`);
    const options = {
      mic: true,
      systemAudio: includeSystemAudio,
      projectId: "inbox",
      template: "meeting",
      meetingCaptureMode: includeSystemAudio ? "me_and_them" : "mic_only",
    };
    // Dictation's live preview can stream on the same channel.
    const liveEventsBefore = Number(await cdp.evaluate("window.__footprintLiveEvents")) || 0;
    currentState = "meeting";
    await cdp.pressShiftInWindow();
    const started = await cdp.invoke("begin_meeting_capture", { options }, 120_000);
    const recordingId = typeof started === "string" ? started : started?.recordingId;
    if (typeof recordingId !== "string") throw new Error("Meeting capture did not return a recording ID.");
    const stopFixture = startFixtureLoop(MEETING_FIXTURE, 4_000);
    await delay(meetingMs);
    const overlay = await cdp.invoke("get_recording_overlay_state");
    await captureFrame(cdp, "meeting");
    await captureOverlayFrame(cdp, "recording");
    await stopFixture();
    const liveEvents = (Number(await cdp.evaluate("window.__footprintLiveEvents")) || 0) - liveEventsBefore;

    // (d) Stop, then everything the app does after the call.
    currentState = "post-call";
    await cdp.pressShiftInWindow();
    await cdp.invoke("end_meeting_capture", { recordingId }, 120_000);
    const postStarted = Date.now();
    // Search indexing of the call is post-call work too; on a busy Mac it
    // retries after notes, so the state lasts until the index covers the call.
    const indexExpected = searchIndexExpected(await cdp.invoke("get_embedding_status").catch(() => null));
    let indexedAfterMs: number | null = null;
    let indexStatus: any = null;
    let recording: any = null;
    let completedAfterMs: number | null = null;
    let notesSettledAfterMs: number | null = null;
    let quietSince: number | null = null;
    while (Date.now() - postStarted < postCallTimeoutMs) {
      recording = await cdp.invoke("get_recording", { recordingId }).catch(() => recording);
      if (completedAfterMs === null && recording?.status === "completed") {
        completedAfterMs = Date.now() - postStarted;
      }
      const analysisPhase = await cdp.evaluate(`window.__footprintAnalysis?.[${JSON.stringify(recordingId)}]`);
      const notesDone = !notesExpected || analysisPhase === "completed" || analysisPhase === "failed";
      if (notesExpected && notesDone && notesSettledAfterMs === null) notesSettledAfterMs = Date.now() - postStarted;
      if (indexExpected && indexedAfterMs === null && completedAfterMs !== null) {
        indexStatus = await cdp.invoke("get_embedding_status").catch(() => indexStatus);
        if (searchIndexSettled(indexStatus)) indexedAfterMs = Date.now() - postStarted;
      }
      const indexDone = !indexExpected || indexedAfterMs !== null;
      const cpu = nativeWorkCpu();
      quietSince = cpu !== null && cpu < 5 ? quietSince ?? Date.now() : null;
      if (completedAfterMs !== null && notesDone && indexDone && quietSince !== null && Date.now() - quietSince >= 15_000) break;
      await delay(1_000);
    }
    const helperEvidence = await cdp.invoke("get_embedding_status");
    const helperReports = helperEvidence?.qaHelperFootprints;
    if (helperReports?.overflow) measurementErrors.push("The helper snapshot history overflowed; process coverage is incomplete.");
    for (const report of (helperReports?.reports ?? [])) {
      try {
        const sample = helperCompletionSample(report, startedAt, "post-call", rootPid ?? undefined);
        const state = helperCompletionState(samples, sample.elapsedMs);
        sample.state = state;
        samples.push(sample);
        const kind = state === "idle" || state === "idle-hidden" ? "idle" : state === "dictation" ? "dictation" : state === "meeting" ? "meeting" : notesExpected ? "notes" : "meeting";
        const transientUpperBound = sample.transientUpperBoundBytes ?? sample.totalBytes;
        if (state === "meeting" || state === "dictation") measurementErrors.push("A search helper ran during live capture.");
        if (transientUpperBound > budgetBytes(tier, kind) && sample.totalBytes <= budgetBytes(tier, kind)) {
          measurementErrors.push("A helper lifetime peak could exceed the concurrent state budget; the limit is not qualified.");
        }
      } catch (error) {
        measurementErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    samples.sort((left, right) => left.elapsedMs - right.elapsedMs);
    const transcript = await cdp.invoke("get_transcript", { recordingId }).catch(() => null);
    const fullText = String(transcript?.fullText ?? transcript?.full_text ?? "");
    const details = await cdp.invoke("get_meeting_transcript_details", { recordingId }).catch(() => null);
    // The profile's meeting route may name a model that is not downloaded, in
    // which case the app falls back; record what really ran.
    const requestedRoute = String(details?.requestedProvider ?? "unknown");
    const actualRoute = `${details?.actualProvider ?? "unknown"}/${details?.modelId ?? details?.model ?? "unknown"}`;
    if (!actualRoute.startsWith(`${requestedRoute}/`)) {
      notes.push(`The meeting asked for ${requestedRoute} but was transcribed by ${actualRoute}.`);
    }
    meetingReportedRoute = { provider: details?.actualProvider ?? null, engine: null, modelId: details?.modelId ?? details?.model ?? null };
    const coverage = matchSpokenFixture(fullText, MEETING_FIXTURE).coverage;
    const postCallSettled = completedAfterMs !== null && quietSince !== null && Date.now() - quietSince >= 15_000;
    meeting = {
      captureMode: options.meetingCaptureMode,
      requestedRoute,
      actualRoute,
      overlayPhase: overlay?.phase ?? null,
      liveEvents,
      transcriptChars: fullText.trim().length,
      fixtureCoverage: coverage,
      status: recording?.status ?? null,
      completedAfterMs,
      notesExpected,
      notesMemoryAttributed,
      notesSettledAfterMs,
      summaryPresent: Boolean(recording?.summary),
      analysisFailed: Boolean(recording?.analysisFailure),
      // The app's own notice; the fixtures are synthetic speech.
      analysisFailure: recording?.analysisFailure ? String(recording.analysisFailure).slice(0, 400) : null,
      postCallSettled,
      searchIndexExpected: indexExpected,
      searchIndexedAfterMs: indexedAfterMs,
      searchIndexLastError: indexStatus?.lastError ?? null,
    };
    states.push({
      state: "meeting",
      budgetKind: "meeting",
      exercised: overlay?.phase === "recording" && liveEvents > 0 && coverage >= 0.5,
      exercisedDetail: `${meetingMs / 1000} s ${options.meetingCaptureMode} capture transcribed by ${actualRoute}; live phase ${overlay?.phase ?? "unknown"}; ${liveEvents} live transcript events; final transcript fixture coverage ${coverage}.`,
    });
    states.push({
      state: "post-call",
      budgetKind: notesExpected ? "notes" : "meeting",
      exercised: postCallSettled && notesMemoryAttributed && (!indexExpected || indexedAfterMs !== null) &&
        (!notesExpected || (notesSettledAfterMs !== null && Boolean(recording?.summary) && !recording?.analysisFailure)),
      exercisedDetail: `Transcript completed after ${completedAfterMs ?? "never"} ms; notes ${
        notesExpected ? (recording?.summary ? "written" : recording?.analysisFailure ? `failed (${String(recording.analysisFailure).slice(0, 400)})` : "not finished") : `skipped: ${notesSkipReason}`
      }; search index ${indexExpected ? (indexedAfterMs !== null ? `covered the call after ${indexedAfterMs} ms` : "never covered the call") : "not expected (built-in search off or not downloaded)"}; native workers quiet for 15 s: ${postCallSettled ? "yes" : "no"}.`,
    });
    if (!notesExpected) {
      notes.push(`Notes after the call skipped: ${notesSkipReason}. The post-call state is judged against the meeting budget.`);
    }

    // (e) Wait for the speech model's idle release. System memory counts
    // against speech only if it goes when the Core ML speech helper does.
    const helperSeen = systemSamples.some((sample) => sample.neuralEngineHelperAlive) ||
      samples.some((sample) => sample.processes.some((entry) => entry.label === NEURAL_ENGINE_ASR_LABEL));
    if (helperSeen) {
      const current = await cdp.invoke("get_settings").catch(() => effectiveSettings);
      const keepReadyMs = speechModelKeepReadyMs(tier, current?.transcription?.speechModelKeepReady);
      // The idle check runs every 5 s; the margin also covers a slow exit.
      const timeoutMs = speechReleaseTimeoutOverride ?? (keepReadyMs === null ? null : keepReadyMs + 60_000);
      const helperRunning = () => neuralEngineHelperAlive(parseProcessTable(run("/bin/ps", ["-axo", "pid=,ppid=,pcpu=,command="])));
      if (timeoutMs === null) {
        notes.push("Keep speech model ready is set to Always, so the release that attributes system memory to speech never happens in this run.");
      } else {
        currentState = "speech-release-wait";
        const waitStarted = Date.now();
        while (helperRunning() && Date.now() - waitStarted < timeoutMs) await delay(2_000);
        if (helperRunning()) {
          notes.push(`The Core ML speech helper was still running ${Math.round(timeoutMs / 1000)} s after post-call work finished, so its system memory cannot be attributed.`);
        } else {
          notes.push(`The Core ML speech helper released its model ${Math.round((Date.now() - waitStarted) / 1000)} s after post-call work finished.`);
          currentState = "speech-released";
          await delay(releaseSampleMs);
        }
      }
    }
  } catch (runError) {
    error = runError instanceof Error ? runError.message : String(runError);
  } finally {
    sampling = false;
    await sampler;
    await systemSampler;
    await cdp.send("Browser.close", {}, 5_000, true).catch(() => undefined);
    await delay(1_500);
    const remaining = await terminateProfileProcesses(qaProfile.electronUserDataDir);
    if (remaining.length > 0) notes.push(`Process groups still alive after cleanup: ${remaining.length}.`);
    qaProfile.cleanup();
  }

  const results: StateResult[] = states.map((window) => summarizeState(window, samples, tier));
  const required: Array<[string, BudgetKind]> = [
    ["idle", "idle"],
    ["idle-hidden", "idle"],
    ["dictation", "dictation"],
    ["meeting", "meeting"],
    ["post-call", "meeting"],
  ];
  if (cpuIdleExpected) required.push(["idle-after-dictation", "idle"]);
  for (const [state, budgetKind] of required) {
    if (!results.some((result) => result.state === state)) {
      results.push(
        summarizeState({ state, budgetKind, exercised: false, exercisedDetail: "Not reached." }, samples, tier),
      );
    }
  }
  // The sidecar runs the Core ML route on the CPU on the Light tier and on
  // the Neural Engine above it, so states whose report names no engine (the
  // meeting's) take the compute units from the tier this run simulated.
  const computeUnitsHint = tier === "light" ? "cpu" as const : "ane" as const;
  const speechRoutes = [
    speechRouteEvidence(samples, "dictation", dictationRoutes, computeUnitsHint),
    ...(cpuIdleExpected ? [speechRouteEvidence(samples, "idle-after-dictation", dictationRoutes, computeUnitsHint)] : []),
    speechRouteEvidence(samples, "meeting", meetingReportedRoute ? [meetingReportedRoute] : [], computeUnitsHint),
    speechRouteEvidence(samples, "post-call", meetingReportedRoute ? [meetingReportedRoute] : [], computeUnitsHint),
  ];
  const systemMemory = buildSystemMemoryReport(
    baselineSystemSamples,
    systemSamples,
    results,
    (state) => speechRoutes.some((route) => route.state === state && (route.route === "neural-engine" || route.route === "coreml-cpu")),
    otherInstanceRunning,
  );
  notes.push(...systemNotes, ...systemMemory.warnings.map((warning) => `WARN: ${warning}`));
  const processPeaks = summarizeProcessPeaks(samples);
  for (const peak of processPeaks.filter((row) => row.verdict === "unsampled-spike")) {
    notes.push(`${peak.label} (${peak.pid}) reached a lifetime peak of ${Math.round((peak.lifetimePeakBytes ?? 0) / 1048576)} MiB, above its highest sample of ${Math.round(peak.sampledPeakBytes / 1048576)} MiB; a state may have been over budget between samples.`);
  }
  if (meetingReportedRoute) {
    notes.push("The meeting transcript records the selected model, not the runtime that decoded it; the meeting speech route comes from process evidence.");
  }
  notes.push(...[...new Set(measurementErrors)]);
  if (captureFrames) notes.push("Frames were captured for visual review. Screenshot allocations can affect app memory, so this experiment cannot qualify a release.");
  if (!standardWorkload) notes.push("Shortened or altered sampling workload. This run cannot qualify a release.");
  const generatedAt = new Date().toISOString();
  const summary = {
    generatedAt,
    pass: gatePassed({ error, simulationReachedSidecar, measurementErrors,
      experimental: captureFrames || extraAppArgs.length > 0 || extraSettings.length > 0 || meetingRoute !== null || notesMode !== "auto" || !includeSystemAudio,
      standardWorkload, states: results, effective: systemMemory.effective }),
    measurementErrors,
    captureFrames,
    standardWorkload,
    attribution,
    speechRoutes,
    processPeaks,
    systemMemory,
    appPath,
    simulateGb,
    simulateAvailableGb,
    tier,
    simulationReachedSidecar,
    states: results,
    launchPeakBytes,
    windowMetrics,
    launchUi,
    reopenFromHiddenMs,
    error,
    notes,
  };
  const receipt = bindAppReceipt(
    {
      ...summary,
      candidatePath,
      candidateIdentity,
      sampleIntervalMs,
      fixtureDevice,
      includeSystemAudio,
      extraAppArgs,
      extraSettings,
      dictations,
      meeting,
      // Compact timeline: per-process bytes by label, no command lines.
      timeline: samples.map((sample) => ({
        elapsedMs: sample.elapsedMs,
        state: sample.state,
        source: sample.source ?? "periodic",
        totalBytes: sample.totalBytes,
        processes: sample.processes.map((entry) => ({ label: entry.label, pid: entry.pid, bytes: entry.bytes, peakBytes: entry.peakBytes ?? null, cpuPct: entry.cpuPct, cpuMs: entry.cpuMs })),
      })),
      systemSampleIntervalMs,
      systemBaselineTimeline: baselineSystemSamples,
      systemTimeline: systemSamples,
    },
    binding,
  );
  const command = `bun run qa:packaged:macos:footprint -- --simulate-gb ${simulateGb}${
    simulateAvailableGb === null ? "" : ` --simulate-available-gb ${simulateAvailableGb}`
  }${
    appPath === path.resolve(repoRoot, "release/mac-arm64/Plainsong.app") ? "" : ` --app ${appPath}`
  }`;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`);
  fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
  fs.writeFileSync(markdownPath, renderFootprintMarkdown({ ...summary, pass: receipt.pass }, command));
  console.log(
    JSON.stringify(
      {
        pass: receipt.pass,
        tier,
        error,
        states: results.map((result) => ({
          state: result.state,
          peakMb: Math.round(result.peakBytes / 1048576),
          budgetMb: Math.round(result.budgetBytes / 1048576),
          pass: result.pass,
          exercised: result.exercised,
          ...(() => {
            const effective = systemMemory.effective.find((row) => row.state === result.state);
            return effective ? {
              effectiveMb: Math.round(effective.effectiveBytes / 1048576),
              effective: effective.verdict,
              attribution: effective.attribution.status,
            } : {};
          })(),
        })),
        systemMemoryWarnings: systemMemory.warnings,
        speechRoutes: speechRoutes.map((route) => ({ state: route.state, route: route.route })),
        out: outPath,
      },
      null,
      2,
    ),
  );
  process.exit(receipt.pass ? 0 : 1);
}

main().catch((mainError) => {
  console.error(mainError instanceof Error ? mainError.stack : mainError);
  process.exit(1);
});
