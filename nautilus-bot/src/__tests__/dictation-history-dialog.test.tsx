import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DictationHistoryDialog } from "@/components/views/dictation/dictation-history-dialog";
import type {
  DictationHistoryDetails,
  DictationReprocessOutcome,
  DictationReprocessResult,
} from "@/lib/backend/dictation";
import type { Recording, Transcript } from "@/types";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const recording: Recording = {
  id: "dictation-1",
  title: "First dictation",
  projectId: "inbox",
  duration: 4,
  createdAt: "2026-10-11T12:00:00.000Z",
  updatedAt: "2026-10-11T12:00:00.000Z",
  sourceType: "dictation",
  audioPath: "/tmp/dictation-1.wav",
  status: "completed",
};

const transcript: Transcript = {
  id: "transcript-1",
  recordingId: recording.id,
  segments: [],
  fullText: "Saved result from storage.",
  language: "en",
  confidence: 0.98,
  model: "test-model",
};

const historyDetails: DictationHistoryDetails = {
  modePreset: "notes",
  modeLabel: "Note",
  baseModePreset: "notes",
  baseModeLabel: "Note",
  customModeId: null,
  customModeName: null,
  contextSource: null,
  contextAppName: null,
  appTarget: null,
  activationMatcher: null,
  commandApplied: null,
  dictionaryAppliedCount: 0,
  snippetAppliedCount: 0,
  formattingApplied: true,
  recentInsertReused: false,
  pipelineStageKeys: [],
  promptSource: null,
  promptPreview: null,
  requestedProvider: "local",
  actualProvider: "local",
  modelId: "test-model",
  routePreference: "local",
  resolvedHosting: "local",
  startupLatencyMs: 10,
  transcriptionLatencyMs: 20,
  insertLatencyMs: 5,
  endToEndMs: 35,
  rawTranscript: "  recognizer words  \nsecond line\n",
  audioAvailable: true,
};

const reprocessedResult: DictationReprocessResult = {
  modePreset: "polished",
  outputText: "Style preview text.",
  usedAi: true,
  provider: "local",
  modelId: "test-model",
};

const processAgainOutcome: DictationReprocessOutcome = {
  recording: { ...recording, id: "dictation-2", title: "Retry" },
  transcript: {
    ...transcript,
    id: "transcript-2",
    recordingId: "dictation-2",
    fullText: "Retry result text.",
  },
  finalText: "Retry result text.",
  rawText: "retry raw text",
  modePreset: "notes",
  customModeId: null,
  customModeName: null,
  provider: "local",
  modelId: "test-model",
  usedAi: false,
  reprocessedFromId: recording.id,
  reprocessedFromCreatedAt: recording.createdAt,
  transcriptionLatencyMs: 25,
};

function dialogProps(overrides: Partial<React.ComponentProps<typeof DictationHistoryDialog>> = {}) {
  const props: React.ComponentProps<typeof DictationHistoryDialog> = {
    open: true,
    onOpenChange: vi.fn(),
    recording,
    transcript,
    historyDetails,
    isLoadingTranscript: false,
    durationLabel: "0:04",
    reprocessModePreset: "notes",
    onReprocessModePresetChange: vi.fn(),
    reprocessedResult,
    isReprocessing: false,
    reprocessError: null,
    onReprocess: vi.fn(),
    onUseReprocessedResult: vi.fn(),
    processAgainModeId: "notes",
    processAgainSpeechRoute: "current",
    processAgainSpeechOptions: [],
    onProcessAgainSpeechRouteChange: vi.fn(),
    onProcessAgainModeIdChange: vi.fn(),
    processAgainCustomModes: [],
    processAgainOutcome,
    isProcessingAgain: false,
    processAgainError: null,
    onProcessAgain: vi.fn(),
    onOpenProcessAgainResult: vi.fn(),
    correctionText: "Edited saved result.",
    onCorrectionTextChange: vi.fn(),
    onCorrectionBlur: vi.fn(),
    canLearnCorrection: false,
    onLearnCorrection: vi.fn(),
    learnStatus: null,
    isReadingAloud: false,
    onToggleReadAloud: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  };
  return props;
}

function renderDialog(overrides: Partial<React.ComponentProps<typeof DictationHistoryDialog>> = {}) {
  return render(<DictationHistoryDialog {...dialogProps(overrides)} />);
}

describe("DictationHistoryDialog keyboard focus", () => {
  it("returns to history search when refreshing removes the original opener", async () => {
    const opener = document.createElement("button");
    const search = document.createElement("input");
    document.body.append(opener, search);
    const props = dialogProps({ returnFocusTarget: opener, returnFocusFallback: search });
    try {
      const { rerender } = render(<DictationHistoryDialog {...props} />);
      await waitFor(() => expect(screen.getByRole("heading", { name: recording.title })).toHaveFocus());
      opener.remove();
      rerender(<DictationHistoryDialog {...props} open={false} />);
      await waitFor(() => expect(search).toHaveFocus());
    } finally {
      opener.remove();
      search.remove();
    }
  });

  it("ignores an old close callback after reopening and tolerates a removed opener", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    const props = dialogProps({ returnFocusTarget: opener });
    try {
      const { rerender } = render(<DictationHistoryDialog {...props} />);
      await waitFor(() => expect(screen.getByRole("heading", { name: recording.title })).toHaveFocus());
      rerender(<DictationHistoryDialog {...props} open={false} />);
      rerender(<DictationHistoryDialog {...props} recording={{ ...recording, id: "next", title: "Next result" }} />);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(screen.getByRole("heading", { name: "Next result" })).toHaveFocus();
      expect(opener).not.toHaveFocus();
      opener.remove();
      rerender(<DictationHistoryDialog {...props} open={false} />);
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    } finally {
      opener.remove();
    }
  });

  it("focuses the title while loading and keeps keyboard focus when the result arrives", async () => {
    const props = dialogProps({ transcript: null, historyDetails: null, isLoadingTranscript: true });
    const { rerender } = render(<DictationHistoryDialog {...props} />);
    const title = screen.getByRole("heading", { name: recording.title });
    await waitFor(() => expect(title).toHaveFocus());
    expect(screen.getByRole("button", { name: "Delete" })).not.toHaveFocus();

    const close = screen.getByRole("button", { name: "Close" });
    close.focus();
    rerender(<DictationHistoryDialog {...props} transcript={transcript} historyDetails={historyDetails} isLoadingTranscript={false} />);
    expect(close).toHaveFocus();
    expect(title).not.toHaveFocus();
  });
});

describe("DictationHistoryDialog clipboard actions", () => {
  const writeText = vi.fn<(_: string) => Promise<void>>();

  beforeEach(() => {
    writeText.mockReset();
    writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  it("shows review words only for the loaded original recording", () => {
    const props = dialogProps({ historyDetails: { ...historyDetails,
      rawTranscript: "The tailie text.",
      recognitionReviewWords: [{ word: "tailie", score: 0.533, startTime: 0, endTime: 1 }],
    }, correctionText: "The tally text." });
    const { rerender } = render(<DictationHistoryDialog {...props} />);
    expect(screen.getByLabelText("Original words to check")).toHaveTextContent("tailie");
    rerender(<DictationHistoryDialog {...props} recording={{ ...recording, id: "new-recording" }} />);
    expect(screen.queryByLabelText("Original words to check")).not.toBeInTheDocument();
    rerender(<DictationHistoryDialog {...props} isLoadingTranscript />);
    expect(screen.queryByLabelText("Original words to check")).not.toBeInTheDocument();
  });

  it("restores exact recognizer text to the draft without saving or replacing the original result", () => {
    const props = dialogProps({ onSaveEdit: vi.fn(), onRestoreOriginal: vi.fn() });
    const { rerender } = render(<DictationHistoryDialog {...props} />);
    const restore = screen.getByRole("button", { name: "Restore recognizer output" });

    fireEvent.click(restore);

    expect(props.onCorrectionTextChange).toHaveBeenCalledExactlyOnceWith(historyDetails.rawTranscript);
    expect(props.onSaveEdit).not.toHaveBeenCalled();
    expect(props.onRestoreOriginal).not.toHaveBeenCalled();
    expect(transcript.fullText).toBe("Saved result from storage.");

    rerender(<DictationHistoryDialog {...props} correctionText={historyDetails.rawTranscript!} />);
    expect(restore).toBeDisabled();
  });

  it("prevents restoring recognizer text while a saved edit is pending", () => {
    const props = dialogProps({ isSavingEdit: true });
    render(<DictationHistoryDialog {...props} />);

    const restore = screen.getByRole("button", { name: "Restore recognizer output" });
    expect(restore).toBeDisabled();
    fireEvent.click(restore);
    expect(props.onCorrectionTextChange).not.toHaveBeenCalled();
  });

  it("routes recognizer restoration separately from ordinary typing", () => {
    const onRestoreText = vi.fn();
    const props = dialogProps({ onRestoreText });
    render(<DictationHistoryDialog {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Restore recognizer output" }));
    expect(onRestoreText).toHaveBeenCalledExactlyOnceWith(historyDetails.rawTranscript);
    expect(props.onCorrectionTextChange).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Saved result"), { target: { value: "A typed correction." } });
    expect(props.onCorrectionTextChange).toHaveBeenCalledExactlyOnceWith("A typed correction.");
    expect(onRestoreText).toHaveBeenCalledTimes(1);
  });

  it("blocks recognizer restoration while reprocessing", () => {
    const onRestoreText = vi.fn();
    render(<DictationHistoryDialog {...dialogProps({ onRestoreText, isReprocessing: true })} />);
    const restore = screen.getByRole("button", { name: "Restore recognizer output" });
    expect(restore).toBeDisabled();
    fireEvent.click(restore);
    expect(onRestoreText).not.toHaveBeenCalled();
  });

  it("copies the recognizer output byte for byte without changing the saved transcript", async () => {
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Copy recognizer output" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("  recognizer words  \nsecond line\n");
    });
    expect(transcript.fullText).toBe("Saved result from storage.");
    expect(screen.getByRole("status")).toHaveTextContent("Recognizer output copied.");
  });

  it("reviews style preview changes against the editable source", () => {
    renderDialog({ correctionText: "Send Jon $15.", reprocessedResult: {
      ...reprocessedResult, outputText: "Send John $50.",
    } });
    const review = screen.getAllByText("Review changes")[1].closest("details")!;
    fireEvent.click(within(review).getByText("Review changes"));
    expect(within(review).getByText("Current text")).toBeInTheDocument();
    expect(within(review).getByText("New result")).toBeInTheDocument();
    expect(within(review).getByText("Jon").tagName).toBe("DEL");
    expect(within(review).getByText("John").tagName).toBe("INS");
    expect(within(review).getByText("$15.").tagName).toBe("DEL");
    expect(within(review).getByText("$50.").tagName).toBe("INS");
  });

  it("does not overwrite the clipboard with an empty editor", () => {
    renderDialog({ correctionText: " \n " });
    fireEvent.click(screen.getAllByRole("button", { name: "Copy" })[1]);
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Nothing to copy");
  });

  it("announces a dialog copy before writing to the clipboard", async () => {
    const onCopyStart = vi.fn();
    writeText.mockImplementationOnce(async () => {
      expect(onCopyStart).toHaveBeenCalledTimes(1);
    });
    renderDialog({ onCopyStart });

    fireEvent.click(screen.getAllByRole("button", { name: "Copy" })[1]);

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Edited saved result."));
  });

  it("allows only one clipboard write at a time", async () => {
    const pendingCopy = deferred<void>();
    writeText.mockReturnValueOnce(pendingCopy.promise);
    renderDialog();

    const copyButtons = screen.getAllByRole("button", { name: "Copy" });
    const headerCopy = copyButtons[0];
    const savedResultCopy = copyButtons[1];
    const stylePreviewCopy = copyButtons[2];
    const recognizerCopy = screen.getByRole("button", { name: "Copy recognizer output" });
    const retryResultCopy = screen.getByRole("button", { name: "Copy result" });

    fireEvent.click(savedResultCopy);

    expect(screen.getByRole("status")).toHaveTextContent("Copying…");
    for (const button of [headerCopy, savedResultCopy, stylePreviewCopy, recognizerCopy, retryResultCopy]) {
      expect(button).toBeDisabled();
    }

    fireEvent.click(stylePreviewCopy);
    fireEvent.click(recognizerCopy);
    fireEvent.click(retryResultCopy);
    fireEvent.click(headerCopy);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("Edited saved result.");

    await act(async () => pendingCopy.resolve());

    expect(screen.getByRole("status")).toHaveTextContent("Saved result copied.");
    for (const button of [headerCopy, savedResultCopy, stylePreviewCopy, recognizerCopy, retryResultCopy]) {
      expect(button).toBeEnabled();
    }
  });

  it.each([
    ["style preview", "Copy", 2, "Style preview text.", "Style preview copied."],
    ["retry result", "Copy result", 0, "Retry result text.", "New dictation copied."],
  ])("copies the %s and reports success", async (_name, buttonName, buttonIndex, expectedText, expectedStatus) => {
    renderDialog();
    const buttons = screen.getAllByRole("button", { name: buttonName });

    fireEvent.click(buttons[buttonIndex]);

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(expectedStatus));
    expect(writeText).toHaveBeenCalledWith(expectedText);
  });

  it.each([0, 1])("distinguishes an earlier draft copied while the editor changes using Copy button %s", async (buttonIndex) => {
    const pendingCopy = deferred<void>();
    writeText.mockReturnValueOnce(pendingCopy.promise);
    const props = dialogProps();
    const { rerender } = render(<DictationHistoryDialog {...props} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Copy" })[buttonIndex]);
    const updatedText = "New edits made during the copy.";
    fireEvent.change(screen.getByRole("textbox", { name: "Saved result" }), { target: { value: updatedText } });
    expect(props.onCorrectionTextChange).toHaveBeenCalledWith(updatedText);
    rerender(<DictationHistoryDialog {...props} correctionText={updatedText} />);
    await act(async () => pendingCopy.resolve());
    expect(writeText).toHaveBeenCalledExactlyOnceWith(props.correctionText);
    expect(screen.getByRole("textbox", { name: "Saved result" })).toHaveValue(updatedText);
    expect(screen.getByRole("status")).toHaveTextContent("Earlier text copied. Copy again to include your latest edits.");
    fireEvent.click(screen.getAllByRole("button", { name: "Copy" })[buttonIndex]);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(buttonIndex === 0 ? "Editor text copied." : "Saved result copied."));
    expect(writeText).toHaveBeenLastCalledWith(updatedText);
  });

  it("updates a completed editable copy acknowledgement when the draft later changes", async () => {
    const props = dialogProps();
    const { rerender } = render(<DictationHistoryDialog {...props} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Copy" })[1]);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saved result copied."));
    const updatedText = "Later draft edits.";
    rerender(<DictationHistoryDialog {...props} correctionText={updatedText} />);
    expect(screen.getByRole("status")).toHaveTextContent("Earlier text copied. Copy again to include your latest edits.");
    expect(writeText).toHaveBeenCalledExactlyOnceWith(props.correctionText);
    expect(screen.getByRole("textbox", { name: "Saved result" })).toHaveValue(updatedText);
    fireEvent.click(screen.getAllByRole("button", { name: "Copy" })[1]);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saved result copied."));
    expect(writeText).toHaveBeenLastCalledWith(updatedText);
  });

  it("offers manual copying when the clipboard rejects the write", async () => {
    writeText.mockRejectedValueOnce(new Error("clipboard unavailable"));
    renderDialog();

    fireEvent.click(screen.getAllByRole("button", { name: "Copy" })[1]);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't copy to the clipboard. Select the text and copy it manually.",
    );
  });

  it("unlocks clipboard actions after a rejected write and allows a retry", async () => {
    const rejectedCopy = deferred<void>();
    const retryCopy = deferred<void>();
    writeText.mockReturnValueOnce(rejectedCopy.promise).mockReturnValueOnce(retryCopy.promise);
    renderDialog();

    const recognizerCopy = screen.getByRole("button", { name: "Copy recognizer output" });
    const stylePreviewCopy = screen.getAllByRole("button", { name: "Copy" })[2];
    fireEvent.click(recognizerCopy);

    await act(async () => rejectedCopy.reject(new Error("clipboard unavailable")));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't copy to the clipboard. Select the text and copy it manually.",
    );
    expect(recognizerCopy).toBeEnabled();
    expect(stylePreviewCopy).toBeEnabled();

    fireEvent.click(stylePreviewCopy);

    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenLastCalledWith("Style preview text.");
    expect(screen.getByRole("status")).toHaveTextContent("Copying…");
    expect(stylePreviewCopy).toBeDisabled();
    expect(recognizerCopy).toBeDisabled();

    await act(async () => retryCopy.resolve());

    expect(screen.getByRole("status")).toHaveTextContent("Style preview copied.");
    expect(stylePreviewCopy).toBeEnabled();
    expect(recognizerCopy).toBeEnabled();
  });

  it("unlocks clipboard actions when the copy observer throws", async () => {
    const onCopyStart = vi.fn().mockImplementationOnce(() => {
      throw new Error("observer failed");
    });
    renderDialog({ onCopyStart });

    const savedResultCopy = screen.getAllByRole("button", { name: "Copy" })[1];
    fireEvent.click(savedResultCopy);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't copy to the clipboard. Select the text and copy it manually.",
    );
    expect(savedResultCopy).toBeEnabled();
    expect(writeText).not.toHaveBeenCalled();

    fireEvent.click(savedResultCopy);

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Saved result copied."));
    expect(writeText).toHaveBeenCalledWith("Edited saved result.");
  });

  it("does not show a stale result after switching recordings", async () => {
    const pendingCopy = deferred<void>();
    writeText.mockReturnValueOnce(pendingCopy.promise);
    const view = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Copy recognizer output" }));
    view.rerender(
      <DictationHistoryDialog
        {...dialogProps({
          recording: { ...recording, id: "dictation-next", title: "Next dictation" },
          transcript: { ...transcript, recordingId: "dictation-next" },
        })}
      />,
    );

    expect(screen.queryByText("Copying…")).not.toBeInTheDocument();
    const nextRecognizerCopy = screen.getByRole("button", { name: "Copy recognizer output" });
    expect(nextRecognizerCopy).toBeDisabled();
    fireEvent.click(nextRecognizerCopy);
    expect(writeText).toHaveBeenCalledTimes(1);

    await act(async () => pendingCopy.resolve());

    expect(screen.queryByText("Recognizer output copied.")).not.toBeInTheDocument();
    expect(nextRecognizerCopy).toBeEnabled();

    fireEvent.click(nextRecognizerCopy);
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Recognizer output copied."));
  });
});

describe("DictationHistoryDialog text reprocessing", () => {
  it("offers Process again for a failed dictation that retained audio", () => {
    const onProcessAgain = vi.fn();
    const onOpenProcessAgainResult = vi.fn();
    renderDialog({
      recording: { ...recording, status: "error" },
      transcript: null,
      reprocessedResult: null,
      onProcessAgain,
      onOpenProcessAgainResult,
    });

    expect(screen.getByText("Transcription didn't finish. Plainsong saved the audio, so you can try again.")).toBeInTheDocument();
    expect(screen.getByLabelText("Style for the new entry")).toBeInTheDocument();
    expect(screen.getByLabelText("Speech model for this retry")).toBeInTheDocument();
    expect(screen.queryByLabelText("Saved result")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reprocess" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Read aloud" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();
    expect(screen.getByText("Retry result text.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Process again" }));
    fireEvent.click(screen.getByRole("button", { name: "Open it" }));

    expect(onProcessAgain).toHaveBeenCalledTimes(1);
    expect(onOpenProcessAgainResult).toHaveBeenCalledTimes(1);
  });

  it("shows the unavailable-audio reason without a transcript editor", () => {
    renderDialog({
      recording: { ...recording, status: "error" },
      transcript: null,
      historyDetails: { ...historyDetails, audioAvailable: null },
      reprocessedResult: null,
      processAgainOutcome: null,
    });

    expect(screen.getByText(/This dictation has no saved audio/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Saved result")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Process again" })).not.toBeInTheDocument();
  });

  it("keeps the transcript editor and text actions for a completed dictation", () => {
    renderDialog();

    expect(screen.getByLabelText("Saved result")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Read aloud" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reprocess" })).toBeInTheDocument();
  });

  it("disables Reprocess when the editable text contains only whitespace", () => {
    renderDialog({ correctionText: " \n\t " });

    expect(screen.getByRole("button", { name: "Reprocess" })).toBeDisabled();
  });

  it.each([
    [true, "AI returned your text without changes."],
    [false, "This style left your text unchanged."],
  ])("compares a style preview with the corrected text: AI=%s", (usedAi, message) => {
    renderDialog({
      correctionText: "Please email John tomorrow.",
      reprocessedResult: {
        ...reprocessedResult,
        outputText: "Please email John tomorrow.",
        usedAi,
      },
    });

    expect(screen.getByText("No changes")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(message);
    expect(screen.getByRole("button", { name: "Use Result" })).toBeDisabled();
  });
});
