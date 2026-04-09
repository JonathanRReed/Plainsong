import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SettingsSwitch, SettingsInput } from "@/components/ui/settings-control";

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

  it("renders without description", () => {
    render(
      <SettingsSwitch
        label="Test Label"
        checked={false}
        onCheckedChange={vi.fn()}
      />
    );
    expect(screen.getByText("Test Label")).toBeInTheDocument();
  });

  it("calls onCheckedChange when toggled", () => {
    const onCheckedChange = vi.fn();
    render(
      <SettingsSwitch
        label="Test Label"
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

  it("renders without description", () => {
    render(
      <SettingsInput
        label="Test Label"
        value="test"
        onChange={vi.fn()}
      />
    );
    expect(screen.getByText("Test Label")).toBeInTheDocument();
  });

  it("renders input with correct value", () => {
    render(
      <SettingsInput
        label="Test Label"
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
        value=""
        onChange={vi.fn()}
        placeholder="Enter value"
      />
    );
    const input = screen.getByPlaceholderText("Enter value");
    expect(input).toBeInTheDocument();
  });
});
