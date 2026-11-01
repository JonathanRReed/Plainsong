import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getCalendarSnapshot,
  requestCalendarAccess,
} from "@/lib/backend/calendar";
import {
  calendarPermissionView,
  describeCalendarLead,
  selectNextCalendarEvent,
  type CalendarLead,
  type CalendarEventSummary,
  type CalendarPermissionView,
  type CalendarSnapshot,
} from "@/lib/calendar-events";
import {
  CALENDAR_PREFERENCE_EVENT,
  dismissCalendarEvent,
  loadCalendarDisconnected,
  readDismissedCalendarEventKeys,
  readIgnoredCalendarIds,
} from "@/lib/calendar-preferences";
import { listen } from "@/lib/electron";

/**
 * How often the countdown is recomputed. The snapshot itself refreshes on the
 * main process's own 60s cache; this only re-renders "starts in 12 min" so it
 * does not sit on a stale minute.
 */
const TICK_MS = 20_000;

const EMPTY_SNAPSHOT: CalendarSnapshot = {
  authorization: "unknown",
  observedAt: 0,
  events: [],
  calendars: [],
  errorCode: null,
};

/**
 * What the last Connect click came back with, so the card can say so.
 *
 * Before this existed a Connect click that macOS answered without a prompt
 * left the card exactly as it was, and a rejected request was swallowed: the
 * reader saw nothing happen at all. `null` means there is nothing to add to
 * what the permission view already says (no click yet, or macOS gave an answer
 * the denied / write-only / restricted cards already explain).
 */
export type CalendarConnectResult =
  | { kind: "connected" }
  | { kind: "no_prompt" }
  | { kind: "failed"; message: string }
  | null;

function describeCalendarConnectResult(
  next: CalendarSnapshot,
): CalendarConnectResult {
  switch (next.authorization) {
    case "authorized":
      return { kind: "connected" };
    case "denied":
    case "write_only":
    case "restricted":
      return null;
    case "not_determined":
      return next.errorCode === "timeout"
        ? { kind: "failed", message: "macOS didn't answer the calendar request in time." }
        : { kind: "no_prompt" };
    default:
      return {
        kind: "failed",
        message: "Plainsong couldn't reach the macOS calendar service.",
      };
  }
}

function connectErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (/recent click|key press|same page/i.test(text)) {
    return "macOS needs the request to come straight from your click. Click Connect calendar again.";
  }
  return "Plainsong couldn't ask macOS for calendar access.";
}

export interface CalendarEventsState {
  snapshot: CalendarSnapshot;
  /** The single event the header should offer, or null. */
  nextEvent: CalendarEventSummary | null;
  lead: CalendarLead | null;
  view: CalendarPermissionView;
  ignoredCalendarIds: string[];
  /**
   * The reader turned the calendar off in Settings. While true nothing is
   * polled or read, and `snapshot` is empty.
   */
  disconnected: boolean;
  requesting: boolean;
  /** The answer to the last Connect click, for the card to report. */
  connectResult: CalendarConnectResult;
  /** MUST be called from a user gesture; it is the only prompting path. */
  connect: (options?: Parameters<typeof requestCalendarAccess>[0]) => Promise<void>;
  /**
   * Takes the event, not its id: the dismissal is per OCCURRENCE, and the
   * start time is the half that separates today's standup from next week's.
   */
  dismiss: (event: { id: string; startsAt: string }) => void;
  refresh: () => Promise<void>;
}

export function useCalendarEvents(options?: {
  /** Skip all of it while the view that owns the affordance is not on screen. */
  enabled?: boolean;
}): CalendarEventsState {
  const enabled = options?.enabled !== false;
  const [snapshot, setSnapshot] = useState<CalendarSnapshot>(EMPTY_SNAPSHOT);
  const [requesting, setRequesting] = useState(false);
  const [connectResult, setConnectResult] = useState<CalendarConnectResult>(null);
  const [now, setNow] = useState(() => Date.now());
  const [preferences, setPreferences] = useState(() => ({
    ignoredCalendarIds: readIgnoredCalendarIds(),
    dismissedEventKeys: readDismissedCalendarEventKeys(),
  }));
  // `null` until settings answer. Nothing is read before then, so a reader
  // who disconnected is never polled even once on mount.
  const [disconnectedSetting, setDisconnectedSetting] = useState<boolean | null>(null);
  const disconnected = disconnectedSetting === true;

  const reloadDisconnected = useCallback(() => {
    void loadCalendarDisconnected().then(setDisconnectedSetting, () =>
      setDisconnectedSetting(false),
    );
  }, []);

  const reloadPreferences = useCallback(() => {
    setPreferences({
      ignoredCalendarIds: readIgnoredCalendarIds(),
      dismissedEventKeys: readDismissedCalendarEventKeys(),
    });
    reloadDisconnected();
  }, [reloadDisconnected]);

  useEffect(() => {
    reloadDisconnected();
    window.addEventListener(CALENDAR_PREFERENCE_EVENT, reloadPreferences);
    // Another window, or a restored backup, can change the setting too.
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void listen("settings-changed", () => reloadDisconnected()).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
      window.removeEventListener(CALENDAR_PREFERENCE_EVENT, reloadPreferences);
    };
  }, [reloadDisconnected, reloadPreferences]);

  const load = useCallback(
    async (forceRefresh: boolean) => {
      if (disconnectedSetting !== false) return;
      // Reads the stored permission answer; it cannot prompt. That is the
      // property that lets this run on mount at all.
      try {
        const next = await getCalendarSnapshot({ forceRefresh });
        setSnapshot(next);
      } catch {
        setSnapshot({ ...EMPTY_SNAPSHOT, observedAt: Date.now() });
      }
    },
    [disconnectedSetting],
  );

  useEffect(() => {
    if (disconnected) {
      // Drop what was read before the disconnect, not just hide it.
      setSnapshot(EMPTY_SNAPSHOT);
    }
  }, [disconnected]);

  useEffect(() => {
    if (!enabled || disconnectedSetting !== false) return;
    let cancelled = false;

    const poll = () => {
      void getCalendarSnapshot()
        .then((next) => {
          if (!cancelled) setSnapshot(next);
        })
        .catch(() => {
          // Meetings stays quiet; Settings keeps a recovery action available.
          if (!cancelled) setSnapshot({ ...EMPTY_SNAPSHOT, observedAt: Date.now() });
        });
    };

    poll();
    const timer = window.setInterval(() => {
      setNow(Date.now());
      poll();
    }, TICK_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled, disconnectedSetting]);

  const nextEvent = useMemo(
    () =>
      disconnected
        ? null
        : selectNextCalendarEvent(snapshot.events, {
            now,
            ignoredCalendarIds: preferences.ignoredCalendarIds,
            dismissedEventKeys: preferences.dismissedEventKeys,
          }),
    [
      now,
      disconnected,
      preferences.dismissedEventKeys,
      preferences.ignoredCalendarIds,
      snapshot.events,
    ],
  );

  return {
    snapshot,
    nextEvent,
    lead: nextEvent ? describeCalendarLead(nextEvent, now) : null,
    view: calendarPermissionView(snapshot.authorization, !disconnected),
    ignoredCalendarIds: preferences.ignoredCalendarIds,
    disconnected,
    requesting,
    connectResult,
    connect: async (options) => {
      setRequesting(true);
      setConnectResult(null);
      try {
        const next = await requestCalendarAccess(options);
        const result = describeCalendarConnectResult(next);
        // A non-answer (helper crashed, unreadable output) would hide the
        // card the failure is reported on, and says nothing new about TCC.
        if (result?.kind !== "failed" || next.authorization === "not_determined") {
          setSnapshot(next);
        }
        setConnectResult(result);
      } catch (error) {
        // Nothing was granted, and the reader clicked a button: say so rather
        // than leave the card looking as if the click never landed.
        console.warn("Calendar access request failed:", error);
        setConnectResult({ kind: "failed", message: connectErrorMessage(error) });
      } finally {
        setRequesting(false);
      }
    },
    dismiss: (event: { id: string; startsAt: string }) => {
      dismissCalendarEvent(event);
      reloadPreferences();
    },
    refresh: () => load(true),
  };
}
