import { invoke } from "@/lib/electron";
import type { CalendarSnapshot } from "@/lib/calendar-events";

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

export async function openCalendarPrivacySettings(): Promise<void> {
  await invoke("open_calendar_privacy_settings");
}
