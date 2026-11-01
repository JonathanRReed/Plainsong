/**
 * System memory the packaged footprint gate attributes to speech.
 *
 * On most Apple Silicon Macs, Parakeet's Core ML build runs on the Neural
 * Engine in `plainsong-native-asr-helper`. The helper's own `phys_footprint`
 * is small, but loading its model wires memory in the kernel's Neural Engine
 * driver and in the system services that compile and serve the model. None of
 * that is in the app's process tree, yet an 8 GB Mac loses it all the same.
 * On the Light tier the same model decodes on the CPU instead: nothing is
 * wired, so this attribution should find nothing to charge.
 *
 * The gate therefore also samples system wired and compressor memory
 * (`vm_stat`) against a pre-launch baseline, and the footprint of the Neural
 * Engine services. A rise counts against a state's budget only when it is
 * attributable: it appears while the helper holds its model and mostly
 * disappears once the idle release (`speech_residency.rs`) stops the helper.
 * Anything else on a shared Mac can move wired memory too, so an
 * unattributable rise is reported as a warning, never as a failure.
 */
import type { HardwareTier, ProcessRow, StateResult } from "./footprint-gate.ts";

const MIB = 1024 * 1024;

export interface VmStatSnapshot {
  pageSizeBytes: number;
  wiredBytes: number;
  /** Physical memory the compressor occupies ("Pages occupied by compressor"). */
  compressorBytes: number;
  /** Logical memory held compressed ("Pages stored in compressor"). */
  storedInCompressorBytes: number;
  freeBytes: number;
}

/** Parse `vm_stat` output. Returns null when the counters the gate needs are missing. */
export function parseVmStat(output: string): VmStatSnapshot | null {
  const pageSize = Number(output.match(/page size of (\d+) bytes/)?.[1]);
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) return null;
  const pages = new Map<string, number>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*"?([^":]+?)"?:\s+(\d+)\.?\s*$/);
    if (match) pages.set(match[1].trim(), Number(match[2]));
  }
  const read = (name: string): number | null => {
    const value = pages.get(name);
    return value === undefined || !Number.isSafeInteger(value) ? null : value * pageSize;
  };
  const wiredBytes = read("Pages wired down");
  const compressorBytes = read("Pages occupied by compressor");
  if (wiredBytes === null || compressorBytes === null) return null;
  return {
    pageSizeBytes: pageSize,
    wiredBytes,
    compressorBytes,
    storedInCompressorBytes: read("Pages stored in compressor") ?? 0,
    freeBytes: read("Pages free") ?? 0,
  };
}

/**
 * System processes that compile, load and schedule Core ML models on the
 * Neural Engine for other apps. `aned` is the Neural Engine daemon,
 * `aneuserd` its per-user counterpart, `ANECompilerService` compiles a model
 * for the Neural Engine on first load, and `ANEStorageMaintainer` prunes the
 * compiled-model cache.
 */
const NEURAL_ENGINE_SERVICES = ["aned", "aneuserd", "ANECompilerService", "ANEStorageMaintainer"] as const;

/** The service name of a system Neural Engine process, or null for anything else. */
export function neuralEngineServiceName(command: string): string | null {
  const executable = command.trim().split(/\s+/)[0] ?? "";
  // Only Apple's own copies: a user process with the same name is not one.
  if (!/^\/(usr\/libexec|System\/Library)\//.test(executable)) return null;
  const name = executable.split("/").pop() ?? "";
  return (NEURAL_ENGINE_SERVICES as readonly string[]).includes(name) ? name : null;
}

export function findNeuralEngineServices(rows: ProcessRow[]): Array<{ pid: number; name: string }> {
  return rows.flatMap((row) => {
    const name = neuralEngineServiceName(row.command);
    return name ? [{ pid: row.pid, name }] : [];
  });
}

const TOP_UNITS: Record<string, number> = { B: 1, K: 1024, M: MIB, G: 1024 * MIB, T: 1024 * 1024 * MIB };

/**
 * Parse `top -l 1 -s 0 -stats pid,mem -pid …`. `top` reads other users'
 * `phys_footprint` (its `mem` column) through the system, where `footprint`
 * needs root. Values look like `12M`, `1153K+` or `1.2G`.
 */
export function parseTopMemory(output: string): Map<number, number> {
  const rows = new Map<number, number>();
  let inTable = false;
  for (const line of output.split(/\r?\n/)) {
    if (/^\s*PID\s+MEM\s*$/.test(line)) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    const match = line.match(/^\s*(\d+)\s+(\d+(?:\.\d+)?)([BKMGT])?[+-]?\s*$/);
    if (match) rows.set(Number(match[1]), Math.round(Number(match[2]) * TOP_UNITS[match[3] ?? "B"]));
  }
  return rows;
}

export type ServiceReadSource = "footprint" | "top";

export interface ServiceFootprint {
  name: string;
  pid: number;
  /** null: running, but neither `footprint` nor `top` could read it. */
  bytes: number | null;
  source: ServiceReadSource | null;
}

export interface SystemMemorySample {
  at: string;
  elapsedMs: number;
  state: string;
  wiredBytes: number;
  compressorBytes: number;
  /** Whether the app's Neural Engine helper process was alive at this sample. */
  neuralEngineHelperAlive: boolean;
  services: ServiceFootprint[];
}

/** Summed service footprint, or null when any running service was unreadable. */
export function serviceTotalBytes(sample: SystemMemorySample): number | null {
  let total = 0;
  for (const service of sample.services) {
    if (service.bytes === null) return null;
    total += service.bytes;
  }
  return total;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

export interface SystemMemoryBaseline {
  samples: number;
  wiredBytes: number;
  compressorBytes: number;
  serviceBytes: number | null;
  /** Another Plainsong was running while the baseline was taken. */
  otherInstanceRunning: boolean;
}

/** Medians of the samples taken before launch, with the app not running. */
export function systemBaseline(samples: SystemMemorySample[], otherInstanceRunning = false): SystemMemoryBaseline | null {
  if (samples.length === 0) return null;
  const services = samples.map(serviceTotalBytes).filter((value): value is number => value !== null);
  return {
    samples: samples.length,
    wiredBytes: median(samples.map((sample) => sample.wiredBytes))!,
    compressorBytes: median(samples.map((sample) => sample.compressorBytes))!,
    serviceBytes: median(services),
    otherInstanceRunning,
  };
}

export interface SystemStateSummary {
  state: string;
  samples: number;
  peakWiredDeltaBytes: number | null;
  medianWiredDeltaBytes: number | null;
  /** Median wired delta over the samples taken while the helper was alive. */
  loadedWiredDeltaBytes: number | null;
  peakCompressorDeltaBytes: number | null;
  /** Highest summed service footprint above the baseline; null if unreadable. */
  peakServiceDeltaBytes: number | null;
  neuralEngineHelperAliveSamples: number;
}

export function summarizeSystemState(
  state: string,
  samples: SystemMemorySample[],
  baseline: SystemMemoryBaseline | null,
): SystemStateSummary {
  const inState = samples.filter((sample) => sample.state === state);
  const wired = baseline ? inState.map((sample) => sample.wiredBytes - baseline.wiredBytes) : [];
  const loaded = baseline
    ? inState.filter((sample) => sample.neuralEngineHelperAlive).map((sample) => sample.wiredBytes - baseline.wiredBytes)
    : [];
  const compressor = baseline ? inState.map((sample) => sample.compressorBytes - baseline.compressorBytes) : [];
  const serviceTotals = inState.map(serviceTotalBytes);
  const servicesReadable = baseline?.serviceBytes !== null && baseline !== null &&
    serviceTotals.length > 0 && serviceTotals.every((value) => value !== null);
  return {
    state,
    samples: inState.length,
    peakWiredDeltaBytes: wired.length ? Math.max(...wired) : null,
    medianWiredDeltaBytes: median(wired),
    loadedWiredDeltaBytes: median(loaded),
    peakCompressorDeltaBytes: compressor.length ? Math.max(...compressor) : null,
    peakServiceDeltaBytes: servicesReadable
      ? Math.max(...(serviceTotals as number[]).map((value) => value - baseline!.serviceBytes!))
      : null,
    neuralEngineHelperAliveSamples: inState.filter((sample) => sample.neuralEngineHelperAlive).length,
  };
}

/** A wired-memory move smaller than this is ordinary churn on a shared Mac. */
export const ATTRIBUTION_NOISE_FLOOR_BYTES = 64 * MIB;
/** Share of the rise that may remain after the release and still count as gone. */
const ATTRIBUTION_RESIDUAL_FRACTION = 0.25;

export type NeuralEngineAttributionStatus = "attributed" | "partly-attributed" | "unattributed" | "below-noise" | "not-applicable";

export interface NeuralEngineAttributionInput {
  /** The helper held a model, or did the decoding, in this state. */
  neuralEngineUsed: boolean;
  /** Wired delta with the app running but no speech model loaded yet. */
  preLoadWiredDeltaBytes: number | null;
  /** Wired delta while the helper held its model in this state. */
  loadedWiredDeltaBytes: number | null;
  /** The idle release stopped the helper while the gate was still sampling. */
  releaseObserved: boolean;
  /** Wired delta after the release. */
  releasedWiredDeltaBytes: number | null;
  /** Neural Engine service footprint above the baseline; null if unreadable. */
  serviceDeltaBytes: number | null;
}

export interface NeuralEngineAttribution {
  status: NeuralEngineAttributionStatus;
  /** Wired-memory rise with the model loaded over the pre-load reference. */
  riseBytes: number | null;
  /** What the effective figure adds to the app tree: the rise plus the services' growth. */
  neuralEngineDeltaBytes: number;
  reason: string;
}

const mib = (bytes: number) => `${Math.round(bytes / MIB)} MiB`;

/**
 * Whether a state's system wired-memory rise belongs to the speech model:
 * it must be above the noise floor while the helper holds its model, and at
 * most a quarter of it (or the noise floor, if larger) may remain once the
 * idle release has stopped the helper.
 */
export function attributeNeuralEngineMemory(input: NeuralEngineAttributionInput): NeuralEngineAttribution {
  if (!input.neuralEngineUsed) {
    return { status: "not-applicable", riseBytes: null, neuralEngineDeltaBytes: 0, reason: "The Neural Engine helper held no model in this state." };
  }
  const services = Math.max(0, input.serviceDeltaBytes ?? 0);
  const { preLoadWiredDeltaBytes: before, loadedWiredDeltaBytes: loaded } = input;
  if (before === null || loaded === null) {
    return {
      status: "unattributed", riseBytes: null, neuralEngineDeltaBytes: services,
      reason: before === null
        ? "No sample shows the running app without a loaded speech model, so the rise has no reference."
        : "No system sample was taken while the helper held its model.",
    };
  }
  const rise = loaded - before;
  const delta = Math.max(0, rise) + services;
  if (rise < ATTRIBUTION_NOISE_FLOOR_BYTES) {
    return { status: "below-noise", riseBytes: rise, neuralEngineDeltaBytes: delta,
      reason: `Wired memory rose ${mib(rise)} with the model loaded, below the ${mib(ATTRIBUTION_NOISE_FLOOR_BYTES)} noise floor.` };
  }
  if (!input.releaseObserved) {
    return { status: "unattributed", riseBytes: rise, neuralEngineDeltaBytes: delta,
      reason: `Wired memory rose ${mib(rise)}, but the helper never released its model while the gate sampled, so the rise cannot be tied to it.` };
  }
  if (input.releasedWiredDeltaBytes === null) {
    return { status: "unattributed", riseBytes: rise, neuralEngineDeltaBytes: delta,
      reason: `Wired memory rose ${mib(rise)}, but no system sample was taken after the release.` };
  }
  const residual = input.releasedWiredDeltaBytes - before;
  const allowed = Math.max(ATTRIBUTION_NOISE_FLOOR_BYTES, ATTRIBUTION_RESIDUAL_FRACTION * rise);
  if (residual > allowed) {
    // Part of the rise outlived the helper, so only the part that left with
    // it is charged. That part alone is the speech model's beyond doubt.
    const released = Math.max(0, rise - residual);
    if (released >= ATTRIBUTION_NOISE_FLOOR_BYTES) {
      return { status: "partly-attributed", riseBytes: rise, neuralEngineDeltaBytes: released + services,
        reason: `Wired memory rose ${mib(rise)} with the model loaded and ${mib(residual)} of it remained after the release; the ${mib(released)} released with the helper is charged.` };
    }
    return { status: "unattributed", riseBytes: rise, neuralEngineDeltaBytes: delta,
      reason: `Wired memory rose ${mib(rise)} with the model loaded, but ${mib(residual)} of it remained after the release (at most ${mib(allowed)} may).` };
  }
  return { status: "attributed", riseBytes: rise, neuralEngineDeltaBytes: delta,
    reason: `Wired memory rose ${mib(rise)} with the model loaded and fell back to within ${mib(Math.max(0, residual))} of the reference after the release.` };
}

/**
 * How long the Core ML helper stays ready after its last use. Light uses
 * CPU speech with a 30-minute auto timer; other tiers retain their defaults.
 * Explicit choices override auto. Pressure or heavy work can release earlier.
 * This is used only when the footprint capture has seen the Core ML helper.
 * null means "Always".
 */
export function speechModelKeepReadyMs(tier: HardwareTier, keepReady: unknown): number | null {
  const choices: Record<string, number | null> = {
    "2m": 120_000, "5m": 300_000, "10m": 600_000, "30m": 1_800_000, "1h": 3_600_000, always: null,
  };
  const value = typeof keepReady === "string" ? keepReady.trim() : "auto";
  if (value in choices) return choices[value];
  return { light: 1_800_000, balanced: 300_000, best: 600_000 }[tier];
}

export type EffectiveVerdict = "pass" | "fail" | "warn" | "skipped";

export interface EffectiveStateResult {
  state: string;
  budgetBytes: number;
  appPeakBytes: number;
  neuralEngineDeltaBytes: number;
  effectiveBytes: number;
  attribution: NeuralEngineAttribution;
  verdict: EffectiveVerdict;
}

/**
 * The app tree's peak plus the system memory the speech model costs. Over
 * budget fails when that memory, or the part of it that left with the
 * helper, is attributable; otherwise it warns.
 */
export function effectiveStateResult(
  app: Pick<StateResult, "state" | "budgetBytes" | "peakBytes" | "samples" | "skipped">,
  attribution: NeuralEngineAttribution,
): EffectiveStateResult {
  const effectiveBytes = app.peakBytes + attribution.neuralEngineDeltaBytes;
  const over = effectiveBytes > app.budgetBytes;
  const verdict: EffectiveVerdict = app.skipped || app.samples === 0 ? "skipped"
    : over ? (attribution.status === "unattributed" || attribution.status === "below-noise" ? "warn" : "fail")
    : attribution.status === "unattributed" ? "warn" : "pass";
  return {
    state: app.state,
    budgetBytes: app.budgetBytes,
    appPeakBytes: app.peakBytes,
    neuralEngineDeltaBytes: attribution.neuralEngineDeltaBytes,
    effectiveBytes,
    attribution,
    verdict,
  };
}

/** States whose system memory the receipt reports, in run order. */
const SYSTEM_REPORT_STATES = ["launch", "idle", "idle-hidden", "dictation", "meeting", "post-call", "speech-released"];

export interface SystemMemoryReport {
  baseline: SystemMemoryBaseline | null;
  states: SystemStateSummary[];
  /** Wired delta used as the "no model loaded" reference, and the state it came from. */
  preLoadReference: { state: string; wiredDeltaBytes: number } | null;
  /** The helper stopped while sampling continued, and the wired delta after that. */
  release: { observed: boolean; atElapsedMs: number | null; wiredDeltaBytes: number | null; samples: number };
  effective: EffectiveStateResult[];
  /** Per service: how it was read, or that it was unreadable without root. */
  serviceReadability: Array<{ name: string; read: ServiceReadSource | "unreadable" }>;
  warnings: string[];
}

const SPEECH_STATES = ["dictation", "meeting"];

/** Samples after a helper exit this soon are still settling. */
const RELEASE_SETTLE_MS = 5_000;

export function buildSystemMemoryReport(
  baselineSamples: SystemMemorySample[],
  samples: SystemMemorySample[],
  appStates: StateResult[],
  routeUsedNeuralEngine: (state: string) => boolean = () => false,
  otherInstanceRunning = false,
): SystemMemoryReport {
  const baseline = systemBaseline(baselineSamples, otherInstanceRunning);
  const states = SYSTEM_REPORT_STATES.map((state) => summarizeSystemState(state, samples, baseline));
  const delta = (sample: SystemMemorySample) => sample.wiredBytes - baseline!.wiredBytes;

  const firstAlive = samples.findIndex((sample) => sample.neuralEngineHelperAlive);
  const beforeLoad = firstAlive < 0 ? samples : samples.slice(0, firstAlive);
  let preLoadReference: SystemMemoryReport["preLoadReference"] = null;
  if (baseline) {
    for (const state of ["idle-hidden", "idle"]) {
      const value = median(beforeLoad.filter((sample) => sample.state === state).map(delta));
      if (value !== null) {
        preLoadReference = { state, wiredDeltaBytes: value };
        break;
      }
    }
  }

  let lastAlive = -1;
  samples.forEach((sample, index) => {
    if (sample.neuralEngineHelperAlive) lastAlive = index;
  });
  const releaseAt = lastAlive >= 0 && lastAlive < samples.length - 1 ? samples[lastAlive + 1].elapsedMs : null;
  const afterRelease = releaseAt === null ? [] : samples.filter((sample) => sample.elapsedMs >= releaseAt + RELEASE_SETTLE_MS);
  // The window the gate holds after post-call work has finished; a release
  // during post-call would otherwise be judged against notes or indexing.
  const quiet = afterRelease.filter((sample) => sample.state === "speech-released");
  const released = quiet.length > 0 ? quiet : afterRelease;
  const release = {
    observed: releaseAt !== null,
    atElapsedMs: releaseAt,
    wiredDeltaBytes: baseline ? median(released.map(delta)) : null,
    samples: released.length,
  };

  // What the loaded model cost while speech was the only heavy work. After
  // the call, the notes model and search indexing can wire GPU memory too,
  // and that is already in the app tree's footprint.
  const speechPlateau = baseline
    ? median(samples.filter((sample) => SPEECH_STATES.includes(sample.state) && sample.neuralEngineHelperAlive).map(delta))
    : null;
  const effective = appStates.map((app) => {
    const summary = summarizeSystemState(app.state, samples, baseline);
    const own = summary.loadedWiredDeltaBytes;
    const loaded = SPEECH_STATES.includes(app.state) || own === null || speechPlateau === null ? own : Math.min(own, speechPlateau);
    return effectiveStateResult(app, attributeNeuralEngineMemory({
      neuralEngineUsed: summary.neuralEngineHelperAliveSamples > 0 || routeUsedNeuralEngine(app.state),
      preLoadWiredDeltaBytes: preLoadReference?.wiredDeltaBytes ?? null,
      loadedWiredDeltaBytes: loaded,
      releaseObserved: release.observed,
      releasedWiredDeltaBytes: release.wiredDeltaBytes,
      serviceDeltaBytes: summary.peakServiceDeltaBytes,
    }));
  });

  const sources = new Map<string, Set<ServiceReadSource | "unreadable">>();
  for (const sample of [...baselineSamples, ...samples]) {
    for (const service of sample.services) {
      const set = sources.get(service.name) ?? new Set();
      set.add(service.source ?? "unreadable");
      sources.set(service.name, set);
    }
  }
  const serviceReadability = [...sources].map(([name, set]) => ({
    name,
    // One unreadable sample makes the service's figures incomplete.
    read: set.has("unreadable") ? "unreadable" as const : set.has("footprint") ? "footprint" as const : "top" as const,
  }));

  const warnings: string[] = [];
  if (!baseline) warnings.push("No pre-launch system baseline was recorded, so system memory deltas are unknown.");
  if (otherInstanceRunning) warnings.push("Another Plainsong was running during the pre-launch baseline; its activity is inside the system deltas.");
  for (const row of serviceReadability.filter((entry) => entry.read === "unreadable")) {
    warnings.push(`${row.name} memory could not be read without root; the effective figure leaves it out.`);
  }
  for (const row of effective.filter((entry) => entry.verdict === "warn")) {
    warnings.push(`${row.state}: effective ${mib(row.effectiveBytes)} against ${mib(row.budgetBytes)}, ${row.attribution.status}. ${row.attribution.reason}`);
  }
  return { baseline, states, preLoadReference, release, effective, serviceReadability, warnings };
}

const SYSTEM_MEMORY_CAVEAT =
  "Wired and compressor memory are system-wide. On a shared Mac they include other apps' activity, so a delta is attributed to speech only when it appears while the Neural Engine helper holds its model and disappears after the idle release. Pages that are both wired and owned by a process (for example an IOSurface the helper shares with the Neural Engine) can be counted in the app tree and in the wired delta, so the effective figure is an upper bound.";

const formatOptional = (bytes: number | null) => (bytes === null ? "-" : `${bytes >= 0 ? "+" : ""}${mib(bytes)}`);

export function renderSystemMemoryMarkdown(report: SystemMemoryReport | undefined): string {
  if (!report) return "Not recorded.";
  const baseline = report.baseline
    ? `Pre-launch baseline (app not running, ${report.baseline.samples} samples): wired ${mib(report.baseline.wiredBytes)}, compressor ${mib(report.baseline.compressorBytes)}, Neural Engine services ${report.baseline.serviceBytes === null ? "unreadable" : mib(report.baseline.serviceBytes)}.`
    : "No pre-launch baseline was recorded.";
  const services = report.serviceReadability.length
    ? report.serviceReadability.map((row) => `${row.name} (${row.read === "unreadable" ? "unreadable without root" : `read with ${row.read}`})`).join(", ")
    : "none running";
  const stateRows = report.states.map((row) => `| ${row.state} | ${row.samples} | ${formatOptional(row.peakWiredDeltaBytes)} | ${
    formatOptional(row.medianWiredDeltaBytes)} | ${formatOptional(row.loadedWiredDeltaBytes)} | ${formatOptional(row.peakCompressorDeltaBytes)} | ${
    formatOptional(row.peakServiceDeltaBytes)} | ${row.neuralEngineHelperAliveSamples} |`).join("\n");
  const effectiveRows = report.effective.map((row) => `| ${row.state} | ${row.attribution.status} | ${formatOptional(row.attribution.riseBytes)} | ${
    mib(row.neuralEngineDeltaBytes)} | ${mib(row.appPeakBytes)} | ${mib(row.effectiveBytes)} | ${mib(row.budgetBytes)} | ${row.verdict.toUpperCase()} | ${row.attribution.reason} |`).join("\n");
  return `${SYSTEM_MEMORY_CAVEAT}

${baseline}

Neural Engine services: ${services}.

No-model reference: ${report.preLoadReference ? `${report.preLoadReference.state}, wired ${formatOptional(report.preLoadReference.wiredDeltaBytes)}` : "none"}. Helper release: ${
    report.release.observed ? `observed at ${Math.round((report.release.atElapsedMs ?? 0) / 1000)} s, wired ${formatOptional(report.release.wiredDeltaBytes)} afterwards over ${report.release.samples} samples` : "not observed"}.

| State | Samples | Peak wired Δ | Median wired Δ | Wired Δ with model loaded | Peak compressor Δ | Neural Engine services Δ | Helper alive samples |
|---|---|---|---|---|---|---|---|
${stateRows}

Deltas are against the pre-launch baseline. The effective figure adds the wired rise over the no-model reference and the services' growth to the app tree's peak. A state outside dictation and the meeting is charged at most what the loaded model cost during them, since notes and search work wire GPU memory the app tree already counts.

| State | Attribution | Wired rise | Added | App tree peak | Effective | Limit | Result | Why |
|---|---|---|---|---|---|---|---|---|
${effectiveRows}`;
}
