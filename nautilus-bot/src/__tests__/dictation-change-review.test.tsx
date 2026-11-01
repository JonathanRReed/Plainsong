import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DictationChangeReview } from "@/components/views/dictation/dictation-change-review";

describe("DictationChangeReview", () => {
  it("renders nothing when the draft is unchanged", () => {
    const { container } = render(
      <DictationChangeReview original="Same words." current="Same words." />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("shows the default labels and exact inline additions and removals", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <DictationChangeReview
        original="Meet at noon."
        current="Meet at 12:30."
      />,
    );

    await user.click(screen.getByText("Review changes"));

    expect(screen.getByText("Original")).toBeInTheDocument();
    expect(screen.getByText("Your edit")).toBeInTheDocument();
    expect(screen.getByText("Removed")).toBeInTheDocument();
    expect(screen.getByText("Added")).toBeInTheDocument();
    expect(container.querySelector("del")?.textContent).toBe("noon.");
    expect(container.querySelector("ins")?.textContent).toBe("12:30.");
  });

  it("exposes each exact version instead of merged changes to screen readers", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <DictationChangeReview
        original="Do not send the invoice."
        current="Send the invoice."
        originalLabel="Saved transcript"
      />,
    );

    await user.click(screen.getByText("Review changes"));

    const original = screen.getByText("Saved transcript: Do not send the invoice.");
    const current = screen.getByText("Your edit: Send the invoice.");
    expect(original.closest('[aria-hidden="true"]')).toBeNull();
    expect(current.closest('[aria-hidden="true"]')).toBeNull();
    expect(container.querySelector("del")?.closest("p")).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector("ins")?.closest("p")).toHaveAttribute("aria-hidden", "true");
  });

  it.each([
    ["", "New text", "Original: No text.", "Your edit: New text"],
    ["Deleted text", "", "Original: Deleted text", "Your edit: No text."],
  ])("labels an empty version in the accessible comparison", async (original, current, originalText, currentText) => {
    const user = userEvent.setup();
    render(<DictationChangeReview original={original} current={current} />);

    await user.click(screen.getByText("Review changes"));

    expect(screen.getByText(originalText)).toBeInTheDocument();
    expect(screen.getByText(currentText)).toBeInTheDocument();
  });

  it("preserves exact whitespace in the accessible versions", () => {
    const original = "First line\n\n  indented\twords";
    const current = "First line\n  edited\twords";
    const { container } = render(<DictationChangeReview original={original} current={current} />);
    const versions = container.querySelectorAll("div.sr-only p");

    expect(versions[0].textContent).toBe(`Original: ${original}`);
    expect(versions[1].textContent).toBe(`Your edit: ${current}`);
  });

  it("uses a custom source label and restores only through the explicit button", async () => {
    const user = userEvent.setup();
    const onRestoreOriginal = vi.fn();
    render(
      <DictationChangeReview
        original="First draft"
        current="Edited draft"
        originalLabel="Saved transcript"
        onRestoreOriginal={onRestoreOriginal}
      />,
    );

    await user.click(screen.getByText("Review changes"));
    expect(screen.getByText("Saved transcript")).toBeInTheDocument();
    expect(onRestoreOriginal).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Restore original" }));
    expect(onRestoreOriginal).toHaveBeenCalledTimes(1);
  });
});
