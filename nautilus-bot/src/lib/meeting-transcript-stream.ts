/**
 * The renderer half of the `recording-transcription-stream` and
 * `meeting-audio-source-warning` contracts.
 *
 * The sidecar emits both readings of a live segment on every event: `text` is
 * the whole preview transcript so far and `segmentText` only the words that
 * segment added (see rust-sidecar/src/streaming.rs). A surface that shows one
 * running block reads `text`; a surface that renders timestamped lines reads
 * `segmentText`, because stamping the running transcript with the newest
 * segment's start time claims the whole meeting began there.
 */

export const RECORDING_TRANSCRIPTION_STREAM_EVENT = "recording-transcription-stream";
export const MEETING_AUDIO_SOURCE_WARNING_EVENT = "meeting-audio-source-warning";

export type TranscriptSegmentKind = "speech" | "gap";

export interface RecordingTranscriptionStreamEvent {
  recordingId: string;
  /** Whether `text` will still grow. Describes the running transcript, not the segment. */
  isPartial: boolean;
  isFinal: boolean;
  /** The whole preview transcript so far, this segment included. */
  text: string;
  /** Only the words this segment added, or the stand-in for a lost span. */
  segmentText?: string;
  startTime?: number;
  endTime?: number;
  confidence?: number;
  kind?: TranscriptSegmentKind;
  /** The provider only decodes whole buffers, so this trails the speaker. */
  delayedPreview?: boolean;
  lagSeconds?: number;
}

export interface MeetingAudioSourceWarningEvent {
  recordingId: string;
  source: "mic" | "system" | string;
  reason: string;
  silentSeconds?: number;
}

export interface TranscriptStreamLine {
  text: string;
  startTime: number;
  endTime: number;
  kind: TranscriptSegmentKind;
}

/**
 * Append one event's own words to the line list.
 *
 * Returns the same array when the event carries nothing to show — the closing
 * marker has an empty `segmentText` and exists only to say the preview stopped,
 * so it must not push a blank line.
 */
export function appendTranscriptStreamLine(
  lines: TranscriptStreamLine[],
  event: RecordingTranscriptionStreamEvent
): TranscriptStreamLine[] {
  const segmentText = (event.segmentText ?? "").trim();
  if (!segmentText) {
    return lines;
  }
  return [
    ...lines,
    {
      text: segmentText,
      startTime: event.startTime ?? 0,
      endTime: event.endTime ?? event.startTime ?? 0,
      kind: event.kind === "gap" ? "gap" : "speech",
    },
  ];
}

export interface TranscriptDelayDescriptor {
  /** Panel label. Never says "live" while the preview is running behind. */
  label: string;
  /** One line stating how far behind, or what the panel is when it is not behind. */
  caption: string;
  delayed: boolean;
}

/**
 * Describe the honesty of the preview panel.
 *
 * No ASR provider wired here decodes incrementally, so the panel is a preview
 * that trails the speaker. Calling it a live transcript would be a claim the
 * bytes do not support.
 */
export function describeTranscriptDelay(
  event: Pick<RecordingTranscriptionStreamEvent, "delayedPreview" | "lagSeconds"> | null | undefined
): TranscriptDelayDescriptor {
  if (!event?.delayedPreview) {
    return {
      label: "Transcript preview",
      caption: "Lines land here as they are decoded.",
      delayed: false,
    };
  }

  const lagSeconds = Math.max(0, Math.round(event.lagSeconds ?? 0));
  return {
    label: "Delayed preview",
    caption: lagSeconds
      ? `Running about ${lagSeconds}s behind the speaker — not a live caption.`
      : "Trails the speaker while each span is decoded — not a live caption.",
    delayed: true,
  };
}

/** Plain-language label for a span of audio that was lost before it was decoded. */
export function describeTranscriptGap(line: TranscriptStreamLine): string {
  const droppedSeconds = Math.max(0, Math.round(line.endTime - line.startTime));
  return droppedSeconds
    ? `${droppedSeconds}s of audio was overwritten before it could be read`
    : "Some audio was overwritten before it could be read";
}

export interface AudioSourceWarningDescriptor {
  title: string;
  message: string;
}

/**
 * Describe a capture source that has gone quiet mid-meeting.
 *
 * The user has to learn this while the meeting is still running — after the
 * fact the missing half of the conversation cannot be recovered.
 */
export function describeAudioSourceWarning(
  warning: MeetingAudioSourceWarningEvent
): AudioSourceWarningDescriptor {
  const sourceLabel = warning.source === "system" ? "System audio" : "Microphone";
  const silentSeconds = Math.max(0, Math.round(warning.silentSeconds ?? 0));
  const duration = silentSeconds ? ` for ${silentSeconds}s` : "";
  return {
    title: `${sourceLabel} has gone silent`,
    message: `${sourceLabel} has recorded nothing${duration}. Check the device is still connected and unmuted — anything it would have captured is not being recorded.`,
  };
}
