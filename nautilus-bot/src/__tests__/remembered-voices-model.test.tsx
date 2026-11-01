import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  RememberedVoicesSection,
  rememberedVoicesModelNote,
} from "@/components/remembered-voices-section";
import type { RememberedVoice } from "@/lib/backend";

/**
 * A voice signature only matches under the speaker model that computed it.
 * Switching models (new Apple Silicon installs start on pyannote
 * community-1) must not make earlier voices disappear without a word.
 */

vi.mock("@/components/toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

const voices: RememberedVoice[] = [];
vi.mock("@/lib/backend/asr", () => ({
  listRememberedVoices: vi.fn(async () => voices),
  forgetRememberedVoice: vi.fn(async () => true),
  forgetAllRememberedVoices: vi.fn(async () => 0),
}));

const voice = (id: string, model: string): RememberedVoice => ({
  id,
  displayName: id,
  embeddingModelId: model,
  sampleCount: 1,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
});

const labels = {
  ecapa_tdnn_speaker: "ECAPA-TDNN 512",
  pyannote_community1: "pyannote community-1",
  nemotron3_diarization: "Nemotron 3 Diarization (experimental)",
};

function renderWith(activeModelId: string, runModelId?: string | null) {
  render(
    <RememberedVoicesSection
      rememberVoices
      autoApplyConfidentVoices={false}
      onRememberVoicesChange={vi.fn()}
      onAutoApplyChange={vi.fn()}
      activeModelId={activeModelId}
      runModelId={runModelId}
      modelLabels={labels}
    />,
  );
}

const label = (id: string) => labels[id as keyof typeof labels] ?? id;

describe("remembered voices under another speaker model", () => {
  it("says which voices cannot be matched by the active model, and keeps them", async () => {
    voices.splice(0, voices.length, voice("Dana", "ecapa_tdnn_speaker"), voice("Ravi", "ecapa_tdnn_speaker"), voice("Mo", "pyannote_community1"));
    renderWith("pyannote_community1");
    const notice = await screen.findByTestId("remembered-voices-model-notice");
    expect(notice).toHaveTextContent(
      "2 voices remembered with ECAPA-TDNN 512 can’t be matched while pyannote community-1 tells speakers apart",
    );
    expect(notice).toHaveTextContent("They are kept");
    // Each stored voice names its model as the picker does, not by its id.
    expect(await screen.findAllByText(/· ECAPA-TDNN 512/)).toHaveLength(2);
  });

  it("names voices from a model the picker no longer offers", async () => {
    voices.splice(0, voices.length, voice("Ana", "eres2netv2_speaker"));
    renderWith("ecapa_tdnn_speaker");
    const notice = await screen.findByTestId("remembered-voices-model-notice");
    expect(notice).toHaveTextContent("1 voice remembered with ERes2NetV2 can’t be matched");
    expect(await screen.findByText(/· ERes2NetV2/)).toBeInTheDocument();
  });

  it("says nothing when every voice belongs to the active model", async () => {
    voices.splice(0, voices.length, voice("Mo", "pyannote_community1"));
    renderWith("pyannote_community1");
    await screen.findByText(/· pyannote community-1/);
    expect(screen.queryByTestId("remembered-voices-model-notice")).toBeNull();
  });

  it("says a model without signatures neither remembers nor recognises voices", async () => {
    voices.splice(0, voices.length, voice("Dana", "ecapa_tdnn_speaker"));
    renderWith("nemotron3_diarization");
    const notice = await screen.findByTestId("remembered-voices-model-notice");
    expect(notice).toHaveTextContent("neither remembers nor recognises voices");
  });

  it("keys the note off the model that will run when the selected one is missing", async () => {
    // community-1 selected but not downloaded; ECAPA runs instead. ECAPA
    // voices will match, so they are not the ones called out.
    voices.splice(0, voices.length, voice("Dana", "ecapa_tdnn_speaker"), voice("Mo", "pyannote_community1"));
    renderWith("pyannote_community1", "ecapa_tdnn_speaker");
    const notice = await screen.findByTestId("remembered-voices-model-notice");
    expect(notice).toHaveTextContent(
      "1 voice remembered with pyannote community-1 can’t be matched while ECAPA-TDNN 512 tells speakers apart. pyannote community-1 is selected but isn’t downloaded, so meetings use ECAPA-TDNN 512.",
    );
    expect(notice).toHaveTextContent("download pyannote community-1 under Speakers");
    expect(notice).not.toHaveTextContent("remembered with ECAPA-TDNN 512");
  });

  it("says nothing in the fallback case when every voice matches the model that runs", async () => {
    voices.splice(0, voices.length, voice("Dana", "ecapa_tdnn_speaker"));
    renderWith("pyannote_community1", "ecapa_tdnn_speaker");
    await screen.findByText(/· ECAPA-TDNN 512/);
    expect(screen.queryByTestId("remembered-voices-model-notice")).toBeNull();
  });

  it("says plainly when no speaker model is downloaded at all", () => {
    expect(
      rememberedVoicesModelNote({
        voices: [voice("Dana", "ecapa_tdnn_speaker")],
        activeModelId: "pyannote_community1",
        runModelId: null,
        label,
      }),
    ).toBe(
      "No speaker model is downloaded, so meetings are saved without speaker labels and remembered voices can’t be matched. They are kept: download a speaker model under Speakers to use them.",
    );
    expect(
      rememberedVoicesModelNote({ voices: [], activeModelId: "pyannote_community1", runModelId: null, label }),
    ).toBeNull();
  });
});
