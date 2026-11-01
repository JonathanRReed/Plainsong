import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PreMeetingBriefPanel } from "@/components/meetings/pre-meeting-brief-panel";
import { prepareMeetingBrief, type MeetingBriefResult } from "@/lib/backend/calendar";
import type { CalendarEventSummary } from "@/lib/calendar-events";

vi.mock("@/lib/backend/calendar", () => ({ prepareMeetingBrief: vi.fn() }));
const prepare = vi.mocked(prepareMeetingBrief);
const event: CalendarEventSummary = {
  id: "event-a", title: "Weekly planning", startsAt: "2026-10-13T15:00:00Z",
  endsAt: "2026-10-13T16:00:00Z", isAllDay: false, calendarId: "work",
  calendarName: "Work", videoService: null, attendees: [],
};
const result = (text: string): MeetingBriefResult => ({
  eventId: event.id, state: "ready", related: [], brief: text, citations: [],
  grounded: true, model: null, actualProvider: null, unavailableReason: null,
  generatedAt: null, cached: false,
});
function deferred() {
  let resolve!: (value: MeetingBriefResult) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<MeetingBriefResult>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => vi.clearAllMocks());

describe("pre-meeting brief context", () => {
  it.each([
    { ...event, id: "event-b" },
    { ...event, title: "Budget review" },
    { ...event, attendees: [{ name: "Dana", email: null, isOrganizer: false, isCurrentUser: false }] },
  ])("clears the previous brief when the meeting context changes: $title", async (nextEvent) => {
    prepare.mockResolvedValue(result("Previous decisions"));
    const { rerender } = render(<PreMeetingBriefPanel event={event} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Prepare" })); });
    expect(screen.getByText("Previous decisions")).toBeInTheDocument();
    rerender(<PreMeetingBriefPanel event={nextEvent} />);
    expect(screen.queryByText("Previous decisions")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Prepare" })).toBeEnabled();
  });

  it("allows a new meeting to prepare while an old request is pending and ignores its reply", async () => {
    const old = deferred();
    const current = deferred();
    prepare.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const { rerender } = render(<PreMeetingBriefPanel event={event} />);
    fireEvent.click(screen.getByRole("button", { name: "Prepare" }));
    rerender(<PreMeetingBriefPanel event={{ ...event, id: "event-b" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Prepare" }));
    await act(async () => { current.resolve(result("Current decisions")); });
    await act(async () => { old.resolve(result("Old decisions")); });
    expect(screen.getByText("Current decisions")).toBeInTheDocument();
    expect(screen.queryByText("Old decisions")).not.toBeInTheDocument();
    expect(prepare.mock.calls[1][0].eventId).toBe("event-b");
  });

  it("ignores an old failure without interrupting the current request", async () => {
    const old = deferred();
    const current = deferred();
    prepare.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const { rerender } = render(<PreMeetingBriefPanel event={event} />);
    fireEvent.click(screen.getByRole("button", { name: "Prepare" }));
    rerender(<PreMeetingBriefPanel event={{ ...event, title: "New agenda" }} />);
    fireEvent.click(screen.getByRole("button", { name: "Prepare" }));
    await act(async () => { old.reject(new Error("Old failure")); });
    expect(screen.queryByText("Old failure")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reading your meetings…" })).toBeDisabled();
    await act(async () => { current.resolve(result("New agenda decisions")); });
    expect(screen.getByText("New agenda decisions")).toBeInTheDocument();
  });

  it("keeps a prepared brief through equivalent calendar snapshots", async () => {
    prepare.mockResolvedValue(result("Saved context"));
    const { rerender } = render(<PreMeetingBriefPanel event={event} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Prepare" })); });
    rerender(<PreMeetingBriefPanel event={{ ...event, attendees: [] }} />);
    expect(screen.getByText("Saved context")).toBeInTheDocument();
    expect(prepare).toHaveBeenCalledTimes(1);
  });
});


describe("pre-meeting brief source evidence", () => {
  it.each(["sources_only", "ready"] as const)("shows source review status for %s", async (state) => {
    prepare.mockResolvedValue({
      ...result("Review the prior decisions"), state,
      brief: state === "ready" ? "Review the prior decisions" : null,
      related: [{
        recordingId: "prior-meeting", title: "Prior planning", createdAt: "2026-10-12T15:00:00Z",
        reason: { sharedAttendees: 0, titleMatch: true }, sharedAttendeeNames: [],
        needsReview: true, summary: null, decisions: [], openItems: ["Confirm the budget"],
      }],
    });
    const openMeeting = vi.fn();
    render(<PreMeetingBriefPanel event={event} onOpenMeeting={openMeeting} />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Prepare" })); });
    expect(screen.getByText(/This source needs review/)).toHaveTextContent("unverified claims");
    expect(screen.getByText("Confirm the budget")).toBeInTheDocument();
    expect(screen.getByText(/Checked the newest 200 meetings/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open this meeting" }));
    expect(openMeeting).toHaveBeenCalledWith("prior-meeting");
  });

  it("limits the no-source claim to the searched meetings", async () => {
    prepare.mockResolvedValue({ ...result(""), state: "no_sources", brief: null });
    render(<PreMeetingBriefPanel event={event} />);
    expect(screen.getByText(/Checks the newest 200 meetings/)).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Prepare" })); });
    expect(screen.getByText(/No related meeting was found among the newest 200 meetings/))
      .toHaveTextContent("Older meetings were not checked.");
    expect(screen.queryByText(/No meeting on this Mac shares/)).not.toBeInTheDocument();
  });
});
