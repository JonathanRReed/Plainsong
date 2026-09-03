import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  SettingsSwitch,
  SettingsInput,
  SettingsSelect,
} from "@/components/ui/settings-control";

describe("SettingsSwitch", () => {
  it("renders label and description", () => {
    render(
      <SettingsSwitch
        label="Test Label"
        description="Test Description"
        checked={false}
        onCheckedChange={vi.fn()}
      />
    );
    expect(screen.getByText("Test Label")).toBeInTheDocument();
    expect(screen.getByText("Test Description")).toBeInTheDocument();
  });

  // The description used to be optional, "omit it if it only restates the
  // label". That licensed rows like "While dictating" with nothing under them.
  // It is required now, and it is wired to the control so a screen reader
  // hears the consequence too.
  it("wires the description to the switch with aria-describedby", () => {
    render(
      <SettingsSwitch
        label="Test Label"
        description="Test Description"
        checked={false}
        onCheckedChange={vi.fn()}
      />
    );
    const switchElement = screen.getByRole("switch");
    const describedBy = switchElement.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)?.textContent).toBe(
      "Test Description",
    );
  });

  it("calls onCheckedChange when toggled", () => {
    const onCheckedChange = vi.fn();
    render(
      <SettingsSwitch
        label="Test Label"
        description="Test Description"
        checked={false}
        onCheckedChange={onCheckedChange}
      />
    );
    const switchElement = screen.getByRole("switch");
    switchElement.click();
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("is disabled when disabled prop is true", () => {
    render(
      <SettingsSwitch
        label="Test Label"
        description="Test Description"
        checked={false}
        onCheckedChange={vi.fn()}
        disabled
      />
    );
    const switchElement = screen.getByRole("switch");
    expect(switchElement).toBeDisabled();
  });
});

describe("SettingsInput", () => {
  it("renders label and description", () => {
    render(
      <SettingsInput
        label="Test Label"
        description="Test Description"
        value="test"
        onChange={vi.fn()}
      />
    );
    expect(screen.getByText("Test Label")).toBeInTheDocument();
    expect(screen.getByText("Test Description")).toBeInTheDocument();
  });

  it("wires the description to the input with aria-describedby", () => {
    render(
      <SettingsInput
        label="Test Label"
        description="Test Description"
        value="test"
        onChange={vi.fn()}
      />
    );
    const input = screen.getByRole("textbox");
    const describedBy = input.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)?.textContent).toBe(
      "Test Description",
    );
  });

  it("renders input with correct value", () => {
    render(
      <SettingsInput
        label="Test Label"
        description="Test Description"
        value="test value"
        onChange={vi.fn()}
      />
    );
    const input = screen.getByRole("textbox");
    expect(input).toHaveValue("test value");
  });

  it("calls onChange when input changes", () => {
    const onChange = vi.fn();
    render(
      <SettingsInput
        label="Test Label"
        description="Test Description"
        value="test"
        onChange={onChange}
      />
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "new value" } });
    expect(onChange).toHaveBeenCalledWith("new value");
  });

  it("is disabled when disabled prop is true", () => {
    render(
      <SettingsInput
        label="Test Label"
        description="Test Description"
        value="test"
        onChange={vi.fn()}
        disabled
      />
    );
    const input = screen.getByRole("textbox");
    expect(input).toBeDisabled();
  });

  it("renders placeholder when provided", () => {
    render(
      <SettingsInput
        label="Test Label"
        description="Test Description"
        value=""
        onChange={vi.fn()}
        placeholder="Enter value"
      />
    );
    const input = screen.getByPlaceholderText("Enter value");
    expect(input).toBeInTheDocument();
  });
});

describe("SettingsSelect", () => {
  it("wires the description to the select with aria-describedby", () => {
    render(
      <SettingsSelect
        label="Test Label"
        description="Test Description"
        value="a"
        onChange={vi.fn()}
      >
        <option value="a">A</option>
        <option value="b">B</option>
      </SettingsSelect>
    );
    const select = screen.getByRole("combobox", { name: "Test Label" });
    const describedBy = select.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)?.textContent).toBe(
      "Test Description",
    );
  });

  it("reports the chosen value", () => {
    const onChange = vi.fn();
    render(
      <SettingsSelect
        label="Test Label"
        description="Test Description"
        value="a"
        onChange={onChange}
      >
        <option value="a">A</option>
        <option value="b">B</option>
      </SettingsSelect>
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Test Label" }), {
      target: { value: "b" },
    });
    expect(onChange).toHaveBeenCalledWith("b");
  });
});
