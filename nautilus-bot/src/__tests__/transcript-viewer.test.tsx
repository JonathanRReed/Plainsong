import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TranscriptViewer } from "@/components/transcript-viewer";

// Two segments spoken by the same speaker within 2s group into one turn.
const GROUPED_TURN_SEGMENTS = [
  {
    id: "seg-1",
    startTime: 0,
    endTime: 1.2,
    text: "We agreed on the plan.",
    speakerId: "me",
    confidence: 0.95,
  },
  {
    id: "seg-2",
    startTime: 1.4,
    endTime: 2.6,
    text: "Kickoff is Monday.",
    speakerId: "me",
    confidence: 0.93,
  },
];

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

  it("saves a grouped-turn edit with every segment id in the turn", async () => {
    const onEditSegment = vi.fn(async () => {});

    render(
      <TranscriptViewer
        segments={GROUPED_TURN_SEGMENTS}
        onEditSegment={onEditSegment}
        onDeleteSegments={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit segment" }));

    const editor = screen.getByRole("textbox");
    expect(editor).toHaveValue("We agreed on the plan. Kickoff is Monday.");

    fireEvent.change(editor, {
      target: { value: "We agreed on the plan. Kickoff is Tuesday." },
    });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(onEditSegment).toHaveBeenCalledWith(
        ["seg-1", "seg-2"],
        "We agreed on the plan. Kickoff is Tuesday."
      );
    });
    // Editor closes after a successful save.
    await waitFor(() => {
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    });
  });

  it("keeps the editor open when saving the edit fails", async () => {
    const onEditSegment = vi.fn(async () => {
      throw new Error("disk full");
    });

    render(
      <TranscriptViewer
        segments={GROUPED_TURN_SEGMENTS}
        onEditSegment={onEditSegment}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit segment" }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Corrected text" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => {
      expect(onEditSegment).toHaveBeenCalledTimes(1);
    });
    // The correction stays on screen instead of silently snapping back.
    expect(screen.getByRole("textbox")).toHaveValue("Corrected text");
  });
});
