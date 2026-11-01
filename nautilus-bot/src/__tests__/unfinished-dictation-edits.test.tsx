import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { UnfinishedDictationEdits } from "@/components/views/dictation/unfinished-dictation-edits";
import type { LocalDictationDraft } from "@/hooks/use-dictation-drafts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function draft(overrides: Partial<LocalDictationDraft> = {}): LocalDictationDraft {
  return {
    recordingId: "draft-1",
    title: "Recovered draft",
    text: "Recovered words",
    expectedSavedText: null,
    status: "saved",
    ...overrides,
  };
}

function renderEdits(
  drafts: LocalDictationDraft[] = [draft()],
  overrides: Partial<React.ComponentProps<typeof UnfinishedDictationEdits>> = {},
) {
  const props: React.ComponentProps<typeof UnfinishedDictationEdits> = {
    drafts,
    loading: false,
    error: null,
    onResume: vi.fn(),
    onDiscard: vi.fn(),
    ...overrides,
  };
  return render(<UnfinishedDictationEdits {...props} />);
}

describe("UnfinishedDictationEdits draft recovery", () => {
  const writeText = vi.fn<(_: string) => Promise<void>>();

  beforeEach(() => {
    writeText.mockReset();
    writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  it("shows the exact full draft as text without truncating or interpreting HTML", async () => {
    const fullText = `  First line with "quotes".\n<script>window.bad = true</script>\n${"Long recovery text ".repeat(10)}\nFinal line.  `;
    renderEdits([draft({ text: fullText })]);

    const disclosure = screen.getByText("View full draft").closest("details")!;
    expect(disclosure.querySelector("pre")).toBeNull();
    fireEvent.click(within(disclosure).getByText("View full draft"));
    const fullDraft = await within(disclosure).findByText((_, element) =>
      element?.tagName === "PRE" && element.textContent === fullText,
    );

    expect(fullDraft).toHaveClass("whitespace-pre-wrap", "break-words");
    expect(disclosure.querySelector("script")).toBeNull();
    expect(fullDraft.textContent).toBe(fullText);
  });

  it("copies the exact snapshot and waits for clipboard acknowledgement before success", async () => {
    const pending = deferred<void>();
    const exactText = "  line one\n\"quoted\" <b>literal</b>\nline three  \n";
    const onCopyStart = vi.fn();
    writeText.mockReturnValueOnce(pending.promise);
    renderEdits([draft({ text: exactText })], { onCopyStart });

    expect(document.querySelector("pre")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy draft" }));

    expect(onCopyStart).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(exactText);
    expect(screen.getByRole("button", { name: "Copy draft" })).toBeDisabled();
    expect(screen.queryByText("Draft copied.")).not.toBeInTheDocument();

    await act(async () => pending.resolve());

    expect(screen.getByRole("status")).toHaveTextContent("Draft copied.");
    expect(screen.getByRole("button", { name: "Copy draft" })).toBeEnabled();
  });

  it("allows only one clipboard write at a time across all rows", () => {
    const pending = deferred<void>();
    writeText.mockReturnValueOnce(pending.promise);
    renderEdits([
      draft(),
      draft({ recordingId: "draft-2", title: "Second", text: "Second draft" }),
    ]);

    const buttons = screen.getAllByRole("button", { name: "Copy draft" });
    fireEvent.click(buttons[0]);
    fireEvent.click(buttons[1]);

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(buttons[0]).toBeDisabled();
    expect(buttons[1]).toBeDisabled();
  });

  it("offers the full-draft disclosure as the manual fallback after a rejected write", async () => {
    writeText.mockRejectedValueOnce(new Error("clipboard unavailable"));
    renderEdits();

    fireEvent.click(screen.getByRole("button", { name: "Copy draft" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't copy the draft. Open View full draft and copy the text manually.",
    );
  });

  it("does not offer or attempt clipboard writes for a whitespace-only draft", () => {
    renderEdits([draft({ text: " \n\t  " })]);

    const button = screen.getByRole("button", { name: "Copy draft" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("ignores a late clipboard acknowledgement after the row text changes", async () => {
    const pending = deferred<void>();
    writeText.mockReturnValueOnce(pending.promise);
    const first = draft({ text: "First snapshot" });
    const view = renderEdits([first]);

    fireEvent.click(screen.getByRole("button", { name: "Copy draft" }));
    view.rerender(
      <UnfinishedDictationEdits
        drafts={[{ ...first, text: "Updated snapshot" }]}
        loading={false}
        error={null}
        onResume={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );
    await act(async () => pending.resolve());

    expect(screen.queryByText("Draft copied.")).not.toBeInTheDocument();
  });

  it("ignores a late clipboard acknowledgement after discard", async () => {
    const pending = deferred<void>();
    const onDiscard = vi.fn();
    writeText.mockReturnValueOnce(pending.promise);
    renderEdits([draft()], { onDiscard });

    fireEvent.click(screen.getByRole("button", { name: "Copy draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard unfinished edit" }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve());

    expect(screen.queryByText("Draft copied.")).not.toBeInTheDocument();
  });

  it("requires confirmation, shows the exact draft and focuses Keep draft", async () => {
    const onDiscard = vi.fn();
    const selected = draft({ text: "  My words\n<script>literal</script>  " });
    renderEdits([selected], { onDiscard });
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onDiscard).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    expect(dialog.querySelector("pre")?.textContent).toBe(selected.text);
    expect(dialog.querySelector("script")).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "Keep draft" })).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "Keep draft" }));
    expect(onDiscard).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard unfinished edit" }));
    expect(onDiscard).toHaveBeenCalledExactlyOnceWith(selected);
  });

  it("blocks discarding changed words until the user reviews them again", () => {
    const onDiscard = vi.fn();
    const view = renderEdits([draft()], { onDiscard });
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    view.rerender(<UnfinishedDictationEdits drafts={[draft({ text: "Newer words" })]} loading={false} error={null} onResume={vi.fn()} onDiscard={onDiscard} />);
    expect(screen.getByRole("alert")).toHaveTextContent("This draft changed");
    expect(screen.getByRole("button", { name: "Discard unfinished edit" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Discard unfinished edit" }));
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it("does not publish a late clipboard result after unmount", async () => {
    const pending = deferred<void>();
    writeText.mockReturnValueOnce(pending.promise);
    const view = renderEdits();

    fireEvent.click(screen.getByRole("button", { name: "Copy draft" }));
    view.unmount();
    await act(async () => pending.resolve());

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
  });
});
