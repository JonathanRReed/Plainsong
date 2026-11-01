import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActionItemList } from "@/components/views/meetings/action-item-list";

const clipboardWriteText = vi.fn();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("ActionItemList task copy", () => {
  beforeEach(() => {
    clipboardWriteText.mockReset();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWriteText },
    });
  });

  it("copies the canonical stored task and disables every copy control while pending", async () => {
    const pending = deferred<void>();
    clipboardWriteText.mockReturnValueOnce(pending.promise);
    const stored = "  Send  the deck (Owner: Jane · Due: Friday)  ";
    render(
      <ActionItemList
        sourceKey="meeting-a"
        items={[stored, "Confirm launch owner"]}
      />,
    );
    const row = screen.getByText((_, element) =>
      element?.tagName === "SPAN" && element.textContent === "Send  the deck",
    ).closest("li") as HTMLElement;

    fireEvent.click(within(row).getByRole("button", { name: "Copy task: Send the deck" }));

    expect(clipboardWriteText).toHaveBeenCalledWith(
      "Send  the deck (Owner: Jane · Due: Friday)",
    );
    const copyButtons = screen.getAllByRole("button", { name: /^Copy task:/ });
    expect(copyButtons).toHaveLength(2);
    expect(copyButtons.every((button) => button.hasAttribute("disabled"))).toBe(true);
    expect(within(row).getByRole("button", { name: "Copy task: Send the deck" })).toHaveTextContent("Copying…");
    expect(screen.queryByText("Task copied.")).not.toBeInTheDocument();

    await act(async () => {
      pending.resolve(undefined);
      await pending.promise;
    });
    expect(await screen.findByText("Task copied.")).toBeInTheDocument();
  });

  it("keeps the task visible after copy failure and allows retry", async () => {
    clipboardWriteText
      .mockRejectedValueOnce(new Error("clipboard denied"))
      .mockResolvedValueOnce(undefined);
    const stored = "Send the deck (Owner: Jane · Due: Friday)";
    render(<ActionItemList sourceKey="meeting-a" items={[stored]} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy task: Send the deck" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not copy this task. Select its text and copy it manually.",
    );
    expect(screen.getByText("Send the deck")).toBeInTheDocument();
    expect(screen.getByText("Owner: Jane")).toBeInTheDocument();
    expect(screen.getByText("Due: Friday")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copy task: Send the deck" }));
    await waitFor(() => expect(clipboardWriteText).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Task copied.")).toBeInTheDocument();
  });

  it("suppresses late feedback after the task list changes", async () => {
    const pending = deferred<void>();
    clipboardWriteText.mockReturnValueOnce(pending.promise);
    const view = render(
      <ActionItemList sourceKey="meeting-a" items={["Send the deck"]} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy task: Send the deck" }));

    view.rerender(
      <ActionItemList sourceKey="meeting-a" items={["Confirm launch owner"]} />,
    );
    await act(async () => {
      pending.resolve(undefined);
      await pending.promise;
    });

    expect(screen.queryByText("Task copied.")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Confirm launch owner")).toBeInTheDocument();
  });

  it("suppresses late feedback when identical task text belongs to another source", async () => {
    const pending = deferred<void>();
    clipboardWriteText.mockReturnValueOnce(pending.promise);
    const view = render(
      <ActionItemList sourceKey="meeting-a" items={["Send the deck"]} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy task: Send the deck" }));

    view.rerender(
      <ActionItemList sourceKey="meeting-b" items={["Send the deck"]} />,
    );
    await act(async () => {
      pending.resolve(undefined);
      await pending.promise;
    });

    expect(screen.queryByText("Task copied.")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("announces success only on the copied row when task text is duplicated", async () => {
    clipboardWriteText.mockResolvedValueOnce(undefined);
    const { container } = render(
      <ActionItemList
        sourceKey="meeting-a"
        items={["Send the deck", "Send the deck"]}
      />,
    );
    const rows = Array.from(container.querySelectorAll("li"));

    fireEvent.click(
      within(rows[1] as HTMLElement).getByRole("button", {
        name: "Copy task: Send the deck",
      }),
    );

    expect(
      await within(rows[1] as HTMLElement).findByText("Task copied."),
    ).toBeInTheDocument();
    expect(
      within(rows[0] as HTMLElement).queryByText("Task copied."),
    ).not.toBeInTheDocument();
    expect(clipboardWriteText).toHaveBeenCalledOnce();
    expect(clipboardWriteText).toHaveBeenCalledWith("Send the deck");
  });
});

describe("ActionItemList completion", () => {
  it("toggles the exact stored task while keeping owner and date visible", async () => {
    const user = userEvent.setup();
    const onCompletionChange = vi.fn();
    const stored = "Send the deck (Owner: Jane · Due: Friday)";

    render(
      <ActionItemList
        items={[stored]}
        completedTasks={new Set()}
        onCompletionChange={onCompletionChange}
      />,
    );

    const checkbox = screen.getByRole("checkbox", { name: "Mark Send the deck done" });
    expect(checkbox).not.toBeChecked();
    expect(screen.getByText("Owner: Jane")).toBeInTheDocument();
    expect(screen.getByText("Due: Friday")).toBeInTheDocument();

    await user.click(checkbox);

    expect(onCompletionChange).toHaveBeenCalledWith(stored, true);
    expect(screen.getByText("Send the deck")).not.toHaveClass("line-through");
  });

  it("shows saved completion and respects the disabled state", () => {
    render(
      <ActionItemList
        items={["Send the deck (Owner: Jane · Due: Friday)"]}
        completedTasks={new Set(["Send the deck (Owner: Jane · Due: Friday)"])}
        disabled
        onCompletionChange={vi.fn()}
      />,
    );

    const checkbox = screen.getByRole("checkbox", { name: "Mark Send the deck incomplete" });
    expect(checkbox).toBeChecked();
    expect(checkbox).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("Send the deck")).toHaveClass("line-through");
  });

  it.each([false, true])("keeps completion focused and blocks activation while saving, initially completed: %s", async (completed) => {
    const user = userEvent.setup();
    const stored = "Send the deck (Owner: Jane · Due: Friday)";
    const onCompletionChange = vi.fn();
    const props = { items: [stored], completedTasks: new Set(completed ? [stored] : []), onCompletionChange };
    const view = render(<ActionItemList {...props} />);
    const checkbox = screen.getByRole("checkbox");
    checkbox.focus();

    view.rerender(<ActionItemList {...props} disabled />);

    expect(checkbox).not.toBeDisabled();
    expect(checkbox).toHaveAttribute("aria-disabled", "true");
    expect(checkbox).toHaveFocus();
    await user.keyboard("[Space][Space]");
    await user.click(checkbox);
    expect(onCompletionChange).not.toHaveBeenCalled();
    expect(checkbox).toHaveProperty("checked", completed);

    view.rerender(<ActionItemList {...props} />);

    expect(screen.getByRole("checkbox")).toBe(checkbox);
    expect(checkbox).toHaveFocus();
    expect(checkbox).not.toHaveAttribute("aria-disabled", "true");
    await user.keyboard("[Space]");
    expect(onCompletionChange).toHaveBeenCalledExactlyOnceWith(stored, !completed);
  });
});

describe("ActionItemList focus", () => {
  it("focuses and centers only the exact stored item", () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const exact = "Send the deck (Owner: Jane · Due: Friday)";

    const { container } = render(
      <ActionItemList
        items={[
          "Send the deck (Owner: Alex · Due: Monday)",
          exact,
        ]}
        focusedTask={`  ${exact}  `}
      />,
    );

    const rows = container.querySelectorAll("li");
    expect(rows[0]).not.toHaveAttribute("data-focused");
    expect(rows[0]).not.toHaveAttribute("tabindex");
    expect(rows[1]).toHaveAttribute("aria-current", "true");
    expect(rows[1]).toHaveAttribute("data-focused", "true");
    expect(rows[1]).toHaveAttribute("tabindex", "-1");
    expect(rows[1]).toHaveFocus();
    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    expect(within(rows[1] as HTMLElement).getByText("Owner: Jane")).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText("Due: Friday")).toBeInTheDocument();
  });

  it("does nothing when the exact stored item is missing", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const onCompletionChange = vi.fn();
    const user = userEvent.setup();

    const { container } = render(
      <ActionItemList
        items={["Send the deck (Owner: Alex · Due: Monday)"]}
        focusedTask="Send the deck (Owner: Jane · Due: Friday)"
        onCompletionChange={onCompletionChange}
      />,
    );

    expect(container.querySelector("li")).not.toHaveAttribute("data-focused");
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(document.body).toHaveFocus();
    expect(onCompletionChange).not.toHaveBeenCalled();

    await user.click(screen.getByRole("checkbox", { name: "Mark Send the deck done" }));
    expect(onCompletionChange).toHaveBeenCalledWith(
      "Send the deck (Owner: Alex · Due: Monday)",
      true,
    );
  });

  it("does not steal focus when only completion state changes", () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const stored = "Send the deck (Owner: Jane · Due: Friday)";
    const items = [stored];
    const { container, rerender } = render(
      <ActionItemList items={items} focusedTask={stored} completedTasks={new Set()} />,
    );
    const row = container.querySelector("li") as HTMLLIElement;
    const focus = vi.spyOn(row, "focus");
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();

    rerender(
      <ActionItemList
        items={items}
        focusedTask={stored}
        completedTasks={new Set([stored])}
      />,
    );

    expect(outside).toHaveFocus();
    expect(focus).not.toHaveBeenCalled();
    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(screen.getByText("Send the deck")).toHaveClass("line-through");
    outside.remove();
  });
});


describe("ActionItemList row editing", () => {
  it("keeps a failed draft and retries the original source line", async () => {
    const original = "Send deck (Owner: Jane · Due: after approval)";
    const onEdit = vi.fn().mockRejectedValueOnce(new Error("Tasks changed. Your draft was kept.")).mockResolvedValueOnce(undefined);
    render(<ActionItemList sourceKey="a" items={[original]} onEdit={onEdit} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit task: Send deck" }));
    expect(screen.getByLabelText("Due date")).toHaveValue("after approval");
    fireEvent.change(screen.getByLabelText("Owner"), { target: { value: "Sam" } });
    fireEvent.click(screen.getByRole("button", { name: "Save task" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("draft was kept");
    expect(screen.getByLabelText("Owner")).toHaveValue("Sam");
    fireEvent.click(screen.getByRole("button", { name: "Save task" }));
    await waitFor(() => expect(screen.queryByRole("form", { name: "Edit action item" })).not.toBeInTheDocument());
    expect(onEdit).toHaveBeenLastCalledWith(original, "Send deck (Owner: Sam · Due: after approval)");
  });

  it("suppresses duplicate saves and discards the editor when changing meetings", async () => {
    const pending = deferred<void>();
    const onEdit = vi.fn().mockReturnValue(pending.promise);
    const view = render(<ActionItemList sourceKey="a" items={["First"]} onEdit={onEdit} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit task: First" }));
    const form = screen.getByRole("form", { name: "Edit action item" });
    fireEvent.submit(form); fireEvent.submit(form);
    expect(onEdit).toHaveBeenCalledTimes(1);
    view.rerender(<ActionItemList sourceKey="b" items={["Second"]} onEdit={onEdit} />);
    await act(async () => { pending.resolve(undefined); await pending.promise; });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Task")).not.toBeInTheDocument();
  });

  it("keeps the draft visible if the original task disappears", async () => {
    const onEdit = vi.fn().mockRejectedValue(new Error("Tasks changed"));
    const view = render(<ActionItemList sourceKey="a" items={["First"]} onEdit={onEdit} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit task: First" }));
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "My draft" } });
    view.rerender(<ActionItemList sourceKey="a" items={["Other"]} onEdit={onEdit} />);
    expect(screen.getByLabelText("Task")).toHaveValue("My draft");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onEdit).not.toHaveBeenCalled();
  });
});


describe("ActionItemList add and delete", () => {
  it("keeps a failed new task draft and retries its owner and due date", async () => {
    const onAdd = vi.fn().mockRejectedValueOnce(new Error("Save failed")).mockResolvedValueOnce(undefined);
    render(<ActionItemList sourceKey="a" items={[]} onAdd={onAdd} />);
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "Send deck" } });
    fireEvent.change(screen.getByLabelText("Owner"), { target: { value: "Sam" } });
    fireEvent.change(screen.getByLabelText("Due date"), { target: { value: "Friday" } });
    fireEvent.click(screen.getByRole("button", { name: "Save task" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Save failed");
    expect(screen.getByLabelText("Task")).toHaveValue("Send deck");
    fireEvent.click(screen.getByRole("button", { name: "Save task" }));
    await waitFor(() => expect(screen.queryByLabelText("Task")).not.toBeInTheDocument());
    expect(onAdd).toHaveBeenLastCalledWith("Send deck (Owner: Sam · Due: Friday)");
  });

  it("requires confirmation, keeps a failed deletion, and prevents duplicate requests", async () => {
    const pending = deferred<void>();
    const onDelete = vi.fn().mockRejectedValueOnce(new Error("Tasks changed")).mockReturnValueOnce(pending.promise);
    render(<ActionItemList sourceKey="a" items={["Send deck"]} onDelete={onDelete} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete task: Send deck" }));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete task" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Tasks changed");
    expect(screen.getByText("Send deck")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete task" }));
    fireEvent.click(screen.getByRole("button", { name: "Deleting…" }));
    expect(onDelete).toHaveBeenCalledTimes(2);
    await act(async () => pending.resolve(undefined));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Confirm delete task" })).not.toBeInTheDocument());
    expect(onDelete).toHaveBeenLastCalledWith("Send deck", 0);
  });
});


it("deletes the second identical occurrence using its full source index", async () => {
  const onDelete = vi.fn().mockResolvedValue(undefined);
  render(<ActionItemList items={["Same", "Same"]} sourceItems={["Hidden", "Same", "Same"]} onDelete={onDelete} />);
  fireEvent.click(screen.getAllByRole("button", { name: "Delete task: Same" })[1]);
  fireEvent.click(screen.getByRole("button", { name: "Confirm delete task" }));
  await waitFor(() => expect(onDelete).toHaveBeenCalledWith("Same", 2));
});


describe("ActionItemList keyboard focus", () => {
  it("returns to the edit or add control after cancelling a draft", async () => {
    const user = userEvent.setup();
    render(<ActionItemList sourceKey="a" items={["Send deck"]} onEdit={vi.fn()} onAdd={vi.fn()} />);
    const edit = screen.getByRole("button", { name: "Edit task: Send deck" });
    await user.click(edit);
    expect(screen.getByLabelText("Task")).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(edit).toHaveFocus();
    const add = screen.getByRole("button", { name: "Add task" });
    await user.click(add);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(add).toHaveFocus();
  });

  it("returns to a surviving task control after saving a replacement", async () => {
    const user = userEvent.setup();
    const pending = deferred<void>();
    const onEdit = vi.fn().mockReturnValue(pending.promise);
    const view = render(<ActionItemList sourceKey="a" items={["Send deck"]} onEdit={onEdit} />);
    await user.click(screen.getByRole("button", { name: "Edit task: Send deck" }));
    await user.clear(screen.getByLabelText("Task"));
    await user.type(screen.getByLabelText("Task"), "Send updated deck");
    await user.click(screen.getByRole("button", { name: "Save task" }));
    view.rerender(<ActionItemList sourceKey="a" items={["Send updated deck"]} onEdit={onEdit} />);
    await act(async () => { pending.resolve(undefined); await pending.promise; });
    expect(screen.getByRole("button", { name: "Edit task: Send updated deck" })).toHaveFocus();
  });

  it("focuses Cancel in deletion confirmation and restores its trigger", async () => {
    const user = userEvent.setup();
    render(<ActionItemList sourceKey="a" items={["Send deck"]} onDelete={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Delete task: Send deck" });
    await user.click(trigger);
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(trigger).toHaveFocus();
  });

  it("returns focus to Add task after deleting the last task", async () => {
    const user = userEvent.setup();
    const pending = deferred<void>();
    const onDelete = vi.fn().mockReturnValue(pending.promise);
    const view = render(<ActionItemList sourceKey="a" items={["Send deck"]} onDelete={onDelete} onAdd={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Delete task: Send deck" }));
    screen.getByRole("button", { name: "Confirm delete task" }).focus();
    await user.keyboard("{Enter}");
    view.rerender(<ActionItemList sourceKey="a" items={[]} onDelete={onDelete} onAdd={vi.fn()} />);
    await act(async () => { pending.resolve(undefined); await pending.promise; });
    expect(screen.getByRole("button", { name: "Add task" })).toHaveFocus();
  });

  it("does not move focus into a newer meeting when an old deletion finishes", async () => {
    const user = userEvent.setup();
    const pending = deferred<void>();
    const onDelete = vi.fn().mockReturnValue(pending.promise);
    const view = render(<ActionItemList sourceKey="a" items={["Send deck"]} onDelete={onDelete} onAdd={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Delete task: Send deck" }));
    screen.getByRole("button", { name: "Confirm delete task" }).focus();
    await user.keyboard("{Enter}");
    view.rerender(<ActionItemList sourceKey="b" items={["New task"]} onDelete={onDelete} onAdd={vi.fn()} />);
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    await act(async () => { pending.resolve(undefined); await pending.promise; });
    expect(outside).toHaveFocus();
    outside.remove();
  });
});

describe("ActionItemList evidence", () => {
  it("shows the quoted source sentence under its own task only", () => {
    const items = [
      "send the export report by Tuesday after I rerun the 3 failing checks. (Owner: Leo · Due: Tuesday)",
      "Book the room",
    ];
    render(
      <ActionItemList
        sourceKey="meeting-a"
        items={[items[1], items[0]]}
        sourceItems={items}
        evidence={["I'll send the export report by Tuesday after I rerun the 3 failing checks.", null]}
      />,
    );
    const rows = screen.getAllByRole("listitem");
    expect(within(rows[1]).getByText("“I'll send the export report by Tuesday after I rerun the 3 failing checks.”")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Said in the meeting:", { exact: false })).toHaveClass("sr-only");
    expect(within(rows[0]).queryByText(/Said in the meeting/)).toBeNull();
  });

  it("shows a quoted item as its attributed sentences, without repeating them", () => {
    const task = "I'll repair the scull by the 21st. Not the 21st, the 28th.";
    const items = [`${task} (Owner: Hector · Due: the 28th)`];
    render(
      <ActionItemList
        sourceKey="meeting-a"
        items={items}
        evidence={["Hector (0:40): “I'll repair the scull by the 21st.”\nImogen (0:50): “Not the 21st, the 28th.”"]}
      />,
    );
    const row = screen.getByRole("listitem");
    expect(within(row).getByText("“I'll repair the scull by the 21st.”")).toBeInTheDocument();
    expect(within(row).getByText("“Not the 21st, the 28th.”")).toBeInTheDocument();
    expect(within(row).getByText("Imogen")).toBeInTheDocument();
    expect(within(row).getByText("0:50")).toBeInTheDocument();
    expect(within(row).getByText("Owner: Hector")).toBeInTheDocument();
    expect(within(row).getByText("Due: the 28th")).toBeInTheDocument();
    expect(within(row).queryByText(task)).toBeNull();
    expect(within(row).getByText("Said in the meeting:", { exact: false })).toHaveClass("sr-only");
    expect(within(row).getByRole("button", { name: `Copy task: ${task}` })).toBeInTheDocument();
  });

  it("marks an unclear quoted item, and not once it is edited", () => {
    const task = "Leo will send the invoice by Monday. Nina will send the invoice by Monday.";
    const view = render(
      <ActionItemList
        sourceKey="meeting-a"
        items={[`${task} (Due: Monday)`, "Book the room"]}
        evidence={["Ana (0:00): “Leo will send the invoice by Monday.”\nAna (0:20): “Nina will send the invoice by Monday.”", null]}
        unclear={[true, false]}
      />,
    );
    const rows = screen.getAllByRole("listitem");
    expect(within(rows[0]).getByText("Unclear in the meeting")).toBeInTheDocument();
    expect(within(rows[0]).queryByText(/Owner:/)).toBeNull();
    expect(within(rows[1]).queryByText("Unclear in the meeting")).toBeNull();
    view.rerender(
      <ActionItemList
        sourceKey="meeting-a"
        items={["Send the invoice by Monday (Owner: Nina)"]}
        evidence={["Ana (0:20): “Nina will send the invoice by Monday.”"]}
        unclear={[true]}
      />,
    );
    expect(screen.queryByText("Unclear in the meeting")).toBeNull();
  });

  it("shows an edited quoted item as plain text", () => {
    render(
      <ActionItemList
        sourceKey="meeting-a"
        items={["Repair the scull by the 28th (Owner: Hector)"]}
        evidence={["Hector (0:40): “I'll repair the scull by the 28th.”"]}
      />,
    );
    const row = screen.getByRole("listitem");
    expect(within(row).getByText("Repair the scull by the 28th")).toBeInTheDocument();
    expect(within(row).getByText(/I'll repair the scull by the 28th/)).toBeInTheDocument();
  });
});
