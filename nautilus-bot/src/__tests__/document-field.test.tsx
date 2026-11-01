import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentField } from "@/components/views/meetings/document-field";

vi.mock("@/components/views/meetings/markdown-text", () => ({
  MarkdownText: ({ value }: { value: string }) => <p>{value}</p>,
}));

const clipboardWriteText = vi.fn();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe("DocumentField copy", () => {
  beforeEach(() => {
    clipboardWriteText.mockReset();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWriteText },
    });
  });

  it("copies the exact current text with a warning and waits for acknowledgement", async () => {
    const pending = deferred<void>();
    clipboardWriteText.mockReturnValueOnce(pending.promise);
    const onChange = vi.fn();
    const onEditingChange = vi.fn();
    const value = "  First line\n\nSecond  line  ";
    render(
      <DocumentField label="Summary" value={value} onChange={onChange}
        emptyMessage="No summary yet." editorPlaceholder="Write a summary"
        isEditing={false} onEditingChange={onEditingChange} copyable
        copySourceKey="meeting-a" copyWarning="Review before sharing." />,
    );

    const copy = screen.getByRole("button", { name: "Copy Summary" });
    fireEvent.click(copy);
    fireEvent.click(copy);

    expect(clipboardWriteText).toHaveBeenCalledOnce();
    expect(clipboardWriteText).toHaveBeenCalledWith(
      `Review before sharing.\n\n${value}`,
    );
    expect(copy).toBeDisabled();
    expect(copy).toHaveTextContent("Copying…");
    expect(screen.queryByText("Copied.")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    expect(onEditingChange).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve(undefined);
      await pending.promise;
    });
    expect(await screen.findByText("Copied.")).toBeInTheDocument();
  });

  it("keeps an editing read-only draft after failure and allows retry", async () => {
    clipboardWriteText
      .mockRejectedValueOnce(new Error("clipboard denied"))
      .mockResolvedValueOnce(undefined);
    const onChange = vi.fn();
    const onEditingChange = vi.fn();
    const value = "Draft words\nwith spacing";
    render(
      <DocumentField label="Summary" value={value} onChange={onChange}
        emptyMessage="No summary yet." editorPlaceholder="Write a summary"
        isEditing onEditingChange={onEditingChange} disabled copyable
        copySourceKey="meeting-a" />,
    );

    const copy = screen.getByRole("button", { name: "Copy Summary" });
    expect(copy).toBeEnabled();
    fireEvent.click(copy);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not copy. Select the text and copy it manually.",
    );
    expect(screen.getByRole("textbox", { name: "Summary" })).toHaveValue(value);
    expect(onChange).not.toHaveBeenCalled();
    expect(onEditingChange).not.toHaveBeenCalled();

    fireEvent.click(copy);
    await waitFor(() => expect(clipboardWriteText).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Copied.")).toBeInTheDocument();
  });

  it("disables copy for blank text", () => {
    render(
      <DocumentField label="Summary" value={"  \n  "} onChange={vi.fn()}
        emptyMessage="No summary yet." editorPlaceholder="Write a summary"
        isEditing={false} onEditingChange={vi.fn()} copyable />,
    );

    const copy = screen.getByRole("button", { name: "Copy Summary" });
    expect(copy).toBeDisabled();
    fireEvent.click(copy);
    expect(clipboardWriteText).not.toHaveBeenCalled();
  });

  it.each([
    ["value", { value: "New value", copySourceKey: "meeting-a", copyWarning: "Warning A" }],
    ["warning", { value: "Same value", copySourceKey: "meeting-a", copyWarning: "Warning B" }],
    ["source", { value: "Same value", copySourceKey: "meeting-b", copyWarning: "Warning A" }],
  ] as const)("suppresses late feedback after the %s changes", async (_kind, next) => {
    const pending = deferred<void>();
    clipboardWriteText.mockReturnValueOnce(pending.promise);
    const common = {
      label: "Summary",
      onChange: vi.fn(),
      emptyMessage: "No summary yet.",
      editorPlaceholder: "Write a summary",
      isEditing: false,
      onEditingChange: vi.fn(),
      copyable: true,
    };
    const view = render(
      <DocumentField {...common} value="Same value" copySourceKey="meeting-a"
        copyWarning="Warning A" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy Summary" }));

    view.rerender(<DocumentField {...common} {...next} />);
    await act(async () => {
      pending.resolve(undefined);
      await pending.promise;
    });

    expect(screen.queryByText("Copied.")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

interface HarnessProps {
  disabled?: boolean;
  initialEditing?: boolean;
  initialValue?: string;
}

function Harness({
  disabled = false,
  initialEditing = false,
  initialValue = "First line",
}: HarnessProps) {
  const [isEditing, setIsEditing] = useState(initialEditing);
  const [value, setValue] = useState(initialValue);

  return (
    <DocumentField
      label="Summary"
      value={value}
      onChange={setValue}
      emptyMessage="No summary yet."
      editorPlaceholder="Write a summary"
      isEditing={isEditing}
      onEditingChange={setIsEditing}
      disabled={disabled}
    />
  );
}

describe("DocumentField editor focus", () => {
  it("focuses the editor at the end after an explicit Edit click", async () => {
    const user = userEvent.setup();
    render(<Harness initialValue="A complete summary" />);

    await user.click(screen.getByRole("button", { name: "Edit Summary" }));

    const editor = screen.getByRole("textbox", { name: "Summary" });
    expect(editor).toHaveFocus();
    expect(editor).toHaveValue("A complete summary");
    expect(editor).toHaveProperty("selectionStart", 18);
    expect(editor).toHaveProperty("selectionEnd", 18);
  });

  it("returns focus to Edit when Done is clicked", async () => {
    const user = userEvent.setup();
    render(<Harness initialEditing />);

    await user.click(screen.getByRole("button", { name: "Done editing Summary" }));

    expect(screen.queryByRole("textbox", { name: "Summary" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit Summary" })).toHaveFocus();
  });
});

describe("DocumentField editor shortcuts", () => {
  it("closes on Command+Enter and Control+Enter without losing the controlled value", async () => {
    const user = userEvent.setup();
    render(<Harness initialEditing />);

    let editor = screen.getByRole("textbox", { name: "Summary" });
    await user.clear(editor);
    await user.type(editor, "Revised summary");
    fireEvent.keyDown(editor, { key: "Enter", metaKey: true });

    let editButton = screen.getByRole("button", { name: "Edit Summary" });
    expect(editButton).toHaveFocus();
    expect(screen.getByText("Revised summary")).toBeInTheDocument();

    await user.click(editButton);
    editor = screen.getByRole("textbox", { name: "Summary" });
    expect(editor).toHaveValue("Revised summary");
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });

    editButton = screen.getByRole("button", { name: "Edit Summary" });
    expect(editButton).toHaveFocus();
    expect(screen.getByText("Revised summary")).toBeInTheDocument();
  });

  it("keeps plain Enter as a multiline edit", () => {
    render(<Harness initialEditing />);
    const editor = screen.getByRole("textbox", { name: "Summary" });

    fireEvent.change(editor, { target: { value: "First line\nSecond line" } });
    fireEvent.keyDown(editor, { key: "Enter" });

    expect(screen.getByRole("textbox", { name: "Summary" })).toHaveValue(
      "First line\nSecond line",
    );
    expect(screen.getByRole("button", { name: "Done editing Summary" })).toBeInTheDocument();
  });

  it("ignores save shortcuts for a disabled editor and during composition", () => {
    const disabledView = render(<Harness initialEditing disabled />);
    const disabledEditor = screen.getByRole("textbox", { name: "Summary" });

    expect(disabledEditor).toHaveAttribute("readonly");
    fireEvent.keyDown(disabledEditor, { key: "Enter", ctrlKey: true });
    expect(screen.getByRole("textbox", { name: "Summary" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done editing Summary" })).toBeDisabled();

    disabledView.unmount();
    render(<Harness initialEditing />);
    const composingEditor = screen.getByRole("textbox", { name: "Summary" });

    fireEvent.keyDown(composingEditor, { key: "Enter", metaKey: true, isComposing: true });
    expect(screen.getByRole("textbox", { name: "Summary" })).toBeInTheDocument();

    fireEvent.keyDown(composingEditor, { key: "Enter", metaKey: true, keyCode: 229 });
    expect(screen.getByRole("textbox", { name: "Summary" })).toBeInTheDocument();
  });
});

describe("DocumentField controlled editing state", () => {
  it("does not steal focus when isEditing changes externally", () => {
    const onEditingChange = vi.fn();
    const outside = document.createElement("button");
    document.body.append(outside);
    const view = render(
      <DocumentField
        label="Summary"
        value="First line"
        onChange={vi.fn()}
        emptyMessage="No summary yet."
        editorPlaceholder="Write a summary"
        isEditing={false}
        onEditingChange={onEditingChange}
      />,
    );
    outside.focus();

    view.rerender(
      <DocumentField
        label="Summary"
        value="First line"
        onChange={vi.fn()}
        emptyMessage="No summary yet."
        editorPlaceholder="Write a summary"
        isEditing
        onEditingChange={onEditingChange}
      />,
    );

    expect(screen.getByRole("textbox", { name: "Summary" })).not.toHaveFocus();
    expect(outside).toHaveFocus();
    expect(onEditingChange).not.toHaveBeenCalled();
    outside.remove();
  });
});
