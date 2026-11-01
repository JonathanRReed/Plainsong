import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  TIER_BUDGET_MIB,
  FOOTPRINT_PROBE_SOURCE,
  helperCompletionSample,
  helperCompletionState,
  measurementComplete,
  gatePassed,
  installedOllamaNotesModel,
  livingPids,
  simulatedMemoryReached,
  simulatedAvailableReached,
  parseSimulatedAvailableGb,
  parseCpuTimeMs,
  budgetBytes,
  descendantsOf,
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
  type FootprintSample,
} from "../../scripts/lib/footprint-gate";

const MIB = 1024 * 1024;

describe("footprint gate budgets", () => {
  it("are the budgets hardware_tier.rs enforces", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../rust-sidecar/src/hardware_tier.rs"),
      "utf8",
    );
    const evaluate = (expression: string): number => {
      const match = expression.trim().match(/^(\d+)\s*\*\s*(MIB|GIB)(?:\s*\/\s*(\d+))?$|^(GIB|MIB)$/);
      if (!match) throw new Error(`Unrecognised budget expression: ${expression}`);
      if (match[4]) return match[4] === "GIB" ? 1024 : 1;
      const unit = match[2] === "GIB" ? 1024 : 1;
      return (Number(match[1]) * unit) / Number(match[3] ?? 1);
    };
    for (const [tier, rustName] of [
      ["light", "Light"],
      ["balanced", "Balanced"],
      ["best", "Best"],
    ] as const) {
      const block = source.match(
        new RegExp(`Self::${rustName} => TierBudget \\{([^}]*)\\}`),
      )?.[1];
      expect(block, `budget block for ${rustName}`).toBeTruthy();
      const read = (field: string) =>
        evaluate(block!.match(new RegExp(`${field}:\\s*([^,]+),`))![1]);
      expect(TIER_BUDGET_MIB[tier]).toEqual({
        idle: read("idle_bytes"),
        dictation: read("dictation_bytes"),
        meeting: read("meeting_bytes"),
        notes: read("notes_bytes"),
      });
    }
    expect(source).toContain("physical_bytes < 12 * GIB");
    expect(source).toContain("physical_bytes < 20 * GIB");
  });

  it("maps simulated Mac sizes to the same tiers", () => {
    expect(tierForPhysicalGb(8)).toBe("light");
    expect(tierForPhysicalGb(16)).toBe("balanced");
    expect(tierForPhysicalGb(18)).toBe("balanced");
    expect(tierForPhysicalGb(24)).toBe("best");
    expect(budgetBytes("light", "meeting")).toBe(1536 * MIB);
  });
});

describe("footprint gate process accounting", () => {
  const ps = [
    "  100     1   0.5 /Applications/Plainsong.app/Contents/MacOS/Plainsong --user-data-dir=/tmp/x --remote-debugging-pipe",
    "  101   100   1.0 /Applications/Plainsong.app/Contents/Frameworks/Plainsong Helper (GPU).app/Contents/MacOS/Plainsong Helper (GPU) --type=gpu-process --user-data-dir=/tmp/x",
    "  102   100   0.0 /Applications/Plainsong.app/Contents/Frameworks/Plainsong Helper (Renderer).app/Contents/MacOS/Plainsong Helper (Renderer) --type=renderer --lang=en-US",
    "  103   100   0.0 /Applications/Plainsong.app/Contents/Frameworks/Plainsong Helper.app/Contents/MacOS/Plainsong Helper --type=utility --utility-sub-type=network.mojom.NetworkService",
    "  104   100  12.0 /Applications/Plainsong.app/Contents/Resources/sidecar/plainsong-sidecar",
    "  105   104   0.0 /Applications/Plainsong.app/Contents/Resources/sidecar/plainsong-sidecar --system-audio-check",
    "  106   104   0.0 osascript -l JavaScript -e ObjC.import('AppKit'); const secret = 1;",
    "  107   100   0.0 /usr/bin/afplay /System/Library/Sounds/Tink.aiff",
    "  200     1   0.0 /Applications/Other.app/Contents/MacOS/Other",
  ].join("\n");

  it("counts the main process and every descendant, nothing else", () => {
    const tree = descendantsOf(100, parseProcessTable(ps));
    expect(tree.map((row) => row.pid).sort()).toEqual([100, 101, 102, 103, 104, 105, 106, 107]);
    expect(tree.find((row) => row.pid === 104)?.cpuPct).toBe(12);
  });

  it("labels processes without keeping their arguments", () => {
    const labels = Object.fromEntries(
      parseProcessTable(ps).map((row) => [row.pid, processLabel(row.command)]),
    );
    expect(labels).toMatchObject({
      100: "main",
      101: "gpu",
      102: "renderer",
      103: "utility:NetworkService",
      104: "sidecar",
      105: "sidecar",
      106: "osascript",
      107: "afplay",
    });
    expect(Object.values(labels).join(" ")).not.toContain("secret");
  });

  it("reads per-process footprints and ignores the summary block", () => {
    const output = `======================================================================
plainsong-sidecar [104]: 64-bit    Footprint: 900000000 B (16384 bytes per page)
======================================================================

      Dirty         Clean   Reclaimable    Regions    Category
        ---           ---           ---        ---    ---
 791674880 B           0 B           0 B         30    Untagged
  83886080 B           0 B           0 B         12    Malloc Large
         0 B      557056 B           0 B         87    __TEXT
        ---           ---           ---        ---    ---
 900000000 B      589824 B           0 B        564    TOTAL

Auxiliary data:
    phys_footprint: 901000000 B
    phys_footprint_peak: 950000000 B

======================================================================
Plainsong Helper (GPU) [101]: 64-bit    Footprint: 140000000 B (16384 bytes per page)
======================================================================

Auxiliary data:
    phys_footprint: 140000000 B
    phys_footprint_peak: 150000000 B

======================================================================
Summary Footprint: 1041000000 B
======================================================================

      Dirty         Clean   Reclaimable    Regions    Category
        ---           ---           ---        ---    ---
 999999999 B           0 B           0 B         30    Untagged
`;
    const parsed = parseFootprintOutput(output);
    expect(parsed).toEqual([
      {
        pid: 104,
        bytes: 901000000,
        peakBytes: 950000000,
        categories: [
          { category: "Untagged", dirtyBytes: 791674880 },
          { category: "Malloc Large", dirtyBytes: 83886080 },
        ],
      },
      { pid: 101, bytes: 140000000, peakBytes: 150000000, categories: [] },
    ]);
  });
});

describe("footprint gate judgement", () => {
  const sample = (state: string, totalMb: number, at = "t"): FootprintSample => ({
    at,
    elapsedMs: 0,
    state,
    totalBytes: totalMb * MIB,
    processes: [{ pid: 1, label: "sidecar", bytes: totalMb * MIB }],
  });

  it("fails a state whose peak exceeds its tier budget and reports by how much", () => {
    const result = summarizeState(
      { state: "meeting", budgetKind: "meeting", exercised: true, exercisedDetail: "" },
      [sample("meeting", 1200), sample("meeting", 1700, "peak"), sample("idle", 5000)],
      "light",
    );
    expect(result.pass).toBe(false);
    expect(result.peakBytes).toBe(1700 * MIB);
    expect(result.peakAt).toBe("peak");
    expect(result.overBudgetBytes).toBe((1700 - 1536) * MIB);
    expect(result.meanBytes).toBe(1450 * MIB);
  });

  it("charges retained speech to the unchanged idle budget after dictation", () => {
    const window = { state: "idle-after-dictation", budgetKind: "idle" as const, exercised: true, exercisedDetail: "" };
    const retained = sample(window.state, 310);
    retained.processes = [
      { pid: 1, label: "main", bytes: 230 * MIB },
      { pid: 2, label: "neural-engine-asr-helper", bytes: 80 * MIB },
    ];
    const result = summarizeState(window, [retained], "light");
    expect(result.budgetBytes).toBe(300 * MIB);
    expect(result.pass).toBe(false);
    expect(result.overBudgetBytes).toBe(10 * MIB);
  });

  it("passes only a state that ran, was exercised and stayed under budget", () => {
    const window = { state: "dictation", budgetKind: "dictation" as const, exercisedDetail: "" };
    expect(summarizeState({ ...window, exercised: true }, [sample("dictation", 900)], "light").pass).toBe(true);
    expect(summarizeState({ ...window, exercised: false }, [sample("dictation", 900)], "light").pass).toBe(false);
    expect(summarizeState({ ...window, exercised: true }, [], "light").pass).toBe(false);
    expect(
      summarizeState({ ...window, exercised: false, skipped: "no notes model" }, [], "light").pass,
    ).toBe(true);
  });
});


describe("footprint gate evidence", () => {
  it("rejects missing live processes, but allows processes that exited during sampling", () => {
    expect(measurementComplete([1, 2], [1], [1, 2])).toBe(false);
    expect(measurementComplete([1, 2], [1], [1])).toBe(true);
    expect(measurementComplete([1], [], [1])).toBe(false);
  });

  it("requires simulation, complete measurements and the standard workload", () => {
    const run = { error: null, simulationReachedSidecar: true, measurementErrors: [], experimental: false,
      standardWorkload: true, states: [{ pass: true }] };
    expect(gatePassed(run)).toBe(true);
    expect(gatePassed({ ...run, experimental: true })).toBe(false);
    expect(gatePassed({ ...run, simulationReachedSidecar: false })).toBe(false);
    expect(gatePassed({ ...run, simulationReachedSidecar: null })).toBe(false);
    expect(gatePassed({ ...run, measurementErrors: ["missing renderer"] })).toBe(false);
    expect(gatePassed({ ...run, standardWorkload: false })).toBe(false);
    expect(gatePassed({ ...run, states: [] })).toBe(false);
  });
});

it("reads cumulative process CPU time for post-call quiescence", () => {
  expect(parseCpuTimeMs("0:03.25")).toBe(3250);
  expect(parseCpuTimeMs("01:02:03")).toBe(3723000);
  expect(parseCpuTimeMs("1-01:02:03")).toBe(90123000);
  expect(parseCpuTimeMs("missing")).toBeNull();
});

it("uses the selected model from the sidecar's string model list", () => {
  expect(installedOllamaNotesModel(["qwen3.5:4b"], "qwen3.5:4b")).toBe(true);
  expect(installedOllamaNotesModel(["other"], "qwen3.5:4b")).toBe(false);
  expect(installedOllamaNotesModel([{ name: "qwen3.5:4b" }], "qwen3.5:4b")).toBe(false);
  expect(installedOllamaNotesModel(null, "qwen3.5:4b")).toBe(false);
});

it("verifies the exact simulation value rather than a numeric prefix", () => {
  expect(simulatedMemoryReached("app PLAINSONG_SIMULATE_PHYSICAL_MEMORY_GB=8 OTHER=x", 8)).toBe(true);
  expect(simulatedMemoryReached("app PLAINSONG_SIMULATE_PHYSICAL_MEMORY_GB=80", 8)).toBe(false);
  expect(simulatedMemoryReached("app OTHER_PLAINSONG_SIMULATE_PHYSICAL_MEMORY_GB=8", 8)).toBe(false);
});

it("verifies the exact available-memory simulation the sidecar received", () => {
  const environment = "app PLAINSONG_SIMULATE_PHYSICAL_MEMORY_GB=8 PLAINSONG_SIMULATE_AVAILABLE_GB=2.5";
  expect(simulatedAvailableReached(environment, 2.5)).toBe(true);
  expect(simulatedAvailableReached(environment, 2)).toBe(false);
  expect(simulatedAvailableReached("app PLAINSONG_SIMULATE_AVAILABLE_GB=1.5", 1.5)).toBe(true);
  expect(simulatedAvailableReached("app PLAINSONG_SIMULATE_PHYSICAL_MEMORY_GB=8", 2.5)).toBe(false);
});

it("accepts an available-memory simulation only inside the simulated Mac", () => {
  expect(parseSimulatedAvailableGb(null, 8)).toBeNull();
  expect(parseSimulatedAvailableGb("2.5", 8)).toBe(2.5);
  expect(parseSimulatedAvailableGb("8", 8)).toBe(8);
  expect(parseSimulatedAvailableGb("9", 8)).toBe("--simulate-available-gb cannot exceed --simulate-gb.");
  for (const invalid of ["0", "-1", "lots", "Infinity"]) {
    expect(parseSimulatedAvailableGb(invalid, 8)).toBe("--simulate-available-gb must be a positive number.");
  }
});

it("records the available-memory simulation in the receipt", () => {
  const base = {
    generatedAt: "now", pass: false, appPath: "/tmp/Plainsong.app", simulateGb: 8, tier: "light" as const,
    simulationReachedSidecar: true, states: [], launchPeakBytes: null, reopenFromHiddenMs: null, notes: [],
  };
  expect(renderFootprintMarkdown(base, "cmd")).toContain("Simulated free memory beside other apps: not simulated");
  expect(renderFootprintMarkdown({ ...base, simulateAvailableGb: 1.5 }, "cmd"))
    .toContain("Simulated free memory beside other apps: 1.5 GB at sidecar start (stress run; cannot qualify a release)");
});

it("preserves live and analysis observations through workspace navigation", () => {
  const saved = new Map<string, string>();
  const sessionStorage = { getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => { saved.set(key, value); } };
  function navigate() {
    const handlers = new Map<string, (event: unknown) => void>();
    const window: Record<string, unknown> = { electronAPI: { on: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler) } };
    vm.runInNewContext(FOOTPRINT_PROBE_SOURCE, { window, sessionStorage, setTimeout });
    return { window, handlers };
  }
  const first = navigate();
  first.handlers.get("recording-transcription-stream")!({ kind: "speech", segmentText: "fixture" });
  first.handlers.get("meeting-analysis-status")!({ recordingId: "r", phase: "running" });
  const second = navigate();
  expect(second.window.__footprintLiveEvents).toBe(1);
  expect(second.window.__footprintAnalysis).toEqual({ r: "running" });
  second.handlers.get("meeting-analysis-status")!({ recordingId: "r", phase: "completed" });
  expect(navigate().window.__footprintAnalysis).toEqual({ r: "completed" });
});

it("attributes the one-job embedding process separately", () => {
  expect(processLabel("/tmp/Plainsong.app/Contents/Resources/sidecar/plainsong-sidecar --embedding-helper")).toBe("embedding-helper");
});

it("names the speech and text helpers, and tells the two speech routes apart", () => {
  expect(processLabel("/tmp/Plainsong.app/Contents/Resources/asr-helper/plainsong-native-asr-helper")).toBe("neural-engine-asr-helper");
  expect(processLabel("/tmp/Plainsong.app/Contents/Resources/sidecar/nautilus-macos-speech-helper-aarch64-apple-darwin")).toBe("speech-helper");
  expect(processLabel("/tmp/Plainsong.app/Contents/Resources/text-helper/plainsong-text-helper --model-fd 3")).toBe("text-helper");
});

it("includes short-lived helpers through a simultaneous app-tree snapshot", () => {
  const output = "sidecar [1]: 64-bit Footprint: 100 B\nHelper [2]: 64-bit Footprint: 900 B\n";
  const report = { captured_at_ms: 2000, helper_pid: 2, processes: [{ pid: 1, label: "sidecar" }, { pid: 2, label: "embedding-helper" }], alive_after: [1, 2], footprint_output: output, error: null };
  expect(helperCompletionSample(report, 1000, "post-call")).toMatchObject({ totalBytes: 1000, elapsedMs: 1000, source: "helper-completion" });
  expect(() => helperCompletionSample({ ...report, processes: [...report.processes, { pid: 3, label: "renderer" }], alive_after: [1, 2, 3] }, 1000, "post-call")).toThrow("missing");
  expect(() => helperCompletionSample({ ...report, error: "capture refused" }, 1000, "post-call")).toThrow("refused");
  expect(() => helperCompletionSample(report, 1000, "post-call", 99)).toThrow("root process");
});

it("keeps shared and shared-cache tables out of a process's own categories", () => {
  const output = `======================================================================
bash [10]: 64-bit    Footprint: 1500000 B (16384 bytes per page)
======================================================================

      Dirty         Clean   Reclaimable    Regions    Category
        ---           ---           ---        ---    ---
   540672 B           0 B           0 B          9    Malloc Metadata
   278912 B           0 B           0 B          1    page table
        ---           ---           ---        ---    ---
   819584 B           0 B           0 B         10    TOTAL

Shared with sleep [11]:
      Dirty         Clean   Reclaimable    Regions    Category
        ---           ---           ---        ---    ---
    81920 B           0 B           0 B          4    Untagged
        ---           ---           ---        ---    ---
    81920 B           0 B           0 B          4    TOTAL

Auxiliary data:
    phys_footprint: 1500000 B
    phys_footprint_peak: 1600000 B

======================================================================
Shared Cache 2BD06591-E751-3E84-963F-B08DAB6AF23A
======================================================================

Shared with sleep [11], bash [10]:
      Dirty         Clean   Reclaimable    Regions    Category
        ---           ---           ---        ---    ---
   900000 B           0 B           0 B         21    __DATA_DIRTY
        ---           ---           ---        ---    ---
   900000 B           0 B           0 B         21    TOTAL
`;
  expect(parseFootprintOutput(output)).toEqual([{
    pid: 10, bytes: 1500000, peakBytes: 1600000,
    categories: [{ category: "Malloc Metadata", dirtyBytes: 540672 }, { category: "page table", dirtyBytes: 278912 }],
  }]);
});

// A process that is exiting fails footprint's region walk: its banner loses
// the Footprint figure but its auxiliary data still follows. footprint sorts
// such a block last, after the smallest live process.
it("gives an exiting process its own memory instead of the block before it", () => {
  const output = `======================================================================
plainsong-native-shortcut-helper [20]: 64-bit    Footprint: 2000000 B (16384 bytes per page)
======================================================================

      Dirty         Clean   Reclaimable    Regions    Category
        ---           ---           ---        ---    ---
   540672 B           0 B           0 B          9    Malloc Metadata
        ---           ---           ---        ---    ---
   540672 B           0 B           0 B          9    TOTAL

Auxiliary data:
    phys_footprint: 2000000 B
    phys_footprint_peak: 2100000 B

plainsong-sidecar [30]: bailing out due to error: mach_vm_region_recurse - (os/kern) invalid argument
======================================================================
plainsong-sidecar [30]: 64-bit
Errors were encountered while examining the process. Results may be incomplete or incorrect.
    mach_vm_region_recurse - (os/kern) invalid argument
======================================================================

      Dirty         Clean   Reclaimable    Regions    Category
        ---           ---           ---        ---    ---
 560000000 B           0 B           0 B         10    Malloc Large
        ---           ---           ---        ---    ---
        0 B           0 B           0 B          0    TOTAL

Auxiliary data:
    phys_footprint: 620000000 B
    phys_footprint_peak: 745000000 B

======================================================================
Summary Footprint: 622000000 B (may be invalid due to errors)
======================================================================
`;
  expect(parseFootprintOutput(output)).toEqual([
    { pid: 20, bytes: 2000000, peakBytes: 2100000, categories: [{ category: "Malloc Metadata", dirtyBytes: 540672 }] },
    { pid: 30, bytes: 620000000, peakBytes: 745000000, categories: [{ category: "Malloc Large", dirtyBytes: 560000000 }] },
  ]);
});

it("does not count a reaped-pending zombie as a live process", () => {
  const rows = parseProcessTable("  41     1   0.0 /Applications/Plainsong.app/Contents/MacOS/Plainsong\n  42    41   0.0 <defunct>\n");
  expect(livingPids(rows)).toEqual([41]);
  expect(measurementComplete([41, 42], [41], livingPids(rows))).toBe(true);
});

describe("per-process lifetime peaks", () => {
  const at = (state: string, bytes: number, peakBytes: number | null): FootprintSample => ({
    at: state, elapsedMs: 0, state, totalBytes: bytes,
    processes: [{ pid: 7, label: "shortcut-helper", bytes, peakBytes }],
  });

  it("names a spike that happened between samples", () => {
    const [row] = summarizeProcessPeaks([at("idle", 2 * MIB, 3 * MIB), at("meeting", 3 * MIB, 200 * MIB)]);
    expect(row).toMatchObject({ label: "shortcut-helper", sampledPeakBytes: 3 * MIB, sampledPeakState: "meeting",
      lifetimePeakBytes: 200 * MIB, verdict: "unsampled-spike" });
  });

  it("calls a process consistent when the samples caught its high-water mark", () => {
    expect(summarizeProcessPeaks([at("idle", 40 * MIB, 41 * MIB)])[0].verdict).toBe("consistent");
    expect(summarizeProcessPeaks([at("idle", 40 * MIB, null)])[0].verdict).toBe("no-lifetime-peak");
  });

  it("renders the peaks and the speech route in the receipt", () => {
    const samples = [at("dictation", 3 * MIB, 200 * MIB)];
    const markdown = renderFootprintMarkdown({
      generatedAt: "now", pass: false, appPath: "/tmp/Plainsong.app", simulateGb: 8, tier: "light",
      simulationReachedSidecar: true, states: [], launchPeakBytes: null, reopenFromHiddenMs: null, notes: [],
      processPeaks: summarizeProcessPeaks(samples),
      speechRoutes: [speechRouteEvidence(samples, "dictation")],
    }, "cmd");
    expect(markdown).toContain("## Speech route");
    expect(markdown).toContain("| shortcut-helper | 7 | 3 MiB | dictation | 200 MiB | unsampled-spike |");
  });
});

describe("speech route evidence", () => {
  const sample = (state: string, processes: Array<{ label: string; pid: number; cpuMs: number; bytes?: number }>): FootprintSample => ({
    at: state, elapsedMs: 0, state, totalBytes: 0,
    processes: processes.map((entry) => ({ bytes: 50 * MIB, ...entry })),
  });

  it("credits the Neural Engine helper when it did the decoding", () => {
    const samples = [
      sample("idle", [{ label: "sidecar", pid: 1, cpuMs: 1000 }]),
      sample("dictation", [{ label: "sidecar", pid: 1, cpuMs: 1200 }, { label: "neural-engine-asr-helper", pid: 2, cpuMs: 300, bytes: 40 * MIB }]),
      sample("dictation", [{ label: "sidecar", pid: 1, cpuMs: 1300 }, { label: "neural-engine-asr-helper", pid: 2, cpuMs: 900, bytes: 45 * MIB }]),
      sample("meeting", [{ label: "sidecar", pid: 1, cpuMs: 1400 }, { label: "neural-engine-asr-helper", pid: 2, cpuMs: 950 }]),
    ];
    const route = speechRouteEvidence(samples, "dictation", [{ provider: "transcribe_cpp", engine: "neural_engine", modelId: "parakeet-tdt-0.6b-v3-coreml" }]);
    expect(route).toMatchObject({ route: "neural-engine", neuralEngineHelperCpuMs: 900, sidecarCpuMs: 300, neuralEngineHelperPeakBytes: 45 * MIB });
    expect(route.detail).toContain("the app reported neural_engine");
    // The platform-engine setting is not a runtime, so it cannot disagree.
    const unnamed = speechRouteEvidence(samples, "dictation", [{ provider: "transcribe_cpp", engine: "provider_default", modelId: "m" }]);
    expect(unnamed.detail).toContain("the app did not report an engine");
    // The meeting's 50 ms is a liveness ping, not a decode.
    expect(speechRouteEvidence(samples, "meeting").route).toBe("in-process");
  });

  it("tells the Light tier's CPU decode apart from the Neural Engine", () => {
    const samples = [
      sample("idle", [{ label: "sidecar", pid: 1, cpuMs: 1000 }]),
      sample("dictation", [{ label: "sidecar", pid: 1, cpuMs: 1200 }, { label: "neural-engine-asr-helper", pid: 2, cpuMs: 300, bytes: 30 * MIB }]),
      sample("dictation", [{ label: "sidecar", pid: 1, cpuMs: 1300 }, { label: "neural-engine-asr-helper", pid: 2, cpuMs: 1200, bytes: 35 * MIB }]),
      sample("meeting", [{ label: "sidecar", pid: 1, cpuMs: 1400 }, { label: "neural-engine-asr-helper", pid: 2, cpuMs: 2000 }]),
    ];
    // The app report decides when it names an engine.
    const reported = speechRouteEvidence(samples, "dictation", [{ provider: "transcribe_cpp", engine: "coreml_cpu", modelId: "parakeet-tdt-0.6b-v3-coreml" }]);
    expect(reported).toMatchObject({ route: "coreml-cpu", neuralEngineHelperCpuMs: 1200 });
    expect(reported.detail).toContain("the app reported coreml_cpu");
    // A state whose report names no engine (a meeting) follows the
    // simulated tier, which is what the sidecar's choice follows.
    expect(speechRouteEvidence(samples, "meeting", [], "cpu").route).toBe("coreml-cpu");
    expect(speechRouteEvidence(samples, "meeting").route).toBe("neural-engine");
    const hinted = speechRouteEvidence(samples, "meeting", [], "cpu");
    expect(hinted.detail).toContain("Light, so CPU");
    // An app report of the Neural Engine on a CPU-hinted run wins: the
    // report is direct evidence, the hint only fills a missing one.
    const disagrees = speechRouteEvidence(samples, "dictation", [{ provider: "transcribe_cpp", engine: "neural_engine", modelId: "m" }], "cpu");
    expect(disagrees.route).toBe("neural-engine");
  });

  it("calls a sidecar-only decode in-process and flags a report that disagrees", () => {
    const samples = [
      sample("idle", [{ label: "sidecar", pid: 1, cpuMs: 1000 }]),
      sample("dictation", [{ label: "sidecar", pid: 1, cpuMs: 4000, bytes: 900 * MIB }]),
    ];
    const route = speechRouteEvidence(samples, "dictation", [{ provider: "transcribe_cpp", engine: "neural_engine", modelId: "x" }]);
    expect(route).toMatchObject({ route: "in-process", sidecarCpuMs: 3000, sidecarPeakBytes: 900 * MIB, neuralEngineHelperPeakBytes: null });
    expect(route.detail).toContain("disagrees");
    expect(speechRouteEvidence(samples, "meeting").route).toBe("not-observed");
  });
});

it("records each dictation's route but not its text", () => {
  const handlers = new Map<string, (event: unknown) => void>();
  const window: Record<string, unknown> = { electronAPI: { on: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler) } };
  const saved = new Map<string, string>();
  const sessionStorage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); } };
  vm.runInNewContext(FOOTPRINT_PROBE_SOURCE, { window, sessionStorage, setTimeout });
  handlers.get("dictation-text-ready")!({ text: "private words", actualProvider: "transcribe_cpp", actualEngine: "neural_engine", modelId: "m" });
  expect(window.__footprintDictationRoutes).toEqual([{ provider: "transcribe_cpp", engine: "neural_engine", modelId: "m" }]);
  expect([...saved.values()].join("")).not.toContain("private");
});

describe("search indexing after the call", () => {
  const status = { memorySearchMode: "builtin", builtInAvailable: true, selectedBuiltInModel: "embeddinggemma-2",
    builtInModels: [{ id: "embeddinggemma-2", downloaded: true }], indexedRecordings: 0, totalRecordings: 1, indexing: false };

  it("is expected only when built-in search is selected and its model is downloaded", () => {
    expect(searchIndexExpected(status)).toBe(true);
    expect(searchIndexExpected({ ...status, memorySearchMode: "ollama" })).toBe(false);
    expect(searchIndexExpected({ ...status, builtInModels: [{ id: "embeddinggemma-2", downloaded: false }] })).toBe(false);
    expect(searchIndexExpected({ ...status, builtInAvailable: false })).toBe(false);
    expect(searchIndexExpected(null)).toBe(false);
  });

  it("is settled once every transcript is indexed and no batch is running", () => {
    expect(searchIndexSettled(status)).toBe(false);
    expect(searchIndexSettled({ ...status, indexedRecordings: 1 })).toBe(true);
    expect(searchIndexSettled({ ...status, indexedRecordings: 1, indexing: true })).toBe(false);
    expect(searchIndexSettled({ ...status, indexedRecordings: 0, totalRecordings: 0 })).toBe(false);
  });
});


describe("helper completion state attribution", () => {
  const sample = (elapsedMs: number, state: string, source: FootprintSample["source"] = "periodic"): FootprintSample =>
    ({ at: "2026-01-01T00:00:00Z", elapsedMs, state, source, totalBytes: 0, processes: [] });

  it("ignores older appended helpers when assigning a later report", () => {
    const samples = [sample(1_000, "idle"), sample(360_464, "post-call")];
    for (const elapsedMs of [360_570, 1_500, 360_600]) {
      const state = helperCompletionState(samples, elapsedMs);
      samples.push(sample(elapsedMs, state, "helper-completion"));
    }
    expect(samples.slice(2).map((entry) => entry.state)).toEqual(["post-call", "idle", "post-call"]);
  });

  it("selects the nearest earlier regular sample regardless of input order", () => {
    const samples = [sample(300, "meeting"), sample(100, "idle"), sample(200, "dictation")];
    expect(helperCompletionState(samples, 250)).toBe("dictation");
    expect(helperCompletionState(samples, 300)).toBe("meeting");
    expect(helperCompletionState(samples, 50)).toBe("post-call");
    expect(helperCompletionState([], 50)).toBe("post-call");
  });
});
