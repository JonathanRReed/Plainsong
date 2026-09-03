import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  TranscriptViewer,
  type SpeakerVoiceState,
} from "@/components/transcript-viewer";

/** Two speakers, one turn each, so both headers render once. */
const TWO_SPEAKER_SEGMENTS = [
  {
    id: "seg-1",
    startTime: 0,
    endTime: 4,
    text: "We agreed on the plan.",
    speakerId: "S1",
    confidence: 0.95,
  },
  {
    id: "seg-2",
    startTime: 10,
    endTime: 14,
    text: "Kickoff is Monday.",
    speakerId: "S2",
    confidence: 0.93,
  },
  {
    id: "seg-3",
    startTime: 20,
    endTime: 24,
    text: "And the review is Thursday.",
    speakerId: "S1",
    confidence: 0.93,
  },
];

const DANA_SUGGESTION: Record<string, SpeakerVoiceState> = {
  S1: {
    matchState: null,
    suggestion: { profileId: "p-dana", displayName: "Dana", percent: 91 },
  },
};

describe("TranscriptViewer voiceprint suggestions", () => {
  it("shows nothing about voices when there are no suggestions", () => {
    render(
      <TranscriptViewer
        segments={TWO_SPEAKER_SEGMENTS}
        onRenameSpeaker={vi.fn(async () => {})}
      />,
    );

    expect(screen.queryByText(/Looks like/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm" })).not.toBeInTheDocument();
    expect(screen.queryByText("auto")).not.toBeInTheDocument();
  });

  it("offers one chip per matched speaker, on that speaker's first turn only", () => {
    render(
      <TranscriptViewer
        segments={TWO_SPEAKER_SEGMENTS}
        speakerVoices={DANA_SUGGESTION}
        onConfirmSpeakerVoice={vi.fn(async () => {})}
        onRejectSpeakerVoice={vi.fn(async () => {})}
      />,
    );

    // S1 speaks twice; the offer appears once.
    const chips = screen.getAllByText(/Looks like/);
    expect(chips).toHaveLength(1);
    expect(chips[0]).toHaveTextContent("Looks like Dana, 91%");
    expect(screen.getAllByRole("button", { name: "Confirm" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Not them" })).toHaveLength(1);
  });

  it("confirms with the speaker and profile the chip named", async () => {
    const onConfirmSpeakerVoice = vi.fn(async () => {});
    render(
      <TranscriptViewer
        segments={TWO_SPEAKER_SEGMENTS}
        speakerVoices={DANA_SUGGESTION}
        onConfirmSpeakerVoice={onConfirmSpeakerVoice}
        onRejectSpeakerVoice={vi.fn(async () => {})}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    });

    expect(onConfirmSpeakerVoice).toHaveBeenCalledWith("S1", "p-dana");
  });

  it("rejects with the speaker and profile the chip named", async () => {
    const onRejectSpeakerVoice = vi.fn(async () => {});
    render(
      <TranscriptViewer
        segments={TWO_SPEAKER_SEGMENTS}
        speakerVoices={DANA_SUGGESTION}
        onConfirmSpeakerVoice={vi.fn(async () => {})}
        onRejectSpeakerVoice={onRejectSpeakerVoice}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Not them" }));
    });

    expect(onRejectSpeakerVoice).toHaveBeenCalledWith("S1", "p-dana");
  });

  // An auto-applied name is on the transcript already, so the chip has to say
  // where the name came from rather than pretending it is a fresh guess, and
  // the header carries an "auto" marker until someone agrees with it.
  it("marks an auto-applied name and words its chip differently", () => {
    render(
      <TranscriptViewer
        segments={TWO_SPEAKER_SEGMENTS}
        speakerNames={{ S1: "Dana" }}
        speakerVoices={{
          S1: {
            matchState: "auto",
            suggestion: { profileId: "p-dana", displayName: "Dana", percent: 97 },
          },
        }}
        onConfirmSpeakerVoice={vi.fn(async () => {})}
        onRejectSpeakerVoice={vi.fn(async () => {})}
      />,
    );

    expect(
      screen.getByText(/Named from a remembered voice/),
    ).toHaveTextContent("Named from a remembered voice: Dana, 97%");
    expect(screen.getAllByText("auto").length).toBeGreaterThan(0);
  });

  it("says nothing more once a match is confirmed", () => {
    render(
      <TranscriptViewer
        segments={TWO_SPEAKER_SEGMENTS}
        speakerNames={{ S1: "Dana" }}
        speakerVoices={{ S1: { matchState: "confirmed", suggestion: null } }}
        onConfirmSpeakerVoice={vi.fn(async () => {})}
        onRejectSpeakerVoice={vi.fn(async () => {})}
      />,
    );

    expect(screen.queryByRole("button", { name: "Confirm" })).not.toBeInTheDocument();
    expect(screen.queryByText("auto")).not.toBeInTheDocument();
  });
});

describe("TranscriptViewer rename-and-remember", () => {
  it("does not offer to remember a voice while the setting is off", () => {
    render(
      <TranscriptViewer
        segments={TWO_SPEAKER_SEGMENTS}
        onRenameSpeaker={vi.fn(async () => {})}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Rename Speakers" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Edit speaker name" })[0]);

    expect(screen.queryByLabelText(/Remember this voice/)).not.toBeInTheDocument();
  });

  it("offers to remember, checked by default, and passes the choice through", async () => {
    const onRenameSpeaker = vi.fn(async () => {});
    render(
      <TranscriptViewer
        segments={TWO_SPEAKER_SEGMENTS}
        rememberVoicesEnabled
        onRenameSpeaker={onRenameSpeaker}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Rename Speakers" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Edit speaker name" })[0]);
    fireEvent.change(screen.getByLabelText("Speaker name"), {
      target: { value: "Dana" },
    });

    const remember = screen.getByLabelText("Remember this voice as Dana");
    expect(remember).toBeChecked();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save speaker name" }));
    });

    expect(onRenameSpeaker).toHaveBeenCalledWith("S1", "Dana", true);
  });

  it("renames without remembering when the offer is switched off", async () => {
    const onRenameSpeaker = vi.fn(async () => {});
    render(
      <TranscriptViewer
        segments={TWO_SPEAKER_SEGMENTS}
        rememberVoicesEnabled
        onRenameSpeaker={onRenameSpeaker}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Rename Speakers" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Edit speaker name" })[0]);
    fireEvent.change(screen.getByLabelText("Speaker name"), {
      target: { value: "Dana" },
    });
    fireEvent.click(screen.getByLabelText("Remember this voice as Dana"));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save speaker name" }));
    });

    expect(onRenameSpeaker).toHaveBeenCalledWith("S1", "Dana", false);
  });
});
