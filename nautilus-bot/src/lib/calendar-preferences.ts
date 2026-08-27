/**
 * The reader's calendar choices that macOS does not store for us.
 *
 * These live in browser storage for the same reason
 * `src/lib/ai-notes-preference.ts` does: the settings schema is a
 * field-for-field mirror of `rust-sidecar/src/settings.rs` (see
 * `src/__tests__/settings-wire-contract.test.ts`), so a renderer-only
 * preference cannot be added there without the Rust half. macOS owns the
 * permission; these three keys own what Plainsong does with it.
 *
 * All three are stored as the EXCEPTION rather than the state, so an
 * unreadable store (private mode, blocked site data) degrades to the ordinary
 * behaviour instead of to a mystery. Nothing here is a security boundary: a
 * reader who wants Plainsong to stop reading their calendar entirely turns it
 * off in System Settings, and the card says so.
 */

export const CALENDAR_DISCONNECTED_STORAGE_KEY = "plainsong_calendar_disconnected";
export const CALENDAR_IGNORED_STORAGE_KEY = "plainsong_calendar_ignored_ids";
export const CALENDAR_DISMISSED_STORAGE_KEY = "plainsong_calendar_dismissed_ids";
export const CALENDAR_PREFERENCE_EVENT = "plainsong-calendar-preference";

/** Bounded so a long-running session cannot grow the dismissal list forever. */
const MAX_DISMISSED_EVENTS = 50;

function readRaw(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (value === null) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, value);
    }
  } catch {
    // Nothing to fall back to; the event below still updates this session.
  }
  window.dispatchEvent(new CustomEvent(CALENDAR_PREFERENCE_EVENT));
}

function readIdList(key: string): string[] {
  const raw = readRaw(key);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string" && !!entry)
      : [];
  } catch {
    return [];
  }
}

/**
 * Whether the reader told Plainsong to stop using an already-granted calendar.
 *
 * Granting access and then being asked to "connect" again would be a second
 * question about a decision already made, so the default is connected and only
 * an explicit disconnect is recorded.
 */
export function readCalendarDisconnected(): boolean {
  return readRaw(CALENDAR_DISCONNECTED_STORAGE_KEY) === "true";
}

export function writeCalendarDisconnected(disconnected: boolean): void {
  writeRaw(CALENDAR_DISCONNECTED_STORAGE_KEY, disconnected ? "true" : null);
}

/** Calendars the reader does not want meeting suggestions from. */
export function readIgnoredCalendarIds(): string[] {
  return readIdList(CALENDAR_IGNORED_STORAGE_KEY);
}

export function setCalendarIgnored(calendarId: string, ignored: boolean): void {
  const current = new Set(readIgnoredCalendarIds());
  if (ignored) {
    current.add(calendarId);
  } else {
    current.delete(calendarId);
  }
  writeRaw(
    CALENDAR_IGNORED_STORAGE_KEY,
    current.size === 0 ? null : JSON.stringify([...current]),
  );
}

/**
 * Events the reader waved away.
 *
 * Per-event rather than per-session: dismissing "Standup" should not also hide
 * the client call an hour later, and it should stay dismissed across a restart
 * that happens during the meeting.
 */
export function readDismissedCalendarEventIds(): string[] {
  return readIdList(CALENDAR_DISMISSED_STORAGE_KEY);
}

export function dismissCalendarEvent(eventId: string): void {
  const current = readDismissedCalendarEventIds().filter((id) => id !== eventId);
  current.push(eventId);
  writeRaw(
    CALENDAR_DISMISSED_STORAGE_KEY,
    JSON.stringify(current.slice(-MAX_DISMISSED_EVENTS)),
  );
}
