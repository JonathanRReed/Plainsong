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

// Six unlabelled turns, five seconds apart, so each stands as its own group.
// The turn at 0:40 is the one a deep link names.
const DEEP_LINK_SEGMENTS = Array.from({ length: 6 }, (_, index) => ({
  id: `deep-${index}`,
  startTime: index * 10,
  endTime: index * 10 + 5,
  text:
    index === 4
      ? "The launch review moved to Monday."
      : `Filler line ${index}.`,
  confidence: 0.9,
}));

describe("TranscriptViewer", () => {
  it("scrolls to the cued turn when the transcript lands after the viewer mounted", () => {
    const scrollTargets: Element[] = [];
    const scrollIntoView = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(function scrollIntoViewStub(this: Element) {
        scrollTargets.push(this);
      });

    try {
      // The real deep-link flow mounts the viewer before the transcript has
      // arrived: the workspace clears the transcript, then fetches it. The cue
      // is already set, so the turn only exists on a later render.
      const { rerender } = render(<TranscriptViewer segments={[]} currentTime={40} />);
      expect(scrollTargets).toHaveLength(0);

      rerender(<TranscriptViewer segments={DEEP_LINK_SEGMENTS} currentTime={40} />);

      const cuedTurn = screen
        .getByText("The launch review moved to Monday.")
        .closest("div.group");
      expect(cuedTurn).not.toBeNull();
      expect(scrollTargets).toContain(cuedTurn);
    } finally {
      scrollIntoView.mockRestore();
    }
  });

  it("keeps a scrollbar on screen so the transcript reads as a long document", () => {
    // Testers could not tell a long transcript from a short one: the scrollbar
    // was hover-revealed, so nothing on screen said there was more below.
    const { container } = render(<TranscriptViewer segments={DEEP_LINK_SEGMENTS} />);

    expect(
      container.querySelectorAll('[data-orientation="vertical"]').length
    ).toBeGreaterThan(0);
  });

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

  it("does not open the editor on a single click, but does on a double click", () => {
    const onEditSegment = vi.fn(async () => {});

    render(
      <TranscriptViewer
        segments={GROUPED_TURN_SEGMENTS}
        onEditSegment={onEditSegment}
      />
    );

    const paragraph = screen.getByText(/We agreed on the plan/i);

    // A single click sets the reading place; it must leave the words alone so
    // they stay selectable and copyable.
    fireEvent.click(paragraph);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

    fireEvent.doubleClick(paragraph);
    expect(screen.getByRole("textbox")).toHaveValue(
      "We agreed on the plan. Kickoff is Monday."
    );
  });

  it("highlights search hits in place and keeps every segment rendered", () => {
    const onMatchesChange = vi.fn();

    render(
      <TranscriptViewer
        segments={GROUPED_TURN_SEGMENTS}
        highlightQuery="Monday"
        onMatchesChange={onMatchesChange}
      />
    );

    // The non-matching sentence is still on screen — searching must never read
    // as a transcript that lost its text.
    expect(screen.getByText(/We agreed on the plan/i)).toBeInTheDocument();
    expect(screen.queryByText("No transcript available")).not.toBeInTheDocument();

    const marks = document.querySelectorAll("mark");
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveTextContent("Monday");
    expect(onMatchesChange).toHaveBeenLastCalledWith([
      { segmentId: "seg-2", startTime: 1.4 },
    ]);
  });

  it("reports zero hits without emptying the transcript", () => {
    const onMatchesChange = vi.fn();

    render(
      <TranscriptViewer
        segments={GROUPED_TURN_SEGMENTS}
        highlightQuery="quarterly budget"
        onMatchesChange={onMatchesChange}
      />
    );

    expect(screen.getByText(/We agreed on the plan/i)).toBeInTheDocument();
    expect(screen.getByText(/Kickoff is Monday/i)).toBeInTheDocument();
    expect(document.querySelectorAll("mark")).toHaveLength(0);
    expect(onMatchesChange).toHaveBeenLastCalledWith([]);
  });

  it("never claims a local transcript for a provider it cannot name", () => {
    const { rerender } = render(<TranscriptViewer segments={GROUPED_TURN_SEGMENTS} />);

    expect(screen.getAllByText("Provider unknown").length).toBeGreaterThan(0);
    expect(screen.queryByText("Local transcript")).not.toBeInTheDocument();
    expect(screen.queryByText("Local")).not.toBeInTheDocument();

    rerender(
      <TranscriptViewer
        segments={GROUPED_TURN_SEGMENTS}
        provenance={{ source: "cloud", provider: "Groq" }}
      />
    );
    expect(screen.getAllByText("Cloud (Groq)").length).toBeGreaterThan(0);

    rerender(
      <TranscriptViewer segments={GROUPED_TURN_SEGMENTS} provenance={{ source: "local" }} />
    );
    expect(screen.getByText("Local transcript")).toBeInTheDocument();
  });

  it("leaves the pane's heading to the page and keeps only its own readout", () => {
    // The rail this viewer sits in already renders a "Transcript" heading with
    // a segment count under it. A second matching heading directly below read
    // as two stacked headers for the same pane.
    render(<TranscriptViewer segments={GROUPED_TURN_SEGMENTS} />);

    expect(screen.queryByText("Transcript")).not.toBeInTheDocument();
    expect(screen.getByText("2 segments")).toBeInTheDocument();
  });

  it("walks the transcript turn by turn from the keyboard", () => {
    const onSegmentClick = vi.fn();

    render(
      <TranscriptViewer
        segments={[
          ...GROUPED_TURN_SEGMENTS,
          {
            id: "seg-3",
            startTime: 8,
            endTime: 9.4,
            text: "Legal still has to sign off.",
            speakerId: "them",
            confidence: 0.9,
          },
        ]}
        onSegmentClick={onSegmentClick}
      />
    );

    const turns = screen.getByRole("group", { name: "Transcript turns" });
    fireEvent.keyDown(turns, { key: "ArrowDown" });
    expect(onSegmentClick).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "seg-1" })
    );

    fireEvent.keyDown(turns, { key: "ArrowDown" });
    expect(onSegmentClick).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "seg-3" })
    );

    fireEvent.keyDown(turns, { key: "ArrowUp" });
    expect(onSegmentClick).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "seg-1" })
    );
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
