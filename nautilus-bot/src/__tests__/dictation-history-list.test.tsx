import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DictationHistoryList } from "@/components/views/dictation/dictation-history-list";
import type { Recording } from "@/types";

const recordings: Recording[] = ["first", "second"].map((id) => ({
  id, title: id, projectId: "inbox", duration: 4,
  createdAt: "2026-10-13T10:00:00Z", updatedAt: "2026-10-13T10:00:00Z",
  sourceType: "dictation", audioPath: "", status: "completed",
}));

function setup(onCopy: (recording: Recording) => Promise<boolean>) {
  const props = {
    recordings, onCopy, isLoading: false,
    formatDuration: () => "4s", onOpen: vi.fn(), onDelete: vi.fn(),
  };
  return { props, ...render(<DictationHistoryList {...props} />) };
}

describe("DictationHistoryList copy", () => {
  it("blocks repeated and competing row copies while showing progress", async () => {
    let finish!: (success: boolean) => void;
    const onCopy = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    setup(onCopy);
    const first = screen.getByRole("button", { name: "Copy first" });
    const second = screen.getByRole("button", { name: "Copy second" });
    fireEvent.click(first);
    expect(first).toBeDisabled();
    expect(second).toBeDisabled();
    expect(first).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Copying…")).toBeInTheDocument();
    fireEvent.click(first);
    fireEvent.click(second);
    expect(onCopy).toHaveBeenCalledTimes(1);
    await act(async () => finish(true));
    expect(first).toBeEnabled();
    expect(second).toBeEnabled();
    expect(screen.getByText("Copied")).toBeInTheDocument();
  });

  it.each(["false", "reject"])("permits retry after a %s failure", async (failure) => {
    const onCopy = vi.fn()
      .mockImplementationOnce(() => failure === "reject"
        ? Promise.reject(new Error("clipboard unavailable")) : Promise.resolve(false))
      .mockResolvedValue(true);
    setup(onCopy);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy first" })));
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't copy that dictation.");
    expect(screen.queryByText("Copied")).not.toBeInTheDocument();
    const first = screen.getByRole("button", { name: "Copy first" });
    expect(first).toBeEnabled();
    await act(async () => fireEvent.click(first));
    expect(onCopy).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Copied")).toBeInTheDocument();
  });

  it("ignores success after the copied row disappears", async () => {
    let finish!: (success: boolean) => void;
    const onCopy = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const { props, rerender } = setup(onCopy);
    fireEvent.click(screen.getByRole("button", { name: "Copy first" }));
    rerender(<DictationHistoryList {...props} recordings={[recordings[1]]} />);
    await act(async () => finish(true));
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(screen.getByRole("button", { name: "Copy second" })).toBeEnabled();
  });

  it("does not schedule a confirmation timer after unmount", async () => {
    let finish!: (success: boolean) => void;
    const onCopy = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    const { unmount } = setup(onCopy);
    fireEvent.click(screen.getByRole("button", { name: "Copy first" }));
    unmount();
    const timer = vi.spyOn(window, "setTimeout");
    try {
      await act(async () => finish(true));
      expect(timer).not.toHaveBeenCalled();
    } finally {
      timer.mockRestore();
    }
  });
});

describe("DictationHistoryList empty state", () => {
  const props = {
    recordings: [], onCopy: vi.fn(), isLoading: false,
    formatDuration: () => "4s", onOpen: vi.fn(), onDelete: vi.fn(),
  };

  it("names the shortcut that starts a first dictation once it is known", () => {
    const { rerender } = render(<DictationHistoryList {...props} />);
    expect(screen.getByText(/^No dictations yet\. If auto-delete/)).toBeInTheDocument();
    rerender(<DictationHistoryList {...props} shortcutLabel="⌘ ⇧ Space" />);
    expect(
      screen.getByText(/^No dictations yet\. Press ⌘ ⇧ Space anywhere to start one\./),
    ).toBeInTheDocument();
  });
});

it("pages a 10,000-item dictation history and updates rows after deletion", () => {
  const history = Array.from({ length: 10_000 }, (_, index) => ({
    ...recordings[0], id: String(index), title: `Dictation ${index} [🙂]`,
  }));
  const props = {
    recordings: history, onCopy: vi.fn(), isLoading: false,
    formatDuration: () => "4s", onOpen: vi.fn(), onDelete: vi.fn(),
  };
  const { rerender } = render(<DictationHistoryList {...props} />);
  expect(screen.getAllByRole("button", { name: /^Open saved dictation:/ })).toHaveLength(25);
  fireEvent.click(screen.getByRole("button", { name: "Show more" }));
  expect(screen.getAllByRole("button", { name: /^Open saved dictation:/ })).toHaveLength(50);
  rerender(<DictationHistoryList {...props} recordings={history.slice(1)} />);
  expect(screen.queryByRole("button", { name: "Open saved dictation: Dictation 0 [🙂]" })).not.toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: /^Open saved dictation:/ })).toHaveLength(50);
});
