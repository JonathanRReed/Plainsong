import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  footprintReceiptFailures,
  footprintReceiptQualifies,
  gatePassed,
  parseFootprintOutput,
  parseProcessTable,
  renderFootprintMarkdown,
  type StateResult,
} from "../../scripts/lib/footprint-gate";
import {
  ATTRIBUTION_NOISE_FLOOR_BYTES,
  attributeNeuralEngineMemory,
  buildSystemMemoryReport,
  effectiveStateResult,
  findNeuralEngineServices,
  neuralEngineServiceName,
  parseTopMemory,
  parseVmStat,
  renderSystemMemoryMarkdown,
  serviceTotalBytes,
  speechModelKeepReadyMs,
  summarizeSystemState,
  systemBaseline,
  type NeuralEngineAttributionInput,
  type SystemMemorySample,
} from "../../scripts/lib/system-memory-gate";

const MIB = 1024 * 1024;
const PAGE = 16384;
const fixture = (name: string) =>
  fs.readFileSync(path.resolve(__dirname, "fixtures/system-memory", name), "utf8");

describe("vm_stat parsing", () => {
  it("reads wired and compressor memory from a recorded 8 GB gate snapshot", () => {
    const before = parseVmStat(fixture("vm_stat-b12-before.txt"))!;
    expect(before).toEqual({
      pageSizeBytes: PAGE,
      wiredBytes: 315580 * PAGE,
      compressorBytes: 296973 * PAGE,
      storedInCompressorBytes: 544990 * PAGE,
      freeBytes: 18483 * PAGE,
    });
    const after = parseVmStat(fixture("vm_stat-b12-after.txt"))!;
    expect(after.wiredBytes - before.wiredBytes).toBe((355717 - 315580) * PAGE);
    expect(after.compressorBytes - before.compressorBytes).toBe((294129 - 296973) * PAGE);
  });

  it("uses the reported page size rather than assuming 16 KiB", () => {
    const intel = "Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages wired down:  10.\nPages occupied by compressor:  2.\n";
    expect(parseVmStat(intel)).toMatchObject({ pageSizeBytes: 4096, wiredBytes: 40960, compressorBytes: 8192 });
  });

  it("refuses output without a page size or the counters the gate needs", () => {
    expect(parseVmStat("")).toBeNull();
    expect(parseVmStat("Pages wired down: 10.\nPages occupied by compressor: 2.\n")).toBeNull();
    expect(parseVmStat("Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages wired down: 10.\n")).toBeNull();
    // A truncated counter is not silently read as zero.
    expect(parseVmStat("Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages wired down: abc.\nPages occupied by compressor: 2.\n")).toBeNull();
  });
});

describe("Neural Engine services", () => {
  it("finds only Apple's own service binaries", () => {
    const rows = parseProcessTable([
      "99568     1   0.0 /usr/libexec/aned",
      "33257     1   0.0 /usr/libexec/aneuserd",
      "41131     1   0.0 /System/Library/PrivateFrameworks/AppleNeuralEngine.framework/XPCServices/ANECompilerService.xpc/Contents/MacOS/ANECompilerService",
      "50000   400   0.0 /tmp/aned",
      "50001   400   0.0 /usr/libexec/anedx",
      "50002   400   0.0 /usr/bin/grep aned",
    ].join("\n"));
    expect(findNeuralEngineServices(rows)).toEqual([
      { pid: 99568, name: "aned" },
      { pid: 33257, name: "aneuserd" },
      { pid: 41131, name: "ANECompilerService" },
    ]);
    expect(neuralEngineServiceName("/Users/me/bin/ANECompilerService")).toBeNull();
  });

  it("records that footprint cannot read the services without root", () => {
    // Recorded on this Mac: aned runs as root and aneuserd as _neuralengine.
    expect(parseFootprintOutput(fixture("footprint-root-services.txt"))).toEqual([]);
  });

  it("reads the services' physical footprint from top's mem column", () => {
    const rows = parseTopMemory(fixture("top-services-synthetic.txt"));
    expect(rows.get(99568)).toBe(21 * MIB);
    expect(rows.get(33257)).toBe(4321 * 1024);
    expect(rows.get(41131)).toBe(187 * MIB);
    // Header lines such as "PhysMem: 23G used" are not process rows.
    expect(rows.size).toBe(3);
    expect(parseTopMemory("99568 21M\n")).toEqual(new Map());
    expect(parseTopMemory("PID    MEM\n1 1.5G\n2 512B-\n")).toEqual(new Map([[1, 1.5 * 1024 * MIB], [2, 512]]));
  });

  it("treats any unreadable running service as an unknown total", () => {
    const sample = (bytes: number | null): SystemMemorySample => ({
      at: "", elapsedMs: 0, state: "idle", wiredBytes: 0, compressorBytes: 0, neuralEngineHelperAlive: false,
      services: [{ name: "aned", pid: 1, bytes: 10, source: "top" }, { name: "aneuserd", pid: 2, bytes, source: bytes === null ? null : "top" }],
    });
    expect(serviceTotalBytes(sample(5))).toBe(15);
    expect(serviceTotalBytes(sample(null))).toBeNull();
  });
});

const base = (overrides: Partial<NeuralEngineAttributionInput> = {}): NeuralEngineAttributionInput => ({
  neuralEngineUsed: true,
  preLoadWiredDeltaBytes: 40 * MIB,
  loadedWiredDeltaBytes: 670 * MIB,
  releaseObserved: true,
  releasedWiredDeltaBytes: 60 * MIB,
  serviceDeltaBytes: 20 * MIB,
  ...overrides,
});

describe("Neural Engine attribution", () => {
  it("attributes a rise that appears with the model and goes with the release", () => {
    const result = attributeNeuralEngineMemory(base());
    expect(result.status).toBe("attributed");
    expect(result.riseBytes).toBe(630 * MIB);
    expect(result.neuralEngineDeltaBytes).toBe(650 * MIB);
  });

  it("charges only the part of a rise that left with the helper when the rest stays", () => {
    // 630 MiB rise; 158 MiB (a quarter) is the most that may remain.
    expect(attributeNeuralEngineMemory(base({ releasedWiredDeltaBytes: 40 * MIB + 157 * MIB })).status).toBe("attributed");
    // b17's 8 GB run: 232 MiB stayed wired, so its whole rise could not be
    // tied to the model and an over-budget dictation passed as a warning.
    const stayed = attributeNeuralEngineMemory(base({ releasedWiredDeltaBytes: 40 * MIB + 232 * MIB }));
    expect(stayed.status).toBe("partly-attributed");
    expect(stayed.reason).toContain("remained after the release");
    expect(stayed.neuralEngineDeltaBytes).toBe((630 - 232 + 20) * MIB);
  });

  it("does not attribute a rise that all but entirely stays after the release", () => {
    const stayed = attributeNeuralEngineMemory(base({ releasedWiredDeltaBytes: 40 * MIB + 600 * MIB }));
    expect(stayed.status).toBe("unattributed");
    // The delta is still reported so a warning shows its size.
    expect(stayed.neuralEngineDeltaBytes).toBe(650 * MIB);
  });

  it("allows the noise floor as residual when the rise is small", () => {
    const rise = 100 * MIB;
    const input = base({ loadedWiredDeltaBytes: 40 * MIB + rise, releasedWiredDeltaBytes: 40 * MIB + 60 * MIB });
    expect(attributeNeuralEngineMemory(input).status).toBe("attributed");
  });

  it("does not attribute without an observed release", () => {
    expect(attributeNeuralEngineMemory(base({ releaseObserved: false })).status).toBe("unattributed");
    expect(attributeNeuralEngineMemory(base({ releasedWiredDeltaBytes: null })).status).toBe("unattributed");
  });

  it("does not attribute without a no-model reference", () => {
    const result = attributeNeuralEngineMemory(base({ preLoadWiredDeltaBytes: null }));
    expect(result.status).toBe("unattributed");
    expect(result.neuralEngineDeltaBytes).toBe(20 * MIB);
  });

  it("calls a rise under the noise floor below noise, and a drop not a rise", () => {
    const small = attributeNeuralEngineMemory(base({ loadedWiredDeltaBytes: 40 * MIB + ATTRIBUTION_NOISE_FLOOR_BYTES - 1 }));
    expect(small.status).toBe("below-noise");
    const fell = attributeNeuralEngineMemory(base({ loadedWiredDeltaBytes: 0, serviceDeltaBytes: null }));
    expect(fell.status).toBe("below-noise");
    expect(fell.neuralEngineDeltaBytes).toBe(0);
  });

  it("adds nothing when the helper held no model", () => {
    expect(attributeNeuralEngineMemory(base({ neuralEngineUsed: false }))).toMatchObject({ status: "not-applicable", neuralEngineDeltaBytes: 0 });
  });

  it("ignores a shrinking service footprint", () => {
    expect(attributeNeuralEngineMemory(base({ serviceDeltaBytes: -50 * MIB })).neuralEngineDeltaBytes).toBe(630 * MIB);
  });
});

const appState = (state: string, peakMib: number, overrides: Partial<StateResult> = {}): StateResult => ({
  state, budgetKind: state === "dictation" ? "dictation" : "meeting", exercised: true, exercisedDetail: "", skipped: null,
  samples: 10, budgetBytes: (state === "dictation" ? 1024 : 1536) * MIB, peakBytes: peakMib * MIB, meanBytes: 0,
  peakAt: null, peakSource: null, peakBreakdown: [], overBudgetBytes: 0, pass: true, ...overrides,
});

describe("effective budget", () => {
  it("fails an attributed effective figure over budget", () => {
    const row = effectiveStateResult(appState("dictation", 563), attributeNeuralEngineMemory(base()));
    expect(row.effectiveBytes).toBe((563 + 650) * MIB);
    expect(row.verdict).toBe("fail");
  });

  it("fails when the part released with the helper alone is over budget", () => {
    // b17 8 GB: 537 MiB app peak; 750 MiB rise of which 232 MiB stayed.
    const partly = attributeNeuralEngineMemory(base({
      loadedWiredDeltaBytes: 40 * MIB + 750 * MIB, releasedWiredDeltaBytes: 40 * MIB + 232 * MIB, serviceDeltaBytes: 0,
    }));
    const row = effectiveStateResult(appState("dictation", 537), partly);
    expect(row.effectiveBytes).toBe((537 + 518) * MIB);
    expect(row.verdict).toBe("fail");
  });

  it("warns, not fails, when the same figure is unattributed", () => {
    const row = effectiveStateResult(appState("dictation", 563), attributeNeuralEngineMemory(base({ releaseObserved: false })));
    expect(row.verdict).toBe("warn");
  });

  it("passes an attributed figure within budget and warns on an unattributed one within budget", () => {
    expect(effectiveStateResult(appState("meeting", 800), attributeNeuralEngineMemory(base())).verdict).toBe("pass");
    expect(effectiveStateResult(appState("meeting", 800), attributeNeuralEngineMemory(base({ releaseObserved: false }))).verdict).toBe("warn");
  });

  it("skips states the app gate skipped or never sampled", () => {
    expect(effectiveStateResult(appState("meeting", 0, { samples: 0 }), attributeNeuralEngineMemory(base())).verdict).toBe("skipped");
    expect(effectiveStateResult(appState("meeting", 900, { skipped: "not asked" }), attributeNeuralEngineMemory(base())).verdict).toBe("skipped");
  });

  it("makes the whole gate fail on an effective failure only", () => {
    const run = { error: null, simulationReachedSidecar: true, measurementErrors: [], experimental: false, standardWorkload: true, states: [{ pass: true }] };
    expect(gatePassed(run)).toBe(true);
    expect(gatePassed({ ...run, effective: [{ verdict: "warn" }, { verdict: "pass" }] })).toBe(true);
    expect(gatePassed({ ...run, effective: [{ verdict: "fail" }] })).toBe(false);
  });
});

describe("speech model keep-ready period", () => {
  it("follows the Core ML helper route unless the user chose a period", () => {
    expect(speechModelKeepReadyMs("light", "auto")).toBe(1_800_000);
    expect(speechModelKeepReadyMs("light", "2m")).toBe(120_000);
    expect(speechModelKeepReadyMs("balanced", undefined)).toBe(300_000);
    expect(speechModelKeepReadyMs("best", "nonsense")).toBe(600_000);
    expect(speechModelKeepReadyMs("light", "30m")).toBe(1_800_000);
    expect(speechModelKeepReadyMs("light", "always")).toBeNull();
  });
});

describe("system memory report", () => {
  const WIRED = 5000 * MIB;
  let clock = 0;
  const sample = (state: string, wiredDeltaMib: number, alive: boolean, serviceMib: number | null = 30): SystemMemorySample => {
    clock += 2000;
    return {
      at: new Date(clock).toISOString(), elapsedMs: clock, state,
      wiredBytes: WIRED + wiredDeltaMib * MIB, compressorBytes: 900 * MIB + (alive ? 50 * MIB : 0),
      neuralEngineHelperAlive: alive,
      services: [{ name: "aned", pid: 99568, bytes: serviceMib === null ? null : serviceMib * MIB, source: serviceMib === null ? null : "top" }],
    };
  };
  const run = (released: number) => {
    clock = 0;
    const baseline = [sample("baseline", 0, false, 20), sample("baseline", 4, false, 20), sample("baseline", -4, false, 20)];
    const samples = [
      sample("launch", 120, false), sample("idle", 40, false), sample("idle-hidden", 30, false), sample("idle-hidden", 34, false),
      sample("dictation", 640, true), sample("dictation", 660, true), sample("dictation", 700, true),
      sample("meeting", 650, true), sample("meeting", 670, true), sample("post-call", 680, true, 40),
      sample("speech-release-wait", 50, false), sample("speech-release-wait", released, false),
      sample("speech-released", released, false), sample("speech-released", released, false),
      sample("speech-released", released, false),
    ];
    return buildSystemMemoryReport(baseline, samples, [appState("dictation", 563), appState("meeting", 800), appState("idle-hidden", 250, { budgetBytes: 300 * MIB })]);
  };

  it("measures each state against the pre-launch baseline", () => {
    const report = run(36);
    expect(report.baseline).toMatchObject({ samples: 3, wiredBytes: WIRED, serviceBytes: 20 * MIB });
    const dictation = report.states.find((row) => row.state === "dictation")!;
    expect(dictation).toMatchObject({
      samples: 3, peakWiredDeltaBytes: 700 * MIB, medianWiredDeltaBytes: 660 * MIB, loadedWiredDeltaBytes: 660 * MIB,
      peakCompressorDeltaBytes: 50 * MIB, peakServiceDeltaBytes: 10 * MIB, neuralEngineHelperAliveSamples: 3,
    });
    expect(report.states.map((row) => row.state)).toEqual(["launch", "idle", "idle-hidden", "dictation", "meeting", "post-call", "speech-released"]);
    expect(report.preLoadReference).toEqual({ state: "idle-hidden", wiredDeltaBytes: 32 * MIB });
  });

  it("attributes the rise when it goes with the release, and fails the 8 GB dictation state", () => {
    const report = run(36);
    expect(report.release).toMatchObject({ observed: true, wiredDeltaBytes: 36 * MIB, samples: 2 });
    const dictation = report.effective.find((row) => row.state === "dictation")!;
    expect(dictation.attribution.status).toBe("attributed");
    expect(dictation.neuralEngineDeltaBytes).toBe((660 - 32 + 10) * MIB);
    expect(dictation.verdict).toBe("fail");
    expect(report.effective.find((row) => row.state === "idle-hidden")!.verdict).toBe("pass");
    expect(report.warnings).toEqual([]);
  });

  it("charges the released part when some wired memory stays after the release", () => {
    const dictation = run(500).effective.find((row) => row.state === "dictation")!;
    expect(dictation.attribution.status).toBe("partly-attributed");
    expect(dictation.neuralEngineDeltaBytes).toBeLessThan((660 - 32 + 10) * MIB);
    expect(dictation.neuralEngineDeltaBytes).toBeGreaterThan(0);
  });

  it("warns instead when the wired memory stays after the release", () => {
    const report = run(650);
    const dictation = report.effective.find((row) => row.state === "dictation")!;
    expect(dictation.attribution.status).toBe("unattributed");
    expect(dictation.verdict).toBe("warn");
    expect(report.warnings.some((warning) => warning.startsWith("dictation: effective"))).toBe(true);
  });

  it("charges post-call only the model's speech-time cost, not the notes model's GPU memory", () => {
    clock = 0;
    const samples = [
      sample("idle-hidden", 30, false), sample("dictation", 660, true), sample("meeting", 660, true),
      // The notes model wires Metal memory the app tree already counts.
      sample("post-call", 1800, true), sample("post-call", 1800, true),
      ...[1, 2, 3, 4].map(() => sample("speech-released", 40, false)),
    ];
    const report = buildSystemMemoryReport([sample("baseline", 0, false, 20)], samples,
      [appState("post-call", 1700, { budgetKind: "notes", budgetBytes: 2560 * MIB })]);
    expect(report.effective[0].attribution).toMatchObject({ status: "attributed", riseBytes: 630 * MIB });
    expect(report.states.find((row) => row.state === "post-call")!.peakWiredDeltaBytes).toBe(1800 * MIB);
  });

  it("renders the effective column in the receipt's state table", () => {
    const markdown = renderFootprintMarkdown({
      generatedAt: "now", pass: false, appPath: "/tmp/Plainsong.app", simulateGb: 8, tier: "light",
      simulationReachedSidecar: true, states: [appState("dictation", 563)], launchPeakBytes: null, reopenFromHiddenMs: null,
      notes: [], systemMemory: run(36),
    }, "cmd");
    expect(markdown).toContain("## System memory attributed to speech");
    expect(markdown).toContain("| dictation | dictation | 1024 MiB | 563 MiB | 0 MiB | - | PASS | +638 MiB | 1201 MiB | FAIL (attributed) |");
    const without = renderFootprintMarkdown({
      generatedAt: "now", pass: false, appPath: "/tmp/Plainsong.app", simulateGb: 8, tier: "light",
      simulationReachedSidecar: true, states: [appState("dictation", 563)], launchPeakBytes: null, reopenFromHiddenMs: null, notes: [],
    }, "cmd");
    expect(without).toContain("| PASS | - | - | not measured |");
  });

  it("warns when the helper never released while sampling", () => {
    clock = 0;
    const baseline = [sample("baseline", 0, false)];
    const samples = [sample("idle-hidden", 30, false), sample("dictation", 660, true), sample("post-call", 660, true)];
    const report = buildSystemMemoryReport(baseline, samples, [appState("dictation", 563)]);
    expect(report.release.observed).toBe(false);
    expect(report.effective[0].verdict).toBe("warn");
  });

  it("records unreadable services and leaves them out", () => {
    clock = 0;
    const baseline = [sample("baseline", 0, false, null)];
    const samples = [sample("idle-hidden", 30, false, null), sample("dictation", 660, true, null),
      ...[1, 2, 3, 4].map(() => sample("speech-released", 30, false, null))];
    const report = buildSystemMemoryReport(baseline, samples, [appState("dictation", 300)]);
    expect(report.serviceReadability).toEqual([{ name: "aned", read: "unreadable" }]);
    expect(report.effective[0]).toMatchObject({ neuralEngineDeltaBytes: 630 * MIB, verdict: "pass" });
    expect(report.warnings).toContain("aned memory could not be read without root; the effective figure leaves it out.");
  });

  it("has no reference when the model was loaded before idle", () => {
    clock = 0;
    const report = buildSystemMemoryReport([sample("baseline", 0, false)],
      [sample("idle-hidden", 660, true), sample("dictation", 660, true), sample("speech-released", 30, false)], [appState("dictation", 300)]);
    expect(report.preLoadReference).toBeNull();
    expect(report.effective[0].attribution.status).toBe("unattributed");
  });

  it("warns that nothing can be judged without a baseline", () => {
    clock = 0;
    const report = buildSystemMemoryReport([], [sample("dictation", 660, true)], [appState("dictation", 300)]);
    expect(report.baseline).toBeNull();
    expect(summarizeSystemState("dictation", [], systemBaseline([]))).toMatchObject({ samples: 0, peakWiredDeltaBytes: null });
    expect(report.warnings[0]).toContain("No pre-launch system baseline");
  });

  it("renders the section with the shared-Mac caveat and the effective column", () => {
    const markdown = renderSystemMemoryMarkdown(run(36));
    expect(markdown).toContain("include other apps' activity");
    expect(markdown).toContain("| dictation | attributed | +628 MiB | 638 MiB | 563 MiB | 1201 MiB | 1024 MiB | FAIL |");
    expect(markdown).toContain("| dictation | 3 | +700 MiB | +660 MiB | +660 MiB | +50 MiB | +10 MiB | 3 |");
    expect(renderSystemMemoryMarkdown(undefined)).toBe("Not recorded.");
  });
});

describe("release audit of a footprint receipt", () => {
  const receipt = {
    simulateGb: 8, tier: "light", simulationReachedSidecar: true, standardWorkload: true, measurementErrors: [],
    extraSettings: [], extraAppArgs: [],
    states: ["idle", "idle-hidden", "dictation", "meeting", "post-call"].map((state) => ({ state, pass: true, samples: 10 })),
  };

  it("still qualifies a receipt from before the gate measured system memory", () => {
    expect(footprintReceiptQualifies(receipt, 8, "light")).toBe(true);
    expect(footprintReceiptQualifies(receipt, 16, "balanced")).toBe(false);
  });

  it("refuses an effective failure even when every app-tree state passed", () => {
    const failing = { ...receipt, systemMemory: { effective: [{ state: "dictation", verdict: "fail" }, { state: "meeting", verdict: "warn" }] } };
    expect(footprintReceiptQualifies(failing, 8, "light")).toBe(false);
    expect(footprintReceiptFailures(failing)).toEqual(["dictation (effective, with system speech memory)"]);
    const warning = { ...receipt, systemMemory: { effective: [{ state: "dictation", verdict: "warn" }] } };
    expect(footprintReceiptQualifies(warning, 8, "light")).toBe(true);
  });

  it("names app-tree failures and refuses incomplete receipts", () => {
    const over = { ...receipt, states: receipt.states.map((state) => (state.state === "meeting" ? { ...state, pass: false } : state)) };
    expect(footprintReceiptFailures(over)).toEqual(["meeting"]);
    expect(footprintReceiptQualifies(over, 8, "light")).toBe(false);
    expect(footprintReceiptQualifies({ ...receipt, states: receipt.states.slice(1) }, 8, "light")).toBe(false);
    expect(footprintReceiptQualifies(null, 8, "light")).toBe(false);
  });

  it("never lets a busier-other-apps stress run stand in for the standard receipt", () => {
    expect(footprintReceiptQualifies({ ...receipt, simulateAvailableGb: null }, 8, "light")).toBe(true);
    expect(footprintReceiptQualifies({ ...receipt, simulateAvailableGb: 2.5 }, 8, "light")).toBe(false);
  });
});
