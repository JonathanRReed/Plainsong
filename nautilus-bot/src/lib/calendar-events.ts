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

export interface CalendarEventSummary {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  isAllDay: boolean;
  calendarId: string;
  calendarName: string;
  videoService: CalendarVideoService | null;
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
  dismissedEventIds?: readonly string[];
  lookaheadMs?: number;
  inProgressGraceMs?: number;
}

function startTime(event: CalendarEventSummary): number {
  return Date.parse(event.startsAt);
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
  if (options.dismissedEventIds?.includes(event.id)) return false;

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
    return candidate.title.localeCompare(best.title) < 0 ? candidate : best;
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
