import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MeetingSwitcher } from "@/components/views/meetings/meeting-switcher";
import type { Recording } from "@/types";
const meetings = [
  { id: "a", title: "Weekly sync", sourceType: "meeting", status: "completed", createdAt: "2026-10-13T12:00:00Z" },
  { id: "b", title: "Launch review", sourceType: "meeting", status: "processing", createdAt: "2026-10-12T12:00:00Z" },
  { id: "d", title: "Private dictation", sourceType: "dictation", status: "completed", createdAt: "2026-10-12T12:00:00Z" },
] as Recording[];
describe("MeetingSwitcher", () => {
  it("pages 10,000 meetings, searches the whole history, and drops deleted matches", async () => {
    const history = Array.from({ length: 10_000 }, (_, index) => ({
      ...meetings[0], id: String(index), title: `Meeting ${index} [🙂]`,
    }));
    const onSelect = vi.fn(async () => true);
    const { rerender } = render(<MeetingSwitcher meetings={history} currentId="0" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: "Switch meeting" }));
    expect(screen.getAllByRole("button", { name: /^Open meeting:/ })).toHaveLength(50);
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getAllByRole("button", { name: /^Open meeting:/ })).toHaveLength(100);
    fireEvent.change(screen.getByRole("textbox", { name: "Find a meeting" }), { target: { value: "9999 [🙂]" } });
    expect(screen.getAllByRole("button", { name: /^Open meeting:/ })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Open meeting: Meeting 9999 [🙂]" })).toBeInTheDocument();
    rerender(<MeetingSwitcher meetings={history.slice(0, -1)} currentId="0" onSelect={onSelect} />);
    expect(screen.getByText("No meeting titles match.")).toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: "Find a meeting" }), { target: { value: "" } });
    expect(screen.getAllByRole("button", { name: /^Open meeting:/ })).toHaveLength(50);
  });

  it("searches local meeting titles and selects with the keyboard", async () => {
    const user = userEvent.setup(); const onSelect = vi.fn(async () => true);
    render(<MeetingSwitcher meetings={meetings} currentId="a" onSelect={onSelect} />);
    await user.click(screen.getByRole("button", { name: "Switch meeting" }));
    expect(screen.queryByText("Private dictation")).not.toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Find a meeting" }), "missing");
    expect(screen.getByText("No meeting titles match.")).toBeInTheDocument();
    await user.clear(screen.getByRole("textbox", { name: "Find a meeting" }));
    await user.type(screen.getByRole("textbox", { name: "Find a meeting" }), "launch");
    expect(onSelect).not.toHaveBeenCalled();
    await user.tab(); await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(onSelect).toHaveBeenCalledWith(meetings[1], expect.any(Function));
    await waitFor(() => expect(screen.getByRole("button", { name: "Switch meeting" })).toHaveFocus());
  });
  it("closes the current selection without reloading", async () => {
    const user = userEvent.setup(); const onSelect = vi.fn(async () => true);
    render(<MeetingSwitcher meetings={meetings} currentId="a" onSelect={onSelect} />);
    await user.click(screen.getByRole("button", { name: "Switch meeting" }));
    expect(screen.getByRole("button", { name: "Open meeting: Weekly sync" })).toHaveAttribute("aria-current", "true");
    await user.click(screen.getByRole("button", { name: "Open meeting: Weekly sync" }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("prevents duplicate selection and invalidates a save when dismissed", async () => {
    const user = userEvent.setup(); let resolve!: (saved: boolean) => void;
    let isCurrent!: () => boolean;
    const onSelect = vi.fn((_meeting, current) => { isCurrent = current; return new Promise<boolean>(done => { resolve = done; }); });
    render(<MeetingSwitcher meetings={meetings} currentId="a" onSelect={onSelect} />);
    await user.click(screen.getByRole("button", { name: "Switch meeting" }));
    await user.click(screen.getByRole("button", { name: "Open meeting: Launch review" }));
    expect(screen.getByRole("button", { name: "Open meeting: Launch review" })).toBeDisabled();
    await user.keyboard("{Escape}"); expect(isCurrent()).toBe(false);
    await user.click(screen.getByRole("button", { name: "Switch meeting" }));
    await act(async () => resolve(true));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
  it("closes when the current meeting changes and ignores an older failure", async () => {
    const user = userEvent.setup(); let resolve!: (saved: boolean) => void;
    let isCurrent!: () => boolean;
    const onSelect = vi.fn((_meeting, current) => { isCurrent = current; return new Promise<boolean>(done => { resolve = done; }); });
    const view = render(<MeetingSwitcher meetings={meetings} currentId="a" onSelect={onSelect} />);
    await user.click(screen.getByRole("button", { name: "Switch meeting" }));
    await user.click(screen.getByRole("button", { name: "Open meeting: Launch review" }));
    view.rerender(<MeetingSwitcher meetings={meetings} currentId="b" onSelect={onSelect} />);
    expect(isCurrent()).toBe(false);
    await act(async () => resolve(false));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Switch meeting" })).toHaveFocus());
  });
  it("keeps the chooser open when drafts cannot be saved", async () => {
    const user = userEvent.setup();
    render(<MeetingSwitcher meetings={meetings} currentId="a" onSelect={async () => false} />);
    await user.click(screen.getByRole("button", { name: "Switch meeting" }));
    await user.click(screen.getByRole("button", { name: "Open meeting: Launch review" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Finish your edits");
    expect(screen.getByRole("button", { name: "Open meeting: Launch review" })).toBeEnabled();
  });
});
