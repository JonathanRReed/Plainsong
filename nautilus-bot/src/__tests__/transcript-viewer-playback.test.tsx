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

  it("lands explicit source jumps after manual scrolling and repeats the same moment", () => {
    const { rerender } = render(<TranscriptViewer segments={SEGMENTS} currentTime={22} />);
    const region = screen.getByRole("group", { name: "Transcript turns" });
    fireEvent.wheel(region, { deltaY: -120 });
    scrollTargets.length = 0;
    rerender(<TranscriptViewer segments={SEGMENTS} currentTime={22} sourceNavigation={{ time: 22, requestId: 1 }} />);
    expect(scrollTargets).toHaveLength(1);
    expect(scrollTargets[0]).toHaveTextContent("Line 2.");
    expect(scrollTargets[0]).toHaveFocus();
    region.focus();
    rerender(<TranscriptViewer segments={SEGMENTS} currentTime={22} sourceNavigation={{ time: 22, requestId: 2 }} />);
    expect(scrollTargets).toHaveLength(2);
    expect(scrollTargets[1]).toHaveFocus();
  });

  it("continues reading from the cited turn with deliberate arrow navigation", () => {
    const onSegmentClick = vi.fn();
    const onTogglePlayback = vi.fn();
    render(<TranscriptViewer segments={SEGMENTS} onSegmentClick={onSegmentClick} onTogglePlayback={onTogglePlayback}
      sourceNavigation={{ time: 42, segmentId: "seg-4", requestId: 1 }} />);
    const cited = document.activeElement as HTMLElement;
    fireEvent.wheel(cited, { deltaY: -120 });
    scrollTargets.length = 0;
    fireEvent.keyDown(cited, { key: "ArrowDown" });
    expect(onSegmentClick).toHaveBeenLastCalledWith(SEGMENTS[5]);
    expect(scrollTargets[0]).toHaveTextContent("Line 5.");
    expect(scrollTargets[0]).toHaveFocus();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" });
    expect(onSegmentClick).toHaveBeenLastCalledWith(SEGMENTS[5]);
    expect(scrollTargets[1]).toHaveFocus();
    expect(onTogglePlayback).not.toHaveBeenCalled();
  });

  it("reveals arrow reading destinations without a player and stays at the first boundary", () => {
    render(<TranscriptViewer segments={SEGMENTS} />);
    const region = screen.getByRole("group", { name: "Transcript turns" });
    fireEvent.wheel(region, { deltaY: -120 });
    fireEvent.keyDown(region, { key: "ArrowDown" });
    expect(scrollTargets[0]).toHaveTextContent("Line 0.");
    expect(scrollTargets[0]).toHaveFocus();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowUp" });
    expect(scrollTargets[1]).toHaveTextContent("Line 0.");
    expect(scrollTargets[1]).toHaveFocus();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" });
    expect(scrollTargets[2]).toHaveTextContent("Line 1.");
    expect(scrollTargets[2]).toHaveFocus();
  });

  it("continues reading after a late search result without stealing search focus", () => {
    const onSegmentClick = vi.fn();
    const { rerender } = render(<><input aria-label="Search fixture" /><TranscriptViewer segments={SEGMENTS} highlightQuery="Line" activeMatchIndex={0} onSegmentClick={onSegmentClick} /></>);
    const search = screen.getByRole("textbox", { name: "Search fixture" });
    search.focus();
    fireEvent.wheel(screen.getByRole("group", { name: "Transcript turns" }), { deltaY: -120 });
    scrollTargets.length = 0;
    rerender(<><input aria-label="Search fixture" /><TranscriptViewer segments={SEGMENTS} currentTime={2} highlightQuery="Line" activeMatchIndex={4} onSegmentClick={onSegmentClick} /></>);
    expect(scrollTargets).toHaveLength(1);
    expect(scrollTargets[0].closest("[data-transcript-segment]")).toHaveAttribute("data-transcript-segment", "seg-4");
    expect(search).toHaveFocus();
    const region = screen.getByRole("group", { name: "Transcript turns" });
    region.focus();
    fireEvent.keyDown(region, { key: "ArrowDown" });
    expect(onSegmentClick).toHaveBeenLastCalledWith(SEGMENTS[5]);
    expect(document.activeElement).toHaveAttribute("data-transcript-segment", "seg-5");
  });

  it("keeps the search reading cursor through playback updates and search clearing", () => {
    const onSegmentClick = vi.fn();
    const { rerender } = render(<TranscriptViewer segments={SEGMENTS} currentTime={2} highlightQuery="Line" activeMatchIndex={3} onSegmentClick={onSegmentClick} />);
    rerender(<TranscriptViewer segments={SEGMENTS} currentTime={42} highlightQuery="Line" activeMatchIndex={3} onSegmentClick={onSegmentClick} />);
    rerender(<TranscriptViewer segments={SEGMENTS} currentTime={42} onSegmentClick={onSegmentClick} />);
    fireEvent.keyDown(screen.getByRole("group", { name: "Transcript turns" }), { key: "ArrowDown" });
    expect(onSegmentClick).toHaveBeenLastCalledWith(SEGMENTS[4]);
  });

  it("waits for transcript turns before consuming an explicit source request", () => {
    const sourceNavigation = { time: 22, segmentId: "seg-2", requestId: 1 };
    const { rerender } = render(<TranscriptViewer segments={[]} sourceNavigation={sourceNavigation} />);
    expect(scrollTargets).toHaveLength(0);
    rerender(<TranscriptViewer segments={SEGMENTS} sourceNavigation={sourceNavigation} />);
    expect(scrollTargets).toHaveLength(1);
    expect(scrollTargets[0]).toHaveTextContent("Line 2.");
    expect(scrollTargets[0]).toHaveFocus();
  });

  it("does not replay a missing source if a later transcript reuses its segment id", () => {
    const sourceNavigation = { time: 22, segmentId: "missing", requestId: 1 };
    const { rerender } = render(<TranscriptViewer segments={SEGMENTS} sourceNavigation={sourceNavigation} />);
    expect(scrollTargets).toHaveLength(0);
    rerender(<TranscriptViewer segments={[{ ...SEGMENTS[2], id: "missing" }]} sourceNavigation={sourceNavigation} />);
    expect(scrollTargets).toHaveLength(0);
  });

  it("lands on a late sentence inside one long speaker turn and repeats it", () => {
    const segments = SEGMENTS.map((segment, index) => ({ ...segment, speakerId: "speaker-1", id: index === 5 ? 'late"]segment' : segment.id }));
    const sourceNavigation = { time: 52, segmentId: segments[5].id, requestId: 1 };
    const { rerender } = render(<TranscriptViewer segments={segments} sourceNavigation={sourceNavigation} />);
    expect(document.querySelectorAll("[data-transcript-turn]")).toHaveLength(1);
    expect(scrollTargets[0]).toHaveTextContent("Line 5.");
    expect(scrollTargets[0]).not.toHaveTextContent("Line 0.");
    expect(scrollTargets[0]).toHaveAttribute("data-transcript-segment", segments[5].id);
    expect(scrollTargets[0]).toHaveFocus();
    rerender(<TranscriptViewer segments={segments} sourceNavigation={{ ...sourceNavigation, requestId: 2 }} />);
    expect(scrollTargets).toHaveLength(2);
    expect(scrollTargets[1]).toHaveFocus();
  });

  it("lands on the new turn at a shared timestamp boundary", () => {
    const segments = [{ ...SEGMENTS[0], endTime: 10 }, SEGMENTS[1]];
    const { rerender } = render(<TranscriptViewer segments={segments} sourceNavigation={{ time: 10, requestId: 1 }} />);
    expect(scrollTargets[0]).toHaveTextContent("Line 1.");
    expect(scrollTargets[0]).toHaveFocus();
    rerender(<TranscriptViewer segments={segments} sourceNavigation={{ time: 10, segmentId: "seg-0", requestId: 2 }} />);
    expect(scrollTargets[1]).toHaveTextContent("Line 0.");
    expect(scrollTargets[1]).toHaveFocus();
  });

  it("uses the cited segment identity instead of a conflicting timestamp", () => {
    render(<TranscriptViewer segments={SEGMENTS} sourceNavigation={{ time: 22, segmentId: "seg-4", requestId: 1 }} />);
    expect(scrollTargets).toHaveLength(1);
    expect(scrollTargets[0]).toHaveTextContent("Line 4.");
    expect(scrollTargets[0]).toHaveFocus();
  });

  it("does not focus another turn for an unavailable source segment or timestamp gap", () => {
    const { rerender } = render(<TranscriptViewer segments={SEGMENTS} />);
    scrollTargets.length = 0;
    rerender(<TranscriptViewer segments={SEGMENTS} sourceNavigation={{ time: 22, segmentId: "removed", requestId: 1 }} />);
    expect(scrollTargets).toHaveLength(0);
    rerender(<TranscriptViewer segments={SEGMENTS} sourceNavigation={{ time: 28, requestId: 2 }} />);
    expect(scrollTargets).toHaveLength(0);
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
