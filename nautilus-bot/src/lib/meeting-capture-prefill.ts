/**
 * What an accepted offer carries into the meeting it starts.
 *
 * Two affordances open the consent sheet with something already known about
 * the meeting — the calendar cue and the detected-call cue — and the sheet
 * itself is the same one "New meeting" opens. This is the one shape the view
 * keeps between the click and the reader's answer, so neither source has to
 * be special-cased after that point.
 *
 * Everything here is pure.
 */

import type { CalendarCapturePrefill, CalendarVideoService } from "@/lib/calendar-events";
import type { DetectedCallCapturePrefill } from "@/lib/detected-call";

export interface MeetingCapturePrefill {
  /** Becomes the recording's title, so auto-naming leaves it alone. */
  title: string;
  /**
   * The conferencing service this meeting is on, stored with the recording so
   * a meeting that began from a detected call and one that began from a
   * calendar event carry the same tag.
   */
  videoService: CalendarVideoService | null;
  /**
   * The detected call this capture is the answer to, or `null` for every
   * other way of starting. The sidecar binds a meeting's auto-stop to this
   * call and to no other — see `bind_detected_call` in
   * rust-sidecar/src/meeting_detect.rs.
   */
  detectedCallId: number | null;
}

/** A calendar event's prefill. Its `eventId` stays in the renderer. */
export function meetingCapturePrefillFromCalendarEvent(
  prefill: CalendarCapturePrefill,
): MeetingCapturePrefill {
  return {
    title: prefill.title,
    videoService: prefill.videoService,
    detectedCallId: null,
  };
}

/** A detected call's prefill. Its `callId` is what the sidecar binds to. */
export function meetingCapturePrefillFromDetectedCall(
  prefill: DetectedCallCapturePrefill,
): MeetingCapturePrefill {
  return {
    title: prefill.title,
    videoService: prefill.videoService,
    detectedCallId: prefill.callId,
  };
}
