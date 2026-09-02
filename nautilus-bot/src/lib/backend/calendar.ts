import { invoke } from "@/lib/electron";
import type { CalendarSnapshot } from "@/lib/calendar-events";
import type { MeetingAttendee } from "@/lib/attendees";

/**
 * The three calendar commands, and the line between them.
 *
 * `getCalendarSnapshot` cannot raise a permission prompt — the main process
 * runs the helper's read-only probe and only reads events once macOS has
 * already said yes. `requestCalendarAccess` is the only one that can, and the
 * main process refuses it unless a real click in the main window preceded it.
 * Keeping them as two functions rather than one with a flag is what makes the
 * prompting call site greppable.
 */

function normalizeSnapshot(value: unknown): CalendarSnapshot {
  // The main process is the only producer, but a null answer is what a
  // not-yet-ready bridge returns, and an unknown authorization renders as
  // nothing rather than as an error.
  if (!value || typeof value !== "object") {
    return {
      authorization: "unknown",
      observedAt: Date.now(),
      events: [],
      calendars: [],
      errorCode: null,
    };
  }
  const snapshot = value as Partial<CalendarSnapshot>;
  return {
    authorization: snapshot.authorization ?? "unknown",
    observedAt: snapshot.observedAt ?? Date.now(),
    events: Array.isArray(snapshot.events) ? snapshot.events : [],
    calendars: Array.isArray(snapshot.calendars) ? snapshot.calendars : [],
    errorCode: snapshot.errorCode ?? null,
  };
}

export async function getCalendarSnapshot(options?: {
  forceRefresh?: boolean;
}): Promise<CalendarSnapshot> {
  return normalizeSnapshot(
    await invoke("get_calendar_snapshot", {
      forceRefresh: options?.forceRefresh === true,
    }),
  );
}

/**
 * Ask macOS for calendar access. Call this ONLY from a click handler.
 *
 * `src/__tests__/calendar-access-gesture.test.ts` reads this file and its
 * callers to keep that true.
 */
export async function requestCalendarAccess(): Promise<CalendarSnapshot> {
  return normalizeSnapshot(await invoke("request_calendar_access"));
}

/**
 * Bring System Settings to the Calendars pane. Call this ONLY from a click
 * handler: the main process requires a fresh user gesture, and rejects without
 * one.
 *
 * The rejection is swallowed here rather than at each call site. There is
 * nothing useful to tell the reader — the button is right in front of them and
 * clicking it again works — and the alternative is an unhandled rejection from
 * every `void openCalendarPrivacySettings()`.
 */
export async function openCalendarPrivacySettings(): Promise<void> {
  try {
    await invoke("open_calendar_privacy_settings");
  } catch (error) {
    console.warn("Could not open the calendar privacy settings:", error);
  }
}

/**
 * Why a prior meeting is in a brief. Mirrors `RelatedMeetingReason` in
 * rust-sidecar/src/meeting_brief.rs.
 */
export interface RelatedMeetingReason {
  sharedAttendees: number;
  titleMatch: boolean;
}

export interface RelatedMeeting {
  recordingId: string;
  title: string;
  createdAt: string;
  reason: RelatedMeetingReason;
  /** Names only. The sidecar never puts an address in this. */
  sharedAttendeeNames: string[];
  summary: string | null;
  openItems: string[];
  decisions: string[];
}

export interface MeetingBriefCitation {
  text: string;
  lineId?: string | null;
  segmentId?: string | null;
  recordingId?: string | null;
  certainty?: number | null;
}

export interface MeetingBriefResult {
  eventId: string;
  /**
   * `ready` — a written brief with citations.
   * `sources_only` — related meetings found, but no brief; `unavailableReason`
   *   says why. This is what a Mac with no analysis provider gets, and the
   *   panel shows the raw list instead of an error.
   * `no_sources` — nothing on this Mac relates to this event.
   */
  state: "ready" | "sources_only" | "no_sources";
  related: RelatedMeeting[];
  brief: string | null;
  citations: MeetingBriefCitation[];
  grounded: boolean;
  model: string | null;
  actualProvider: string | null;
  unavailableReason: string | null;
  generatedAt: string | null;
  cached: boolean;
}

/**
 * Build (or re-read) the pre-meeting brief for a calendar event.
 *
 * Local data only: prior meetings on this Mac that share an attendee or a
 * normalized title with this event. `refresh` skips the cache; without it a
 * brief written from the same evidence comes straight back without a model
 * call.
 */
export async function prepareMeetingBrief(request: {
  eventId: string;
  title: string;
  attendees: MeetingAttendee[];
  refresh?: boolean;
}): Promise<MeetingBriefResult> {
  return await invoke("prepare_meeting_brief", {
    eventId: request.eventId,
    title: request.title,
    attendees: request.attendees,
    refresh: request.refresh === true,
  });
}
