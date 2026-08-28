/**
 * The wire between the read-only EventKit helper and the renderer.
 *
 * Everything in this file is pure: parsing the helper's JSON, classifying a
 * conferencing URL, and deciding whether a cached answer is still worth using.
 * The spawning lives in macos-calendar-runtime.ts so this half can be read and
 * tested without a subprocess.
 *
 * The renderer never sees the helper's raw payload. It sees `CalendarSnapshot`,
 * which carries titles and times and a service name — and, deliberately, no
 * URLs, no locations and no notes. A conferencing link is only ever reported as
 * "this looks like a Zoom call"; the link itself stops here.
 */

/**
 * TCC's answer, reported as itself.
 *
 * `write_only` is its own state rather than a flavour of denied: macOS 14 can
 * grant an app permission to ADD events without permission to read them, and
 * the fix for that in System Settings is a different switch. Calling it denied
 * would send the reader to the wrong place.
 *
 * `unsupported_platform` and `helper_unavailable` are this process's answers,
 * not TCC's. They exist so a Windows build and a broken install are visibly
 * different from "the user said no" — the UI renders nothing at all for both,
 * and lumping them into `denied` would have shown a System Settings link to
 * someone with no System Settings.
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
  /** ISO 8601, UTC, as emitted by the helper. */
  startsAt: string;
  endsAt: string;
  isAllDay: boolean;
  calendarId: string;
  calendarName: string;
  /**
   * The conferencing service, when the URL's host is one we recognize.
   *
   * `null` covers both "no link at all" and "a link we do not recognize", on
   * purpose: the badge exists to tell the reader this is a call they will join
   * in a video app, and guessing that from an unknown host would be a claim
   * this code cannot support.
   */
  videoService: CalendarVideoService | null;
}

export interface CalendarSourceSummary {
  id: string;
  title: string;
  accountName: string;
}

export interface CalendarSnapshot {
  authorization: CalendarAuthorization;
  /** Epoch ms at which the main process read this, for cache decisions. */
  observedAt: number;
  events: CalendarEventSummary[];
  calendars: CalendarSourceSummary[];
  /** The helper's typed error code, when it returned one. */
  errorCode: string | null;
}

/**
 * How long a snapshot is reused before the helper is spawned again.
 *
 * Long enough that scrolling the Meetings list does not fork a process per
 * render; short enough that an event added in Calendar shows up without a
 * restart. The renderer re-derives "starts in 12 min" from the cached start
 * time every tick, so the countdown stays honest between refreshes.
 */
export const CALENDAR_SNAPSHOT_TTL_MS = 60_000;

/**
 * The window the helper is asked for: ~8 hours, matching what the Meetings
 * header can usefully offer. A longer horizon is a bigger read of the user's
 * calendar for no extra affordance.
 */
const CALENDAR_HORIZON_MINUTES = 480;

/**
 * Recognized conferencing hosts.
 *
 * Matching is host equality or a dot-anchored suffix, never a bare
 * `includes`: `evil-zoom.us` and `zoom.us.example.com` must not match. This is
 * a label on a button rather than a security boundary, but a badge that says
 * "Zoom" about a link that is not Zoom is still a lie, and the anchored form
 * costs nothing.
 */
const VIDEO_SERVICE_HOSTS: ReadonlyArray<readonly [CalendarVideoService, readonly string[]]> = [
  ["zoom", ["zoom.us", "zoomgov.com"]],
  ["google_meet", ["meet.google.com"]],
  ["microsoft_teams", ["teams.microsoft.com", "teams.live.com"]],
  ["webex", ["webex.com", "webex.com.cn"]],
  ["whereby", ["whereby.com"]],
  ["gotomeeting", ["gotomeeting.com", "gotomeet.me"]],
  ["bluejeans", ["bluejeans.com"]],
  ["jitsi", ["meet.jit.si", "jitsi.net"]],
];

function hostMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

/**
 * The first recognized conferencing service among a set of candidate URLs.
 *
 * Order follows the helper's own field order (event URL, then location, then
 * notes), so an explicit conferencing URL on the event wins over a link
 * someone pasted into the body.
 */
export function detectVideoService(urls: readonly unknown[]): CalendarVideoService | null {
  for (const candidate of urls) {
    if (typeof candidate !== "string" || !candidate) continue;
    let hostname: string;
    try {
      const url = new URL(candidate);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      hostname = url.hostname.toLowerCase();
    } catch {
      continue;
    }
    for (const [service, domains] of VIDEO_SERVICE_HOSTS) {
      if (domains.some((domain) => hostMatches(hostname, domain))) {
        return service;
      }
    }
  }
  return null;
}

const AUTHORIZATION_VALUES = new Set<string>([
  "not_determined",
  "denied",
  "restricted",
  "write_only",
  "authorized",
]);

function readAuthorization(value: unknown): CalendarAuthorization {
  return typeof value === "string" && AUTHORIZATION_VALUES.has(value)
    ? (value as CalendarAuthorization)
    : "unknown";
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * A well-formed ISO timestamp, or nothing.
 *
 * An event whose start or end does not parse is dropped rather than repaired:
 * the whole feature is a countdown, and a countdown to `Invalid Date` renders
 * as "starts in NaN min".
 */
function readTimestamp(value: unknown): string | null {
  const text = readString(value);
  if (!text) return null;
  return Number.isNaN(Date.parse(text)) ? null : text;
}

function parseEvent(raw: unknown): CalendarEventSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = readString(record.id);
  const title = readString(record.title);
  const startsAt = readTimestamp(record.starts_at);
  const endsAt = readTimestamp(record.ends_at);
  const calendarId = readString(record.calendar_id);
  if (!id || !title || !startsAt || !endsAt || !calendarId) return null;

  return {
    id,
    title,
    startsAt,
    endsAt,
    isAllDay: record.is_all_day === true,
    calendarId,
    calendarName: readString(record.calendar_name) ?? "",
    videoService: detectVideoService(
      Array.isArray(record.conference_urls) ? record.conference_urls : [],
    ),
  };
}

function parseCalendarSource(raw: unknown): CalendarSourceSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = readString(record.id);
  if (!id) return null;
  return {
    id,
    title: readString(record.title) ?? "Calendar",
    accountName: readString(record.account_name) ?? "",
  };
}

export function emptyCalendarSnapshot(
  authorization: CalendarAuthorization,
  observedAt: number,
  errorCode: string | null = null,
): CalendarSnapshot {
  return { authorization, observedAt, events: [], calendars: [], errorCode };
}

/**
 * Turn one line of helper stdout into a snapshot.
 *
 * The helper answers on stdout and exits non-zero for its typed errors, so a
 * refusal ("you have not granted access") arrives here as a parseable payload
 * rather than as a crash. Anything genuinely unparseable becomes `unknown`,
 * which the UI renders as nothing at all — the failure mode for a convenience
 * feature is silence, not an error banner over the Meetings list.
 */
export function parseCalendarHelperOutput(
  stdout: unknown,
  observedAt: number,
): CalendarSnapshot {
  const text = typeof stdout === "string" ? stdout : "";
  const line = text
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .filter(Boolean)
    .pop();
  if (!line) {
    return emptyCalendarSnapshot("unknown", observedAt);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(line);
  } catch {
    return emptyCalendarSnapshot("unknown", observedAt);
  }
  if (!payload || typeof payload !== "object") {
    return emptyCalendarSnapshot("unknown", observedAt);
  }

  const record = payload as Record<string, unknown>;
  const authorization = readAuthorization(record.authorization);

  if (record.type === "error") {
    return emptyCalendarSnapshot(
      authorization,
      observedAt,
      readString(record.code),
    );
  }

  if (record.type === "probe") {
    return emptyCalendarSnapshot(authorization, observedAt);
  }

  if (record.type !== "events") {
    return emptyCalendarSnapshot("unknown", observedAt);
  }

  return {
    authorization,
    observedAt,
    errorCode: null,
    events: (Array.isArray(record.events) ? record.events : [])
      .map(parseEvent)
      .filter((event): event is CalendarEventSummary => event !== null),
    calendars: (Array.isArray(record.calendars) ? record.calendars : [])
      .map(parseCalendarSource)
      .filter((entry): entry is CalendarSourceSummary => entry !== null),
  };
}

export function calendarSnapshotIsFresh(
  snapshot: CalendarSnapshot | null,
  now: number,
  ttlMs: number = CALENDAR_SNAPSHOT_TTL_MS,
): snapshot is CalendarSnapshot {
  if (!snapshot) return false;
  const age = now - snapshot.observedAt;
  // A clock that jumped backwards makes `age` negative. That is not freshness;
  // it is an unknown age, and re-reading a calendar is cheap.
  return age >= 0 && age < ttlMs;
}

/**
 * Which helper mode to run for a snapshot request.
 *
 * `--events` is only worth spawning once access exists. Before that the probe
 * is the whole answer, and running the event mode would just produce the same
 * `authorization_not_determined` error with more work — while making the code
 * look, to a reader auditing it, as though it tried to read the calendar
 * without permission.
 */
export function calendarHelperArgsForSnapshot(
  authorization: CalendarAuthorization,
  horizonMinutes: number = CALENDAR_HORIZON_MINUTES,
): string[] {
  return authorization === "authorized"
    ? ["--events", "--horizon-minutes", String(horizonMinutes)]
    : ["--probe"];
}
