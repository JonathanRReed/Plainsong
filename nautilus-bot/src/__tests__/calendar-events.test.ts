import { describe, expect, it } from "vitest";
import {
  buildCalendarCapturePrefill,
  calendarEventDismissalKey,
  calendarPermissionView,
  CALENDAR_PREFILL_TITLE_MAX_LENGTH,
  describeCalendarLead,
  selectNextCalendarEvent,
  videoServiceLabel,
  type CalendarEventSummary,
} from "@/lib/calendar-events";
import {
  detectVideoService,
  parseCalendarHelperOutput,
  calendarSnapshotIsFresh,
  calendarHelperArgsForSnapshot,
} from "../../electron/macos-calendar";

const NOW = Date.parse("2026-08-27T15:00:00Z");

function event(overrides: Partial<CalendarEventSummary> = {}): CalendarEventSummary {
  return {
    id: "event-1",
    title: "Weekly sync",
    startsAt: new Date(NOW + 10 * 60_000).toISOString(),
    endsAt: new Date(NOW + 40 * 60_000).toISOString(),
    isAllDay: false,
    calendarId: "work",
    calendarName: "Work",
    videoService: null,
    ...overrides,
  };
}

describe("selectNextCalendarEvent", () => {
  it("offers the soonest event inside the lookahead window", () => {
    const soon = event({ id: "soon", startsAt: new Date(NOW + 5 * 60_000).toISOString() });
    const later = event({ id: "later", startsAt: new Date(NOW + 20 * 60_000).toISOString() });

    expect(selectNextCalendarEvent([later, soon], { now: NOW })?.id).toBe("soon");
  });

  it("says nothing about a meeting that is still hours away", () => {
    // The affordance is for the meeting the reader is about to walk into. A
    // button for something three hours out is noise on every other view of
    // the list.
    const distant = event({ startsAt: new Date(NOW + 3 * 3_600_000).toISOString() });
    expect(selectNextCalendarEvent([distant], { now: NOW })).toBeNull();
  });

  it("excludes all-day events", () => {
    // A whole-day "Q3 planning" is a label on the day, not something that
    // starts at a time; a countdown to it would be a countdown to a fiction.
    const allDay = event({ isAllDay: true, startsAt: new Date(NOW + 5 * 60_000).toISOString() });
    expect(selectNextCalendarEvent([allDay], { now: NOW })).toBeNull();
  });

  it("keeps offering a meeting that already started", () => {
    // People join late, and this is exactly the moment someone reaches for
    // the Start button.
    const running = event({
      startsAt: new Date(NOW - 4 * 60_000).toISOString(),
      endsAt: new Date(NOW + 26 * 60_000).toISOString(),
    });
    expect(selectNextCalendarEvent([running], { now: NOW })?.id).toBe("event-1");
  });

  it("prefers the meeting already running over one starting soon", () => {
    const running = event({
      id: "running",
      startsAt: new Date(NOW - 3 * 60_000).toISOString(),
      endsAt: new Date(NOW + 27 * 60_000).toISOString(),
    });
    const upcoming = event({ id: "upcoming", startsAt: new Date(NOW + 8 * 60_000).toISOString() });

    expect(selectNextCalendarEvent([upcoming, running], { now: NOW })?.id).toBe("running");
  });

  it("drops an in-progress meeting once it has ended", () => {
    // Inside the ten-minute grace window, but over: a one-minute standup that
    // ended eight minutes ago is not a thing to offer to record.
    const finished = event({
      startsAt: new Date(NOW - 8 * 60_000).toISOString(),
      endsAt: new Date(NOW - 7 * 60_000).toISOString(),
    });
    expect(selectNextCalendarEvent([finished], { now: NOW })).toBeNull();
  });

  it("drops a meeting that started before the grace window", () => {
    const stale = event({
      startsAt: new Date(NOW - 45 * 60_000).toISOString(),
      endsAt: new Date(NOW + 15 * 60_000).toISOString(),
    });
    expect(selectNextCalendarEvent([stale], { now: NOW })).toBeNull();
  });

  it("honours ignored calendars and dismissed events", () => {
    const holidays = event({ id: "holiday", calendarId: "holidays" });
    const dismissed = event({ id: "dismissed" });
    const wanted = event({ id: "wanted", startsAt: new Date(NOW + 12 * 60_000).toISOString() });

    expect(
      selectNextCalendarEvent([holidays, dismissed, wanted], {
        now: NOW,
        ignoredCalendarIds: ["holidays"],
        dismissedEventKeys: [calendarEventDismissalKey(dismissed)],
      })?.id,
    ).toBe("wanted");
  });

  it("dismisses one occurrence of a repeating meeting, not the series", () => {
    // EventKit hands every occurrence of a repeating event the same
    // `eventIdentifier`. Keying dismissals on the id alone turned "not this
    // standup" into "never show this standup again" — the reader waves away
    // today's and silently loses every future one.
    const today = event({
      id: "weekly-standup",
      startsAt: new Date(NOW + 5 * 60_000).toISOString(),
      endsAt: new Date(NOW + 20 * 60_000).toISOString(),
    });
    const nextWeek = {
      ...today,
      startsAt: new Date(NOW + 7 * 24 * 3_600_000).toISOString(),
      endsAt: new Date(NOW + 7 * 24 * 3_600_000 + 15 * 60_000).toISOString(),
    };
    expect(nextWeek.id).toBe(today.id);

    const dismissedKeys = [calendarEventDismissalKey(today)];

    expect(
      selectNextCalendarEvent([today, nextWeek], {
        now: NOW,
        dismissedEventKeys: dismissedKeys,
      }),
    ).toBeNull();

    // A week later, the same series is offered again — the dismissal was for
    // one occurrence, and that occurrence is over.
    const nextWeekNow = Date.parse(nextWeek.startsAt) - 5 * 60_000;
    expect(
      selectNextCalendarEvent([today, nextWeek], {
        now: nextWeekNow,
        dismissedEventKeys: dismissedKeys,
      })?.startsAt,
    ).toBe(nextWeek.startsAt);
  });

  it("keeps a dismissed single event dismissed", () => {
    // The other half of the same rule: composing the key must not make a
    // one-off dismissal forgetful.
    const once = event({ id: "one-off" });

    expect(
      selectNextCalendarEvent([once], {
        now: NOW,
        dismissedEventKeys: [calendarEventDismissalKey(once)],
      }),
    ).toBeNull();
  });
});

describe("calendarEventDismissalKey", () => {
  it("separates two occurrences that share an identifier", () => {
    const base = { id: "weekly-standup", startsAt: "2026-08-27T15:00:00Z" };
    const next = { id: "weekly-standup", startsAt: "2026-09-03T15:00:00Z" };

    expect(calendarEventDismissalKey(base)).not.toBe(
      calendarEventDismissalKey(next),
    );
  });

  it("is stable for the same occurrence across reads", () => {
    // The key is stored and compared across polls and restarts, so it has to
    // be a pure function of the two fields and nothing else.
    const occurrence = { id: "weekly-standup", startsAt: "2026-08-27T15:00:00Z" };

    expect(calendarEventDismissalKey(occurrence)).toBe(
      calendarEventDismissalKey({ ...occurrence }),
    );
  });

  it("breaks ties on title so the offer does not flip between refreshes", () => {
    // EventKit's ordering for two events at the same minute is not something
    // to render a button from.
    const a = event({ id: "a", title: "Budget review" });
    const b = event({ id: "b", title: "Aardvark standup" });

    expect(selectNextCalendarEvent([a, b], { now: NOW })?.id).toBe("b");
    expect(selectNextCalendarEvent([b, a], { now: NOW })?.id).toBe("b");
  });

  it("ignores an event whose timestamps do not parse", () => {
    const broken = event({ startsAt: "not a date" });
    expect(selectNextCalendarEvent([broken], { now: NOW })).toBeNull();
  });
});

describe("describeCalendarLead", () => {
  it("rounds up while the meeting is still ahead", () => {
    // "starts in 1 min" stays true for the last sixty seconds; "starts in
    // 0 min" is not a thing anyone says.
    const lead = describeCalendarLead(
      event({ startsAt: new Date(NOW + 11 * 60_000 + 30_000).toISOString() }),
      NOW,
    );
    expect(lead).toEqual({ tone: "upcoming", text: "starts in 12 min" });
  });

  it("collapses the minute either side of the start to 'starting now'", () => {
    expect(
      describeCalendarLead(event({ startsAt: new Date(NOW + 20_000).toISOString() }), NOW).text,
    ).toBe("starting now");
    expect(
      describeCalendarLead(event({ startsAt: new Date(NOW - 20_000).toISOString() }), NOW).text,
    ).toBe("starting now");
  });

  it("counts up once the meeting is running", () => {
    const lead = describeCalendarLead(
      event({ startsAt: new Date(NOW - 4 * 60_000).toISOString() }),
      NOW,
    );
    expect(lead).toEqual({ tone: "in_progress", text: "started 4 min ago" });
  });
});

describe("buildCalendarCapturePrefill", () => {
  it("carries the event title and its detected service", () => {
    expect(
      buildCalendarCapturePrefill(event({ title: "Design review", videoService: "zoom" })),
    ).toEqual({ eventId: "event-1", title: "Design review", videoService: "zoom" });
  });

  it("collapses whitespace so a pasted title stays one line", () => {
    // Calendar titles pasted out of email arrive with newlines in them, and a
    // recording title with a newline breaks every list that renders it.
    expect(
      buildCalendarCapturePrefill(event({ title: "  Design\n  review  " }))?.title,
    ).toBe("Design review");
  });

  it("caps a very long title", () => {
    const prefill = buildCalendarCapturePrefill(event({ title: "x".repeat(400) }));
    expect(prefill?.title.length).toBe(CALENDAR_PREFILL_TITLE_MAX_LENGTH);
  });

  it("refuses a title that is only whitespace", () => {
    expect(buildCalendarCapturePrefill(event({ title: "   " }))).toBeNull();
  });
});

describe("calendarPermissionView", () => {
  it("asks only when macOS has not been asked", () => {
    expect(calendarPermissionView("not_determined", true)).toBe("connect");
  });

  it("distinguishes denied, write-only and restricted", () => {
    // Three different fixes: a switch to flip, a switch to widen, and nothing
    // the reader can do on a managed Mac.
    expect(calendarPermissionView("denied", true)).toBe("denied");
    expect(calendarPermissionView("write_only", true)).toBe("write_only");
    expect(calendarPermissionView("restricted", true)).toBe("restricted");
  });

  it("renders nothing when there is nothing honest to say", () => {
    // Windows, a missing helper and an unparseable answer are all "quiet",
    // not "denied": none of them is the reader's decision.
    expect(calendarPermissionView("unsupported_platform", true)).toBe("hidden");
    expect(calendarPermissionView("helper_unavailable", true)).toBe("hidden");
    expect(calendarPermissionView("unknown", true)).toBe("hidden");
  });

  it("goes quiet when a granted calendar has been switched off in settings", () => {
    expect(calendarPermissionView("authorized", true)).toBe("connected");
    expect(calendarPermissionView("authorized", false)).toBe("hidden");
  });
});

describe("detectVideoService", () => {
  it("recognizes the common conferencing hosts", () => {
    expect(detectVideoService(["https://acme.zoom.us/j/123"])).toBe("zoom");
    expect(detectVideoService(["https://meet.google.com/abc-defg-hij"])).toBe("google_meet");
    expect(detectVideoService(["https://teams.microsoft.com/l/meetup-join/x"])).toBe(
      "microsoft_teams",
    );
    expect(detectVideoService(["https://acme.webex.com/meet/x"])).toBe("webex");
  });

  it("will not let a lookalike host borrow the badge", () => {
    // Matching is host equality or a dot-anchored suffix, never `includes`.
    expect(detectVideoService(["https://evil-zoom.us/j/1"])).toBeNull();
    expect(detectVideoService(["https://zoom.us.example.com/j/1"])).toBeNull();
  });

  it("claims nothing for a link it does not recognize", () => {
    // A doc link is not a video call, and guessing would be a claim this code
    // cannot support.
    expect(detectVideoService(["https://notion.so/agenda"])).toBeNull();
    expect(detectVideoService([])).toBeNull();
  });

  it("ignores non-web schemes and unparseable candidates", () => {
    expect(detectVideoService(["addressbook://A7785073:ABPerson", 42, null])).toBeNull();
  });

  it("prefers the earlier candidate, which is the event's own URL", () => {
    expect(
      detectVideoService([
        "https://meet.google.com/abc-defg-hij",
        "https://acme.zoom.us/j/123",
      ]),
    ).toBe("google_meet");
  });

  it("has a label for every service it can return", () => {
    for (const url of [
      "https://acme.zoom.us/j/1",
      "https://meet.google.com/a",
      "https://teams.microsoft.com/l/x",
      "https://acme.webex.com/m/x",
      "https://whereby.com/room",
      "https://gotomeet.me/room",
      "https://bluejeans.com/1",
      "https://meet.jit.si/room",
    ]) {
      const service = detectVideoService([url]);
      expect(service).not.toBeNull();
      expect(videoServiceLabel(service!)).toBeTruthy();
    }
  });
});

describe("parseCalendarHelperOutput", () => {
  it("reads an events payload and classifies its links", () => {
    const snapshot = parseCalendarHelperOutput(
      JSON.stringify({
        protocol_version: 1,
        type: "events",
        authorization: "authorized",
        calendars: [{ id: "work", title: "Work", account_name: "iCloud" }],
        events: [
          {
            id: "e1",
            title: "Design review",
            starts_at: "2026-08-27T15:10:00Z",
            ends_at: "2026-08-27T15:40:00Z",
            is_all_day: false,
            calendar_id: "work",
            calendar_name: "Work",
            conference_urls: ["https://acme.zoom.us/j/1"],
          },
        ],
      }),
      NOW,
    );

    expect(snapshot.authorization).toBe("authorized");
    expect(snapshot.calendars).toEqual([
      { id: "work", title: "Work", accountName: "iCloud" },
    ]);
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.events[0].videoService).toBe("zoom");
  });

  it("keeps the helper's typed refusal", () => {
    const snapshot = parseCalendarHelperOutput(
      JSON.stringify({
        protocol_version: 1,
        type: "error",
        code: "authorization_not_determined",
        authorization: "not_determined",
      }),
      NOW,
    );

    expect(snapshot.authorization).toBe("not_determined");
    expect(snapshot.errorCode).toBe("authorization_not_determined");
    expect(snapshot.events).toEqual([]);
  });

  it("drops an event that is missing what the countdown needs", () => {
    const snapshot = parseCalendarHelperOutput(
      JSON.stringify({
        protocol_version: 1,
        type: "events",
        authorization: "authorized",
        calendars: [],
        events: [
          { id: "e1", title: "No end", starts_at: "2026-08-27T15:10:00Z", calendar_id: "w" },
          { id: "e2", title: "Bad start", starts_at: "soon", ends_at: "later", calendar_id: "w" },
        ],
      }),
      NOW,
    );

    expect(snapshot.events).toEqual([]);
  });

  it("reads the last line, so a stray log before the payload is harmless", () => {
    const snapshot = parseCalendarHelperOutput(
      `warming up\n${JSON.stringify({ type: "probe", authorization: "denied" })}\n`,
      NOW,
    );
    expect(snapshot.authorization).toBe("denied");
  });

  it("degrades unparseable output to 'unknown' rather than to an error", () => {
    // A convenience feature that cannot read the calendar renders nothing; it
    // does not put a banner over the reader's meetings.
    expect(parseCalendarHelperOutput("", NOW).authorization).toBe("unknown");
    expect(parseCalendarHelperOutput("not json", NOW).authorization).toBe("unknown");
    expect(parseCalendarHelperOutput(undefined, NOW).authorization).toBe("unknown");
    expect(
      parseCalendarHelperOutput(JSON.stringify({ type: "surprise" }), NOW).authorization,
    ).toBe("unknown");
  });
});

describe("calendar snapshot caching", () => {
  it("reuses a snapshot inside its TTL", () => {
    const snapshot = parseCalendarHelperOutput(
      JSON.stringify({ type: "probe", authorization: "authorized" }),
      NOW,
    );
    expect(calendarSnapshotIsFresh(snapshot, NOW + 30_000)).toBe(true);
    expect(calendarSnapshotIsFresh(snapshot, NOW + 90_000)).toBe(false);
    expect(calendarSnapshotIsFresh(null, NOW)).toBe(false);
  });

  it("treats a backwards clock as an unknown age, not a fresh cache", () => {
    const snapshot = parseCalendarHelperOutput(
      JSON.stringify({ type: "probe", authorization: "authorized" }),
      NOW,
    );
    expect(calendarSnapshotIsFresh(snapshot, NOW - 5_000)).toBe(false);
  });

  it("only asks for events once macOS has already said yes", () => {
    // The unauthorized path could have read the same refusal out of the event
    // mode's error payload. It runs the probe instead so the code cannot be
    // read as trying to open a calendar it has no permission for.
    expect(calendarHelperArgsForSnapshot("authorized")).toEqual([
      "--events",
      "--horizon-minutes",
      "480",
    ]);
    for (const state of ["not_determined", "denied", "restricted", "write_only", "unknown"] as const) {
      expect(calendarHelperArgsForSnapshot(state)).toEqual(["--probe"]);
    }
  });
});
