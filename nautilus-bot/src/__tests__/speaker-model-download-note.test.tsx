import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeSpeakerModelDownloadError,
  SpeakerModelDownloadNote,
  speakerModelDownloadName,
} from "@/components/meetings/speaker-model-download-note";
import type { DiarizationModelPlan } from "@/lib/backend/asr";

vi.mock("@/lib/backend/asr", () => ({
  downloadDiarizationModel: vi.fn(async () => {}),
}));

const missing: DiarizationModelPlan = {
  selectedModelId: "pyannote_community1",
  selectedLabel: "pyannote community-1",
  selectedDownloadSize: "33 MB",
  selectedInstalled: false,
  runModelId: null,
  fallbackNotice: null,
};

describe("SpeakerModelDownloadNote", () => {
  beforeEach(() => vi.clearAllMocks());

  it("names the model and its size, and downloads only that model on click", async () => {
    const asr = await import("@/lib/backend/asr");
    const onDownloaded = vi.fn();
    render(<SpeakerModelDownloadNote plan={missing} onDownloaded={onDownloaded} />);

    expect(
      screen.getByText("No speaker model is downloaded, so this meeting was saved without speaker labels."),
    ).toBeInTheDocument();
    expect(asr.downloadDiarizationModel).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Download speaker model (33 MB)" }));
    });
    expect(asr.downloadDiarizationModel).toHaveBeenCalledWith("pyannote_community1");
    await waitFor(() => expect(onDownloaded).toHaveBeenCalledTimes(1));
  });

  it("says why a download failed and lets the reader try again", async () => {
    const asr = await import("@/lib/backend/asr");
    vi.mocked(asr.downloadDiarizationModel).mockRejectedValueOnce(
      new Error("pyannote community-1 can't be downloaded yet: Plainsong's model release doesn't have this file yet (pyannote-community-1-embedding.onnx, HTTP 404)."),
    );
    const onDownloaded = vi.fn();
    render(<SpeakerModelDownloadNote plan={missing} onDownloaded={onDownloaded} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Download speaker model (33 MB)" }));
    });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "The download didn't finish: This speaker model isn't available to download yet.",
    );
    expect(alert.textContent).not.toMatch(/onnx|HTTP 404/);
    expect(onDownloaded).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Download speaker model (33 MB)" })).toBeEnabled();
  });

  it.each([
    ["error sending request for url (https://github.com/x/y.onnx)", /couldn't reach the download server/],
    ["No space left on device (os error 28)", /free disk space/],
    ["SHA-256 mismatch for pyannote-community-1-embedding.onnx", /didn't match/],
    ["Speaker model downloads are paused while a backup runs.", /^Speaker model downloads are paused/],
  ])("says %s in words the reader can act on", (raw, expected) => {
    const message = describeSpeakerModelDownloadError(raw);
    expect(message).toMatch(expected);
    expect(message).not.toMatch(/https?:|os error|\.onnx/);
  });

  it("omits an unknown size rather than inventing one", () => {
    expect(speakerModelDownloadName({ ...missing, selectedDownloadSize: null })).toBe(
      "speaker model",
    );
  });
});
