import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptViewer } from "@/components/transcript-viewer";

// Six unlabelled turns, ten seconds apart, so each stands as its own group.
const SEGMENTS = Array.from({ length: 6 }, (_, index) => ({
  id: `seg-${index}`,
  startTime: index * 10,
  endTime: index * 10 + 5,
  text: `Line ${index}.`,
  confidence: 0.9,
}));

describe("TranscriptViewer playback keys", () => {
  it("toggles playback on Space and skips five seconds on the arrow keys", () => {
    const onTogglePlayback = vi.fn();
    const onSeekBy = vi.fn();
    render(
      <TranscriptViewer
        segments={SEGMENTS}
        onTogglePlayback={onTogglePlayback}
        onSeekBy={onSeekBy}
      />
    );
    const region = screen.getByRole("group", { name: "Transcript turns" });

    fireEvent.keyDown(region, { key: " " });
    expect(onTogglePlayback).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(region, { key: "ArrowLeft" });
    expect(onSeekBy).toHaveBeenLastCalledWith(-5);
    fireEvent.keyDown(region, { key: "ArrowRight" });
    expect(onSeekBy).toHaveBeenLastCalledWith(5);
  });

  it("leaves Space alone when focus is on a control inside the transcript", () => {
    const onTogglePlayback = vi.fn();
    render(
      <TranscriptViewer
        segments={[SEGMENTS[0]]}
        onTogglePlayback={onTogglePlayback}
        onEditSegment={vi.fn()}
      />
    );
    // The per-turn Edit control is a button; Space there is the button's, not ours.
    const edit = screen.getByRole("button", { name: "Edit segment" });
    fireEvent.keyDown(edit, { key: " " });
    expect(onTogglePlayback).not.toHaveBeenCalled();
  });

  it("does nothing with the keys when no player is wired", () => {
    render(<TranscriptViewer segments={SEGMENTS} />);
    const region = screen.getByRole("group", { name: "Transcript turns" });
    // No handler, no throw, and the default is not prevented.
    const event = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    region.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("TranscriptViewer follows the playhead", () => {
  let scrollTargets: Element[];
  let scrollIntoView: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    scrollTargets = [];
    scrollIntoView = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(function scrollIntoViewStub(this: Element) {
        scrollTargets.push(this);
      });
    vi.useFakeTimers();
  });

  afterEach(() => {
    scrollIntoView.mockRestore();
    vi.useRealTimers();
  });

  it("highlights and scrolls to the turn containing the current time", () => {
    const { rerender } = render(<TranscriptViewer segments={SEGMENTS} currentTime={0} />);
    scrollTargets.length = 0;

    rerender(<TranscriptViewer segments={SEGMENTS} currentTime={32} />);
    expect(scrollTargets).toHaveLength(1);
    expect(scrollTargets[0]).toHaveTextContent("Line 3.");
    // The active turn carries the gold reading-position mark.
    expect(scrollTargets[0].querySelector(".neume-lit")).not.toBeNull();

    // The playhead moving within the same turn does not scroll again.
    rerender(<TranscriptViewer segments={SEGMENTS} currentTime={34} />);
    expect(scrollTargets).toHaveLength(1);
  });

  it("holds off auto-scroll for a few seconds after the reader scrolls", () => {
    const { rerender } = render(<TranscriptViewer segments={SEGMENTS} currentTime={0} />);
    const region = screen.getByRole("group", { name: "Transcript turns" });
    scrollTargets.length = 0;

    fireEvent.wheel(region, { deltaY: -120 });
    rerender(<TranscriptViewer segments={SEGMENTS} currentTime={22} />);
    expect(scrollTargets).toHaveLength(0);

    // Four seconds later the playhead leads again.
    vi.advanceTimersByTime(4_100);
    rerender(<TranscriptViewer segments={SEGMENTS} currentTime={43} />);
    expect(scrollTargets).toHaveLength(1);
    expect(scrollTargets[0]).toHaveTextContent("Line 4.");
  });
});
