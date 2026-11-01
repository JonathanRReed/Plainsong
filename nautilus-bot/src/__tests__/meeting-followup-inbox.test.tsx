import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MeetingFollowupInbox } from "@/components/views/meetings/meeting-followup-inbox";
import { listMeetingFollowups } from "@/lib/backend/meeting-followups";
import { setMeetingActionCompleted } from "@/lib/backend/meeting-actions";

vi.mock("@/lib/backend/meeting-followups", () => ({
  listMeetingFollowups: vi.fn(),
}));

vi.mock("@/lib/backend/meeting-actions", () => ({
  setMeetingActionCompleted: vi.fn(),
}));

const listFollowups = vi.mocked(listMeetingFollowups);
const setCompleted = vi.mocked(setMeetingActionCompleted);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

const firstItem = {
  recordingId: "meeting-1",
  meetingTitle: "Planning review",
  task: "Send the deck (Owner: Jane · Due: Friday)",
  completed: false,
  needsReview: false,
};

describe("MeetingFollowupInbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listFollowups.mockResolvedValue({ items: [firstItem], nextOffset: null });
    setCompleted.mockResolvedValue({ completedTasks: [firstItem.task] });
  });

  it("does not read follow-ups until the section is first expanded", async () => {
    render(
      <StrictMode>
        <MeetingFollowupInbox onOpenMeeting={vi.fn()} />
      </StrictMode>,
    );

    expect(listFollowups).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Follow-ups/ }));

    await waitFor(() => expect(listFollowups).toHaveBeenCalledWith({
      query: undefined,
      offset: 0,
      limit: 25,
      includeCompleted: false,
    }));
    expect(screen.getByText("Send the deck")).toBeInTheDocument();
    expect(screen.getByText("Owner: Jane")).toBeInTheDocument();
    expect(screen.getByText("Due: Friday")).toBeInTheDocument();
  });

  it("marks only affected follow-ups for source review and opens their exact stored task", async () => {
    const onOpenMeeting = vi.fn();
    const flagged = { ...firstItem, task: "  Send the invoice (Due: Friday)  ", needsReview: true };
    listFollowups.mockResolvedValue({ items: [firstItem, flagged], nextOffset: null });
    render(<MeetingFollowupInbox onOpenMeeting={onOpenMeeting} />);
    fireEvent.click(screen.getByRole("button", { name: /Follow-ups/ }));
    const warning = await screen.findByText("Needs source review");
    expect(screen.getAllByText("Needs source review")).toHaveLength(1);
    const flaggedRow = warning.closest("li")!;
    expect(within(flaggedRow).queryByText(/Owner:/)).not.toBeInTheDocument();
    fireEvent.click(within(flaggedRow).getByRole("button", { name: "Open Send the invoice in Planning review" }));
    expect(onOpenMeeting).toHaveBeenCalledWith(flagged.recordingId, flagged.task);
    const supportedRow = screen.getByText("Send the deck").closest("li")!;
    expect(within(supportedRow).queryByText("Needs source review")).not.toBeInTheDocument();
  });

  it("refreshes the current search and status after a pending completion succeeds", async () => {
    const write = deferred<{ completedTasks: string[] }>();
    const searchResult = { ...firstItem, recordingId: "meeting-search", task: "Search result" };
    const currentResult = { ...firstItem, recordingId: "meeting-current", task: "Current filter result" };
    const refreshedResult = { ...firstItem, recordingId: "meeting-refreshed", task: "Fresh completed result", completed: true };
    setCompleted.mockReturnValueOnce(write.promise);
    listFollowups
      .mockResolvedValueOnce({ items: [firstItem], nextOffset: null })
      .mockResolvedValueOnce({ items: [searchResult], nextOffset: null })
      .mockResolvedValueOnce({ items: [currentResult], nextOffset: null })
      .mockResolvedValueOnce({ items: [refreshedResult], nextOffset: null });
    render(<MeetingFollowupInbox onOpenMeeting={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Follow-ups/ }));
    const checkbox = await screen.findByRole("checkbox", { name: "Mark Send the deck done" });

    fireEvent.click(checkbox);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search follow-ups" }), {
      target: { value: "current" },
    });
    expect(await screen.findByText("Search result")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(await screen.findByText("Current filter result")).toBeInTheDocument();
    const currentCheckbox = screen.getByRole("checkbox", { name: "Mark Current filter result done" });
    expect(currentCheckbox).toBeDisabled();
    fireEvent.click(currentCheckbox);
    expect(setCompleted).toHaveBeenCalledTimes(1);

    await act(async () => {
      write.resolve({ completedTasks: [firstItem.task] });
    });

    await waitFor(() => expect(listFollowups).toHaveBeenLastCalledWith({
      query: "current",
      offset: 0,
      limit: 25,
      includeCompleted: true,
    }));
    expect(await screen.findByText("Fresh completed result")).toBeInTheDocument();
    const refreshedCheckbox = screen.getByRole("checkbox", { name: "Mark Fresh completed result incomplete" });
    expect(refreshedCheckbox).toBeChecked();
    expect(refreshedCheckbox).toBeEnabled();
    expect(screen.queryByText("Send the deck")).not.toBeInTheDocument();
    expect(screen.queryByText("Search result")).not.toBeInTheDocument();
    expect(screen.queryByText("Current filter result")).not.toBeInTheDocument();
    expect(screen.queryByText("Follow-up saved.")).not.toBeInTheDocument();
  });

  it("ignores an older pending page and restores pagination controls after completion refresh", async () => {
    const oldPage = deferred<{ items: (typeof firstItem)[]; nextOffset: number | null }>();
    const refreshedItem = { ...firstItem, recordingId: "meeting-refreshed", task: "Refreshed first page" };
    const refreshedPageItem = { ...firstItem, recordingId: "meeting-refreshed-more", task: "Refreshed next page" };
    listFollowups
      .mockResolvedValueOnce({ items: [firstItem], nextOffset: 25 })
      .mockReturnValueOnce(oldPage.promise)
      .mockResolvedValueOnce({ items: [refreshedItem], nextOffset: 25 })
      .mockResolvedValueOnce({ items: [refreshedPageItem], nextOffset: null });
    render(<MeetingFollowupInbox onOpenMeeting={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Follow-ups/ }));
    const checkbox = await screen.findByRole("checkbox", { name: "Mark Send the deck done" });

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByRole("button", { name: "Loading…" })).toBeDisabled();
    fireEvent.click(checkbox);

    expect(await screen.findByText("Refreshed first page")).toBeInTheDocument();
    const loadMore = screen.getByRole("button", { name: "Load more" });
    expect(loadMore).toBeEnabled();

    await act(async () => {
      oldPage.resolve({
        items: [{ ...firstItem, recordingId: "meeting-stale-page", task: "Stale older page" }],
        nextOffset: null,
      });
    });
    expect(screen.queryByText("Stale older page")).not.toBeInTheDocument();
    expect(loadMore).toBeEnabled();

    fireEvent.click(loadMore);
    expect(await screen.findByText("Refreshed next page")).toBeInTheDocument();
    expect(listFollowups).toHaveBeenLastCalledWith({
      query: undefined,
      offset: 25,
      limit: 25,
      includeCompleted: false,
    });
  });

  it("appends deduplicated pages and opens the selected source with its full stored task", async () => {
    const olderItem = {
      recordingId: "meeting-older",
      meetingTitle: "Older source",
      task: "Book the room (Owner: Pat · Due: Monday)",
      completed: false,
      needsReview: false,
    };
    listFollowups
      .mockResolvedValueOnce({ items: [firstItem], nextOffset: 25 })
      .mockResolvedValueOnce({ items: [firstItem, olderItem], nextOffset: null });
    const onOpenMeeting = vi.fn();
    render(<MeetingFollowupInbox onOpenMeeting={onOpenMeeting} />);
    fireEvent.click(screen.getByRole("button", { name: /Follow-ups/ }));
    await screen.findByText("Send the deck");

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByText("Book the room");

    expect(screen.getAllByText("Send the deck")).toHaveLength(1);
    expect(listFollowups).toHaveBeenLastCalledWith({
      query: undefined,
      offset: 25,
      limit: 25,
      includeCompleted: false,
    });
    fireEvent.click(screen.getByRole("button", { name: "Open Book the room in Older source" }));
    expect(onOpenMeeting).toHaveBeenCalledWith("meeting-older", olderItem.task);
    expect(setCompleted).not.toHaveBeenCalled();
  });

  it("keeps the current filtered row usable and does not claim success when saving fails", async () => {
    const write = deferred<{ completedTasks: string[] }>();
    setCompleted.mockReturnValueOnce(write.promise);
    listFollowups
      .mockResolvedValueOnce({ items: [firstItem], nextOffset: null })
      .mockResolvedValueOnce({ items: [firstItem], nextOffset: null });
    render(<MeetingFollowupInbox onOpenMeeting={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Follow-ups/ }));
    const checkbox = await screen.findByRole("checkbox", { name: "Mark Send the deck done" });

    fireEvent.click(checkbox);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search follow-ups" }), {
      target: { value: "deck" },
    });
    const currentCheckbox = await screen.findByRole("checkbox", { name: "Mark Send the deck done" });
    const currentRow = currentCheckbox.closest("li")!;
    expect(currentCheckbox).toBeDisabled();
    expect(within(currentRow).getByRole("button", { name: "Open Send the deck in Planning review" })).toBeDisabled();

    await act(async () => {
      write.reject(new Error("write failed"));
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't confirm the follow-up was saved");
    expect(currentCheckbox).not.toBeChecked();
    expect(currentCheckbox).toBeEnabled();
    expect(within(currentRow).getByRole("button", { name: "Open Send the deck in Planning review" })).toBeEnabled();
    expect(setCompleted).toHaveBeenCalledWith("meeting-1", firstItem.task, true);
    expect(listFollowups).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Follow-up saved.")).not.toBeInTheDocument();
  });

  it("ignores an older query result that resolves after the current query", async () => {
    const initial = deferred<{ items: (typeof firstItem)[]; nextOffset: number | null }>();
    const current = deferred<{ items: (typeof firstItem)[]; nextOffset: number | null }>();
    listFollowups
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(current.promise);
    render(<MeetingFollowupInbox onOpenMeeting={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Follow-ups/ }));
    await waitFor(() => expect(listFollowups).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByRole("searchbox", { name: "Search follow-ups" }), {
      target: { value: "current" },
    });
    await waitFor(() => expect(listFollowups).toHaveBeenCalledTimes(2));

    await act(async () => {
      current.resolve({
        items: [{ ...firstItem, recordingId: "meeting-current", task: "Current result" }],
        nextOffset: null,
      });
    });
    expect(await screen.findByText("Current result")).toBeInTheDocument();

    await act(async () => {
      initial.resolve({
        items: [{ ...firstItem, recordingId: "meeting-stale", task: "Stale result" }],
        nextOffset: null,
      });
    });
    expect(screen.queryByText("Stale result")).not.toBeInTheDocument();
    expect(screen.getByText("Current result")).toBeInTheDocument();
  });
});
