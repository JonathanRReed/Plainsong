import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TranscriptSegment } from "@/types";

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
  it("formats the total length as m:ss", () => {
    render(<TranscriptViewer segments={SEGMENTS} />);
    // The last segment ends at 599 s.
    expect(screen.getByText("9:59 total")).toBeInTheDocument();
  });
});
