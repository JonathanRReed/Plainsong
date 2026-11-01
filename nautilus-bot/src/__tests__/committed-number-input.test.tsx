import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CommittedNumberInput } from "@/components/ui/committed-number-input";

describe("CommittedNumberInput", () => {
  it("lets the reader clear the field and type a new number, saving once", () => {
    const onCommit = vi.fn();
    render(<CommittedNumberInput aria-label="Hours" value={24} min={1} onCommit={onCommit} />);
    const input = screen.getByLabelText("Hours") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "" } });
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: "7" } });
    fireEvent.change(input, { target: { value: "72" } });
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(72);
  });

  it("restores the saved value for an empty or invalid entry, and clamps to the minimum", () => {
    const onCommit = vi.fn();
    render(<CommittedNumberInput aria-label="Hours" value={24} min={1} onCommit={onCommit} />);
    const input = screen.getByLabelText("Hours") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(input.value).toBe("24");
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith(1);
  });
});
