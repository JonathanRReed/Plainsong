/**
 * Pure logic for the packaged footprint gate (`qa:packaged:macos:footprint`):
 * which processes belong to the app, how `footprint` output is read, which
 * budget applies, and how a run is judged and written up.
 *
 * The budgets are the ones `rust-sidecar/src/hardware_tier.rs` defines. They
 * are repeated here only because the gate has to judge older candidates that
 * cannot report them; `packaged-footprint-gate.test.ts` reads the Rust source
 * and fails if the two ever differ.
 */

import { renderSystemMemoryMarkdown, type SystemMemoryReport } from "./system-memory-gate.ts";

export type HardwareTier = "light" | "balanced" | "best";
export type BudgetKind = "idle" | "dictation" | "meeting" | "notes";

const MIB = 1024 * 1024;

export const TIER_BUDGET_MIB: Record<HardwareTier, Record<BudgetKind, number>> = {
  light: { idle: 300, dictation: 1024, meeting: 1536, notes: 2560 },
  balanced: { idle: 400, dictation: 1536, meeting: 2048, notes: 4096 },
  best: { idle: 500, dictation: 2048, meeting: 3072, notes: 7168 },
};

/** Same thresholds as `HardwareTier::for_physical_bytes`. */
export function tierForPhysicalGb(gb: number): HardwareTier {
  if (gb < 12) return "light";
  if (gb < 20) return "balanced";
  return "best";
}

export function budgetBytes(tier: HardwareTier, kind: BudgetKind): number {
  return TIER_BUDGET_MIB[tier][kind] * MIB;
}

/** Missing measurements are safe only when that process has exited. */
export function measurementComplete(expected: number[], measured: number[], alive: number[]): boolean {
  const found = new Set(measured);
  const living = new Set(alive);
  return expected.every((pid) => found.has(pid) || !living.has(pid));
}

export function gatePassed(run: {
  error: string | null;
  simulationReachedSidecar: boolean | null;
  measurementErrors: string[];
  experimental: boolean;
  standardWorkload: boolean;
  states: Array<{ pass: boolean }>;
  /** App tree plus attributable system Neural Engine memory; only a "fail" counts. */
  effective?: Array<{ verdict: string }>;
}): boolean {
  return run.error === null && run.simulationReachedSidecar === true &&
    run.measurementErrors.length === 0 && !run.experimental && run.standardWorkload &&
    run.states.length > 0 && run.states.every((state) => state.pass) &&
    (run.effective ?? []).every((state) => state.verdict !== "fail");
}

/** A footprint receipt as the release audit reads it from disk. */
export interface FootprintReceiptLike {
  error?: unknown;
  experimental?: unknown;
  simulateGb?: unknown;
  simulateAvailableGb?: unknown;
  tier?: unknown;
  simulationReachedSidecar?: unknown;
  standardWorkload?: unknown;
  measurementErrors?: unknown;
  extraSettings?: unknown[];
  extraAppArgs?: unknown[];
  states?: Array<{ state?: string; pass?: boolean; samples?: number; exercised?: boolean; skipped?: unknown }>;
  systemMemory?: { effective?: Array<{ state?: string; verdict?: string }> };
}

const RELEASE_STATES = ["idle", "idle-hidden", "dictation", "meeting", "post-call"];

/** States a receipt fails, on the app tree or on the effective figure. */
export function footprintReceiptFailures(receipt: FootprintReceiptLike | null | undefined): string[] {
  const states = Array.isArray(receipt?.states) ? receipt.states : [];
  const effective = Array.isArray(receipt?.systemMemory?.effective) ? receipt.systemMemory.effective : [];
  return [
    ...states.filter((state) => state.pass !== true).map((state) => String(state.state)),
    ...effective.filter((row) => row.verdict === "fail").map((row) => `${row.state} (effective, with system speech memory)`),
  ];
}

/**
 * Whether a footprint receipt qualifies one simulated Mac for release. A
 * receipt from before the gate measured system memory has no effective
 * figures and is judged on the app tree alone. A run that simulated busier
 * other apps is a stress test: it may defer work the standard run must
 * measure, so it never stands in for the standard receipt.
 */
export function footprintReceiptQualifies(receipt: FootprintReceiptLike | null | undefined, simulateGb: number, tier: HardwareTier, excludedState?: "idle-after-dictation"): boolean {
  if (excludedState && (simulateGb !== 8 || tier !== "light")) return false;
  const states = Array.isArray(receipt?.states) ? receipt.states : [];
  const ran = (name: string) => states.some((state) => state.state === name && state.pass === true && (state.samples ?? 0) > 0);
  return receipt?.simulateGb === simulateGb && receipt.tier === tier &&
    receipt.error == null && receipt.experimental !== true &&
    (receipt.simulateAvailableGb ?? null) === null &&
    receipt.simulationReachedSidecar === true && receipt.standardWorkload === true &&
    Array.isArray(receipt.measurementErrors) && receipt.measurementErrors.length === 0 &&
    (receipt.extraSettings ?? []).length === 0 && (receipt.extraAppArgs ?? []).length === 0 &&
    RELEASE_STATES.every(ran) &&
    states.every((state) => (excludedState && state.state === excludedState) || state.pass === true) &&
    (!excludedState || states.some((state) => state.state === excludedState && (state.samples ?? 0) > 0 && state.exercised === true && state.skipped == null)) &&
    !(receipt.systemMemory?.effective ?? []).some((row) => !(excludedState && row.state === excludedState) && row.verdict === "fail");
}

export function simulatedMemoryReached(environment: string, gb: number): boolean {
  return environment.split(/\s+/).includes(`PLAINSONG_SIMULATE_PHYSICAL_MEMORY_GB=${gb}`);
}

/** Whether the sidecar's environment carries the available-memory simulation. */
export function simulatedAvailableReached(environment: string, gb: number): boolean {
  return environment.split(/\s+/).includes(`PLAINSONG_SIMULATE_AVAILABLE_GB=${gb}`);
}

/**
 * `--simulate-available-gb`: the memory, in GB, that other apps leave free
 * on the simulated Mac. Absent means no simulation. It must fit inside the
 * simulated Mac, since the sidecar would otherwise cap it there silently.
 */
export function parseSimulatedAvailableGb(value: string | null, simulateGb: number): number | null | string {
  if (value === null) return null;
  const gb = Number(value);
  if (!Number.isFinite(gb) || gb <= 0) return "--simulate-available-gb must be a positive number.";
  if (gb > simulateGb) return "--simulate-available-gb cannot exceed --simulate-gb.";
  return gb;
}

export function installedOllamaNotesModel(models: unknown, selected: string): boolean {
  return Array.isArray(models) && models.some((model) => typeof model === "string" && model === selected);
}

export interface ComponentAttribution {
  component: string;
  measurement: string;
  evidence: string;
  owner: string;
}

/** ps TIME is cumulative CPU time, unlike its lifetime-average %CPU. */
export function parseCpuTimeMs(value: string): number | null {
  const match = value.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  return ((Number(match[1] ?? 0) * 86400 + Number(match[2] ?? 0) * 3600 +
    Number(match[3]) * 60 + Number(match[4])) * 1000);
}

export interface ProcessRow {
  pid: number;
  ppid: number;
  cpuPct: number;
  command: string;
}

/** Parse `ps -axo pid=,ppid=,pcpu=,command=`. */
export function parseProcessTable(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+([0-9.]+)\s+(.*)$/);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      cpuPct: Number(match[3]),
      command: match[4],
    });
  }
  return rows;
}

/** The root and every process descended from it. */
export function descendantsOf(rootPid: number, rows: ProcessRow[]): ProcessRow[] {
  const children = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const list = children.get(row.ppid) ?? [];
    list.push(row);
    children.set(row.ppid, list);
  }
  const root = rows.find((row) => row.pid === rootPid);
  if (!root) return [];
  const out: ProcessRow[] = [];
  const queue = [root];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const row = queue.shift()!;
    if (seen.has(row.pid)) continue;
    seen.add(row.pid);
    out.push(row);
    queue.push(...(children.get(row.pid) ?? []));
  }
  return out;
}

/**
 * A stable, content-free name for an app process. Command lines carry the
 * profile path and Chromium switches, so receipts keep only this label.
 */
export const NEURAL_ENGINE_ASR_LABEL = "neural-engine-asr-helper";

export function processLabel(command: string): string {
  const executable = command.split(/\s+--/)[0] ?? command;
  if (/plainsong-sidecar/.test(executable) && command.includes("--embedding-helper")) return "embedding-helper";
  if (/plainsong-sidecar/.test(executable)) return "sidecar";
  if (/nautilus-macos-speech-helper/.test(executable)) return "speech-helper";
  // Apple Speech and Parakeet-on-the-Neural-Engine are different routes; one
  // label for both hid which of them a receipt measured.
  if (/plainsong-native-asr-helper/.test(executable)) return NEURAL_ENGINE_ASR_LABEL;
  if (/plainsong-text-helper/.test(executable)) return "text-helper";
  if (/plainsong-native-shortcut-helper/.test(executable)) return "shortcut-helper";
  if (/plainsong-native-calendar-helper/.test(executable)) return "calendar-helper";
  if (/plainsong-native-language-model-helper/.test(executable)) return "language-model-helper";
  const type = command.match(/--type=([a-z-]+)/)?.[1];
  if (type === "renderer") return "renderer";
  if (type === "gpu-process") return "gpu";
  if (type === "utility") {
    const service = command.match(/--utility-sub-type=([A-Za-z.]+)/)?.[1] ?? "utility";
    return `utility:${service.split(".").pop()}`;
  }
  if (type) return type;
  if (/Contents\/MacOS\/Plainsong$/.test(executable)) return "main";
  // Anything else the app started (osascript, afplay, …): its program name
  // only, never its arguments.
  const program = command.trim().split(/\s+/)[0] ?? command;
  return program.split("/").pop() || "process";
}

export interface FootprintCategory {
  category: string;
  dirtyBytes: number;
}

export interface ProcessFootprint {
  pid: number;
  bytes: number;
  peakBytes: number | null;
  categories: FootprintCategory[];
}

/**
 * Parse `footprint -f bytes -p … -p …`. Each process block starts with a
 * `name [pid]: … Footprint: N B` banner, optionally lists categories, and
 * ends with its auxiliary `phys_footprint` lines.
 */
export function parseFootprintOutput(output: string): ProcessFootprint[] {
  const results: ProcessFootprint[] = [];
  let current: ProcessFootprint | null = null;
  // A process's own category table ends at its first TOTAL row. The
  // "Shared with …" tables after it repeat memory another process owns.
  let ownTable = false;
  for (const line of output.split(/\r?\n/)) {
    // An exiting process fails the region walk and its banner loses the
    // Footprint figure; its auxiliary phys_footprint still follows.
    const banner = line.match(/\[(\d+)\]:\s+\d+-bit(?:\s+Footprint:\s+(\d+)\s+B)?/);
    if (banner) {
      current = { pid: Number(banner[1]), bytes: banner[2] === undefined ? NaN : Number(banner[2]), peakBytes: null, categories: [] };
      results.push(current);
      ownTable = true;
      continue;
    }
    // The closing "Summary Footprint" block sums every process, and the
    // "Shared Cache" block belongs to none of them.
    if (/^(Summary Footprint:|Shared Cache\b)/.test(line.trim())) {
      current = null;
      continue;
    }
    if (!current) continue;
    const phys = line.match(/^\s*phys_footprint:\s+(\d+)\s+B/);
    if (phys) {
      current.bytes = Number(phys[1]);
      continue;
    }
    const peak = line.match(/^\s*phys_footprint_peak:\s+(\d+)\s+B/);
    if (peak) {
      current.peakBytes = Number(peak[1]);
      continue;
    }
    const category = line.match(/^\s*(\d+)\s+B\s+\d+\s+B\s+\d+\s+B\s+\d+\s+(.+?)\s*$/);
    if (category?.[2] === "TOTAL") {
      ownTable = false;
      continue;
    }
    if (category && ownTable) {
      const dirtyBytes = Number(category[1]);
      if (dirtyBytes > 0) current.categories.push({ category: category[2], dirtyBytes });
    }
  }
  return results.filter((row) => Number.isFinite(row.bytes));
}

/** Processes still running; a zombie awaiting its parent holds no memory. */
export function livingPids(rows: ProcessRow[]): number[] {
  return rows.filter((row) => row.command.trim() !== "<defunct>").map((row) => row.pid);
}

export interface SampleProcess {
  pid: number;
  label: string;
  bytes: number;
  /** The kernel's lifetime `phys_footprint_peak` for this process so far. */
  peakBytes?: number | null;
  cpuPct?: number;
  /** Cumulative CPU time; recorded for native workers only. */
  cpuMs?: number;
  categories?: FootprintCategory[];
}

export interface FootprintSample {
  source?: "periodic" | "helper-completion";
  transientUpperBoundBytes?: number;
  at: string;
  elapsedMs: number;
  state: string;
  totalBytes: number;
  processes: SampleProcess[];
}

/** Attribute completion snapshots only to the nearest earlier regular sample.
 * Reports arrive out of order and appended helper samples are not state changes.
 */
export function helperCompletionState(samples: readonly FootprintSample[], elapsedMs: number): string {
  let nearest: FootprintSample | undefined;
  for (const sample of samples) {
    if (sample.source === "helper-completion" || sample.elapsedMs > elapsedMs) continue;
    if (!nearest || sample.elapsedMs >= nearest.elapsedMs) nearest = sample;
  }
  return nearest?.state ?? "post-call";
}

interface HelperQaSnapshot {
  captured_at_ms: number;
  helper_pid: number;
  processes: { pid: number; label: string }[];
  alive_after: number[];
  footprint_output: string;
  error: string | null;
}

function parseHelperQaSnapshot(value: unknown): HelperQaSnapshot {
  const fail = (field: string): never => {
    throw new Error(`The helper snapshot has an invalid ${field}.`);
  };
  const record = (input: unknown, field: string): Record<string, unknown> =>
    input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : fail(field);
  const pid = (input: unknown, field: string): number =>
    Number.isSafeInteger(input) && (input as number) > 0 ? (input as number) : fail(field);
  const text = (input: unknown, field: string): string => (typeof input === "string" ? input : fail(field));
  const list = (input: unknown, field: string): unknown[] => (Array.isArray(input) ? input : fail(field));
  const report = record(value, "report");
  const capturedAt = report.captured_at_ms;
  if (!Number.isSafeInteger(capturedAt) || (capturedAt as number) < 0 || (capturedAt as number) > 8.64e15) fail("captured_at_ms");
  return {
    captured_at_ms: capturedAt as number,
    helper_pid: pid(report.helper_pid, "helper_pid"),
    processes: list(report.processes, "processes").map((entry) => {
      const row = record(entry, "processes");
      return { pid: pid(row.pid, "processes pid"), label: text(row.label, "processes label") };
    }),
    alive_after: list(report.alive_after, "alive_after").map((entry) => pid(entry, "alive_after")),
    footprint_output: text(report.footprint_output, "footprint_output"),
    error: report.error === null ? null : text(report.error, "error"),
  };
}

export function helperCompletionSample(value: unknown, startedAt: number, state: string, expectedRootPid?: number): FootprintSample {
  const report = parseHelperQaSnapshot(value);
  if (report.error) throw new Error(report.error);
  if (expectedRootPid !== undefined && !report.processes.some((row) => row.pid === expectedRootPid)) {
    throw new Error("The helper snapshot is missing the app root process.");
  }
  const measured = new Map(parseFootprintOutput(report.footprint_output).map((row) => [row.pid, row]));
  if (!measurementComplete(report.processes.map((row) => row.pid), [...measured.keys()], report.alive_after)) {
    throw new Error("A live app process is missing from the helper snapshot.");
  }
  if (!measured.has(report.helper_pid)) throw new Error("The helper did not measure its own memory.");
  const processes = report.processes.flatMap((row) => {
    const entry = measured.get(row.pid);
    return entry ? [{ pid: row.pid, label: row.label, bytes: entry.bytes, peakBytes: entry.peakBytes, categories: entry.categories }] : [];
  });
  const totalBytes = processes.reduce((sum, row) => sum + row.bytes, 0);
  const helper = measured.get(report.helper_pid)!;
  const transientUpperBoundBytes = totalBytes + Math.max(0, (helper.peakBytes ?? helper.bytes) - helper.bytes);
  return { at: new Date(report.captured_at_ms).toISOString(), elapsedMs: report.captured_at_ms - startedAt,
    state, source: "helper-completion", totalBytes, transientUpperBoundBytes, processes };
}

/** The part of `get_embedding_status` the gate reads. */
export interface SearchIndexStatus {
  memorySearchMode?: string;
  builtInAvailable?: boolean;
  builtInModels?: Array<{ id?: string; downloaded?: boolean }>;
  selectedBuiltInModel?: string;
  indexedRecordings?: number | null;
  totalRecordings?: number | null;
  indexing?: boolean;
}

/**
 * Whether the app will index the call for meaning search on its own: the
 * built-in route is selected and its model is on disk. Indexing then belongs
 * to the post-call state, which is not over until it has run.
 */
export function searchIndexExpected(status: SearchIndexStatus | null | undefined): boolean {
  if (!status || status.memorySearchMode !== "builtin" || status.builtInAvailable !== true) return false;
  return (status.builtInModels ?? []).some((model) => model.id === status.selectedBuiltInModel && model.downloaded === true);
}

export function searchIndexSettled(status: SearchIndexStatus | null | undefined): boolean {
  const indexed = status?.indexedRecordings;
  const total = status?.totalRecordings;
  return typeof indexed === "number" && typeof total === "number" && total > 0 && indexed >= total && status?.indexing !== true;
}

export interface StateWindow {
  /** Receipt name of the measured state. */
  state: string;
  budgetKind: BudgetKind;
  /** Whether the state actually ran; a skipped state is reported, not judged. */
  skipped?: string | null;
  /** Why the state counts as exercised, or what was missing. */
  exercised: boolean;
  exercisedDetail: string;
}

export interface StateResult extends StateWindow {
  samples: number;
  budgetBytes: number;
  peakBytes: number;
  meanBytes: number;
  peakAt: string | null;
  peakSource: string | null;
  peakBreakdown: SampleProcess[];
  overBudgetBytes: number;
  pass: boolean;
}

export function summarizeState(
  window: StateWindow,
  samples: FootprintSample[],
  tier: HardwareTier,
): StateResult {
  const inState = samples.filter((sample) => sample.state === window.state);
  const budget = budgetBytes(tier, window.budgetKind);
  const peak = inState.reduce<FootprintSample | null>(
    (best, sample) => (!best || sample.totalBytes > best.totalBytes ? sample : best),
    null,
  );
  const peakBytes = peak?.totalBytes ?? 0;
  const meanBytes = inState.length
    ? Math.round(inState.reduce((sum, sample) => sum + sample.totalBytes, 0) / inState.length)
    : 0;
  const skipped = window.skipped ?? null;
  return {
    ...window,
    skipped,
    samples: inState.length,
    budgetBytes: budget,
    peakBytes,
    meanBytes,
    peakAt: peak?.at ?? null,
    peakSource: peak ? peak.source ?? "periodic" : null,
    peakBreakdown: [...(peak?.processes ?? [])].sort((a, b) => b.bytes - a.bytes),
    overBudgetBytes: Math.max(0, peakBytes - budget),
    // A skipped state passes only because it was not asked of this profile;
    // one that should have run but recorded nothing fails.
    pass: skipped !== null || (inState.length > 0 && window.exercised && peakBytes <= budget),
  };
}

export interface ProcessPeak {
  pid: number;
  label: string;
  /** Highest `phys_footprint` any sample caught. */
  sampledPeakBytes: number;
  sampledPeakState: string;
  /** Highest lifetime `phys_footprint_peak` the kernel reported. */
  lifetimePeakBytes: number | null;
  /**
   * `unsampled-spike`: the process once held much more than any sample saw,
   * so a state budget may have been exceeded between samples.
   * `consistent`: the samples caught the process's real high-water mark.
   */
  verdict: "consistent" | "unsampled-spike" | "no-lifetime-peak";
}

/** A gap below this is sampling jitter, not a spike worth naming. */
const UNSAMPLED_SPIKE_FLOOR_BYTES = 32 * MIB;

/**
 * One row per process the run saw. Samples are a second apart, so a spike
 * shorter than that is visible only in the kernel's lifetime peak.
 */
export function summarizeProcessPeaks(samples: FootprintSample[]): ProcessPeak[] {
  const byPid = new Map<number, ProcessPeak>();
  for (const sample of samples) {
    for (const process of sample.processes) {
      const row = byPid.get(process.pid) ?? {
        pid: process.pid, label: process.label, sampledPeakBytes: -1, sampledPeakState: sample.state,
        lifetimePeakBytes: null, verdict: "no-lifetime-peak" as const,
      };
      if (process.bytes > row.sampledPeakBytes) {
        row.sampledPeakBytes = process.bytes;
        row.sampledPeakState = sample.state;
      }
      if (typeof process.peakBytes === "number") {
        row.lifetimePeakBytes = Math.max(row.lifetimePeakBytes ?? 0, process.peakBytes);
      }
      byPid.set(process.pid, row);
    }
  }
  return [...byPid.values()]
    .map((row) => ({
      ...row,
      verdict: row.lifetimePeakBytes === null ? "no-lifetime-peak" as const
        : row.lifetimePeakBytes - row.sampledPeakBytes > UNSAMPLED_SPIKE_FLOOR_BYTES ? "unsampled-spike" as const
        : "consistent" as const,
    }))
    .sort((a, b) => (b.lifetimePeakBytes ?? b.sampledPeakBytes) - (a.lifetimePeakBytes ?? a.sampledPeakBytes));
}

export interface AppReportedSpeechRoute {
  provider: string | null;
  engine: string | null;
  modelId: string | null;
}

export interface SpeechRouteEvidence {
  state: string;
  /** What actually decoded, judged from the processes that did the work. */
  route: "neural-engine" | "coreml-cpu" | "apple-speech" | "in-process" | "not-observed";
  /** CPU the Neural Engine helper spent in this state. */
  neuralEngineHelperCpuMs: number;
  neuralEngineHelperPeakBytes: number | null;
  sidecarCpuMs: number;
  sidecarPeakBytes: number | null;
  appReported: AppReportedSpeechRoute[];
  detail: string;
}

/** Helper CPU below this is a liveness ping, not a decode. */
const NEURAL_ENGINE_DECODE_CPU_FLOOR_MS = 100;

function cpuSpentInState(samples: FootprintSample[], state: string, matches: (label: string) => boolean): number {
  let spent = 0;
  const last = new Map<number, number>();
  for (const sample of samples) {
    if (sample.source === "helper-completion") continue;
    for (const process of sample.processes) {
      if (!matches(process.label) || typeof process.cpuMs !== "number") continue;
      // A process first seen inside the state started there, from zero.
      const before = last.get(process.pid) ?? (sample.state === state ? 0 : process.cpuMs);
      if (sample.state === state) spent += Math.max(0, process.cpuMs - before);
      last.set(process.pid, process.cpuMs);
    }
  }
  return spent;
}

/**
 * Which speech route served a state. The app's own route report names the
 * model it was asked for; the process tree shows which runtime did the work:
 * Parakeet's Core ML build decodes in its helper, the ggml route and the
 * other local models decode inside the sidecar. The helper decodes on the
 * Neural Engine on most Macs and on the CPU on the Light tier; helper CPU
 * alone cannot tell those apart, so the compute units come from the app's
 * engine report ("neural_engine" vs "coreml_cpu"), or from `computeUnitsHint`
 * (the tier the run simulated, which the sidecar's choice follows) for
 * states whose report names no engine, such as a meeting.
 */
export function speechRouteEvidence(
  samples: FootprintSample[],
  state: string,
  appReported: AppReportedSpeechRoute[] = [],
  computeUnitsHint: "cpu" | "ane" = "ane",
): SpeechRouteEvidence {
  const inState = samples.filter((sample) => sample.state === state);
  const peakOf = (label: string) => {
    const values = inState.flatMap((sample) => sample.processes.filter((p) => p.label === label).map((p) => p.bytes));
    return values.length ? Math.max(...values) : null;
  };
  const neuralEngineHelperCpuMs = cpuSpentInState(samples, state, (label) => label === NEURAL_ENGINE_ASR_LABEL);
  const sidecarCpuMs = cpuSpentInState(samples, state, (label) => label === "sidecar");
  const appleSpeechCpuMs = cpuSpentInState(samples, state, (label) => label === "speech-helper");
  // "provider_default" is the platform-engine setting (no MLX or Apple
  // override), not a runtime: the ASR manager writes it over the provider's
  // own engine, so it says nothing about which runtime decoded.
  const reportedEngines = new Set(appReported.map((entry) => entry.engine).filter((engine) => engine && engine !== "provider_default"));
  const helperRoute = reportedEngines.size > 0
    ? [...reportedEngines].every((engine) => engine === "coreml_cpu") ? "coreml-cpu" as const
      : [...reportedEngines].every((engine) => engine === "neural_engine") ? "neural-engine" as const
      : computeUnitsHint === "cpu" ? "coreml-cpu" as const : "neural-engine" as const
    : computeUnitsHint === "cpu" ? "coreml-cpu" as const : "neural-engine" as const;
  const route = neuralEngineHelperCpuMs >= NEURAL_ENGINE_DECODE_CPU_FLOOR_MS ? helperRoute
    : appleSpeechCpuMs >= NEURAL_ENGINE_DECODE_CPU_FLOOR_MS ? "apple-speech"
    : sidecarCpuMs > 0 ? "in-process" : "not-observed";
  const agreement = reportedEngines.size === 0
    ? `the app did not report an engine; the compute units follow the simulated tier (${computeUnitsHint === "cpu" ? "Light, so CPU" : "Neural Engine"})`
    : route === "neural-engine" && [...reportedEngines].every((engine) => engine === "neural_engine")
      ? "the app reported neural_engine"
      : route === "coreml-cpu" && [...reportedEngines].every((engine) => engine === "coreml_cpu")
        ? "the app reported coreml_cpu"
      : route === "apple-speech" && [...reportedEngines].every((engine) => engine === "macos_apple_speech")
        ? "the app reported macos_apple_speech"
      : route === "in-process" && !reportedEngines.has("neural_engine") && !reportedEngines.has("coreml_cpu") && !reportedEngines.has("macos_apple_speech")
        ? `the app reported ${[...reportedEngines].join(", ")}`
        : `the app reported ${[...reportedEngines].join(", ")}, which disagrees with the process evidence`;
  return {
    state,
    route,
    neuralEngineHelperCpuMs,
    neuralEngineHelperPeakBytes: peakOf(NEURAL_ENGINE_ASR_LABEL),
    sidecarCpuMs,
    sidecarPeakBytes: peakOf("sidecar"),
    appReported,
    detail: `Core ML helper CPU ${neuralEngineHelperCpuMs} ms, Apple Speech helper CPU ${appleSpeechCpuMs} ms, sidecar CPU ${sidecarCpuMs} ms; ${agreement}.`,
  };
}

function formatMib(bytes: number): string {
  return `${(bytes / MIB).toFixed(0)} MiB`;
}

export interface FootprintReceiptSummary {
  generatedAt: string;
  pass: boolean;
  appPath: string;
  simulateGb: number;
  /** Free memory the simulated Mac's other apps leave, when simulated. */
  simulateAvailableGb?: number | null;
  tier: HardwareTier;
  simulationReachedSidecar: boolean | null;
  states: StateResult[];
  launchPeakBytes: number | null;
  reopenFromHiddenMs: number | null;
  error?: string | null;
  notes: string[];
  attribution?: ComponentAttribution[];
  speechRoutes?: SpeechRouteEvidence[];
  processPeaks?: ProcessPeak[];
  systemMemory?: SystemMemoryReport;
}

function renderSpeechRoutes(routes: SpeechRouteEvidence[] | undefined): string {
  if (!routes?.length) return "Not recorded.";
  return `| State | Route that did the work | App-reported route | Core ML helper peak | Sidecar peak | Evidence |
|---|---|---|---|---|---|
${routes.map((route) => `| ${route.state} | ${route.route} | ${
    route.appReported.length
      ? [...new Set(route.appReported.map((entry) => `${entry.provider ?? "?"}/${entry.engine ?? "?"}/${entry.modelId ?? "?"}`))].join(", ")
      : "-"
  } | ${route.neuralEngineHelperPeakBytes === null ? "not running" : formatMib(route.neuralEngineHelperPeakBytes)} | ${
    route.sidecarPeakBytes === null ? "-" : formatMib(route.sidecarPeakBytes)
  } | ${route.detail} |`).join("\n")}`;
}

function renderProcessPeaks(peaks: ProcessPeak[] | undefined): string {
  if (!peaks?.length) return "Not recorded.";
  return `The lifetime peak is the kernel's \`phys_footprint_peak\`. A process whose lifetime peak is well above every sample spiked between samples.

| Process | PID | Highest sample | State | Lifetime peak | Verdict |
|---|---|---|---|---|---|
${peaks.map((peak) => `| ${peak.label} | ${peak.pid} | ${formatMib(peak.sampledPeakBytes)} | ${peak.sampledPeakState} | ${
    peak.lifetimePeakBytes === null ? "-" : formatMib(peak.lifetimePeakBytes)
  } | ${peak.verdict} |`).join("\n")}`;
}

export function renderFootprintMarkdown(receipt: FootprintReceiptSummary, command: string): string {
  const stateRows = receipt.states
    .map((state) => {
      const status = state.skipped ? `skipped (${state.skipped})` : state.pass ? "PASS" : "FAIL";
      const effective = receipt.systemMemory?.effective.find((row) => row.state === state.state);
      return `| ${state.state} | ${state.budgetKind} | ${formatMib(state.budgetBytes)} | ${
        state.samples ? formatMib(state.peakBytes) : "-"
      } | ${state.samples ? formatMib(state.meanBytes) : "-"} | ${
        state.overBudgetBytes ? `+${formatMib(state.overBudgetBytes)}` : "-"
      } | ${status} | ${effective ? `+${formatMib(effective.neuralEngineDeltaBytes)}` : "-"} | ${
        effective && effective.verdict !== "skipped" ? formatMib(effective.effectiveBytes) : "-"
      } | ${effective ? `${effective.verdict.toUpperCase()} (${effective.attribution.status})` : "not measured"} |`;
    })
    .join("\n");
  const breakdowns = receipt.states
    .filter((state) => state.samples > 0)
    .map((state) => {
      const rows = state.peakBreakdown
        .map((process) => {
          const top = (process.categories ?? [])
            .slice()
            .sort((a, b) => b.dirtyBytes - a.dirtyBytes)
            .slice(0, 6)
            .map((category) => `${category.category} ${formatMib(category.dirtyBytes)}`)
            .join(", ");
          return `| ${process.label} | ${process.pid} | ${formatMib(process.bytes)} | ${top || "-"} |`;
        })
        .join("\n");
      return `### ${state.state} at its peak (${state.peakAt ?? "n/a"}, ${state.peakSource ?? "periodic"})

Exercised: ${state.exercised ? "yes" : "no"}. ${state.exercisedDetail}

| Process | PID | phys_footprint | Largest categories |
|---|---|---|---|
${rows}`;
    })
    .join("\n\n");
  return `# Performance: Packaged Memory Footprint

Status: ${receipt.pass ? "PASS" : "FAIL"}
Owner: qa-macos
Generated: ${receipt.generatedAt}

## Command

\`${command}\`

## Setup

- App: \`${receipt.appPath}\`
- Simulated Mac: ${receipt.simulateGb} GB (tier \`${receipt.tier}\`)
- Simulated free memory beside other apps: ${
    receipt.simulateAvailableGb == null ? "not simulated (this Mac's own)" : `${receipt.simulateAvailableGb} GB at sidecar start (stress run; cannot qualify a release)`
  }
- Simulation reached the sidecar: ${
    receipt.simulationReachedSidecar === null ? "unknown" : receipt.simulationReachedSidecar ? "yes" : "no"
  }
- Measure: summed \`phys_footprint\` of the app's main process and every
  descendant (renderers, GPU, utilities, sidecar, native helpers), sampled
  every second, supplemented by full app-tree snapshots before short-lived search helpers exit.
- Effective: the app tree's peak plus the system memory the Neural Engine
  speech model costs outside the app (see "System memory attributed to
  speech"). It fails a state only when that memory is attributable.
- Launch peak (not budgeted): ${receipt.launchPeakBytes === null ? "n/a" : formatMib(receipt.launchPeakBytes)}
- Reopen from hidden to first frame: ${
    receipt.reopenFromHiddenMs === null ? "not measured" : `${receipt.reopenFromHiddenMs} ms`
  }
${receipt.error ? `\n## Error\n\n${receipt.error}\n` : ""}
## States

| State | Budget | Limit | Peak | Mean | Over | Result | System Neural Engine Δ | Effective | Effective result |
|---|---|---|---|---|---|---|---|---|---|
${stateRows}

## Component attribution

${receipt.attribution?.length ? `| Component | Measured allocation or bound | Evidence and limits | Owner |
|---|---|---|---|
${receipt.attribution.map((row) => `| ${row.component} | ${row.measurement} | ${row.evidence} | ${row.owner} |`).join("\n")}` : "No component attribution was supplied. Process categories below do not identify individual models."}

## Speech route

${renderSpeechRoutes(receipt.speechRoutes)}

## System memory attributed to speech

${renderSystemMemoryMarkdown(receipt.systemMemory)}

## Per-process lifetime peaks

${renderProcessPeaks(receipt.processPeaks)}

## Per-process breakdown at each state's peak

${breakdowns || "No samples were recorded."}
${receipt.notes.length ? `\n## Notes\n\n${receipt.notes.map((note) => `- ${note}`).join("\n")}\n` : ""}`;
}

export const FOOTPRINT_PROBE_SOURCE = `(() => {
  const key = "plainsong-footprint-observations";
  const saved = JSON.parse(sessionStorage.getItem(key) || "{}");
  window.__footprintLiveEvents = saved.liveEvents || 0;
  window.__footprintAnalysis = saved.analysis || {};
  window.__footprintDictationRoutes = saved.dictationRoutes || [];
  const persist = () => sessionStorage.setItem(key, JSON.stringify({
    liveEvents: window.__footprintLiveEvents, analysis: window.__footprintAnalysis,
    dictationRoutes: window.__footprintDictationRoutes,
  }));
  const attach = () => {
    if (window.__footprintProbeInstalled) return;
    if (!window.electronAPI?.on) { setTimeout(attach, 0); return; }
    window.__footprintProbeInstalled = true;
    window.electronAPI.on("recording-transcription-stream", (event) => {
      if (event.kind === "speech" && event.segmentText?.trim()) {
        window.__footprintLiveEvents += 1;
        persist();
      }
    });
    window.electronAPI.on("meeting-analysis-status", (event) => {
      window.__footprintAnalysis[event.recordingId] = event.phase;
      persist();
    });
    // Route metadata only; the dictated text stays out of the receipt.
    window.electronAPI.on("dictation-text-ready", (event) => {
      window.__footprintDictationRoutes.push({
        provider: event.actualProvider ?? null, engine: event.actualEngine ?? null, modelId: event.modelId ?? null,
      });
      persist();
    });
  };
  attach();
})()`;
