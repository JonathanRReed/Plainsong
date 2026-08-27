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
  readCalendarDisconnected,
  readDismissedCalendarEventIds,
  readIgnoredCalendarIds,
} from "@/lib/calendar-preferences";

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

export interface CalendarEventsState {
  snapshot: CalendarSnapshot;
  /** The single event the header should offer, or null. */
  nextEvent: CalendarEventSummary | null;
  lead: CalendarLead | null;
  view: CalendarPermissionView;
  ignoredCalendarIds: string[];
  disconnected: boolean;
  requesting: boolean;
  /** MUST be called from a user gesture; it is the only prompting path. */
  connect: () => Promise<void>;
  dismiss: (eventId: string) => void;
  refresh: () => Promise<void>;
}

export function useCalendarEvents(options?: {
  /** Skip all of it while the view that owns the affordance is not on screen. */
  enabled?: boolean;
}): CalendarEventsState {
  const enabled = options?.enabled !== false;
  const [snapshot, setSnapshot] = useState<CalendarSnapshot>(EMPTY_SNAPSHOT);
  const [requesting, setRequesting] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [preferences, setPreferences] = useState(() => ({
    disconnected: readCalendarDisconnected(),
    ignoredCalendarIds: readIgnoredCalendarIds(),
    dismissedEventIds: readDismissedCalendarEventIds(),
  }));

  const reloadPreferences = useCallback(() => {
    setPreferences({
      disconnected: readCalendarDisconnected(),
      ignoredCalendarIds: readIgnoredCalendarIds(),
      dismissedEventIds: readDismissedCalendarEventIds(),
    });
  }, []);

  useEffect(() => {
    window.addEventListener(CALENDAR_PREFERENCE_EVENT, reloadPreferences);
    return () => {
      window.removeEventListener(CALENDAR_PREFERENCE_EVENT, reloadPreferences);
    };
  }, [reloadPreferences]);

  const load = useCallback(
    async (forceRefresh: boolean) => {
      // Reads the stored permission answer; it cannot prompt. That is the
      // property that lets this run on mount at all.
      const next = await getCalendarSnapshot({ forceRefresh });
      setSnapshot(next);
    },
    [],
  );

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const poll = () => {
      void getCalendarSnapshot()
        .then((next) => {
          if (!cancelled) setSnapshot(next);
        })
        .catch(() => {
          // A convenience feature that cannot read the calendar shows nothing.
          // It does not put an error over the reader's meetings.
          if (!cancelled) setSnapshot(EMPTY_SNAPSHOT);
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
  }, [enabled]);

  const nextEvent = useMemo(
    () =>
      preferences.disconnected
        ? null
        : selectNextCalendarEvent(snapshot.events, {
            now,
            ignoredCalendarIds: preferences.ignoredCalendarIds,
            dismissedEventIds: preferences.dismissedEventIds,
          }),
    [
      now,
      preferences.disconnected,
      preferences.dismissedEventIds,
      preferences.ignoredCalendarIds,
      snapshot.events,
    ],
  );

  return {
    snapshot,
    nextEvent,
    lead: nextEvent ? describeCalendarLead(nextEvent, now) : null,
    view: calendarPermissionView(
      snapshot.authorization,
      !preferences.disconnected,
    ),
    ignoredCalendarIds: preferences.ignoredCalendarIds,
    disconnected: preferences.disconnected,
    requesting,
    connect: async () => {
      setRequesting(true);
      try {
        setSnapshot(await requestCalendarAccess());
      } catch {
        // A refused or failed prompt leaves the card exactly as it was, which
        // is the honest state: nothing was granted.
      } finally {
        setRequesting(false);
      }
    },
    dismiss: (eventId: string) => {
      dismissCalendarEvent(eventId);
      reloadPreferences();
    },
    refresh: () => load(true),
  };
}
