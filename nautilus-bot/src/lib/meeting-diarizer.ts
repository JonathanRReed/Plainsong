import {
  isKnownAsrProvider,
  providerReturnsSpeakerLabels,
} from "@/lib/asr-capabilities";
import type { AsrProviderType, MeetingTranscriptDetails } from "@/types";

/**
 * Display names for the diarizing ASR providers. Only providers that actually
 * return speaker labels need one, because only they can appear here.
 */
const PROVIDER_DIARIZER_NAMES: Partial<Record<AsrProviderType, string>> = {
  deepgram: "Deepgram",
  mistral_voxtral: "Mistral Voxtral",
  gemini_transcribe: "Gemini",
};

/**
 * What produced the speaker badges on this transcript, in one phrase.
 *
 * This reads a recorded fact -- `transcripts.diarizer`, written in the same
 * transaction as the labels -- rather than inferring one from the ASR
 * provider. The inference would be wrong exactly when it matters: a meeting
 * transcribed by Deepgram whose provider-diarization attempt fell back to the
 * local pipeline would claim "Speakers by Deepgram" for labels Deepgram never
 * produced.
 *
 * `null` when there is nothing honest to say: no diarizer has run, the
 * transcript has no speaker labels at all, or the capture labelled its own
 * sides (the "Me + Them" case, where no diarizer was involved and the capture
 * mode already says so).
 */
export function describeMeetingDiarizer(
  details: MeetingTranscriptDetails | null | undefined,
): string | null {
  if (!details || !details.hasSpeakerLabels || details.hasSourceAwareSpeakers) {
    return null;
  }

  const recorded = details.diarizer?.trim();
  if (!recorded) {
    return null;
  }

  if (recorded.startsWith("plainsong:")) {
    return "Speakers by Plainsong";
  }

  // Two gates, not one. `providerReturnsSpeakerLabels` is the same set the
  // sidecar uses to decide whether provider labels are even possible, so a
  // recorded value naming a provider that cannot diarize is treated as
  // unrecognised rather than rendered as a claim.
  if (isKnownAsrProvider(recorded) && providerReturnsSpeakerLabels(recorded)) {
    const name = PROVIDER_DIARIZER_NAMES[recorded as AsrProviderType];
    if (name) {
      return `Speakers by ${name}`;
    }
  }

  // A recorded value this build does not recognise -- a transcript written by
  // a newer version, say. Naming it verbatim would put a raw identifier in the
  // header; claiming Plainsong produced it would be false.
  return null;
}

/**
 * The tooltip behind the phrase above: where the labels came from and what
 * that cost, so "Speakers by Deepgram" is not just a brand name in a header.
 */
export function describeMeetingDiarizerDetail(
  details: MeetingTranscriptDetails | null | undefined,
): string | null {
  const recorded = details?.diarizer?.trim();
  if (!describeMeetingDiarizer(details) || !recorded) {
    return null;
  }

  if (recorded.startsWith("plainsong:")) {
    const model = recorded.slice("plainsong:".length);
    return `Speakers were separated on this Mac by Plainsong's own diarizer (${model}). No audio left the machine for this step.`;
  }

  const name = PROVIDER_DIARIZER_NAMES[recorded as AsrProviderType] ?? recorded;
  return `Speakers came back with the transcript from ${name}, which already had the audio. Plainsong did not run its own diarizer over it a second time.`;
}
