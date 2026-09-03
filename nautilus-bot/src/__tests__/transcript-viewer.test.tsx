import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

  it("labels Apple Speech provenance as on-device with server fallback disabled", () => {
    render(
      <TranscriptViewer
        segments={GROUPED_TURN_SEGMENTS}
        provenance={{ source: "apple_on_device" }}
      />,
    );

    expect(screen.getByText("Apple Speech · on-device")).toBeInTheDocument();
    expect(screen.getByText("Apple on-device")).toBeInTheDocument();
    expect(screen.getByTitle(/server fallback disabled/i)).toBeInTheDocument();
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
    expect(
      screen.queryByRole("button", { name: "Rename Speakers" }),
    ).not.toBeInTheDocument();
  });

  it("renders null speaker IDs as Unattributed without offering rename controls", () => {
    render(
      <TranscriptViewer
        segments={[
          {
            id: "unattributed-1",
            startTime: 0,
            endTime: 1,
            text: "Coverage begins after this line.",
            speakerId: null,
            confidence: 0.9,
          },
        ]}
        onRenameSpeaker={vi.fn(async () => {})}
      />,
    );

    expect(screen.getByText("Unattributed")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Rename Speakers" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Edit speaker name" }),
    ).not.toBeInTheDocument();
  });

  it("offers rename controls only for persisted speaker IDs when a callback exists", () => {
    render(
      <TranscriptViewer
        segments={[
          {
            id: "unattributed-1",
            startTime: 0,
            endTime: 1,
            text: "An uncovered opening.",
            speakerId: null,
            confidence: 0.9,
          },
          {
            id: "persisted-1",
            startTime: 4,
            endTime: 5,
            text: "A labelled response.",
            speakerId: "speaker_0",
            confidence: 0.9,
          },
        ]}
        onRenameSpeaker={vi.fn(async () => {})}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Rename Speakers" }));

    expect(screen.getByText("Unattributed")).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Edit speaker name" }),
    ).toHaveLength(1);
  });

  it("reveals hover-hidden speaker rename controls when they receive keyboard focus", () => {
    render(
      <TranscriptViewer
        segments={GROUPED_TURN_SEGMENTS}
        onRenameSpeaker={vi.fn(async () => {})}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Rename Speakers" }));
    const renameButton = screen.getByRole("button", { name: "Edit speaker name" });
    renameButton.focus();

    expect(renameButton).toHaveFocus();
    expect(renameButton).toHaveClass("group-focus-within:opacity-100");
    expect(renameButton).toHaveClass("focus-visible:opacity-100");
  });

  it("waits for rename persistence before changing the visible speaker name", async () => {
    const pendingRename = deferred<void>();
    const onRenameSpeaker = vi.fn(() => pendingRename.promise);

    render(
      <TranscriptViewer
        segments={GROUPED_TURN_SEGMENTS}
        onRenameSpeaker={onRenameSpeaker}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Rename Speakers" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit speaker name" }));
    fireEvent.change(screen.getByLabelText("Speaker name"), {
      target: { value: "Alice" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save speaker name" }));

    expect(onRenameSpeaker).toHaveBeenCalledWith("me", "Alice", false);
    expect(screen.getByLabelText("Speaker name")).toHaveValue("Alice");
    expect(screen.queryByText("Alice")).not.toBeInTheDocument();

    await act(async () => {
      pendingRename.resolve();
      await pendingRename.promise;
    });

    expect(await screen.findByText("Alice")).toBeInTheDocument();
    expect(screen.queryByLabelText("Speaker name")).not.toBeInTheDocument();
  });

  it("keeps the speaker editor and attempted value open when persistence rejects", async () => {
    const pendingRename = deferred<void>();
    const onRenameSpeaker = vi.fn(() => pendingRename.promise);

    render(
      <TranscriptViewer
        segments={GROUPED_TURN_SEGMENTS}
        onRenameSpeaker={onRenameSpeaker}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Rename Speakers" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit speaker name" }));
    fireEvent.change(screen.getByLabelText("Speaker name"), {
      target: { value: "Alice" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save speaker name" }));

    await act(async () => {
      pendingRename.reject(new Error("Alias write failed"));
      await pendingRename.promise.catch(() => undefined);
    });

    expect(screen.getByLabelText("Speaker name")).toHaveValue("Alice");
    expect(screen.queryByText("Alice")).not.toBeInTheDocument();
  });

  it("names a grouped-turn editor with its speaker and timestamp and describes the keyboard save shortcut", async () => {
    const onEditSegment = vi.fn(async () => {});

    render(
      <TranscriptViewer
        segments={GROUPED_TURN_SEGMENTS}
        onEditSegment={onEditSegment}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit segment" }));

    const editor = screen.getByRole("textbox", {
      name: "Edit transcript for Me at 0:00.00",
    });
    expect(editor).toHaveAccessibleDescription("Cmd/Ctrl+Enter to save");

    fireEvent.change(editor, {
      target: { value: "We agreed on Tuesday." },
    });
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });

    await waitFor(() => {
      expect(onEditSegment).toHaveBeenCalledWith(
        ["seg-1", "seg-2"],
        "We agreed on Tuesday."
      );
    });
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

  it("disables speaker-turn save for whitespace-only text", () => {
    const onEditSegment = vi.fn(async () => {});

    render(
      <TranscriptViewer
        segments={GROUPED_TURN_SEGMENTS}
        onEditSegment={onEditSegment}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit segment" }));
    const editor = screen.getByRole("textbox");
    fireEvent.change(editor, { target: { value: "   \n" } });

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.keyDown(editor, { key: "Enter", metaKey: true });
    expect(onEditSegment).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("keeps the speaker-turn editor open when the atomic save rejects", async () => {
    const pendingSave = deferred<void>();
    const onEditSegment = vi.fn(() => pendingSave.promise);

    render(
      <TranscriptViewer
        segments={GROUPED_TURN_SEGMENTS}
        onEditSegment={onEditSegment}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit segment" }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "A correction that must stay visible." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await act(async () => {
      pendingSave.reject(new Error("Atomic transcript write failed"));
      await pendingSave.promise.catch(() => undefined);
    });

    expect(screen.getByRole("textbox")).toHaveValue(
      "A correction that must stay visible."
    );
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

  it("asks before cutting a speaker turn, and names what would be lost", async () => {
    const onDeleteSegments = vi.fn(async () => {});

    render(
      <TranscriptViewer
        segments={GROUPED_TURN_SEGMENTS}
        onEditSegment={vi.fn()}
        onDeleteSegments={onDeleteSegments}
        deleteRecoveryNote="The audio is still saved."
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete this speaker turn" }));

    // Nothing is written on the click itself: the whole turn is chained with no
    // time bound, so one stray tap used to remove it outright.
    expect(onDeleteSegments).not.toHaveBeenCalled();

    const dialog = await screen.findByRole("dialog");
    // Two lines, eight words, whose turn, and where it starts — plus the way
    // back, which the caller had to prove before it could be claimed.
    expect(dialog).toHaveTextContent("Removes 2 transcript lines");
    expect(dialog).toHaveTextContent("8 words");
    expect(dialog).toHaveTextContent("one speaker turn by Me");
    expect(dialog).toHaveTextContent("starting at 0:00.00");
    expect(dialog).toHaveTextContent("The audio is still saved.");
    // The words themselves are quoted back before they go.
    expect(dialog).toHaveTextContent("We agreed on the plan. Kickoff is Monday.");

    fireEvent.click(screen.getByRole("button", { name: "Delete 2 lines" }));

    await waitFor(() => {
      expect(onDeleteSegments).toHaveBeenCalledWith(["seg-1", "seg-2"]);
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("keeps the turn when the delete confirmation is declined", async () => {
    const onDeleteSegments = vi.fn(async () => {});

    render(
      <TranscriptViewer
        segments={GROUPED_TURN_SEGMENTS}
        onEditSegment={vi.fn()}
        onDeleteSegments={onDeleteSegments}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete this speaker turn" }));
    fireEvent.click(await screen.findByRole("button", { name: "Keep this turn" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(onDeleteSegments).not.toHaveBeenCalled();
    expect(screen.getByText(/We agreed on the plan/i)).toBeInTheDocument();
  });

  it("gives Edit and Delete 24px targets with real space between them", () => {
    // They were ~16px icons 4px apart, under the 24px WCAG 2.5.8 floor, and the
    // copy above the transcript sends readers to this corner for Edit.
    render(
      <TranscriptViewer
        segments={GROUPED_TURN_SEGMENTS}
        onEditSegment={vi.fn()}
        onDeleteSegments={vi.fn()}
      />
    );

    const edit = screen.getByRole("button", { name: "Edit segment" });
    const remove = screen.getByRole("button", { name: "Delete this speaker turn" });

    for (const control of [edit, remove]) {
      expect(control).toHaveClass("h-6", "w-6");
      expect(control.className).not.toMatch(/\bp-0\.5\b/);
    }
    expect(edit.parentElement).toBe(remove.parentElement);
    expect(edit.parentElement).toHaveClass("gap-3");
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
