import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NameSourcesSetting } from "@/components/settings/name-sources-setting";

const fakes = vi.hoisted(() => ({
  connect: vi.fn(), snapshot: vi.fn(), reconnect: vi.fn(), contactsStatus: vi.fn(), contactsRequest: vi.fn(),
}));
vi.mock("@/lib/shortcuts", () => ({ isMacPlatform: () => true }));
vi.mock("@/hooks/use-calendar-events", () => ({ useCalendarEvents: () => ({ connect: fakes.connect, disconnected: false }) }));
vi.mock("@/lib/backend/calendar", () => ({ getCalendarSnapshot: fakes.snapshot }));
vi.mock("@/lib/calendar-preferences", () => ({ writeCalendarDisconnected: fakes.reconnect }));
vi.mock("@/lib/backend/contacts", () => ({
  getContactsAccessStatus: fakes.contactsStatus, requestContactsAccess: fakes.contactsRequest,
  contactsAccessGranted: (state: string) => state === "authorized" || state === "limited",
}));

describe("calendar and Contacts spelling choices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakes.snapshot.mockResolvedValue({ authorization: "authorized" });
    fakes.contactsStatus.mockResolvedValue({ authorization: "not_determined", nameCount: 0 });
    fakes.contactsRequest.mockResolvedValue({ authorization: "authorized", nameCount: 0 });
  });
  it("starts off without requesting permission and enables each source separately", async () => {
    const calendar = vi.fn(); const contacts = vi.fn(); const user = userEvent.setup();
    render(<NameSourcesSetting calendarEnabled={false} contactsEnabled={false} onCalendarChange={calendar} onContactsChange={contacts} />);
    expect(screen.getByRole("switch", { name: "Calendar" })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: "Contacts" })).not.toBeChecked();
    expect(fakes.connect).not.toHaveBeenCalled(); expect(fakes.contactsRequest).not.toHaveBeenCalled();
    await user.click(screen.getByRole("switch", { name: "Calendar" }));
    await waitFor(() => expect(calendar).toHaveBeenCalledWith(true));
    expect(contacts).not.toHaveBeenCalled(); expect(fakes.contactsRequest).not.toHaveBeenCalled();
    await user.click(screen.getByRole("switch", { name: "Contacts" }));
    await waitFor(() => expect(contacts).toHaveBeenCalledWith(true));
    expect(fakes.connect).toHaveBeenCalledTimes(1);
  });
  it("leaves a denied source off", async () => {
    fakes.snapshot.mockResolvedValue({ authorization: "denied" });
    fakes.contactsRequest.mockResolvedValue({ authorization: "denied", nameCount: 0 });
    const calendar = vi.fn(); const contacts = vi.fn(); const user = userEvent.setup();
    render(<NameSourcesSetting calendarEnabled={false} contactsEnabled={false} onCalendarChange={calendar} onContactsChange={contacts} />);
    await user.click(screen.getByRole("switch", { name: "Calendar" }));
    await screen.findByText(/Allow Calendars/);
    await user.click(screen.getByRole("switch", { name: "Contacts" }));
    await screen.findByText(/can't read Contacts/);
    expect(calendar).not.toHaveBeenCalled(); expect(contacts).not.toHaveBeenCalled();
  });
  it("switches off without asking macOS again", async () => {
    const calendar = vi.fn(); const contacts = vi.fn(); const user = userEvent.setup();
    render(<NameSourcesSetting calendarEnabled contactsEnabled onCalendarChange={calendar} onContactsChange={contacts} />);
    await user.click(screen.getByRole("switch", { name: "Calendar" }));
    await user.click(screen.getByRole("switch", { name: "Contacts" }));
    expect(calendar).toHaveBeenCalledWith(false); expect(contacts).toHaveBeenCalledWith(false);
    expect(fakes.connect).not.toHaveBeenCalled(); expect(fakes.contactsRequest).not.toHaveBeenCalled();
  });
});

it("requests Calendar permission before waiting for a settings write", async () => {
  let finishSave!: () => void;
  fakes.reconnect.mockImplementationOnce(() => new Promise<void>((resolve) => { finishSave = resolve; }));
  fakes.snapshot.mockResolvedValue({ authorization: "authorized" });
  fakes.contactsStatus.mockResolvedValue({ authorization: "not_determined", nameCount: 0 });
  fakes.connect.mockClear();
  const change = vi.fn();
  render(<NameSourcesSetting calendarEnabled={false} contactsEnabled={false} onCalendarChange={change} onContactsChange={vi.fn()} />);
  await userEvent.setup().click(screen.getByRole("switch", { name: "Calendar" }));
  await waitFor(() => expect(fakes.reconnect).toHaveBeenCalled());
  try { expect(fakes.connect).toHaveBeenCalled(); }
  finally { finishSave(); }
  await waitFor(() => expect(change).toHaveBeenCalledWith(true));
});
