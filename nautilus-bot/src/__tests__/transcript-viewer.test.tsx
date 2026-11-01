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
const GROUPED_TURN_DELETE_EXPECTATIONS = GROUPED_TURN_SEGMENTS.map(
  ({ id, text, startTime, endTime, speakerId }) => ({
    id,
    text,
    startTime,
    endTime,
    speakerId,
  }),
);

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
  it.each([0, 0.88, 0.9, 0.92, 0.94])(
    "does not present recognizer score %s as accuracy or a review verdict",
    (confidence) => {
      const segments = GROUPED_TURN_SEGMENTS.map(segment => ({ ...segment, confidence }));
      render(<TranscriptViewer segments={segments} />);
      expect(screen.queryByText(/% avg conf/)).not.toBeInTheDocument();
      expect(screen.queryByText("Low confidence")).not.toBeInTheDocument();
      expect(screen.getByText("8 words")).toBeInTheDocument();
      expect(screen.getByText(/We agreed on the plan/)).toBeInTheDocument();
    },
  );

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

  describe("speaker name editor recovery", () => {
    const openEditor = () => {
      fireEvent.click(screen.getByRole("button", { name: "Rename Speakers" }));
      fireEvent.click(screen.getByRole("button", { name: "Edit speaker name" }));
      return screen.getByLabelText("Speaker name");
    };

    it("preserves a dirty draft when refreshed speaker metadata arrives", () => {
      const onRenameSpeaker = vi.fn(async () => {});
      const { rerender } = render(
        <TranscriptViewer
          segments={GROUPED_TURN_SEGMENTS}
          speakerNames={{ me: "Stored name" }}
          onRenameSpeaker={onRenameSpeaker}
        />,
      );

      const editor = openEditor();
      fireEvent.change(editor, { target: { value: "Manual draft" } });
      rerender(
        <TranscriptViewer
          segments={GROUPED_TURN_SEGMENTS}
          speakerNames={{ me: "Refreshed alias" }}
          onRenameSpeaker={onRenameSpeaker}
        />,
      );

      expect(screen.getByLabelText("Speaker name")).toHaveValue("Manual draft");
    });

    it("adopts refreshed metadata while the open editor is still clean", () => {
      const onRenameSpeaker = vi.fn(async () => {});
      const { rerender } = render(
        <TranscriptViewer
          segments={GROUPED_TURN_SEGMENTS}
          speakerNames={{ me: "Stored name" }}
          onRenameSpeaker={onRenameSpeaker}
        />,
      );

      openEditor();
      rerender(
        <TranscriptViewer
          segments={GROUPED_TURN_SEGMENTS}
          speakerNames={{ me: "Refreshed alias" }}
          onRenameSpeaker={onRenameSpeaker}
        />,
      );

      expect(screen.getByLabelText("Speaker name")).toHaveValue("Refreshed alias");
    });

    it("keeps the submitted draft through pending refreshes and a failed save, then retries", async () => {
      const firstSave = deferred<void>();
      const onRenameSpeaker = vi
        .fn()
        .mockImplementationOnce(() => firstSave.promise)
        .mockResolvedValueOnce(undefined);
      const { rerender } = render(
        <TranscriptViewer
          segments={GROUPED_TURN_SEGMENTS}
          speakerNames={{ me: "Stored name" }}
          onRenameSpeaker={onRenameSpeaker}
        />,
      );

      const editor = openEditor();
      fireEvent.change(editor, { target: { value: "Exact retry draft" } });
      fireEvent.click(screen.getByRole("button", { name: "Save speaker name" }));
      rerender(
        <TranscriptViewer
          segments={GROUPED_TURN_SEGMENTS}
          speakerNames={{ me: "Background refresh" }}
          onRenameSpeaker={onRenameSpeaker}
        />,
      );
      expect(screen.getByLabelText("Speaker name")).toHaveValue("Exact retry draft");

      await act(async () => {
        firstSave.reject(new Error("write failed"));
        await firstSave.promise.catch(() => undefined);
      });

      expect(screen.getByRole("alert")).toHaveTextContent(/could not save.*try again/i);
      expect(screen.getByLabelText("Speaker name")).toHaveValue("Exact retry draft");
      fireEvent.click(screen.getByRole("button", { name: "Save speaker name" }));
      await waitFor(() => expect(onRenameSpeaker).toHaveBeenCalledTimes(2));
      expect(onRenameSpeaker).toHaveBeenLastCalledWith("me", "Exact retry draft", false);
    });

    it("single-flights duplicate saves and ignores Enter during IME composition", async () => {
      const pendingRename = deferred<void>();
      const onRenameSpeaker = vi.fn(() => pendingRename.promise);
      const editor = (() => {
        render(
          <TranscriptViewer
            segments={GROUPED_TURN_SEGMENTS}
            onRenameSpeaker={onRenameSpeaker}
          />,
        );
        return openEditor();
      })();
      fireEvent.change(editor, { target: { value: "Alice" } });

      fireEvent.keyDown(editor, { key: "Enter", isComposing: true });
      expect(onRenameSpeaker).not.toHaveBeenCalled();
      fireEvent.keyDown(editor, { key: "Enter" });
      fireEvent.keyDown(editor, { key: "Enter" });
      expect(onRenameSpeaker).toHaveBeenCalledTimes(1);
      fireEvent.keyDown(editor, { key: "Escape" });
      expect(screen.getByLabelText("Speaker name")).toHaveValue("Alice");

      await act(async () => {
        pendingRename.resolve();
        await pendingRename.promise;
      });
    });

    it("keeps a pending save owned across equivalent callback rerenders", async () => {
      const pendingRename = deferred<void>();
      const persistedRename = vi.fn(
        (_speakerId: string, _name: string, _remember?: boolean) => pendingRename.promise,
      );
      const firstCallback = (speakerId: string, name: string, remember?: boolean) =>
        persistedRename(speakerId, name, remember);
      const { rerender } = render(
        <TranscriptViewer
          segments={GROUPED_TURN_SEGMENTS}
          onRenameSpeaker={firstCallback}
        />,
      );
      const editor = openEditor();
      fireEvent.change(editor, { target: { value: "Alice" } });
      fireEvent.click(screen.getByRole("button", { name: "Save speaker name" }));

      rerender(
        <TranscriptViewer
          segments={GROUPED_TURN_SEGMENTS}
          onRenameSpeaker={(speakerId, name, remember) =>
            persistedRename(speakerId, name, remember)
          }
        />,
      );

      expect(screen.getByLabelText("Speaker name")).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "Save speaker name" }));
      expect(persistedRename).toHaveBeenCalledTimes(1);

      await act(async () => {
        pendingRename.resolve();
        await pendingRename.promise;
      });

      expect(screen.queryByLabelText("Speaker name")).not.toBeInTheDocument();
    });

    it("cancels a draft and reopens with the latest stored name", () => {
      const onRenameSpeaker = vi.fn(async () => {});
      const { rerender } = render(
        <TranscriptViewer
          segments={GROUPED_TURN_SEGMENTS}
          speakerNames={{ me: "Stored name" }}
          onRenameSpeaker={onRenameSpeaker}
        />,
      );

      const editor = openEditor();
      fireEvent.change(editor, { target: { value: "Discard me" } });
      rerender(
        <TranscriptViewer
          segments={GROUPED_TURN_SEGMENTS}
          speakerNames={{ me: "Latest stored name" }}
          onRenameSpeaker={onRenameSpeaker}
        />,
      );
      fireEvent.keyDown(screen.getByLabelText("Speaker name"), { key: "Escape" });
      fireEvent.click(screen.getByRole("button", { name: "Edit speaker name" }));

      expect(screen.getByLabelText("Speaker name")).toHaveValue("Latest stored name");
    });
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
        "We agreed on Tuesday.",
        GROUPED_TURN_DELETE_EXPECTATIONS
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
        "We agreed on the plan. Kickoff is Tuesday.",
        GROUPED_TURN_DELETE_EXPECTATIONS
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

  it("says a finished meeting heard nothing instead of promising a transcript", () => {
    const { rerender } = render(<TranscriptViewer segments={[]} />);
    expect(screen.getByText("No transcript available")).toBeInTheDocument();

    rerender(
      <TranscriptViewer
        segments={[]}
        emptyState={{ title: "No speech was heard", message: "Nothing to transcribe." }}
      />,
    );
    expect(screen.getByText("No speech was heard")).toBeInTheDocument();
    expect(screen.queryByText(/will appear here once processing/)).not.toBeInTheDocument();
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

  it("counts and highlights a phrase across word rows and speaker turns", () => {
    const onMatchesChange = vi.fn();
    const segments = ["one", "point", "four", "then", "one", "point", "four"].map((text, index) => ({
      id: `word-${index}`, startTime: index, endTime: index + 0.5, text,
      speakerId: index % 2 ? "speaker-b" : "speaker-a", confidence: 0.9,
    }));
    const { rerender } = render(<TranscriptViewer segments={segments} highlightQuery="one point four" activeMatchIndex={0} onMatchesChange={onMatchesChange} />);
    expect(onMatchesChange).toHaveBeenLastCalledWith([
      { segmentId: "word-0", startTime: 0 }, { segmentId: "word-4", startTime: 4 },
    ]);
    const marks = [...document.querySelectorAll("mark")];
    expect(marks.map(mark => mark.textContent)).toEqual(["one", "point", "four", "one", "point", "four"]);
    expect(marks.filter(mark => mark.classList.contains("bg-gold/25"))).toHaveLength(3);
    rerender(<TranscriptViewer segments={segments} highlightQuery="one point four" activeMatchIndex={1} onMatchesChange={onMatchesChange} />);
    expect([...document.querySelectorAll("mark")].filter(mark => mark.classList.contains("bg-gold/25")).map(mark => mark.textContent)).toEqual(["one", "point", "four"]);
    expect(screen.getByText("then")).toBeInTheDocument();
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
      expect(onDeleteSegments).toHaveBeenCalledWith(
        ["seg-1", "seg-2"],
        GROUPED_TURN_DELETE_EXPECTATIONS,
      );
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

  it("explains a failed deletion and retries the same quoted turn", async () => {
    const onDeleteSegments = vi.fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(undefined);
    render(<TranscriptViewer
      segments={GROUPED_TURN_SEGMENTS}
      onEditSegment={vi.fn()}
      onDeleteSegments={onDeleteSegments}
    />);
    fireEvent.click(screen.getByRole("button", { name: "Delete this speaker turn" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete 2 lines" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not remove this turn");
    expect(screen.getByRole("dialog")).toHaveTextContent("We agreed on the plan. Kickoff is Monday.");
    fireEvent.click(screen.getByRole("button", { name: "Delete 2 lines" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(onDeleteSegments).toHaveBeenNthCalledWith(
      2,
      ["seg-1", "seg-2"],
      GROUPED_TURN_DELETE_EXPECTATIONS,
    );
  });

  describe("guarded transcript deletion", () => {
    const expectedTurn = GROUPED_TURN_DELETE_EXPECTATIONS;

    it("blocks confirmation when a quoted row changes and keeps the old quote", async () => {
      const onDeleteSegments = vi.fn(async () => {});
      const { rerender } = render(
        <TranscriptViewer
          segments={GROUPED_TURN_SEGMENTS}
          onEditSegment={vi.fn()}
          onDeleteSegments={onDeleteSegments}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Delete this speaker turn" }));

      rerender(
        <TranscriptViewer
          segments={[{ ...GROUPED_TURN_SEGMENTS[0], text: "The plan changed." }, GROUPED_TURN_SEGMENTS[1]]}
          onEditSegment={vi.fn()}
          onDeleteSegments={onDeleteSegments}
        />,
      );

      expect(screen.getByRole("dialog")).toHaveTextContent(
        "We agreed on the plan. Kickoff is Monday.",
      );
      expect(screen.getByRole("button", { name: "Delete 2 lines" })).toBeDisabled();
      expect(screen.getByRole("alert")).toHaveTextContent(/turn changed.*keep.*reopen/i);
      expect(onDeleteSegments).not.toHaveBeenCalled();
    });

    it("sends the unchanged quoted snapshot with the segment ids", async () => {
      const onDeleteSegments = vi.fn(async () => {});
      render(
        <TranscriptViewer
          segments={GROUPED_TURN_SEGMENTS}
          onEditSegment={vi.fn()}
          onDeleteSegments={onDeleteSegments}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Delete this speaker turn" }));
      fireEvent.click(await screen.findByRole("button", { name: "Delete 2 lines" }));

      await waitFor(() =>
        expect(onDeleteSegments).toHaveBeenCalledWith(
          ["seg-1", "seg-2"],
          expectedTurn,
        ),
      );
    });

    it("allows confirmation when only unrelated rows are appended", async () => {
      const onDeleteSegments = vi.fn(async () => {});
      const { rerender } = render(
        <TranscriptViewer
          segments={GROUPED_TURN_SEGMENTS}
          onEditSegment={vi.fn()}
          onDeleteSegments={onDeleteSegments}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Delete this speaker turn" }));
      rerender(
        <TranscriptViewer
          segments={[
            ...GROUPED_TURN_SEGMENTS,
            { id: "seg-3", startTime: 8, endTime: 9, text: "An unrelated later row.", speakerId: "them", confidence: 0.8 },
          ]}
          onEditSegment={vi.fn()}
          onDeleteSegments={onDeleteSegments}
        />,
      );

      const confirm = screen.getByRole("button", { name: "Delete 2 lines" });
      expect(confirm).toBeEnabled();
      fireEvent.click(confirm);
      await waitFor(() => expect(onDeleteSegments).toHaveBeenCalledTimes(1));
    });

    it("keeps the original expectations while deletion is pending through rerenders", async () => {
      const deletion = deferred<void>();
      const onDeleteSegments = vi.fn(() => deletion.promise);
      const { rerender } = render(
        <TranscriptViewer
          segments={GROUPED_TURN_SEGMENTS}
          onEditSegment={vi.fn()}
          onDeleteSegments={onDeleteSegments}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Delete this speaker turn" }));
      fireEvent.click(await screen.findByRole("button", { name: "Delete 2 lines" }));
      rerender(
        <TranscriptViewer
          segments={[{ ...GROUPED_TURN_SEGMENTS[0], text: "A later mutation." }, GROUPED_TURN_SEGMENTS[1]]}
          onEditSegment={vi.fn()}
          onDeleteSegments={async () => {}}
        />,
      );

      expect(onDeleteSegments).toHaveBeenCalledWith(["seg-1", "seg-2"], expectedTurn);
      expect(screen.getByRole("button", { name: "Removing…" })).toBeDisabled();
      await act(async () => {
        deletion.resolve();
        await deletion.promise;
      });
    });
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

describe("transcript edit save ownership", () => {
  const TWO_TURN_SEGMENTS = [
    ...GROUPED_TURN_SEGMENTS,
    {
      id: "seg-3",
      startTime: 8,
      endTime: 9,
      text: "Legal still has to sign off.",
      speakerId: "them",
      confidence: 0.9,
    },
  ];

  it("keeps newer typing after an earlier save resolves and resaves the exact newer text", async () => {
    const firstSave = deferred<void>();
    const onEditSegment = vi
      .fn()
      .mockImplementationOnce(() => firstSave.promise)
      .mockResolvedValueOnce(undefined);

    render(
      <TranscriptViewer
        segments={GROUPED_TURN_SEGMENTS}
        onEditSegment={onEditSegment}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit segment" }));
    const editor = screen.getByRole("textbox");
    fireEvent.change(editor, { target: { value: "First correction." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.change(editor, { target: { value: "Newer correction." } });

    await act(async () => {
      firstSave.resolve();
      await firstSave.promise;
    });

    expect(screen.getByRole("textbox")).toHaveValue("Newer correction.");
    expect(
      screen.getByText(
        "Earlier correction saved. Your newer changes are not saved yet."
      )
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(onEditSegment).toHaveBeenNthCalledWith(
        2,
        ["seg-1"],
        "Newer correction.",
        [{ ...GROUPED_TURN_DELETE_EXPECTATIONS[0], text: "First correction." }]
      );
    });
  });

  it("keeps the typing selection when an unsaved correction moves out of its source turn", () => {
    const onEditSegment = vi.fn();
    const { rerender } = render(<TranscriptViewer segments={GROUPED_TURN_SEGMENTS} onEditSegment={onEditSegment} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit segment" }));
    const editor = screen.getByRole("textbox");
    fireEvent.change(editor, { target: { value: "My unsaved correction." } });
    editor.focus();
    if (!(editor instanceof HTMLTextAreaElement)) throw new Error("Expected transcript textarea");
    editor.setSelectionRange(5, 9, "backward");
    rerender(<TranscriptViewer segments={[]} onEditSegment={onEditSegment} />);
    const retained = screen.getByRole("textbox");
    expect(retained).toHaveValue("My unsaved correction.");
    expect(retained).toHaveFocus();
    if (!(retained instanceof HTMLTextAreaElement)) throw new Error("Expected retained textarea");
    expect(retained.selectionStart).toBe(5);
    expect(retained.selectionEnd).toBe(9);
    expect(retained.selectionDirection).toBe("backward");
  });

  it("does not focus a relocated draft when the reader left its editor", () => {
    const onEditSegment = vi.fn();
    const { rerender } = render(<><button>Outside transcript</button><TranscriptViewer segments={GROUPED_TURN_SEGMENTS} onEditSegment={onEditSegment} /></>);
    fireEvent.click(screen.getByRole("button", { name: "Edit segment" }));
    screen.getByRole("button", { name: "Outside transcript" }).focus();
    rerender(<><button>Outside transcript</button><TranscriptViewer segments={[]} onEditSegment={onEditSegment} /></>);
    expect(screen.getByRole("button", { name: "Outside transcript" })).toHaveFocus();
    expect(screen.getByRole("textbox")).not.toHaveFocus();
  });

  it("does not carry a canceled draft selection into a new edit session", () => {
    render(<TranscriptViewer segments={GROUPED_TURN_SEGMENTS} onEditSegment={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit segment" }));
    const editor = screen.getByRole("textbox");
    if (!(editor instanceof HTMLTextAreaElement)) throw new Error("Expected transcript textarea");
    editor.setSelectionRange(5, 9, "backward");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit segment" }));
    const next = screen.getByRole("textbox");
    if (!(next instanceof HTMLTextAreaElement)) throw new Error("Expected transcript textarea");
    expect(next).toHaveFocus();
    expect(next.selectionStart).toBe(next.selectionEnd);
    expect(next.selectionDirection).not.toBe("backward");
  });

  it("keeps an unsaved correction visible when its selected source turn disappears", () => {
    const onEditSegment = vi.fn();
    const { rerender } = render(<TranscriptViewer segments={GROUPED_TURN_SEGMENTS} onEditSegment={onEditSegment} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit segment" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "My unsaved correction." } });
    rerender(<TranscriptViewer segments={[]} onEditSegment={onEditSegment} />);
    expect(screen.getByRole("textbox")).toHaveValue("My unsaved correction.");
    expect(onEditSegment).not.toHaveBeenCalled();
  });

  it("retains the draft and frozen baseline after a stale edit conflict", async () => {
    const onEditSegment = vi.fn().mockRejectedValue(new Error("Transcript changed. Review the current turn before saving your correction."));
    const { rerender } = render(<TranscriptViewer segments={GROUPED_TURN_SEGMENTS} onEditSegment={onEditSegment} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit segment" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "My correction." } });
    rerender(<TranscriptViewer segments={GROUPED_TURN_SEGMENTS.map((segment) => ({ ...segment, text: "Other editor saved." }))} onEditSegment={onEditSegment} />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Transcript changed. Your correction is still here. Review the current turn before saving again.");
    expect(screen.getByRole("textbox")).toHaveValue("My correction.");
    expect(onEditSegment).toHaveBeenCalledTimes(1);
    expect(onEditSegment).toHaveBeenCalledWith(["seg-1", "seg-2"], "My correction.", GROUPED_TURN_DELETE_EXPECTATIONS);
  });

  it("allows saving and reviewing a mixed null and undefined unattributed turn", async () => {
    const mixed = [{ ...GROUPED_TURN_SEGMENTS[0], speakerId: null }, { ...GROUPED_TURN_SEGMENTS[1], speakerId: undefined }];
    const onEditSegment = vi.fn().mockRejectedValueOnce(new Error("Transcript changed")).mockResolvedValue(undefined);
    render(<TranscriptViewer segments={mixed} onEditSegment={onEditSegment} onReloadTranscriptForEdit={async () => mixed} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit segment" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Unattributed correction." } });
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("button", { name: "Review saved text" });
    fireEvent.click(screen.getByRole("button", { name: "Review saved text" }));
    fireEvent.click(await screen.findByRole("button", { name: "Keep my correction" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onEditSegment).toHaveBeenCalledTimes(2));
    expect(onEditSegment).toHaveBeenLastCalledWith(["seg-1", "seg-2"], "Unattributed correction.", GROUPED_TURN_DELETE_EXPECTATIONS.map(segment => ({ ...segment, speakerId: null })));
  });

  it("keeps the custom speaker name in the correction editor label", () => {
    render(<TranscriptViewer segments={GROUPED_TURN_SEGMENTS} speakerNames={{ me: "Jonathan" }} onEditSegment={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit segment" }));
    expect(screen.getByRole("textbox", { name: /Edit transcript for Jonathan at/ })).toBeInTheDocument();
  });

  it("reviews fresh selected text and explicitly rebases the exact continued draft", async () => {
    const fresh = GROUPED_TURN_SEGMENTS.map(segment => ({ ...segment, text: "Saved elsewhere." }));
    const read = deferred<typeof fresh>();
    const onReloadTranscriptForEdit = vi.fn(() => read.promise);
    const onEditSegment = vi.fn().mockRejectedValueOnce(new Error("Transcript changed")).mockRejectedValueOnce(new Error("Transcript changed again"));
    render(<TranscriptViewer segments={GROUPED_TURN_SEGMENTS} onEditSegment={onEditSegment} onReloadTranscriptForEdit={onReloadTranscriptForEdit} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit segment" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "My correction." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("button", { name: "Review saved text" });
    fireEvent.click(screen.getByRole("button", { name: "Review saved text" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "My newer correction." } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", ctrlKey: true });
    expect(onEditSegment).toHaveBeenCalledTimes(1);
    await act(async () => read.resolve([...fresh, { ...fresh[1], id: "appended", text: "Later speech." }]));
    expect(screen.getByText("Current saved selected passage: Saved elsewhere. Saved elsewhere.")).toBeInTheDocument();
    expect(screen.queryByText(/Current saved selected passage:.*Later speech/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep my correction" }));
    expect(screen.getByRole("textbox")).toHaveValue("My newer correction.");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onEditSegment).toHaveBeenCalledTimes(2));
    expect(onEditSegment).toHaveBeenLastCalledWith(["seg-1", "seg-2"], "My newer correction.", fresh.map(({ confidence, ...segment }) => segment));
    await screen.findByText("Transcript changed. Your correction is still here. Review the current turn before saving again.");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("discards a slow review after cancel and a new edit", async () => {
    const read = deferred<typeof GROUPED_TURN_SEGMENTS>();
    const onEditSegment = vi.fn().mockRejectedValue(new Error("Transcript changed"));
    render(<TranscriptViewer segments={GROUPED_TURN_SEGMENTS} onEditSegment={onEditSegment} onReloadTranscriptForEdit={() => read.promise} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit segment" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("button", { name: "Review saved text" });
    fireEvent.click(screen.getByRole("button", { name: "Review saved text" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit segment" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "New session draft." } });
    await act(async () => read.resolve(GROUPED_TURN_SEGMENTS));
    expect(screen.getByRole("textbox")).toHaveValue("New session draft.");
    expect(screen.queryByRole("button", { name: "Keep my correction" })).not.toBeInTheDocument();
  });

  it.each(["missing", "split", "interleaved"])("preserves a correction when review finds a %s selected passage", async (change) => {
    const onEditSegment = vi.fn().mockRejectedValue(new Error("Transcript changed"));
    const fresh = change === "missing" ? GROUPED_TURN_SEGMENTS.slice(1) : change === "split"
      ? [GROUPED_TURN_SEGMENTS[0], { ...GROUPED_TURN_SEGMENTS[1], speakerId: "them" }]
      : [GROUPED_TURN_SEGMENTS[0], { ...GROUPED_TURN_SEGMENTS[0], id: "interleaved" }, GROUPED_TURN_SEGMENTS[1]];
    render(<TranscriptViewer segments={GROUPED_TURN_SEGMENTS} onEditSegment={onEditSegment} onReloadTranscriptForEdit={async () => fresh} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit segment" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Keep this draft." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("button", { name: "Review saved text" });
    fireEvent.click(screen.getByRole("button", { name: "Review saved text" }));
    await screen.findByText(/The selected passage is unavailable/);
    expect(screen.getByRole("textbox")).toHaveValue("Keep this draft.");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Keep my correction" })).not.toBeInTheDocument();
  });

  it("retains the draft on clipboard failure and ignores a late copy acknowledgment", async () => {
    const copied = deferred<void>();
    const writeText = vi.fn().mockRejectedValueOnce(new Error("Clipboard denied")).mockImplementationOnce(() => copied.promise);
    const previous = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      render(<TranscriptViewer segments={GROUPED_TURN_SEGMENTS} onEditSegment={vi.fn()} />);
      fireEvent.click(screen.getByRole("button", { name: "Edit segment" }));
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "Copy this correction." } });
      fireEvent.click(screen.getByRole("button", { name: "Copy correction" }));
      await screen.findByText("Could not copy. Select your correction and copy it manually.");
      expect(screen.getByRole("textbox")).toHaveValue("Copy this correction.");
      fireEvent.click(screen.getByRole("button", { name: "Copy correction" }));
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      fireEvent.click(screen.getByRole("button", { name: "Edit segment" }));
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "Different correction." } });
      await act(async () => copied.resolve());
      expect(screen.queryByText("Correction copied.")).not.toBeInTheDocument();
      expect(screen.getByRole("textbox")).toHaveValue("Different correction.");
    } finally {
      if (previous) Object.defineProperty(navigator, "clipboard", previous);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("saves only the segments selected before new speech joins the turn", async () => {
    const onEditSegment = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <TranscriptViewer segments={GROUPED_TURN_SEGMENTS} onEditSegment={onEditSegment} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit segment" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Selected correction." } });

    rerender(
      <TranscriptViewer
        segments={[...GROUPED_TURN_SEGMENTS.map((segment) => ({ ...segment, text: "Changed externally." })), {
          ...GROUPED_TURN_SEGMENTS[1],
          id: "new-speech",
          startTime: GROUPED_TURN_SEGMENTS[1].endTime,
          endTime: GROUPED_TURN_SEGMENTS[1].endTime + 1,
          text: "New speech must survive.",
        }]}
        onEditSegment={onEditSegment}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onEditSegment).toHaveBeenCalledWith(
      ["seg-1", "seg-2"], "Selected correction.", GROUPED_TURN_DELETE_EXPECTATIONS
    ));
  });

  it("keeps ownership when the draft changes and then returns to the submitted text", async () => {
    const firstSave = deferred<void>();
    const onEditSegment = vi.fn(() => firstSave.promise);

    render(
      <TranscriptViewer
        segments={GROUPED_TURN_SEGMENTS}
        onEditSegment={onEditSegment}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit segment" }));
    const editor = screen.getByRole("textbox");
    fireEvent.change(editor, { target: { value: "Submitted correction." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.change(editor, { target: { value: "Temporary newer text." } });
    fireEvent.change(editor, { target: { value: "Submitted correction." } });

    await act(async () => {
      firstSave.resolve();
      await firstSave.promise;
    });

    expect(screen.getByRole("textbox")).toHaveValue("Submitted correction.");
    expect(
      screen.getByText(
        "Correction saved. The editor is still open for your next change."
      )
    ).toBeInTheDocument();
  });

  it("keeps a failed draft available for retry and reports the failure beside it", async () => {
    const onEditSegment = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce(undefined);

    render(
      <TranscriptViewer
        segments={GROUPED_TURN_SEGMENTS}
        onEditSegment={onEditSegment}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit segment" }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Correction worth keeping." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /could not save/i
    );
    expect(screen.getByRole("textbox")).toHaveValue(
      "Correction worth keeping."
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onEditSegment).toHaveBeenCalledTimes(2));
    expect(onEditSegment).toHaveBeenLastCalledWith(
      ["seg-1", "seg-2"],
      "Correction worth keeping.",
      GROUPED_TURN_DELETE_EXPECTATIONS
    );
  });

  it("allows only one save request at a time", async () => {
    const pendingSave = deferred<void>();
    const onEditSegment = vi.fn(() => pendingSave.promise);

    render(
      <TranscriptViewer
        segments={GROUPED_TURN_SEGMENTS}
        onEditSegment={onEditSegment}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit segment" }));
    const editor = screen.getByRole("textbox");
    fireEvent.change(editor, { target: { value: "One correction." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.keyDown(editor, { key: "Enter", metaKey: true });
    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });

    expect(onEditSegment).toHaveBeenCalledTimes(1);

    await act(async () => {
      pendingSave.resolve();
      await pendingSave.promise;
    });
  });

  it("keeps the current draft while another turn's edit control is disabled", () => {
    render(
      <TranscriptViewer
        segments={TWO_TURN_SEGMENTS}
        onEditSegment={vi.fn(async () => {})}
        onDeleteSegments={vi.fn(async () => {})}
      />
    );

    const editButtons = screen.getAllByRole("button", { name: "Edit segment" });
    fireEvent.click(editButtons[0]);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Unsaved current draft." },
    });

    expect(editButtons[1]).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete this speaker turn" })).toBeDisabled();
    fireEvent.click(editButtons[1]);
    expect(screen.getByRole("textbox")).toHaveValue("Unsaved current draft.");
  });

  it("ignores save and cancel shortcuts during composition and cannot cancel a pending save", async () => {
    const pendingSave = deferred<void>();
    const onEditSegment = vi.fn(() => pendingSave.promise);

    render(
      <TranscriptViewer
        segments={GROUPED_TURN_SEGMENTS}
        onEditSegment={onEditSegment}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit segment" }));
    const editor = screen.getByRole("textbox");
    fireEvent.change(editor, { target: { value: "Composed correction." } });
    fireEvent.keyDown(editor, {
      key: "Enter",
      metaKey: true,
      isComposing: true,
    });
    fireEvent.keyDown(editor, { key: "Escape", isComposing: true });

    expect(onEditSegment).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveValue("Composed correction.");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.keyDown(editor, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByRole("textbox")).toHaveValue("Composed correction.");

    await act(async () => {
      pendingSave.resolve();
      await pendingSave.promise;
    });
  });

  it("does not let a save from an unmounted source close the next source's editor", async () => {
    const oldSave = deferred<void>();
    const onEditSegment = vi.fn(() => oldSave.promise);
    const { rerender } = render(
      <TranscriptViewer
        key="source-a"
        segments={GROUPED_TURN_SEGMENTS}
        onEditSegment={onEditSegment}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit segment" }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Source A correction." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    rerender(
      <TranscriptViewer
        key="source-b"
        segments={TWO_TURN_SEGMENTS}
        onEditSegment={vi.fn(async () => {})}
      />
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Edit segment" })[1]);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Source B draft." },
    });

    await act(async () => {
      oldSave.resolve();
      await oldSave.promise;
    });

    expect(screen.getByRole("textbox")).toHaveValue("Source B draft.");
  });
});
