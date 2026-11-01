/**
 * The reader's calendar choices that macOS does not store for us.
 *
 * Whether the calendar is connected at all is a real setting
 * (`meetings.calendarDisconnected`), because the main process enforces it: a
 * disconnected calendar is not read, not just not shown. The hidden calendars
 * and dismissed events stay in browser storage for the same reason
 * `src/lib/ai-notes-preference.ts` does: they only shape what the renderer
 * offers.
 *
 * The storage-backed choices are stored as the EXCEPTION rather than the
 * state, so an unreadable store (private mode, blocked site data) degrades to
 * the ordinary behaviour instead of to a mystery.
 */

import { getSettings, updateSettings } from "@/lib/backend";
import { calendarEventDismissalKey } from "@/lib/calendar-events";
import { resolveMeetingsSettings } from "@/lib/settings-sections";

/**
 * Where Disconnect used to live before it became a setting. Read once to carry
 * an earlier choice across, then cleared.
 */
export const LEGACY_CALENDAR_DISCONNECTED_STORAGE_KEY = "plainsong_calendar_disconnected";
export const CALENDAR_IGNORED_STORAGE_KEY = "plainsong_calendar_ignored_ids";
// Values are occurrence keys (identifier + start), not bare identifiers — see
// `calendarEventDismissalKey`. The name says so, because the two are the same
// shape and a mismatched pair would silently stop suppressing anything.
const CALENDAR_DISMISSED_STORAGE_KEY = "plainsong_calendar_dismissed_keys";
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
 * question about a decision already made, so the default is connected. A
 * disconnect saved by an older build in browser storage is moved into settings
 * the first time this runs, so the main process starts enforcing it too.
 *
 * If settings cannot be read the answer falls back to that older record. The
 * main process holds the saved setting itself and refuses calendar reads while
 * it is set, so an unreadable answer here cannot turn reading back on.
 */
export async function loadCalendarDisconnected(): Promise<boolean> {
  const legacy = readRaw(LEGACY_CALENDAR_DISCONNECTED_STORAGE_KEY) === "true";
  let saved: boolean;
  try {
    saved = resolveMeetingsSettings(await getSettings()).calendarDisconnected;
  } catch {
    return legacy;
  }
  if (legacy && !saved) {
    try {
      await persistCalendarDisconnected(true);
    } catch {
      return true;
    }
    clearLegacyDisconnect();
    return true;
  }
  if (legacy) clearLegacyDisconnect();
  return saved;
}

async function persistCalendarDisconnected(disconnected: boolean): Promise<void> {
  await updateSettings((draft) => {
    draft.meetings = {
      ...resolveMeetingsSettings(draft),
      calendarDisconnected: disconnected,
    };
  });
}

function clearLegacyDisconnect(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(LEGACY_CALENDAR_DISCONNECTED_STORAGE_KEY);
  } catch {
    // Nothing to clear in a store that cannot be read.
  }
}

/**
 * Disconnect or reconnect the calendar. Saved in settings, which the main
 * process reads: while disconnected it answers every calendar read without
 * running the calendar helper, and every open view stops polling.
 */
export async function writeCalendarDisconnected(disconnected: boolean): Promise<void> {
  await persistCalendarDisconnected(disconnected);
  clearLegacyDisconnect();
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(CALENDAR_PREFERENCE_EVENT));
  }
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
 * Occurrences the reader waved away.
 *
 * Per-occurrence, not per-event: dismissing "Standup" should not also hide the
 * client call an hour later, and — because EventKit can hand every occurrence
 * of a repeating meeting the same `eventIdentifier` — it must not hide next
 * Tuesday's standup either. `calendarEventDismissalKey` is what makes the
 * difference between "not this one" and "never again"; storing the bare id
 * would quietly mean the second.
 *
 * It does stay dismissed across a restart, which is the point: closing the app
 * mid-meeting should not bring the cue back for the meeting you are in.
 */
export function readDismissedCalendarEventKeys(): string[] {
  return readIdList(CALENDAR_DISMISSED_STORAGE_KEY);
}

export function dismissCalendarEvent(event: {
  id: string;
  startsAt: string;
}): void {
  const key = calendarEventDismissalKey(event);
  const current = readDismissedCalendarEventKeys().filter(
    (existing) => existing !== key,
  );
  current.push(key);
  writeRaw(
    CALENDAR_DISMISSED_STORAGE_KEY,
    JSON.stringify(current.slice(-MAX_DISMISSED_EVENTS)),
  );
}
