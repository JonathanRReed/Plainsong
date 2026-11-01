import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_ASR_BENCHMARK_AUDIO_BYTES,
  readAsrBenchmarkAudio,
} from "@/lib/asr-benchmark-audio";

describe("benchmark audio memory limit", () => {
  it("rejects an oversized file before reading its contents", async () => {
    const arrayBuffer = vi.fn();
    await expect(
      readAsrBenchmarkAudio({
        size: MAX_ASR_BENCHMARK_AUDIO_BYTES + 1,
        arrayBuffer,
      }),
    ).rejects.toThrow("up to 6 MiB");
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it.each([0, -1, NaN, Infinity, 1.5])(
    "does not read an invalid declared length %s",
    async (size) => {
      const arrayBuffer = vi.fn();
      await expect(readAsrBenchmarkAudio({ size, arrayBuffer })).rejects.toThrow(
        "nonempty WAV",
      );
      expect(arrayBuffer).not.toHaveBeenCalled();
    },
  );

  it("accepts the exact limit and returns the original bytes", async () => {
    const buffer = new ArrayBuffer(MAX_ASR_BENCHMARK_AUDIO_BYTES);
    new Uint8Array(buffer)[0] = 82;
    const arrayBuffer = vi.fn().mockResolvedValue(buffer);
    const result = await readAsrBenchmarkAudio({
      size: buffer.byteLength,
      arrayBuffer,
    });
    expect(result.buffer).toBe(buffer);
    expect(result[0]).toBe(82);
    expect(arrayBuffer).toHaveBeenCalledOnce();
  });

  it("refuses content that differs from the declared length", async () => {
    await expect(
      readAsrBenchmarkAudio({
        size: 2,
        arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(3)),
      }),
    ).rejects.toThrow("changed while reading");
  });

  it("matches the sidecar's byte limit", () => {
    const source = readFileSync("rust-sidecar/src/lib.rs", "utf8");
    const expression = source.match(
      /const MAX_BENCHMARK_AUDIO_BYTES: usize = ([\d\s*]+);/,
    )?.[1];
    expect(expression).toBeDefined();
    const bytes = expression!
      .split("*")
      .map(Number)
      .reduce((total, value) => total * value, 1);
    expect(MAX_ASR_BENCHMARK_AUDIO_BYTES).toBe(bytes);
  });
});
