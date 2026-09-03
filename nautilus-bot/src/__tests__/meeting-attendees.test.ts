import { describe, expect, it } from "vitest";
import {
  MAX_MEETING_ATTENDEES,
  addManualAttendee,
  attendeeIdentityKey,
  attendeeNameSuggestions,
  attendeeNamesForContext,
  meetingAttendeesFromCalendar,
  removeAttendee,
  sanitizeMeetingAttendees,
  type MeetingAttendee,
} from "@/lib/attendees";
import {
  buildCalendarCapturePrefill,
  type CalendarEventSummary,
} from "@/lib/calendar-events";
import { parseCalendarHelperOutput } from "../../electron/macos-calendar";

function attendee(overrides: Partial<MeetingAttendee> = {}): MeetingAttendee {
  return { name: "Alice Brown", email: null, isOrganizer: false, ...overrides };
}

describe("attendee identity", () => {
  it("recognizes the same person across two different display names", () => {
    expect(attendeeIdentityKey({ name: "J. Reed", email: "j@example.com" })).toBe(
      attendeeIdentityKey({ name: "Jonathan Reed", email: "J@Example.com" }),
    );
  });

  it("falls back to the name when there is no address", () => {
    expect(attendeeIdentityKey({ name: "  Alice   Brown ", email: null })).toBe(
      attendeeIdentityKey({ name: "alice brown" }),
    );
  });

  it("keeps two different addresses apart even with the same name", () => {
    expect(attendeeIdentityKey({ name: "Alex", email: "a@one.com" })).not.toBe(
      attendeeIdentityKey({ name: "Alex", email: "a@two.com" }),
    );
  });
});

describe("sanitizeMeetingAttendees", () => {
  it("drops nameless entries, collapses whitespace, and de-duplicates", () => {
    const sanitized = sanitizeMeetingAttendees([
      attendee({ name: "   " }),
      attendee({ name: "  Alice   Brown " }),
      attendee({ name: "Alice Brown" }),
      attendee({ name: "Bob", email: "bob@example.com" }),
      attendee({ name: "Robert", email: "BOB@example.com" }),
    ]);
    expect(sanitized.map((entry) => entry.name)).toEqual(["Alice Brown", "Bob"]);
  });

  it("caps the list", () => {
    const many = Array.from({ length: MAX_MEETING_ATTENDEES + 20 }, (_x, index) =>
      attendee({ name: `Person ${index}` }),
    );
    expect(sanitizeMeetingAttendees(many)).toHaveLength(MAX_MEETING_ATTENDEES);
  });

  it("normalizes an empty address to null", () => {
    expect(sanitizeMeetingAttendees([attendee({ email: "   " })])[0].email).toBeNull();
  });

  // A display name comes off somebody else's calendar invite. A right-to-left
  // override reverses every glyph drawn after it -- in the header, in an
  // export, and inside the fenced block of a prompt. Whitespace collapsing
  // never saw these, so they used to survive the whole sanitizer.
  it("strips bidi overrides, isolates and control characters", () => {
    const sanitized = sanitizeMeetingAttendees([
      attendee({
        name: "Dana\u202E\u2066 Okafor\u0007",
        email: "dana\u200B@example.com",
      }),
    ]);
    expect(sanitized[0].name).toBe("Dana Okafor");
    expect(sanitized[0].email).toBe("dana@example.com");

    // A name that is nothing but steering characters is not a name.
    expect(sanitizeMeetingAttendees([attendee({ name: "\u202E\uFEFF" })])).toEqual([]);
  });

  // The prompt path reads the same normalizer, so an override cannot ride a
  // name into the fenced block a summary or a chat answer is grounded on.
  it("keeps an override out of the names a prompt is given", () => {
    expect(
      attendeeNamesForContext([attendee({ name: "\u202DSam\u202C Ito" })]),
    ).toEqual(["Sam Ito"]);
  });

  // One person typed with an override and the same person without are the
  // same person, not two chips.
  it("gives an overridden and a plain spelling of one name the same identity", () => {
    expect(attendeeIdentityKey({ name: "Dana\u202E Okafor", email: null })).toBe(
      attendeeIdentityKey({ name: "Dana Okafor", email: null }),
    );
  });

  // Manual entry is the other way a name arrives, and it trims before the
  // sanitizer sees it.
  it("strips them from a hand-typed attendee too", () => {
    expect(addManualAttendee([], "Sam\u202E Ito", "sam\u200B@example.com")).toEqual([
      { name: "Sam Ito", email: "sam@example.com", isOrganizer: false },
    ]);
  });
});

describe("meetingAttendeesFromCalendar", () => {
  it("drops the current user, because every meeting shares them", () => {
    const stored = meetingAttendeesFromCalendar([
      { name: "Me", email: "me@example.com", isOrganizer: false, isCurrentUser: true },
      { name: "Alice", email: "alice@example.com", isOrganizer: true, isCurrentUser: false },
    ]);
    expect(stored.map((entry) => entry.name)).toEqual(["Alice"]);
    expect(stored[0].isOrganizer).toBe(true);
  });

  it("returns nothing for an event with no invitees", () => {
    expect(meetingAttendeesFromCalendar(undefined)).toEqual([]);
  });
});

describe("attendeeNamesForContext", () => {
  it("never lets an address into prompt-bound text", () => {
    const names = attendeeNamesForContext([
      attendee({ name: "Alice Brown", email: "alice@acme-holdings.example" }),
      attendee({ name: "Bob", email: "bob@example.com" }),
    ]);
    expect(names).toEqual(["Alice Brown", "Bob"]);
    expect(names.join(" ")).not.toContain("@");
  });
});

describe("attendeeNameSuggestions", () => {
  it("puts the organizer first and never repeats a name", () => {
    expect(
      attendeeNameSuggestions([
        attendee({ name: "Alice" }),
        attendee({ name: "Bob", isOrganizer: true }),
      ]),
    ).toEqual(["Bob", "Alice"]);
  });
});

describe("manual attendee entry", () => {
  it("adds a typed name and refuses an empty one or a duplicate", () => {
    const one = addManualAttendee([], "  Alice  Brown ");
    expect(one.map((entry) => entry.name)).toEqual(["Alice Brown"]);
    expect(addManualAttendee(one, "   ")).toHaveLength(1);
    expect(addManualAttendee(one, "alice brown")).toHaveLength(1);
  });

  it("removes by identity key", () => {
    const list = [attendee({ name: "Alice" }), attendee({ name: "Bob" })];
    const remaining = removeAttendee(list, attendeeIdentityKey(list[0]));
    expect(remaining.map((entry) => entry.name)).toEqual(["Bob"]);
  });
});

describe("the helper payload's attendee list", () => {
  function helperOutput(attendees: unknown) {
    return JSON.stringify({
      protocol_version: 2,
      type: "events",
      authorization: "authorized",
      observed_at: "2026-09-02T15:00:00Z",
      horizon_minutes: 480,
      calendars: [],
      events: [
        {
          id: "event-1",
          title: "Budget review",
          starts_at: "2026-09-02T15:30:00Z",
          ends_at: "2026-09-02T16:00:00Z",
          is_all_day: false,
          calendar_id: "cal-1",
          calendar_name: "Work",
          conference_urls: [],
          attendees,
        },
      ],
    });
  }

  it("parses names, addresses and the organizer/current-user flags", () => {
    const snapshot = parseCalendarHelperOutput(
      helperOutput([
        { name: "Alice", email: "alice@example.com", is_organizer: true, is_current_user: false },
        { name: "Me", email: null, is_organizer: false, is_current_user: true },
      ]),
      0,
    );
    expect(snapshot.events[0].attendees).toEqual([
      { name: "Alice", email: "alice@example.com", isOrganizer: true, isCurrentUser: false },
      { name: "Me", email: null, isOrganizer: false, isCurrentUser: true },
    ]);
  });

  it("drops a nameless participant rather than rendering an empty chip", () => {
    const snapshot = parseCalendarHelperOutput(
      helperOutput([{ name: "  ", email: null }, { name: "Bob" }]),
      0,
    );
    expect(snapshot.events[0].attendees.map((entry) => entry.name)).toEqual(["Bob"]);
  });

  it("treats a protocol-1 payload as an event with no attendees, not a broken event", () => {
    const snapshot = parseCalendarHelperOutput(helperOutput(undefined), 0);
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.events[0].title).toBe("Budget review");
    expect(snapshot.events[0].attendees).toEqual([]);
  });
});

describe("buildCalendarCapturePrefill", () => {
  function event(attendees: CalendarEventSummary["attendees"]): CalendarEventSummary {
    return {
      id: "event-1",
      title: "Budget review",
      startsAt: "2026-09-02T15:30:00Z",
      endsAt: "2026-09-02T16:00:00Z",
      isAllDay: false,
      calendarId: "cal-1",
      calendarName: "Work",
      videoService: null,
      attendees,
    };
  }

  it("carries the invitee list onto the meeting, without the reader", () => {
    const prefill = buildCalendarCapturePrefill(
      event([
        { name: "Alice", email: "alice@example.com", isOrganizer: true, isCurrentUser: false },
        { name: "Me", email: "me@example.com", isOrganizer: false, isCurrentUser: true },
      ]),
    );
    expect(prefill?.attendees.map((entry) => entry.name)).toEqual(["Alice"]);
  });

  it("still produces a prefill for an event with no invitees", () => {
    expect(buildCalendarCapturePrefill(event(undefined))?.attendees).toEqual([]);
  });
});
