import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SearchableSelect } from "@/components/ui/searchable-select";

const OPTIONS = [
  { value: "auto", label: "Auto detect" },
  { value: "en", label: "English" },
  { value: "uk", label: "Ukrainian" },
];

function renderSelect(onChange = vi.fn()) {
  render(
    <div>
      <SearchableSelect
        ariaLabel="Session language"
        value="auto"
        options={OPTIONS}
        onChange={onChange}
      />
      <button type="button">Somewhere else</button>
    </div>,
  );
  return {
    onChange,
    trigger: screen.getByRole("combobox", { name: "Session language" }),
    outside: screen.getByRole("button", { name: "Somewhere else" }),
  };
}

describe("SearchableSelect", () => {
  it("opens a searchable listbox and reports the chosen value", async () => {
    const { onChange, trigger } = renderSelect();

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    fireEvent.change(screen.getByRole("combobox", { name: "" }), {
      target: { value: "ukr" },
    });
    fireEvent.click(await screen.findByRole("option", { name: /Ukrainian/ }));

    expect(onChange).toHaveBeenCalledWith("uk");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("closes on Escape and returns focus to the trigger", () => {
    const { trigger } = renderSelect();

    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByPlaceholderText("Search…"), {
      key: "Escape",
    });

    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  });

  it("closes when keyboard focus leaves the control", async () => {
    // Watching only for an outside mousedown left a keyboard user with an open
    // listbox floating over the controls below, after their focus had moved on.
    const { trigger, outside } = renderSelect();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    act(() => {
      outside.focus();
    });
    fireEvent.focusOut(screen.getByPlaceholderText("Search…"), {
      relatedTarget: outside,
    });

    await waitFor(() => {
      expect(trigger).toHaveAttribute("aria-expanded", "false");
    });
  });

  it("stays open while focus moves between its own parts", async () => {
    const { trigger } = renderSelect();

    fireEvent.click(trigger);
    const input = screen.getByPlaceholderText("Search…");
    fireEvent.focusOut(input, { relatedTarget: trigger });

    await waitFor(() => {
      expect(trigger).toHaveAttribute("aria-expanded", "true");
    });
  });

  it("closes on an outside pointer press", () => {
    const { trigger, outside } = renderSelect();

    fireEvent.click(trigger);
    fireEvent.mouseDown(outside);

    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
});
