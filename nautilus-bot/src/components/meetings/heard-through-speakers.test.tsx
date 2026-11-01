import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HeardThroughSpeakers } from "@/components/meetings/heard-through-speakers";

const echo = {
  id: "echo-1",
  startTime: 64.2,
  endTime: 66,
  text: "we should ship the patch today",
  speakerId: "me",
  confidence: 0.8,
};

describe("HeardThroughSpeakers", () => {
  it("renders nothing when no line was set aside", () => {
    const { container } = render(<HeardThroughSpeakers segments={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("keeps the set-aside lines hidden until asked, then shows each one", () => {
    const onSelect = vi.fn();
    render(<HeardThroughSpeakers segments={[echo]} onSelect={onSelect} />);

    expect(screen.getByText(/1 microphone line matched what the other side said/)).toBeInTheDocument();
    expect(screen.queryByText(echo.text)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(screen.getByText(echo.text)).toBeInTheDocument();
    expect(screen.getByText("1:04")).toBeInTheDocument();

    fireEvent.click(screen.getByText(echo.text));
    expect(onSelect).toHaveBeenCalledWith(echo);

    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.queryByText(echo.text)).not.toBeInTheDocument();
  });
});
