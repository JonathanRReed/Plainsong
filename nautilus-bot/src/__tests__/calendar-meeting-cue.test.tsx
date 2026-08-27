import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CalendarMeetingCue } from "@/components/meetings/calendar-meeting-cue";
import type { CalendarSnapshot } from "@/lib/calendar-events";
import {
  CALENDAR_DISCONNECTED_STORAGE_KEY,
  CALENDAR_IGNORED_STORAGE_KEY,
} from "@/lib/calendar-preferences";

const getCalendarSnapshot = vi.fn();
const requestCalendarAccess = vi.fn();
const openCalendarPrivacySettings = vi.fn();

vi.mock("@/lib/backend/calendar", () => ({
  getCalendarSnapshot: (...args: unknown[]) => getCalendarSnapshot(...args),
  requestCalendarAccess: (...args: unknown[]) => requestCalendarAccess(...args),
  openCalendarPrivacySettings: (...args: unknown[]) =>
    openCalendarPrivacySettings(...args),
}));

/**
 * jsdom under this runner exposes no `window.localStorage`, which is exactly
 * the "storage is unavailable" branch the preference helpers already guard
 * against. These tests need the other branch, so they install a real one.
 */
const storage = new Map<string, string>();
Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, String(value)),
    removeItem: (key: string) => void storage.delete(key),
    clear: () => storage.clear(),
    key: (index: number) => [...storage.keys()][index] ?? null,
    get length() {
      return storage.size;
    },
  },
});

const NOW = Date.parse("2026-08-27T15:00:00Z");

function snapshot(overrides: Partial<CalendarSnapshot> = {}): CalendarSnapshot {
  return {
    authorization: "authorized",
    observedAt: NOW,
    events: [],
    calendars: [],
    errorCode: null,
    ...overrides,
  };
}

function upcomingEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "event-1",
    title: "Design review",
    startsAt: new Date(NOW + 12 * 60_000).toISOString(),
    endsAt: new Date(NOW + 42 * 60_000).toISOString(),
    isAllDay: false,
    calendarId: "work",
    calendarName: "Work",
    videoService: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.setSystemTime(NOW);
  window.localStorage.clear();
  getCalendarSnapshot.mockReset();
  requestCalendarAccess.mockReset();
  openCalendarPrivacySettings.mockReset();
  openCalendarPrivacySettings.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CalendarMeetingCue permission states", () => {
  it("offers an explicit opt-in when macOS has not been asked", async () => {
    getCalendarSnapshot.mockResolvedValue(snapshot({ authorization: "not_determined" }));

    render(<CalendarMeetingCue captureInProgress={false} onStartCapture={vi.fn()} />);

    expect(await screen.findByText("Connect your calendar")).toBeInTheDocument();
    // The card, not the prompt. Nothing has asked macOS anything yet.
    expect(requestCalendarAccess).not.toHaveBeenCalled();
  });

  it("only prompts once the reader clicks Connect", async () => {
    getCalendarSnapshot.mockResolvedValue(snapshot({ authorization: "not_determined" }));
    requestCalendarAccess.mockResolvedValue(snapshot({ authorization: "authorized" }));

    render(<CalendarMeetingCue captureInProgress={false} onStartCapture={vi.fn()} />);
    await screen.findByText("Connect your calendar");

    expect(requestCalendarAccess).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Connect calendar" }));

    expect(requestCalendarAccess).toHaveBeenCalledTimes(1);
  });

  it("names the switch to flip when access was refused", async () => {
    getCalendarSnapshot.mockResolvedValue(snapshot({ authorization: "denied" }));

    render(<CalendarMeetingCue captureInProgress={false} onStartCapture={vi.fn()} />);

    expect(await screen.findByText("Calendar access is off")).toBeInTheDocument();
    // And says, in the same breath, that meetings are unaffected.
    expect(
      screen.getByText(/Meetings record normally either way/),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Open System Settings" }));
    expect(openCalendarPrivacySettings).toHaveBeenCalledTimes(1);
  });

  it("tells a write-only grant apart from a refusal", async () => {
    getCalendarSnapshot.mockResolvedValue(snapshot({ authorization: "write_only" }));

    render(<CalendarMeetingCue captureInProgress={false} onStartCapture={vi.fn()} />);

    expect(
      await screen.findByText(/add calendar events but not read them/),
    ).toBeInTheDocument();
  });

  it("offers no System Settings button on a managed Mac", async () => {
    getCalendarSnapshot.mockResolvedValue(snapshot({ authorization: "restricted" }));

    render(<CalendarMeetingCue captureInProgress={false} onStartCapture={vi.fn()} />);

    expect(await screen.findByText(/managed by this Mac's profile/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it.each([
    ["unsupported_platform", "a Windows build"],
    ["helper_unavailable", "a missing helper"],
    ["unknown", "an answer it could not read"],
  ] as const)("renders nothing for %s (%s)", async (authorization, _reason) => {
    getCalendarSnapshot.mockResolvedValue(snapshot({ authorization }));

    const { container } = render(
      <CalendarMeetingCue captureInProgress={false} onStartCapture={vi.fn()} />,
    );

    await waitFor(() => expect(getCalendarSnapshot).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("says nothing while a meeting is already being captured", async () => {
    getCalendarSnapshot.mockResolvedValue(
      snapshot({ events: [upcomingEvent()] }),
    );

    const { container } = render(
      <CalendarMeetingCue captureInProgress onStartCapture={vi.fn()} />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});

describe("CalendarMeetingCue offer", () => {
  it("shows the next meeting with an honest countdown", async () => {
    getCalendarSnapshot.mockResolvedValue(snapshot({ events: [upcomingEvent()] }));

    render(<CalendarMeetingCue captureInProgress={false} onStartCapture={vi.fn()} />);

    expect(await screen.findByText("Design review")).toBeInTheDocument();
    expect(screen.getByText(/starts in 12 min/)).toBeInTheDocument();
  });

  it("names the conferencing service when it recognized one", async () => {
    getCalendarSnapshot.mockResolvedValue(
      snapshot({ events: [upcomingEvent({ videoService: "zoom" })] }),
    );

    render(<CalendarMeetingCue captureInProgress={false} onStartCapture={vi.fn()} />);

    expect(await screen.findByText(/Zoom/)).toBeInTheDocument();
  });

  it("hands the event's title to the start it triggers", async () => {
    const onStartCapture = vi.fn();
    getCalendarSnapshot.mockResolvedValue(
      snapshot({ events: [upcomingEvent({ videoService: "google_meet" })] }),
    );

    render(
      <CalendarMeetingCue captureInProgress={false} onStartCapture={onStartCapture} />,
    );
    await screen.findByText("Design review");
    await userEvent.click(screen.getByRole("button", { name: "Start capture" }));

    expect(onStartCapture).toHaveBeenCalledWith({
      eventId: "event-1",
      title: "Design review",
      videoService: "google_meet",
    });
  });

  it("stays dismissed once waved away", async () => {
    getCalendarSnapshot.mockResolvedValue(snapshot({ events: [upcomingEvent()] }));

    render(<CalendarMeetingCue captureInProgress={false} onStartCapture={vi.fn()} />);
    await screen.findByText("Design review");
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    await waitFor(() =>
      expect(screen.queryByText("Design review")).not.toBeInTheDocument(),
    );
  });

  it("says nothing about a calendar the reader switched off", async () => {
    window.localStorage.setItem(
      CALENDAR_IGNORED_STORAGE_KEY,
      JSON.stringify(["work"]),
    );
    getCalendarSnapshot.mockResolvedValue(snapshot({ events: [upcomingEvent()] }));

    const { container } = render(
      <CalendarMeetingCue captureInProgress={false} onStartCapture={vi.fn()} />,
    );

    await waitFor(() => expect(getCalendarSnapshot).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("goes quiet entirely when suggestions are turned off in settings", async () => {
    window.localStorage.setItem(CALENDAR_DISCONNECTED_STORAGE_KEY, "true");
    getCalendarSnapshot.mockResolvedValue(snapshot({ events: [upcomingEvent()] }));

    const { container } = render(
      <CalendarMeetingCue captureInProgress={false} onStartCapture={vi.fn()} />,
    );

    await waitFor(() => expect(getCalendarSnapshot).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
