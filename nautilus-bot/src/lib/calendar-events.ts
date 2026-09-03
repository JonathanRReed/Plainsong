/**
 * Which calendar event, if any, the Meetings header should offer to capture.
 *
 * The wire types mirror `electron/macos-calendar.ts`. They are declared again
 * rather than imported because the two halves compile under different
 * tsconfigs — the same arrangement `src/types/settings.ts` has with the Rust
 * settings struct. The main process owns the shape; this file owns what the
 * reader is shown.
 *
 * Everything here is pure. The countdown is re-derived from the event's start
 * time on every tick, so it stays honest between the 60-second snapshot
 * refreshes rather than drifting with a cached string.
 */

import {
  meetingAttendeesFromCalendar,
  type MeetingAttendee,
} from "@/lib/attendees";
import { compareStrings } from "@/lib/format-locale";

export type CalendarAuthorization =
  | "not_determined"
  | "denied"
  | "restricted"
  | "write_only"
  | "authorized"
  | "unsupported_platform"
  | "helper_unavailable"
  | "unknown";

export type CalendarVideoService =
  | "zoom"
  | "google_meet"
  | "microsoft_teams"
  | "webex"
  | "whereby"
  | "gotomeeting"
  | "bluejeans"
  | "jitsi";

/** Mirrors `CalendarAttendee` in electron/macos-calendar.ts. */
export interface CalendarAttendee {
  name: string;
  email: string | null;
  isOrganizer: boolean;
  isCurrentUser: boolean;
}

export interface CalendarEventSummary {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  isAllDay: boolean;
  calendarId: string;
  calendarName: string;
  videoService: CalendarVideoService | null;
  /** Empty when the event has no invitees, or when the helper is protocol 1. */
  attendees?: CalendarAttendee[];
}

export interface CalendarSourceSummary {
  id: string;
  title: string;
  accountName: string;
}

export interface CalendarSnapshot {
  authorization: CalendarAuthorization;
  observedAt: number;
  events: CalendarEventSummary[];
  calendars: CalendarSourceSummary[];
  errorCode: string | null;
}

const VIDEO_SERVICE_LABELS: Record<CalendarVideoService, string> = {
  zoom: "Zoom",
  google_meet: "Google Meet",
  microsoft_teams: "Microsoft Teams",
  webex: "Webex",
  whereby: "Whereby",
  gotomeeting: "GoToMeeting",
  bluejeans: "BlueJeans",
  jitsi: "Jitsi",
};

export function videoServiceLabel(service: CalendarVideoService): string {
  return VIDEO_SERVICE_LABELS[service];
}

/**
 * The label for a service key that came back from storage, or nothing.
 *
 * A recording carries the same key a calendar event does, but it arrives as a
 * plain string from a database that may predate the column or hold a key this
 * build no longer knows. Saying nothing is the right answer for both.
 */
export function storedVideoServiceLabel(service: string | null | undefined): string | null {
  return service && Object.prototype.hasOwnProperty.call(VIDEO_SERVICE_LABELS, service)
    ? VIDEO_SERVICE_LABELS[service as CalendarVideoService]
    : null;
}

/**
 * How far ahead an event is worth mentioning.
 *
 * A meeting three hours away is not something to put a button in front of; the
 * affordance is for the one the reader is about to walk into. The helper still
 * fetches the wider window so the settings row can say which calendars are in
 * play without a second read.
 */
const CALENDAR_LOOKAHEAD_MS = 30 * 60_000;

/**
 * How long after its start an event stays offerable.
 *
 * Meetings run late and people join late; an event that started four minutes
 * ago is exactly the one someone reaches for the Start button about. Past this
 * the offer becomes noise — the meeting is either being recorded already or it
 * was never going to be.
 */
const CALENDAR_IN_PROGRESS_GRACE_MS = 10 * 60_000;

export interface CalendarSelectionOptions {
  now: number;
  ignoredCalendarIds?: readonly string[];
  dismissedEventKeys?: readonly string[];
  lookaheadMs?: number;
  inProgressGraceMs?: number;
}

function startTime(event: CalendarEventSummary): number {
  return Date.parse(event.startsAt);
}

/**
 * What "this event was dismissed" is stored under.
 *
 * NOT the bare `id`. EventKit's `eventIdentifier` is per-event, not per
 * occurrence, so every Tuesday of a weekly standup can come back carrying the
 * same identifier. Keying dismissals on the identifier alone would turn "not
 * this one, thanks" into "never show this meeting again" — the reader would
 * wave away today's standup and silently lose the cue for every future one.
 *
 * The start time is what separates one occurrence from the next, so the key is
 * always both. The helper's payload keeps the raw identifier, which is still
 * the right thing for React keys and for de-duplication within a snapshot.
 */
export function calendarEventDismissalKey(event: {
  id: string;
  startsAt: string;
}): string {
  return `${event.id}@${event.startsAt}`;
}

/**
 * Whether this event could be the one the header offers.
 *
 * All-day events are excluded outright. "Q3 planning" spanning a whole day is
 * a label on the day, not a thing that starts at a time, and offering to
 * capture it at midnight — or at whatever moment the app happened to notice —
 * would be a countdown to a fiction.
 */
function calendarEventIsOfferable(
  event: CalendarEventSummary,
  options: CalendarSelectionOptions,
): boolean {
  if (event.isAllDay) return false;
  if (!event.title.trim()) return false;
  if (options.ignoredCalendarIds?.includes(event.calendarId)) return false;
  if (options.dismissedEventKeys?.includes(calendarEventDismissalKey(event))) {
    return false;
  }

  const start = startTime(event);
  const end = Date.parse(event.endsAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return false;

  const lookahead = options.lookaheadMs ?? CALENDAR_LOOKAHEAD_MS;
  const grace = options.inProgressGraceMs ?? CALENDAR_IN_PROGRESS_GRACE_MS;
  const untilStart = start - options.now;

  if (untilStart > lookahead) return false;
  // Already running: offerable while it is both inside the grace window and
  // has not actually finished. A one-minute standup that ended eight minutes
  // ago is over, grace period or not.
  if (untilStart < 0) {
    return options.now - start <= grace && options.now < end;
  }
  return true;
}

/**
 * The single event to offer, or nothing.
 *
 * "Next" is the earliest offerable start, which puts an in-progress meeting
 * ahead of one starting in ten minutes — the reader is in the first one now.
 * Ties break on title so the choice is stable across refreshes instead of
 * depending on the order EventKit happened to return.
 */
export function selectNextCalendarEvent(
  events: readonly CalendarEventSummary[],
  options: CalendarSelectionOptions,
): CalendarEventSummary | null {
  const candidates = events.filter((event) =>
    calendarEventIsOfferable(event, options),
  );
  if (candidates.length === 0) return null;

  return candidates.reduce((best, candidate) => {
    const bestStart = startTime(best);
    const candidateStart = startTime(candidate);
    if (candidateStart !== bestStart) {
      return candidateStart < bestStart ? candidate : best;
    }
    return compareStrings(candidate.title, best.title) < 0 ? candidate : best;
  });
}

export type CalendarLeadTone = "upcoming" | "starting" | "in_progress";

export interface CalendarLead {
  tone: CalendarLeadTone;
  /** The half-sentence after the title: "starts in 12 min". */
  text: string;
}

/**
 * The countdown, in the words the header uses.
 *
 * Minutes only, rounded up while the meeting is still ahead: "starts in 1 min"
 * is true for the last sixty seconds, and "starts in 0 min" is not a thing
 * anyone says. Inside a minute either way it is "starting now", which is both
 * shorter and less likely to be wrong by the time it is read.
 */
export function describeCalendarLead(
  event: CalendarEventSummary,
  now: number,
): CalendarLead {
  const untilStart = startTime(event) - now;

  if (untilStart >= 60_000) {
    return {
      tone: "upcoming",
      text: `starts in ${Math.ceil(untilStart / 60_000)} min`,
    };
  }
  if (untilStart > -60_000) {
    return { tone: "starting", text: "starting now" };
  }
  return {
    tone: "in_progress",
    text: `started ${Math.floor(-untilStart / 60_000)} min ago`,
  };
}

export interface CalendarCapturePrefill {
  eventId: string;
  /** Becomes the recording's title, so auto-naming leaves it alone. */
  title: string;
  videoService: CalendarVideoService | null;
  /**
   * Who was invited, stored on the recording so the meeting keeps its
   * attendee list after the calendar entry has moved on. The current user is
   * dropped: "who else was there" is the question a chip row answers, and
   * seeing your own name in it tells you nothing.
   */
  attendees: MeetingAttendee[];
}

/**
 * What "Start capture" carries into the meeting.
 *
 * The title is the event's, trimmed and length-capped. Whitespace is collapsed
 * because calendar titles pasted from email arrive with newlines in them, and a
 * recording title with a newline in it breaks every list that renders it on one
 * line.
 */
export const CALENDAR_PREFILL_TITLE_MAX_LENGTH = 120;

export function buildCalendarCapturePrefill(
  event: CalendarEventSummary,
): CalendarCapturePrefill | null {
  const title = event.title.replace(/\s+/g, " ").trim();
  if (!title) return null;
  return {
    eventId: event.id,
    title:
      title.length > CALENDAR_PREFILL_TITLE_MAX_LENGTH
        ? title.slice(0, CALENDAR_PREFILL_TITLE_MAX_LENGTH).trimEnd()
        : title,
    videoService: event.videoService,
    attendees: meetingAttendeesFromCalendar(event.attendees),
  };
}

export type CalendarPermissionView =
  | "hidden"
  | "connect"
  | "denied"
  | "write_only"
  | "restricted"
  | "connected";

/**
 * What the Meetings view should render for a given authorization.
 *
 * `unsupported_platform`, `helper_unavailable` and `unknown` all render
 * nothing. There is no calendar to connect on Windows, a missing helper is our
 * bug rather than the reader's decision, and an unparseable answer is not
 * grounds for putting a permission card over someone's meetings. A convenience
 * feature that cannot tell whether it is available should be quiet.
 */
export function calendarPermissionView(
  authorization: CalendarAuthorization,
  connected: boolean,
): CalendarPermissionView {
  switch (authorization) {
    case "authorized":
      return connected ? "connected" : "hidden";
    case "not_determined":
      return "connect";
    case "denied":
      return "denied";
    case "write_only":
      return "write_only";
    case "restricted":
      return "restricted";
    default:
      return "hidden";
  }
}
