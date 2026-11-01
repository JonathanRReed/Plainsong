import { describe, expect, it } from "vitest";
import { calendarConferenceUrl, firstCalendarConferenceUrl } from "../../electron/calendar-conference-url";
import { buildCalendarCapturePrefill } from "@/lib/calendar-events";
import { meetingCapturePrefillFromCalendarEvent } from "@/lib/meeting-capture-prefill";

describe("calendar conference links", () => {
  it.each([
    "https://us02web.zoom.us/j/123456789?pwd=token",
    "https://meet.google.com/abc-defg-hij",
    "https://teams.microsoft.com/l/meetup-join/19%3ameeting?context=example",
  ])("accepts a supported meeting URL %s", (url) => {
    expect(calendarConferenceUrl(url)).toBe(url);
  });
  it.each([
    "javascript:alert(1)", "http://zoom.us/j/123", "https://zoom.us.evil.test/j/123",
    "https://evil-zoom.us/j/123", "https://user:secret@zoom.us/j/123",
    "https://zoom.us:444/j/123", "https://zoom.us/", "https://meet.google.com/",
    "https://meet.google.com/abc-defg-hij#token", "https://zoom.us\\@evil.test/j/123",
    " https://zoom.us/j/123", "https://zoom.us/j/123\n", null,
  ])("rejects malformed or unsupported links %s", (url) => {
    expect(calendarConferenceUrl(url)).toBeNull();
  });
  it("skips rejected candidates and keeps the first supported URL", () => {
    expect(firstCalendarConferenceUrl(["https://evil.test/", "https://zoom.us/j/123", "https://meet.google.com/abc-defg-hij"]))
      .toBe("https://zoom.us/j/123");
  });
  it("carries join intent only with a validated URL", () => {
    const event = { id: "one", title: "Review", startsAt: "2026-10-12T12:00:00Z", endsAt: "2026-10-12T13:00:00Z", isAllDay: false, calendarId: "work", calendarName: "Work", videoService: null };
    const prefill = buildCalendarCapturePrefill({ ...event, conferenceUrl: "https://zoom.us/j/123" })!;
    expect(meetingCapturePrefillFromCalendarEvent(prefill).joinConferenceUrl).toBe("https://zoom.us/j/123");
    expect(meetingCapturePrefillFromCalendarEvent({ ...prefill, conferenceUrl: undefined }).joinConferenceUrl).toBeUndefined();
    expect(buildCalendarCapturePrefill({ ...event, conferenceUrl: "https://evil.test/" })).not.toHaveProperty("conferenceUrl");
  });
});
