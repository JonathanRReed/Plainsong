import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TranscriptViewer } from "@/components/transcript-viewer";

describe("TranscriptViewer", () => {
  it("renders source-aware meeting speakers as Me and Them", () => {
    render(
      <TranscriptViewer
        segments={[
          {
            id: "seg-1",
            startTime: 0,
            endTime: 1.2,
            text: "I opened the roadmap.",
            speakerId: "me",
            confidence: 0.92,
          },
          {
            id: "seg-2",
            startTime: 1.3,
            endTime: 2.5,
            text: "Let's ship this Friday.",
            speakerId: "them",
            confidence: 0.88,
          },
        ]}
      />
    );

    expect(screen.getByText("Me")).toBeInTheDocument();
    expect(screen.getByText("Them")).toBeInTheDocument();
    expect(screen.getByText(/I opened the roadmap/i)).toBeInTheDocument();
    expect(screen.getByText(/Let's ship this Friday/i)).toBeInTheDocument();
  });
});
