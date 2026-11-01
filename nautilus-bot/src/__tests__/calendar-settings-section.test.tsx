import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CalendarSettingsSection } from "@/components/meetings/calendar-settings-section";
import type { CalendarSnapshot } from "@/lib/calendar-events";
import {
  LEGACY_CALENDAR_DISCONNECTED_STORAGE_KEY,
  readIgnoredCalendarIds,
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

/** The saved settings the calendar's connection is read from and written to. */
const backend = vi.hoisted(() => ({
  settings: {} as { meetings?: Record<string, unknown> },
}));

vi.mock("@/lib/backend", () => ({
  getSettings: async () => structuredClone(backend.settings),
  updateSettings: async (mutate: (draft: Record<string, unknown>) => void) => {
    const draft = structuredClone(backend.settings) as Record<string, unknown>;
    mutate(draft);
    backend.settings = draft as typeof backend.settings;
  },
}));

/** jsdom under this runner exposes no localStorage; these tests need one. */
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

function snapshot(overrides: Partial<CalendarSnapshot> = {}): CalendarSnapshot {
  return {
    authorization: "authorized",
    observedAt: Date.now(),
    events: [],
    calendars: [
      { id: "work", title: "Work", accountName: "iCloud" },
      { id: "holidays", title: "US Holidays", accountName: "Subscribed" },
    ],
    errorCode: null,
    ...overrides,
  };
}

beforeEach(() => {
  storage.clear();
  backend.settings = {};
  getCalendarSnapshot.mockReset();
  requestCalendarAccess.mockReset();
  openCalendarPrivacySettings.mockReset();
  openCalendarPrivacySettings.mockResolvedValue(undefined);
});

describe("CalendarSettingsSection", () => {
  it("offers the Connect card before macOS has been asked, without asking on its own", async () => {
    // Settings > Meetings > Calendar must lead somewhere before access is
    // granted, but opening Settings is not a reason to show a macOS prompt.
    getCalendarSnapshot.mockResolvedValue(snapshot({ authorization: "not_determined" }));

    render(<CalendarSettingsSection />);

    expect(await screen.findByText("Connect your calendar")).toBeInTheDocument();
    expect(requestCalendarAccess).not.toHaveBeenCalled();
    // Nothing to narrow down yet.
    expect(
      screen.queryByRole("switch", { name: "Suggest meetings from your calendar" }),
    ).not.toBeInTheDocument();
  });

  it("asks macOS on Connect and says so when no prompt appeared", async () => {
    getCalendarSnapshot.mockResolvedValue(snapshot({ authorization: "not_determined" }));
    requestCalendarAccess.mockResolvedValue(snapshot({ authorization: "not_determined" }));

    render(<CalendarSettingsSection />);
    await userEvent.click(await screen.findByRole("button", { name: "Connect calendar" }));

    expect(requestCalendarAccess).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText(/macOS didn't show a calendar prompt/),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open System Settings" }));
    expect(openCalendarPrivacySettings).toHaveBeenCalledTimes(1);
  });

  it("shows the calendars once Connect is granted", async () => {
    getCalendarSnapshot.mockResolvedValue(snapshot({ authorization: "not_determined" }));
    requestCalendarAccess.mockResolvedValue(snapshot());

    render(<CalendarSettingsSection />);
    await userEvent.click(await screen.findByRole("button", { name: "Connect calendar" }));

    expect(await screen.findByText("Work")).toBeInTheDocument();
  });

  it("names the switch to flip when macOS refused", async () => {
    getCalendarSnapshot.mockResolvedValue(snapshot({ authorization: "denied" }));

    render(<CalendarSettingsSection />);

    expect(await screen.findByText("Calendar access is off")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open System Settings" }));
    expect(openCalendarPrivacySettings).toHaveBeenCalledTimes(1);
  });

  it("keeps unsupported platforms hidden", async () => {
    getCalendarSnapshot.mockResolvedValue(snapshot({ authorization: "unsupported_platform" }));

    const { container } = render(<CalendarSettingsSection />);

    await waitFor(() => expect(getCalendarSnapshot).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("lists the calendars it can read", async () => {
    getCalendarSnapshot.mockResolvedValue(snapshot());

    render(<CalendarSettingsSection />);

    expect(await screen.findByText("Work")).toBeInTheDocument();
    expect(screen.getByText("US Holidays")).toBeInTheDocument();
  });

  it("records a calendar the reader switched off", async () => {
    getCalendarSnapshot.mockResolvedValue(snapshot());

    render(<CalendarSettingsSection />);
    await screen.findByText("US Holidays");
    await userEvent.click(
      screen.getByRole("switch", { name: "US Holidays" }),
    );

    expect(readIgnoredCalendarIds()).toEqual(["holidays"]);
  });

  it("disconnecting stops every calendar read until the reader reconnects", async () => {
    getCalendarSnapshot.mockResolvedValue(snapshot());

    render(<CalendarSettingsSection />);
    await userEvent.click(
      await screen.findByRole("switch", {
        name: "Suggest meetings from your calendar",
      }),
    );

    // Saved where the main process enforces it, not only in this window.
    expect(backend.settings.meetings?.calendarDisconnected).toBe(true);
    // The calendars read before go with it, and the section says why.
    expect(
      await screen.findByText(/Plainsong is not reading your calendar/),
    ).toBeInTheDocument();
    expect(screen.queryByText("US Holidays")).not.toBeInTheDocument();
    const reads = getCalendarSnapshot.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getCalendarSnapshot).toHaveBeenCalledTimes(reads);

    // Turning it back on is the way back, and reading resumes.
    const reconnect = screen.getByRole("switch", {
      name: "Suggest meetings from your calendar",
    });
    expect(reconnect).not.toBeChecked();
    await userEvent.click(reconnect);
    expect(backend.settings.meetings?.calendarDisconnected).toBe(false);
    expect(await screen.findByText("US Holidays")).toBeInTheDocument();
    expect(getCalendarSnapshot.mock.calls.length).toBeGreaterThan(reads);
  });

  it("reads nothing on mount for a reader who disconnected earlier", async () => {
    backend.settings = { meetings: { calendarDisconnected: true } };
    getCalendarSnapshot.mockResolvedValue(snapshot());

    render(<CalendarSettingsSection />);

    expect(
      await screen.findByText(/Plainsong is not reading your calendar/),
    ).toBeInTheDocument();
    expect(getCalendarSnapshot).not.toHaveBeenCalled();
  });

  it("carries a disconnect saved by an older version into settings", async () => {
    storage.set(LEGACY_CALENDAR_DISCONNECTED_STORAGE_KEY, "true");
    getCalendarSnapshot.mockResolvedValue(snapshot());

    render(<CalendarSettingsSection />);

    expect(
      await screen.findByText(/Plainsong is not reading your calendar/),
    ).toBeInTheDocument();
    expect(backend.settings.meetings?.calendarDisconnected).toBe(true);
    expect(storage.has(LEGACY_CALENDAR_DISCONNECTED_STORAGE_KEY)).toBe(false);
    expect(getCalendarSnapshot).not.toHaveBeenCalled();
  });

  it("says so plainly when macOS returned no calendars", async () => {
    getCalendarSnapshot.mockResolvedValue(snapshot({ calendars: [] }));

    render(<CalendarSettingsSection />);

    expect(
      await screen.findByText("macOS returned no calendars for this account."),
    ).toBeInTheDocument();
  });
});

let platformSpy: { mockRestore(): void } | undefined;
function onPlatform(platform: string) {
  platformSpy = vi.spyOn(window.navigator, "platform", "get").mockReturnValue(platform);
}
afterEach(() => {
  platformSpy?.mockRestore();
  platformSpy = undefined;
});

it.each(["helper_unavailable", "unknown"] as const)("keeps calendar recovery available after %s", async (authorization) => {
  onPlatform("MacIntel");
  getCalendarSnapshot.mockResolvedValue(snapshot({ authorization }));
  render(<CalendarSettingsSection />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't check calendar access");
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(getCalendarSnapshot).toHaveBeenCalledWith({ forceRefresh: true });
  await userEvent.click(screen.getByRole("button", { name: "Open System Settings" }));
  expect(openCalendarPrivacySettings).toHaveBeenCalled();
});

it("keeps Retry available when the calendar check rejects again", async () => {
  onPlatform("MacIntel");
  getCalendarSnapshot.mockRejectedValue(new Error("helper failed"));
  render(<CalendarSettingsSection />);
  await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Couldn't check calendar access");
  expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
});

it("keeps a failed calendar check hidden off macOS", async () => {
  onPlatform("Win32");
  getCalendarSnapshot.mockRejectedValue(new Error("no helper"));
  const { container } = render(<CalendarSettingsSection />);
  await waitFor(() => expect(getCalendarSnapshot).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(container).toBeEmptyDOMElement();
  expect(screen.queryByRole("alert")).toBeNull();
});
