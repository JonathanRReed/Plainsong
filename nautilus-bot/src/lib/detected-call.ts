/**
 * What the Meetings header says about a call detection found, and what a
 * click on it carries into the consent dialog.
 *
 * Everything here is pure. The wire type is `DetectedCall` in
 * `src/lib/backend.ts`, mirroring `ActiveCall` in
 * rust-sidecar/src/meeting_detect.rs.
 */

import type { CalendarVideoService } from "@/lib/calendar-events";

export interface DetectedCallSummary {
  callId: number;
  app: string;
  appLabel: string;
  videoService: string | null;
  detectedAtMs: number;
}

/** What "Start capture" carries into the meeting when it began with a detected call. */
export interface DetectedCallCapturePrefill {
  callId: number;
  /** Becomes the recording's title: "Zoom call, 14:05". */
  title: string;
  videoService: CalendarVideoService | null;
}

const VIDEO_SERVICES: ReadonlySet<string> = new Set([
  "zoom",
  "google_meet",
  "microsoft_teams",
  "webex",
  "whereby",
  "gotomeeting",
  "bluejeans",
  "jitsi",
]);

function knownVideoService(value: string | null): CalendarVideoService | null {
  return value && VIDEO_SERVICES.has(value) ? (value as CalendarVideoService) : null;
}

/**
 * The clock the title carries: 24-hour, local time, so "Zoom call, 14:05"
 * reads the same in every locale and sorts the way the meeting list does.
 */
export function formatDetectedCallClock(detectedAtMs: number): string {
  const date = new Date(detectedAtMs);
  if (Number.isNaN(date.getTime())) return "";
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}

/**
 * The title a detected call gives its recording.
 *
 * Detection knows the app and the time and nothing else — no participants,
 * no agenda — so that is what the title says. Auto-naming only overwrites a
 * placeholder title, so this one survives the analysis pass just as a
 * calendar event's would.
 */
export function buildDetectedCallCapturePrefill(
  call: DetectedCallSummary,
): DetectedCallCapturePrefill | null {
  const label = call.appLabel.replace(/\s+/g, " ").trim();
  if (!label) return null;
  const clock = formatDetectedCallClock(call.detectedAtMs);
  return {
    callId: call.callId,
    title: clock ? `${label} call, ${clock}` : `${label} call`,
    videoService: knownVideoService(call.videoService),
  };
}

/** The one line the header cue shows: "Zoom call in progress". */
export function describeDetectedCall(call: Pick<DetectedCallSummary, "appLabel">): string {
  return `${call.appLabel} call in progress`;
}

/**
 * A call the reader dismissed, or one that started while a meeting was
 * already recording, is not offered. The cue and the notification apply the
 * same rule.
 */
export function detectedCallIsOfferable(
  call: { dismissed: boolean } | null,
  captureInProgress: boolean,
): boolean {
  return Boolean(call) && !call!.dismissed && !captureInProgress;
}
