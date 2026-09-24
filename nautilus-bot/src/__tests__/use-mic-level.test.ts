import { describe, expect, it } from "vitest";
import {
  accumulateHeardMs,
  classifyMicError,
  levelFromSamples,
  MIC_HEARD_AFTER_MS,
  MIC_HEARD_LEVEL,
  micErrorMessage,
  smoothLevel,
} from "@/hooks/use-mic-level";

function tone(amplitude: number, length = 1024): Float32Array {
  return Float32Array.from({ length }, (_, index) =>
    amplitude * Math.sin((index / length) * Math.PI * 16),
  );
}

describe("levelFromSamples", () => {
  it("reads silence and an empty frame as zero", () => {
    expect(levelFromSamples(new Float32Array(512))).toBe(0);
    expect(levelFromSamples([])).toBe(0);
  });

  it("maps loudness onto a -60..0 dBFS scale", () => {
    // A full-scale square wave is 0 dBFS; one hundredth of it is -40 dBFS.
    expect(levelFromSamples(new Float32Array(256).fill(1))).toBeCloseTo(1, 5);
    expect(levelFromSamples(new Float32Array(256).fill(0.01))).toBeCloseTo(1 / 3, 5);
    expect(levelFromSamples(new Float32Array(256).fill(0.001))).toBeCloseTo(0, 5);
  });

  it("puts normal speech above the heard line and room noise below it", () => {
    // Speech peaks around -20 dBFS; a quiet room sits near -55 dBFS.
    expect(levelFromSamples(tone(0.14))).toBeGreaterThan(MIC_HEARD_LEVEL);
    expect(levelFromSamples(tone(0.0025))).toBeLessThan(MIC_HEARD_LEVEL);
  });

  it("never leaves 0..1, even for clipped input", () => {
    expect(levelFromSamples(new Float32Array(64).fill(4))).toBe(1);
  });
});

describe("smoothLevel", () => {
  it("rises faster than it falls", () => {
    const rise = smoothLevel(0.2, 0.8) - 0.2;
    const fall = 0.8 - smoothLevel(0.8, 0.2);
    expect(rise).toBeGreaterThan(fall);
  });

  it("settles on a steady input", () => {
    let level = 0;
    for (let frame = 0; frame < 60; frame += 1) {
      level = smoothLevel(level, 0.6);
    }
    expect(level).toBeCloseTo(0.6, 3);
  });
});

describe("accumulateHeardMs", () => {
  it("counts only time spent above the line", () => {
    let total = 0;
    total = accumulateHeardMs(total, MIC_HEARD_LEVEL + 0.1, 100);
    total = accumulateHeardMs(total, MIC_HEARD_LEVEL - 0.1, 400);
    total = accumulateHeardMs(total, MIC_HEARD_LEVEL, 50);
    expect(total).toBe(150);
  });

  it("needs a moment of speech, not a single click, to count as heard", () => {
    expect(accumulateHeardMs(0, 1, 16)).toBeLessThan(MIC_HEARD_AFTER_MS);
  });

  it("ignores a clock that ran backwards", () => {
    expect(accumulateHeardMs(100, 1, -30)).toBe(100);
  });
});

describe("classifyMicError", () => {
  it.each([
    ["NotAllowedError", "denied"],
    ["PermissionDeniedError", "denied"],
    ["SecurityError", "denied"],
    ["NotFoundError", "no-device"],
    ["DevicesNotFoundError", "no-device"],
    ["OverconstrainedError", "no-device"],
    ["NotReadableError", "busy"],
    ["TrackStartError", "busy"],
    ["AbortError", "busy"],
    ["TypeError", "unavailable"],
  ] as const)("maps %s to %s", (name, kind) => {
    expect(classifyMicError(new DOMException("failed", name))).toBe(kind);
  });

  it("treats anything without a name as unavailable", () => {
    expect(classifyMicError("boom")).toBe("unavailable");
    expect(classifyMicError(null)).toBe("unavailable");
  });

  it("names the failure and what to do about it", () => {
    expect(micErrorMessage("denied")).toMatch(/Privacy & Security > Microphone/);
    expect(micErrorMessage("no-device")).toMatch(/^No microphone found/);
    expect(micErrorMessage("busy")).toMatch(/in use by another app/);
  });
});
