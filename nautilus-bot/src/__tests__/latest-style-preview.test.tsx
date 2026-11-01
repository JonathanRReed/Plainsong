import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LatestStylePreview } from "@/components/views/dictation/latest-style-preview";
import { cancelAnalysisRun } from "@/lib/backend/ai";
import { reprocessDictationText } from "@/lib/backend/dictation";
import { mainViewCanSuspend } from "@/lib/main-window-idle";

vi.mock("@/lib/backend/dictation", () => ({
  reprocessDictationText: vi.fn(),
}));
vi.mock("@/lib/backend/ai", () => ({
  cancelAnalysisRun: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const backendMock = vi.mocked(reprocessDictationText);
const cancelMock = vi.mocked(cancelAnalysisRun);

describe("LatestStylePreview", () => {
  it("keeps a running or unapplied preview alive even with its disclosure closed", async () => {
    const pending = deferred<Awaited<ReturnType<typeof reprocessDictationText>>>();
    backendMock.mockReturnValue(pending.promise);
    const shell = (child: boolean) => <div className="app-shell">
      <button aria-current="page">Dictation</button>
      {child && <LatestStylePreview text="Public fixture" sourceKey="idle" onUsePreview={vi.fn()} />}
    </div>;
    const mounted = render(shell(true));
    expect(mainViewCanSuspend("dictation", document)).toBe(true);
    fireEvent.click(screen.getByText("Try another style"));
    fireEvent.click(screen.getByRole("button", { name: "Preview style" }));
    document.querySelector("details")!.open = false;
    expect(mainViewCanSuspend("dictation", document)).toBe(false);
    await act(async () => pending.resolve({ modePreset: "voice", outputText: "Preview fixture", usedAi: true, provider: "ollama", modelId: "fixture" }));
    expect(mainViewCanSuspend("dictation", document)).toBe(false);
    mounted.rerender(shell(false));
    expect(mainViewCanSuspend("dictation", document)).toBe(true);
  });

  beforeEach(() => {
    backendMock.mockReset();
    cancelMock.mockReset();
    cancelMock.mockResolvedValue();
  });

  it("does not process text until Preview style is clicked", async () => {
    const user = userEvent.setup();
    render(
      <LatestStylePreview
        text="A rough dictation."
        sourceKey="result-1"
        onUsePreview={vi.fn()}
      />,
    );

    expect(backendMock).not.toHaveBeenCalled();
    await user.click(screen.getByText("Try another style"));
    expect(backendMock).not.toHaveBeenCalled();
    await user.selectOptions(screen.getByLabelText("Style"), "email");
    expect(backendMock).not.toHaveBeenCalled();
  });

  it("shows a preview and applies it only through Use preview", async () => {
    const user = userEvent.setup();
    const onUsePreview = vi.fn();
    backendMock.mockResolvedValue({
      modePreset: "email",
      outputText: "A polished dictation.",
      usedAi: true,
      provider: "ollama",
      modelId: "qwen",
    });

    render(
      <LatestStylePreview
        text="A rough dictation."
        sourceKey="result-1"
        appTarget="Mail"
        onUsePreview={onUsePreview}
      />,
    );
    await user.click(screen.getByText("Try another style"));
    await user.selectOptions(screen.getByLabelText("Style"), "email");
    await user.click(screen.getByRole("button", { name: "Preview style" }));

    expect(await screen.findByText("A polished dictation.")).toBeInTheDocument();
    expect(backendMock).toHaveBeenCalledWith(
      "A rough dictation.",
      "email",
      "Mail",
      { runId: expect.any(String) },
    );
    expect(onUsePreview).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Use preview" }));
    expect(onUsePreview).toHaveBeenCalledOnce();
    expect(onUsePreview).toHaveBeenCalledWith("A polished dictation.");
  });

  it("cancels the active preview with its run ID and ignores its rejection", async () => {
    const pending = deferred<Awaited<ReturnType<typeof reprocessDictationText>>>();
    backendMock.mockReturnValue(pending.promise);
    render(
      <LatestStylePreview text="Cancel this" sourceKey="result-1" onUsePreview={vi.fn()} />,
    );
    fireEvent.click(screen.getByText("Try another style"));
    fireEvent.click(screen.getByRole("button", { name: "Preview style" }));

    const runId = backendMock.mock.calls[0]?.[3]?.runId;
    expect(runId).toEqual(expect.any(String));
    fireEvent.click(screen.getByRole("button", { name: "Cancel preview" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancelling…" }));
    expect(cancelMock).toHaveBeenCalledOnce();
    expect(cancelMock).toHaveBeenCalledWith(runId);

    pending.reject(new Error("cancelled"));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Preview style" })).toBeEnabled();
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("ignores a pending result after the text changes and keeps the request single-flight", async () => {
    const pending = deferred<Awaited<ReturnType<typeof reprocessDictationText>>>();
    backendMock.mockReturnValue(pending.promise);
    const view = render(
      <LatestStylePreview
        text="First draft"
        sourceKey="result-1"
        onUsePreview={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Try another style"));
    const previewButton = screen.getByRole("button", { name: "Preview style" });
    act(() => {
      fireEvent.click(previewButton);
      fireEvent.click(previewButton);
    });
    expect(backendMock).toHaveBeenCalledOnce();
    view.rerender(
      <LatestStylePreview
        text="Edited draft"
        sourceKey="result-1"
        onUsePreview={vi.fn()}
      />,
    );

    const runId = backendMock.mock.calls[0]?.[3]?.runId;
    await waitFor(() => expect(cancelMock).toHaveBeenCalledWith(runId));

    expect(screen.getByRole("button", { name: "Creating preview…" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Creating preview…" }));
    expect(backendMock).toHaveBeenCalledOnce();
    pending.resolve({
      modePreset: "voice",
      outputText: "Stale preview",
      usedAi: true,
      provider: "ollama",
      modelId: "qwen",
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Preview style" })).toBeEnabled();
    });
    expect(screen.queryByText("Stale preview")).not.toBeInTheDocument();
  });

  it("cancels an active preview when unmounted", async () => {
    const pending = deferred<Awaited<ReturnType<typeof reprocessDictationText>>>();
    backendMock.mockReturnValue(pending.promise);
    const view = render(
      <LatestStylePreview text="Unmount this" sourceKey="result-1" onUsePreview={vi.fn()} />,
    );
    fireEvent.click(screen.getByText("Try another style"));
    fireEvent.click(screen.getByRole("button", { name: "Preview style" }));
    const runId = backendMock.mock.calls[0]?.[3]?.runId;

    view.unmount();

    expect(cancelMock).toHaveBeenCalledOnce();
    expect(cancelMock).toHaveBeenCalledWith(runId);
  });

  it("ignores a pending result after the source changes", async () => {
    const pending = deferred<Awaited<ReturnType<typeof reprocessDictationText>>>();
    backendMock.mockReturnValue(pending.promise);
    const view = render(
      <LatestStylePreview text="Same words" sourceKey="result-1" onUsePreview={vi.fn()} />,
    );
    fireEvent.click(screen.getByText("Try another style"));
    fireEvent.click(screen.getByRole("button", { name: "Preview style" }));
    view.rerender(
      <LatestStylePreview text="Same words" sourceKey="result-2" onUsePreview={vi.fn()} />,
    );
    pending.resolve({
      modePreset: "voice",
      outputText: "Wrong source preview",
      usedAi: false,
      provider: null,
      modelId: null,
    });

    await waitFor(() => expect(backendMock).toHaveBeenCalledOnce());
    expect(await screen.findByRole("button", { name: "Preview style" })).toBeEnabled();
    expect(screen.queryByText("Wrong source preview")).not.toBeInTheDocument();
  });

  it("labels unchanged and fallback results truthfully and sanitizes failures", async () => {
    const user = userEvent.setup();
    backendMock
      .mockResolvedValueOnce({
        modePreset: "voice",
        outputText: "Already clean.",
        usedAi: true,
        provider: "ollama",
        modelId: "qwen",
      })
      .mockResolvedValueOnce({
        modePreset: "voice",
        outputText: "Basic formatting.",
        usedAi: false,
        aiRewriteFailed: true,
        provider: null,
        modelId: null,
      })
      .mockRejectedValueOnce(new Error("Traceback (most recent call last): secret runtime details"));
    const view = render(
      <LatestStylePreview text="Already clean." sourceKey="result-1" onUsePreview={vi.fn()} />,
    );
    await user.click(screen.getByText("Try another style"));
    await user.click(screen.getByRole("button", { name: "Preview style" }));
    expect(await screen.findByText("No changes")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("AI returned your text without changes.");

    view.rerender(
      <LatestStylePreview text="needs formatting" sourceKey="result-1" onUsePreview={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: "Preview style" }));
    expect(await screen.findByText("Basic formatting")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "AI rewrite wasn't applied. Basic formatting is shown instead.",
    );

    await user.click(screen.getByRole("button", { name: "Preview style" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Transcription failed. Try again or switch to another model.",
    );
    expect(screen.queryByText(/secret runtime details/)).not.toBeInTheDocument();
  });

  it("rejects a malformed preview result without replacing the current text", async () => {
    const user = userEvent.setup();
    const onUsePreview = vi.fn();
    backendMock.mockResolvedValue({ outputText: "" } as Awaited<
      ReturnType<typeof reprocessDictationText>
    >);
    render(
      <LatestStylePreview
        text="Keep this editor text."
        sourceKey="result-1"
        onUsePreview={onUsePreview}
      />,
    );

    await user.click(screen.getByText("Try another style"));
    await user.click(screen.getByRole("button", { name: "Preview style" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't create a style preview. Try again.",
    );
    expect(screen.queryByRole("button", { name: "Use preview" })).not.toBeInTheDocument();
    expect(onUsePreview).not.toHaveBeenCalled();
  });
});
