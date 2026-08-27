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
  /**
   * `silence` from the dropout watchdog, `capture_failed` when a source's
   * stream died and is being rebuilt, or a `SystemAudioFailureKind` from the
   * system-audio status emitter (see `emit_system_audio_status` in
   * rust-sidecar/src/audio/system_capture.rs). They are not the same event and
   * must not be described in the same words.
   */
  reason: string;
  silentSeconds?: number;
  /** The sidecar's own account of the failure, when it has one. */
  detail?: string;
  /** True when the route came back on its own; then this is not a warning. */
  recovered?: boolean;
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
 * Describe what happened to a capture source mid-meeting.
 *
 * The user has to learn this while the meeting is still running — after the
 * fact the missing half of the conversation cannot be recovered.
 *
 * The copy branches on `reason` because the events are different in kind. A
 * source whose stream *failed* is not a source that went quiet: telling someone
 * whose microphone stream died to "check the device is unmuted" sends them to
 * look at a mute button that was never the problem, while Plainsong is already
 * rebuilding the stream. A recovered route is not a warning at all.
 */
export function describeAudioSourceWarning(
  warning: MeetingAudioSourceWarningEvent
): AudioSourceWarningDescriptor {
  const sourceLabel = warning.source === "system" ? "System audio" : "Microphone";

  if (warning.recovered) {
    return {
      title: `${sourceLabel} is recording again`,
      message: `${sourceLabel} dropped out and has been restored. Anything it missed while it was down is not in the recording.`,
    };
  }

  if (warning.reason === "capture_failed") {
    return {
      title: `${sourceLabel} capture failed`,
      message: `The ${sourceLabel.toLowerCase()} stream stopped and Plainsong is rebuilding it. Nothing from that source is being recorded until it comes back.`,
    };
  }

  if (warning.reason !== "silence") {
    // A `SystemAudioFailureKind` — a route problem, not a quiet device. Pass
    // the sidecar's own account through rather than inventing device advice.
    return {
      title: `${sourceLabel} is not being recorded`,
      message:
        warning.detail?.trim() ||
        `Plainsong lost the ${sourceLabel.toLowerCase()} route. Nothing from that source is being recorded.`,
    };
  }

  const silentSeconds = Math.max(0, Math.round(warning.silentSeconds ?? 0));
  const duration = silentSeconds ? ` for ${silentSeconds}s` : "";
  return {
    title: `${sourceLabel} has gone silent`,
    message: `${sourceLabel} has recorded nothing${duration}. Check the device is still connected and unmuted — anything it would have captured is not being recorded.`,
  };
}
