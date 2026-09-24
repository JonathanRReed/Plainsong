import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TranscriptSegment } from "@/types";

// Every turn stamps its start time once per render, so counting the calls
// counts the turns that re-rendered.
const stampCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/lib/format-time", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/format-time")>();
  return {
    ...actual,
    formatTimeWithMs: (seconds: number) => {
      stampCalls.count += 1;
      return actual.formatTimeWithMs(seconds);
    },
  };
});

import { TranscriptViewer } from "@/components/transcript-viewer";

const SEGMENTS: TranscriptSegment[] = Array.from({ length: 60 }, (_, index) => ({
  id: `seg-${index}`,
  startTime: index * 10,
  endTime: index * 10 + 9,
  text: `Line ${index} about the release plan.`,
  speakerId: index % 2 === 0 ? "Me" : "Them",
  confidence: 0.95,
}));

describe("TranscriptViewer rendering", () => {
  beforeEach(() => {
    stampCalls.count = 0;
  });

  it("re-renders only the turns the playhead touches", () => {
    const onSegmentClick = vi.fn();
    const { rerender } = render(
      <TranscriptViewer segments={SEGMENTS} currentTime={1} onSegmentClick={onSegmentClick} />,
    );
    expect(stampCalls.count).toBeGreaterThanOrEqual(SEGMENTS.length);

    // A tick inside the same turn.
    stampCalls.count = 0;
    rerender(
      <TranscriptViewer segments={SEGMENTS} currentTime={1.25} onSegmentClick={onSegmentClick} />,
    );
    expect(stampCalls.count).toBeLessThanOrEqual(1);

    // Crossing into a later turn: the old one and the new one, nothing else.
    stampCalls.count = 0;
    rerender(
      <TranscriptViewer segments={SEGMENTS} currentTime={301} onSegmentClick={onSegmentClick} />,
    );
    expect(stampCalls.count).toBeLessThanOrEqual(2);
  });

  it("formats the total length as m:ss", () => {
    render(<TranscriptViewer segments={SEGMENTS} />);
    // The last segment ends at 599 s.
    expect(screen.getByText("9:59 total")).toBeInTheDocument();
  });
});
