import { describe, expect, it } from "vitest";
import {
  ANALYSIS_PROVIDER_OPTIONS,
  analysisModelChoices,
  analysisProviderOptionsForLane,
  describeAnalysisDestination,
  isDictationOnlyAnalysisProvider,
  isRemoteAnalysisProvider,
  isZeroSetupAnalysisProvider,
} from "@/components/models/ai-lanes";

describe("the zero-setup analysis providers", () => {
  it("are never described as sending text off the machine", () => {
    // The bundled model runs in the sidecar process and Apple's runs in a
    // helper with no network client. Mirrors `Provider::is_remote` in
    // rust-sidecar/src/llm/transport.rs -- if these two ever disagree, the
    // privacy disclosure and the policy gate say different things.
    expect(isRemoteAnalysisProvider("bundled_local")).toBe(false);
    expect(isRemoteAnalysisProvider("apple_language_model")).toBe(false);
  });

  it("name the bundled model exactly as its license requires", () => {
    // Apache-2.0 plus a naming clause: "S1-mini" by "Superwhisper", that
    // exact capitalization, wherever it is used.
    expect(describeAnalysisDestination("bundled_local")).toContain("S1-mini");
    expect(describeAnalysisDestination("bundled_local")).toContain(
      "Superwhisper",
    );
  });

  it("say where Apple's model runs", () => {
    expect(describeAnalysisDestination("apple_language_model")).toContain(
      "on this Mac",
    );
  });

  it("are both flagged as zero-setup, and Ollama is not", () => {
    expect(isZeroSetupAnalysisProvider("bundled_local")).toBe(true);
    expect(isZeroSetupAnalysisProvider("apple_language_model")).toBe(true);
    // Ollama is local, but it is still software the user installs and runs.
    expect(isZeroSetupAnalysisProvider("ollama")).toBe(false);
    expect(isZeroSetupAnalysisProvider(undefined)).toBe(false);
  });
});

describe("provider options per lane", () => {
  it("offers the built-in model first in the dictation lane", () => {
    const options = analysisProviderOptionsForLane("dictationAi");
    expect(options[0]).toEqual({
      value: "bundled_local",
      label: "Built-in (no setup)",
    });
    expect(options.map((option) => option.value)).toContain(
      "apple_language_model",
    );
  });

  it("keeps the dictation-only providers out of the meetings lane", () => {
    // Both refuse meeting work in the sidecar, so offering them here would
    // only be a way to choose a guaranteed failure.
    const values = analysisProviderOptionsForLane("meetingsAi").map(
      (option) => option.value,
    );
    expect(values).not.toContain("bundled_local");
    expect(values).not.toContain("apple_language_model");
    expect(values).toContain("ollama");
    expect(values).toContain("anthropic");
  });

  it("drops exactly the dictation-only providers and nothing else", () => {
    const meetings = analysisProviderOptionsForLane("meetingsAi");
    const dropped = ANALYSIS_PROVIDER_OPTIONS.filter(
      (option) => !meetings.some((kept) => kept.value === option.value),
    );
    expect(dropped.map((option) => option.value).sort()).toEqual([
      "apple_language_model",
      "bundled_local",
    ]);
    for (const option of dropped) {
      expect(isDictationOnlyAnalysisProvider(option.value)).toBe(true);
    }
  });
});

describe("model choices", () => {
  it("returns nothing for the on-device providers, which serve one model", () => {
    // An empty list is what makes the lane row render the fixed-model card
    // instead of a picker with a catalogue it cannot fetch.
    expect(analysisModelChoices("bundled_local", ["anything"])).toEqual([]);
    expect(analysisModelChoices("apple_language_model", ["anything"])).toEqual(
      [],
    );
  });

  it("still filters the cloud catalogues the way it did", () => {
    expect(
      analysisModelChoices("openai", ["gpt-5.6-luna", "gpt-4o-transcribe"]),
    ).toEqual(["gpt-5.6-luna"]);
  });
});
