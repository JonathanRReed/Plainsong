import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TranscriptNavigator } from "@/components/meetings/transcript-navigator";
import type { TranscriptSegment } from "@/types";
const segments = [
  { id: "first", text: "Discuss release dates", startTime: 2, endTime: 15, speakerId: "a", confidence: 1 },
  { id: "second", text: "Review support plan", startTime: 320, endTime: 340, speakerId: "b", confidence: 1 },
] as TranscriptSegment[];
describe("TranscriptNavigator", () => {
  it.each([undefined, NaN])("allows a final known start with end %s without extending its time", endTime => {
    const onNavigate = vi.fn();
    const late = { ...segments[1], startTime: 600, endTime } as TranscriptSegment;
    render(<TranscriptNavigator segments={[segments[0], late]} speakerNames={{}} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByText("Browse transcript"));
    const input = screen.getByRole("textbox", { name: "Jump to transcript time" });
    fireEvent.change(input, { target: { value: "10:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(onNavigate).toHaveBeenCalledWith(600, "second");
    fireEvent.change(input, { target: { value: "10:01" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(screen.getByRole("alert")).toHaveTextContent("up to 10:00");
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
  it("keeps a valid speaker selection and recovers when its source speaker disappears", () => {
    const onNavigate = vi.fn();
    const { rerender } = render(<TranscriptNavigator segments={segments} speakerNames={{}} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByText("Browse transcript"));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "b" } });
    rerender(<TranscriptNavigator segments={[...segments]} speakerNames={{}} onNavigate={onNavigate} />);
    expect(screen.getByRole("combobox")).toHaveValue("b");
    expect(screen.queryByText("Discuss release dates")).not.toBeInTheDocument();
    rerender(<TranscriptNavigator segments={[segments[0]]} speakerNames={{}} onNavigate={onNavigate} />);
    expect(screen.getByRole("combobox")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: /Discuss release dates/ }));
    expect(onNavigate).toHaveBeenCalledWith(2, "first");
    rerender(<TranscriptNavigator segments={segments} speakerNames={{}} onNavigate={onNavigate} />);
    expect(screen.getByRole("combobox")).toHaveValue("");
  });
  it("opens exact evidence and filters navigation without removing transcript data", () => {
    const onNavigate = vi.fn();
    render(<TranscriptNavigator segments={segments} speakerNames={{ a: "Alex", b: "Blair" }} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByText("Browse transcript"));
    fireEvent.click(screen.getByRole("button", { name: /Discuss release dates/ }));
    expect(onNavigate).toHaveBeenCalledWith(2, "first");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "b" } });
    expect(screen.queryByText("Discuss release dates")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Review support plan/ }));
    expect(onNavigate).toHaveBeenLastCalledWith(320, "second");
  });
  it("validates a time before navigation and supports repeated source jumps", () => {
    const onNavigate = vi.fn();
    render(<TranscriptNavigator segments={segments} speakerNames={{}} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByText("Browse transcript"));
    const input = screen.getByRole("textbox", { name: "Jump to transcript time" });
    fireEvent.change(input, { target: { value: "9:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(screen.getByRole("alert")).toHaveTextContent("up to 5:40");
    expect(onNavigate).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "5:30" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(onNavigate).toHaveBeenCalledTimes(2);
    expect(onNavigate).toHaveBeenLastCalledWith(330, "second");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
