import { describe, expect, it } from "vitest";
import { speakerModelName, speakerModelOptionLabel } from "@/lib/speaker-models";
import type { DiarizationModelOption } from "@/lib/backend";

function option(overrides: Partial<DiarizationModelOption>): DiarizationModelOption {
  return {
    id: "ecapa_tdnn_speaker",
    label: "ECAPA-TDNN 512",
    description: "Small and light on memory. Remembers voices.",
    installed: false,
    downloadSize: "25 MB",
    ...overrides,
  };
}

describe("speaker model picker copy", () => {
  it("labels picker rows with size and download state", () => {
    expect(speakerModelOptionLabel(option({}))).toBe("ECAPA-TDNN 512, 25 MB (not downloaded)");
    expect(speakerModelOptionLabel(option({ installed: true, downloadSize: null }))).toBe("ECAPA-TDNN 512");
  });

  it("names known models and nothing else", () => {
    expect(speakerModelName("pyannote_community1")).toBe("pyannote community-1");
    expect(speakerModelName("unknown")).toBeNull();
  });
});
