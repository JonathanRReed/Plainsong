import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CalendarSettingsSection } from "@/components/meetings/calendar-settings-section";
import type { CalendarSnapshot } from "@/lib/calendar-events";
import {
  readCalendarDisconnected,
  readIgnoredCalendarIds,
} from "@/lib/calendar-preferences";

const getCalendarSnapshot = vi.fn();
const openCalendarPrivacySettings = vi.fn();

vi.mock("@/lib/backend/calendar", () => ({
  getCalendarSnapshot: (...args: unknown[]) => getCalendarSnapshot(...args),
  requestCalendarAccess: vi.fn(),
  openCalendarPrivacySettings: (...args: unknown[]) =>
    openCalendarPrivacySettings(...args),
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
  getCalendarSnapshot.mockReset();
  openCalendarPrivacySettings.mockReset();
  openCalendarPrivacySettings.mockResolvedValue(undefined);
});

describe("CalendarSettingsSection", () => {
  it("stays out of the way until macOS has granted access", async () => {
    // A settings page is not where a permission gets asked for. The ask lives
    // on Meetings, next to the thing it improves.
    getCalendarSnapshot.mockResolvedValue(snapshot({ authorization: "not_determined" }));

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

  it("turns suggestions off without touching the macOS grant", async () => {
    getCalendarSnapshot.mockResolvedValue(snapshot());

    render(<CalendarSettingsSection />);
    await userEvent.click(
      await screen.findByRole("switch", {
        name: "Suggest meetings from your calendar",
      }),
    );

    expect(readCalendarDisconnected()).toBe(true);
    // The per-calendar list goes with it — there is nothing left to narrow.
    await waitFor(() =>
      expect(screen.queryByText("US Holidays")).not.toBeInTheDocument(),
    );
    // And the section says where the real permission lives.
    expect(
      screen.getByRole("button", { name: /System Settings/ }),
    ).toBeInTheDocument();
  });

  it("says so plainly when macOS returned no calendars", async () => {
    getCalendarSnapshot.mockResolvedValue(snapshot({ calendars: [] }));

    render(<CalendarSettingsSection />);

    expect(
      await screen.findByText("macOS returned no calendars for this account."),
    ).toBeInTheDocument();
  });
});
