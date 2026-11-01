import { createRef } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EditableTitle, type EditableTitleHandle } from "@/components/views/meetings/editable-title";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("EditableTitle", () => {
  it("keeps a dirty draft when the stored value changes", () => {
    const onCommit = vi.fn();
    const view = render(<EditableTitle value="Weekly sync" onCommit={onCommit} />);
    const title = screen.getByLabelText("Meeting title");

    fireEvent.change(title, { target: { value: "My unsaved title" } });
    view.rerender(<EditableTitle value="Auto-generated title" onCommit={onCommit} />);

    expect(title).toHaveValue("My unsaved title");
  });

  it("keeps the exact draft and reports a retryable error when a commit is rejected", async () => {
    const save = deferred<void>();
    const onCommit = vi.fn(() => save.promise);
    const view = render(<EditableTitle value="Weekly sync" onCommit={onCommit} />);
    const title = screen.getByLabelText("Meeting title");

    fireEvent.change(title, { target: { value: "  Rejected title  " } });
    fireEvent.blur(title);
    view.rerender(<EditableTitle value="Title from storage" onCommit={onCommit} />);

    await act(async () => save.reject(new Error("save failed")));

    await waitFor(() => expect(title).toHaveValue("  Rejected title  "));
    expect(title).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not save the title. Your edit is still here. Press Enter to retry."
    );

    view.rerender(<EditableTitle value="A later stored title" onCommit={onCommit} />);
    expect(title).toHaveValue("  Rejected title  ");
  });

  it("keeps a newer draft when an older commit is rejected", async () => {
    const save = deferred<void>();
    const onCommit = vi.fn(() => save.promise);
    render(<EditableTitle value="Weekly sync" onCommit={onCommit} />);
    const title = screen.getByLabelText("Meeting title");

    fireEvent.change(title, { target: { value: "Rejected title" } });
    fireEvent.blur(title);
    fireEvent.change(title, { target: { value: "Newer draft" } });

    await act(async () => save.reject(new Error("save failed")));

    expect(title).toHaveValue("Newer draft");
    expect(title).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("clears a displayed failure when the user edits again", async () => {
    const onCommit = vi.fn().mockRejectedValue(new Error("save failed"));
    render(<EditableTitle value="Weekly sync" onCommit={onCommit} />);
    const title = screen.getByLabelText("Meeting title");

    fireEvent.change(title, { target: { value: "Rejected title" } });
    fireEvent.blur(title);
    await waitFor(() => expect(title).toHaveAttribute("aria-invalid", "true"));

    fireEvent.change(title, { target: { value: "Corrected title" } });

    expect(title).toHaveValue("Corrected title");
    expect(title).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("dispatches one commit for duplicate blurs of the same pending title", async () => {
    const save = deferred<void>();
    const onCommit = vi.fn(() => save.promise);
    render(<EditableTitle value="Weekly sync" onCommit={onCommit} />);
    const title = screen.getByLabelText("Meeting title");

    fireEvent.change(title, { target: { value: "Pricing sync" } });
    fireEvent.blur(title);
    fireEvent.blur(title);

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith("Pricing sync");
    await act(async () => save.resolve());
  });

  it("keeps the latest draft through overlapping A to B to A saves", async () => {
    const saves = [deferred<void>(), deferred<void>(), deferred<void>()];
    let saveIndex = 0;
    const onCommit = vi.fn(() => saves[saveIndex++].promise);
    const view = render(<EditableTitle value="Weekly sync" onCommit={onCommit} />);
    const title = screen.getByLabelText("Meeting title");

    fireEvent.change(title, { target: { value: "Planning" } });
    fireEvent.blur(title);
    fireEvent.change(title, { target: { value: "Budget" } });
    fireEvent.blur(title);
    fireEvent.change(title, { target: { value: "Planning" } });
    fireEvent.blur(title);

    expect(onCommit).toHaveBeenCalledTimes(3);
    expect(onCommit).toHaveBeenNthCalledWith(1, "Planning");
    expect(onCommit).toHaveBeenNthCalledWith(2, "Budget");
    expect(onCommit).toHaveBeenNthCalledWith(3, "Planning");

    await act(async () => saves[0].resolve());
    view.rerender(<EditableTitle value="Planning" onCommit={onCommit} />);
    expect(title).toHaveValue("Planning");

    await act(async () => saves[1].resolve());
    view.rerender(<EditableTitle value="Budget" onCommit={onCommit} />);
    expect(title).toHaveValue("Planning");

    await act(async () => saves[2].resolve());
    view.rerender(<EditableTitle value="Planning" onCommit={onCommit} />);
    expect(title).toHaveValue("Planning");
  });

  it("restores the stored value on Escape without committing", () => {
    const onCommit = vi.fn();
    render(<EditableTitle value="Weekly sync" onCommit={onCommit} />);
    const title = screen.getByLabelText("Meeting title");

    title.focus();
    fireEvent.change(title, { target: { value: "Board review" } });
    fireEvent.keyDown(title, { key: "Escape" });

    expect(title).toHaveValue("Weekly sync");
    expect(onCommit).not.toHaveBeenCalled();
  });
  it("commits a focused title through the navigation handle", async () => {
    const ref = createRef<EditableTitleHandle>();
    const onCommit = vi.fn().mockResolvedValue(undefined);
    render(<EditableTitle ref={ref} value="Weekly sync" onCommit={onCommit} />);
    fireEvent.change(screen.getByLabelText("Meeting title"), { target: { value: "Pricing sync" } });
    let saved: boolean | undefined;
    await act(async () => { saved = await ref.current!.commit(); });
    expect(saved).toBe(true);
    expect(onCommit).toHaveBeenCalledWith("Pricing sync");
  });

  it("reports a pending save failure to the navigation handle", async () => {
    const save = deferred<void>();
    const ref = createRef<EditableTitleHandle>();
    const onCommit = vi.fn(() => save.promise);
    render(<EditableTitle ref={ref} value="Weekly sync" onCommit={onCommit} />);
    const title = screen.getByLabelText("Meeting title");
    fireEvent.change(title, { target: { value: "Pricing sync" } });
    fireEvent.blur(title);
    const leaving = ref.current!.commit();
    await act(async () => save.reject(new Error("save failed")));
    expect(await leaving).toBe(false);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(title).toHaveValue("Pricing sync");
    expect(title).toHaveAttribute("aria-invalid", "true");
  });

  it("retries the current failed title through the navigation handle", async () => {
    const ref = createRef<EditableTitleHandle>();
    const onCommit = vi.fn()
      .mockRejectedValueOnce(new Error("save failed"))
      .mockResolvedValueOnce(undefined);
    render(<EditableTitle ref={ref} value="Weekly sync" onCommit={onCommit} />);
    const title = screen.getByLabelText("Meeting title");
    fireEvent.change(title, { target: { value: "  Pricing sync  " } });

    let firstResult: boolean | undefined;
    await act(async () => { firstResult = await ref.current!.commit(); });
    expect(firstResult).toBe(false);
    expect(title).toHaveValue("  Pricing sync  ");

    let retryResult: boolean | undefined;
    await act(async () => { retryResult = await ref.current!.commit(); });
    expect(retryResult).toBe(true);
    expect(onCommit).toHaveBeenNthCalledWith(1, "Pricing sync");
    expect(onCommit).toHaveBeenNthCalledWith(2, "Pricing sync");
    expect(title).toHaveValue("Pricing sync");
    expect(title).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("abandons a failed draft on Escape and restores the latest stored title", async () => {
    const ref = createRef<EditableTitleHandle>();
    const onCommit = vi.fn().mockRejectedValue(new Error("save failed"));
    const view = render(<EditableTitle ref={ref} value="Weekly sync" onCommit={onCommit} />);
    const title = screen.getByLabelText("Meeting title");
    fireEvent.change(title, { target: { value: "Rejected title" } });

    await act(async () => { await ref.current!.commit(); });
    view.rerender(<EditableTitle ref={ref} value="Title from storage" onCommit={onCommit} />);
    expect(title).toHaveValue("Rejected title");

    fireEvent.keyDown(title, { key: "Escape" });

    expect(title).toHaveValue("Title from storage");
    expect(title).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onCommit).toHaveBeenCalledTimes(1);
    await expect(ref.current!.commit()).resolves.toBe(true);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

});
