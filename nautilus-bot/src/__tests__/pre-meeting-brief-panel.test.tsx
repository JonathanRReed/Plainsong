import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PreMeetingBriefPanel } from "@/components/meetings/pre-meeting-brief-panel";
import type { MeetingBriefResult } from "@/lib/backend/calendar";
import type { CalendarEventSummary } from "@/lib/calendar-events";

const backendMocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@/lib/electron", () => ({
  invoke: backendMocks.invoke,
  listen: vi.fn(),
}));

const EVENT: CalendarEventSummary = {
  id: "event-1",
  title: "Weekly sync",
  startsAt: "2026-09-02T15:30:00Z",
  endsAt: "2026-09-02T16:00:00Z",
  isAllDay: false,
  calendarId: "cal-1",
  calendarName: "Work",
  videoService: null,
  attendees: [
    { name: "Alice", email: "alice@example.com", isOrganizer: true, isCurrentUser: false },
    { name: "Me", email: "me@example.com", isOrganizer: false, isCurrentUser: true },
  ],
};

function result(overrides: Partial<MeetingBriefResult> = {}): MeetingBriefResult {
  return {
    eventId: "event-1",
    state: "ready",
    related: [
      {
        recordingId: "r1",
        title: "Weekly sync",
        createdAt: "2026-08-26T15:30:00Z",
        reason: { sharedAttendees: 1, titleMatch: true },
        sharedAttendeeNames: ["Alice"],
        summary: "Shipped the importer.",
        openItems: ["Alice to send the revised numbers"],
        decisions: [],
      },
    ],
    brief: "Last week you agreed to ship the importer.",
    citations: [],
    grounded: true,
    model: "llama3",
    actualProvider: "ollama",
    unavailableReason: null,
    generatedAt: "2026-09-02T15:00:00Z",
    cached: false,
    ...overrides,
  };
}

describe("PreMeetingBriefPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does nothing until the reader asks for it", () => {
    render(<PreMeetingBriefPanel event={EVENT} />);
    expect(screen.getByRole("button", { name: "Prepare" })).toBeTruthy();
    expect(backendMocks.invoke).not.toHaveBeenCalled();
  });

  it("sends the event, its title and the invitees without the reader", async () => {
    backendMocks.invoke.mockResolvedValue(result());
    render(<PreMeetingBriefPanel event={EVENT} />);
    fireEvent.click(screen.getByRole("button", { name: "Prepare" }));

    await waitFor(() => expect(backendMocks.invoke).toHaveBeenCalled());
    const [command, payload] = backendMocks.invoke.mock.calls[0];
    expect(command).toBe("prepare_meeting_brief");
    expect(payload).toEqual({
      eventId: "event-1",
      title: "Weekly sync",
      attendees: [{ name: "Alice", email: "alice@example.com", isOrganizer: true }],
      refresh: false,
    });
  });

  it("shows the brief, its sources, and where it came from", async () => {
    backendMocks.invoke.mockResolvedValue(result());
    render(<PreMeetingBriefPanel event={EVENT} />);
    fireEvent.click(screen.getByRole("button", { name: "Prepare" }));

    expect(
      await screen.findByText("Last week you agreed to ship the importer."),
    ).toBeTruthy();
    expect(screen.getByText("Alice to send the revised numbers")).toBeTruthy();
    expect(screen.getByText(/same person: Alice/)).toBeTruthy();
    expect(screen.getByText(/written by ollama/i)).toBeTruthy();
  });

  /**
   * The state that matters most: a Mac with no analysis provider still has
   * the prior meetings and their open items, and hiding those behind an
   * error would be withholding data the app already holds.
   */
  it("falls back to the raw source list when no brief could be written", async () => {
    backendMocks.invoke.mockResolvedValue(
      result({
        state: "sources_only",
        brief: null,
        model: null,
        actualProvider: null,
        grounded: false,
        unavailableReason: "Ollama is not running.",
      }),
    );
    render(<PreMeetingBriefPanel event={EVENT} />);
    fireEvent.click(screen.getByRole("button", { name: "Prepare" }));

    expect(await screen.findByText(/Ollama is not running/)).toBeTruthy();
    expect(screen.getByText("Alice to send the revised numbers")).toBeTruthy();
    expect(screen.getByText("Weekly sync")).toBeTruthy();
  });

  it("says plainly when nothing on this Mac relates to the event", async () => {
    backendMocks.invoke.mockResolvedValue(
      result({ state: "no_sources", related: [], brief: null }),
    );
    render(<PreMeetingBriefPanel event={EVENT} />);
    fireEvent.click(screen.getByRole("button", { name: "Prepare" }));

    expect(
      await screen.findByText(/No meeting on this Mac shares a person or a name/),
    ).toBeTruthy();
  });

  it("warns when the brief could not be traced back to its sources", async () => {
    backendMocks.invoke.mockResolvedValue(result({ grounded: false }));
    render(<PreMeetingBriefPanel event={EVENT} />);
    fireEvent.click(screen.getByRole("button", { name: "Prepare" }));

    expect(
      await screen.findByText(/could not be traced back to a cited meeting/),
    ).toBeTruthy();
  });

  it("asks for a fresh brief on Refresh rather than the cached one", async () => {
    backendMocks.invoke.mockResolvedValue(result({ cached: true }));
    render(<PreMeetingBriefPanel event={EVENT} />);
    fireEvent.click(screen.getByRole("button", { name: "Prepare" }));
    await screen.findByText(/from cache/);

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(backendMocks.invoke).toHaveBeenCalledTimes(2));
    expect(backendMocks.invoke.mock.calls[1][1].refresh).toBe(true);
  });

  it("reports a failed call instead of rendering an empty panel", async () => {
    backendMocks.invoke.mockRejectedValue(new Error("Sidecar is not running"));
    render(<PreMeetingBriefPanel event={EVENT} />);
    fireEvent.click(screen.getByRole("button", { name: "Prepare" }));

    expect(await screen.findByText("Sidecar is not running")).toBeTruthy();
  });

  it("opens a cited meeting", async () => {
    backendMocks.invoke.mockResolvedValue(result());
    const onOpenMeeting = vi.fn();
    render(<PreMeetingBriefPanel event={EVENT} onOpenMeeting={onOpenMeeting} />);
    fireEvent.click(screen.getByRole("button", { name: "Prepare" }));

    fireEvent.click(await screen.findByRole("button", { name: "Open this meeting" }));
    expect(onOpenMeeting).toHaveBeenCalledWith("r1");
  });
});
