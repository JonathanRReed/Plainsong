import { describe, expect, it } from "vitest";
import {
  describeMeetingDiarizer,
  describeMeetingDiarizerDetail,
} from "@/lib/meeting-diarizer";
import type { MeetingTranscriptDetails } from "@/types";

function details(
  overrides: Partial<MeetingTranscriptDetails> = {},
): MeetingTranscriptDetails {
  return {
    segmentCount: 12,
    sourceMode: "speaker_labels",
    hasSourceAwareSpeakers: false,
    hasSpeakerLabels: true,
    ...overrides,
  };
}

describe("describeMeetingDiarizer", () => {
  it("names the provider that actually produced the labels", () => {
    expect(describeMeetingDiarizer(details({ diarizer: "deepgram" }))).toBe(
      "Speakers by Deepgram",
    );
    expect(describeMeetingDiarizer(details({ diarizer: "gemini_transcribe" }))).toBe(
      "Speakers by Gemini",
    );
  });

  it("names Plainsong for a locally diarized meeting, whatever embedding model ran", () => {
    expect(
      describeMeetingDiarizer(details({ diarizer: "plainsong:ecapa_tdnn_speaker" })),
    ).toBe("Speakers by Plainsong");
    expect(
      describeMeetingDiarizer(details({ diarizer: "plainsong:campplus_speaker" })),
    ).toBe("Speakers by Plainsong");
  });

  it("credits the provider only for labels it recorded, not for transcribing", () => {
    // The case this exists for: a meeting Deepgram transcribed whose
    // provider-diarization attempt fell back to the local pipeline. Inferring
    // the diarizer from the ASR provider would put Deepgram's name on labels
    // Deepgram never produced.
    expect(
      describeMeetingDiarizer(
        details({ actualProvider: "deepgram", diarizer: "plainsong:ecapa_tdnn_speaker" }),
      ),
    ).toBe("Speakers by Plainsong");
  });

  it("says nothing when no diarizer has run", () => {
    expect(describeMeetingDiarizer(details({ diarizer: null }))).toBeNull();
    expect(describeMeetingDiarizer(details({ diarizer: "  " }))).toBeNull();
    expect(describeMeetingDiarizer(details({ diarizer: undefined }))).toBeNull();
    expect(describeMeetingDiarizer(null)).toBeNull();
  });

  it("says nothing for a capture that labelled its own sides", () => {
    // "Me" comes from which microphone heard it, not from a diarizer, and the
    // capture mode beside this already says "Me + Them".
    expect(
      describeMeetingDiarizer(
        details({
          sourceMode: "me_them",
          hasSourceAwareSpeakers: true,
          diarizer: "deepgram",
        }),
      ),
    ).toBeNull();
  });

  it("says nothing for a transcript with no speaker labels at all", () => {
    expect(
      describeMeetingDiarizer(
        details({
          sourceMode: "single_source",
          hasSpeakerLabels: false,
          diarizer: "plainsong:ecapa_tdnn_speaker",
        }),
      ),
    ).toBeNull();
  });

  it("stays silent on a diarizer name this build does not recognise", () => {
    // A transcript written by a newer version. Rendering the raw identifier
    // would put machine text in the header; claiming Plainsong produced it
    // would be false.
    expect(describeMeetingDiarizer(details({ diarizer: "some_future_provider" }))).toBeNull();
  });

  it("refuses to credit a provider that cannot return speaker labels", () => {
    // A recorded value naming, say, Groq could only come from a corrupted or
    // hand-edited row: Groq's API returns no speaker field at all. The header
    // says nothing rather than reporting a diarization that cannot have
    // happened.
    for (const providerType of ["groq", "openai_cloud", "cohere_transcribe"]) {
      expect(describeMeetingDiarizer(details({ diarizer: providerType }))).toBeNull();
    }
  });
});

describe("describeMeetingDiarizerDetail", () => {
  it("explains the local case without claiming anything left the machine", () => {
    const detail = describeMeetingDiarizerDetail(
      details({ diarizer: "plainsong:campplus_speaker" }),
    );
    expect(detail).toContain("campplus_speaker");
    expect(detail).toContain("No audio left the machine");
  });

  it("explains that the provider already had the audio", () => {
    const detail = describeMeetingDiarizerDetail(details({ diarizer: "deepgram" }));
    expect(detail).toContain("Deepgram");
    expect(detail).toContain("already had the audio");
  });

  it("returns nothing wherever the phrase itself returns nothing", () => {
    expect(describeMeetingDiarizerDetail(details({ diarizer: null }))).toBeNull();
    expect(
      describeMeetingDiarizerDetail(
        details({ hasSourceAwareSpeakers: true, diarizer: "deepgram" }),
      ),
    ).toBeNull();
  });
});
