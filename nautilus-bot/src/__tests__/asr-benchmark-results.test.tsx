import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AsrBenchmarkResults } from "@/components/asr-benchmark-results";
import type { BenchmarkResult } from "@/types/asr";

const success: BenchmarkResult = {
  providerType: "whisper", providerName: "Whisper", modelId: "base.en",
  runtimeStatus: "ready", nonEmptyTranscript: true, processingTimeMs: 1234,
  transcription: "Keep the price at €12.50.", confidence: 0.9,
};

describe("benchmark results", () => {
  it("shows the transcript for review without presenting placeholder confidence as accuracy", () => {
    render(<AsrBenchmarkResults results={[success]} />);
    expect(screen.getByText(success.transcription)).toBeInTheDocument();
    expect(screen.getByText("1.23s")).toBeInTheDocument();
    expect(screen.getByText("Processing time")).toBeInTheDocument();
    expect(screen.queryByText(/90/)).not.toBeInTheDocument();
  });
  it("distinguishes a memory refusal from a successful empty transcript", () => {
    render(<AsrBenchmarkResults results={[{ ...success, runtimeStatus: "error", nonEmptyTranscript: false, transcription: "", errorMessage: "Insufficient memory: 6 GiB reserve required." }]} />);
    expect(screen.getByText(/Insufficient memory/)).toBeInTheDocument();
    expect(screen.getByText(/Could not benchmark/)).toBeInTheDocument();
    expect(screen.getByText("Attempt duration")).toBeInTheDocument();
    expect(screen.queryByText("No speech returned.")).not.toBeInTheDocument();
    expect(screen.queryByText("Processing time")).not.toBeInTheDocument();
  });
  it("provides a useful fallback for an older failure result without error text", () => {
    render(<AsrBenchmarkResults results={[{ ...success, runtimeStatus: "error", transcription: "", nonEmptyTranscript: false }]} />);
    expect(screen.getByText(/Check its setup and available memory/)).toBeInTheDocument();
  });
  it("shows an empty successful transcript separately", () => {
    render(<AsrBenchmarkResults results={[{ ...success, transcription: "", nonEmptyTranscript: false }]} />);
    expect(screen.getByText("No speech returned.")).toBeInTheDocument();
    expect(screen.queryByText("Attempt duration")).not.toBeInTheDocument();
  });
});
