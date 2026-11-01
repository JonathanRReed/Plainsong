import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { SelectiveChangeReview } from "@/components/views/dictation/selective-change-review";

function Editor() {
  const [text, setText] = useState("Meet midnight with Jonathan.");
  return <><textarea aria-label="Draft" value={text} onChange={event => setText(event.target.value)} />
    <SelectiveChangeReview original="Meet noon with Jon." current={text} onChange={setText} /></>;
}

function FocusMovingEditor() {
  const [text, setText] = useState("Meet midnight with Jonathan.");
  const button = useRef<HTMLButtonElement>(null);
  return <><textarea aria-label="Draft" value={text} onChange={event => setText(event.target.value)} />
    <button ref={button}>Continue editing</button>
    <SelectiveChangeReview original="Meet noon with Jon." current={text} onChange={nextText => {
      setText(nextText);
      button.current?.focus();
    }} /></>;
}

describe("selective correction review", () => {
  it("shows exact nearby wording and marks only the changed text", async () => {
    render(<SelectiveChangeReview original={"Wait\n\tfifteen minutes, then call."} current={"Wait\n\tfive minutes, then call."} onChange={vi.fn()} />);
    await userEvent.click(screen.getByText("Restore individual changes"));
    expect(screen.getByLabelText("Original passage").textContent).toBe("Wait\n\tfifteen minutes, then call.");
    expect(screen.getByLabelText("Your edit passage").textContent).toBe("Wait\n\tfive minutes, then call.");
    expect(screen.getByLabelText("Original changed text").textContent).toBe("fifteen");
    expect(screen.getByLabelText("Your edit changed text").textContent).toBe("five");
    expect(screen.getByLabelText("Your edit changed text").tagName).toBe("MARK");
  });
  it("labels missing text within an insertion's context", async () => {
    render(<SelectiveChangeReview original="Please call." current="Please do call." onChange={vi.fn()} />);
    await userEvent.click(screen.getByText("Restore individual changes"));
    expect(screen.getByLabelText("Original changed text")).toHaveTextContent("No text");
    expect(screen.getByLabelText("Your edit passage").textContent).toBe("Please do call.");
    expect(screen.getByLabelText("Your edit changed text").textContent).toBe("do ");
  });
  it("shows a removal as the struck-through words, not an empty slot", async () => {
    render(<SelectiveChangeReview original="See you on Tuesday. No wait, Wednesday." current="See you on Wednesday." onChange={vi.fn()} />);
    await userEvent.click(screen.getByText("Restore individual changes"));
    const removed = screen.getByLabelText("Your edit removed text");
    expect(removed.tagName).toBe("DEL");
    expect(removed.textContent).toBe(screen.getByLabelText("Original changed text").textContent);
    expect(screen.queryByLabelText("Your edit changed text")).toBeNull();
    expect(screen.getByLabelText("Your edit passage")).not.toHaveTextContent("No text");
  });
  it("marks omitted context instead of repeating a long dictation", async () => {
    const prefix = "same ".repeat(400);
    const suffix = " end".repeat(400);
    render(<SelectiveChangeReview original={`${prefix}old${suffix}`} current={`${prefix}new${suffix}`} onChange={vi.fn()} />);
    await userEvent.click(screen.getByText("Restore individual changes"));
    const passage = screen.getByLabelText("Your edit passage");
    expect(passage.textContent).toHaveLength(165);
    expect(passage.textContent).toMatch(/^….*new.*…$/);
    expect(screen.getAllByLabelText("Earlier context omitted")).toHaveLength(2);
    expect(screen.getAllByLabelText("Later context omitted")).toHaveLength(2);
  });
  it("restores one change, recalculates remaining changes and undoes the operation", async () => {
    const user = userEvent.setup();
    render(<Editor />);
    await user.click(screen.getByText("Restore individual changes"));
    await user.click(screen.getByRole("button", { name: "Restore change 1" }));
    expect(screen.getByLabelText("Draft")).toHaveValue("Meet noon with Jonathan.");
    expect(screen.queryByRole("button", { name: "Restore change 2" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Undo restoration" }));
    expect(screen.getByLabelText("Draft")).toHaveValue("Meet midnight with Jonathan.");
  });
  it("drops undo after further typing", async () => {
    const user = userEvent.setup();
    render(<Editor />);
    await user.click(screen.getByText("Restore individual changes"));
    await user.click(screen.getByRole("button", { name: "Restore change 1" }));
    await user.type(screen.getByLabelText("Draft"), " More.");
    expect(screen.queryByRole("button", { name: "Undo restoration" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Draft")).toHaveValue("Meet noon with Jonathan. More.");
  });
  it("focuses Undo restoration after restoring a change with Enter", async () => {
    const user = userEvent.setup();
    render(<Editor />);
    await user.click(screen.getByText("Restore individual changes"));
    screen.getByRole("button", { name: "Restore change 1" }).focus();
    await user.keyboard("{Enter}");
    expect(screen.getByLabelText("Draft")).toHaveValue("Meet noon with Jonathan.");
    expect(screen.getByRole("button", { name: "Undo restoration" })).toHaveFocus();
  });
  it("focuses Restore individual changes after undoing with Enter", async () => {
    const user = userEvent.setup();
    render(<Editor />);
    await user.click(screen.getByText("Restore individual changes"));
    await user.click(screen.getByRole("button", { name: "Restore change 1" }));
    screen.getByRole("button", { name: "Undo restoration" }).focus();
    await user.keyboard("{Enter}");
    expect(screen.getByLabelText("Draft")).toHaveValue("Meet midnight with Jonathan.");
    expect(screen.getByText("Restore individual changes")).toHaveFocus();
  });
  it("preserves focus moved by the parent during restoration", async () => {
    const user = userEvent.setup();
    render(<FocusMovingEditor />);
    await user.click(screen.getByText("Restore individual changes"));
    screen.getByRole("button", { name: "Restore change 1" }).focus();
    await user.keyboard("{Enter}");
    expect(screen.getByLabelText("Draft")).toHaveValue("Meet noon with Jonathan.");
    expect(screen.getByRole("button", { name: "Continue editing" })).toHaveFocus();
  });
  it("disables restores during a save and creates no writes by rendering", async () => {
    const onChange = vi.fn();
    render(<SelectiveChangeReview original="old" current="new" onChange={onChange} disabled />);
    await userEvent.click(screen.getByText("Restore individual changes"));
    expect(screen.getByRole("button", { name: "Restore change 1" })).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
  });
  it("invalidates undo when the source revision changes", async () => {
    const onChange = vi.fn();
    const { rerender } = render(<SelectiveChangeReview original="old" current="new" onChange={onChange} />);
    await userEvent.click(screen.getByText("Restore individual changes"));
    await userEvent.click(screen.getByRole("button", { name: "Restore change 1" }));
    rerender(<SelectiveChangeReview original="other source" current="old" onChange={onChange} />);
    expect(screen.queryByRole("button", { name: "Undo restoration" })).not.toBeInTheDocument();
  });
});
