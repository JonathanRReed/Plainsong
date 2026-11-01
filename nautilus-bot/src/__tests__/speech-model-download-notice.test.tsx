import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpeechModelDownloadNoticeLine } from "@/components/models/speech-model-download-notice";
import { parseSpeechModelDownloadNotice } from "@/lib/speech-model-download-notice";

const electron = vi.hoisted(() => ({
  current: undefined as unknown,
  listeners: {} as Record<string, (event: { payload: unknown }) => void>,
}));

vi.mock("@/lib/electron", () => ({
  invoke: vi.fn(async (command: string) =>
    command === "get_speech_model_download_notice" ? electron.current : undefined,
  ),
  listen: vi.fn(async (event: string, callback: (event: { payload: unknown }) => void) => {
    electron.listeners[event] = callback;
    return () => {
      delete electron.listeners[event];
    };
  }),
}));

const JARGON = /neural engine|core ?ml|ggml|fluidaudio|gguf|onnx|\bane\b/i;

describe("speech model download notice", () => {
  beforeEach(() => {
    electron.current = undefined;
    electron.listeners = {};
  });

  it("shows nothing while no background download runs", async () => {
    electron.current = { state: "idle", percent: 0, totalBytes: 0 };
    const { container } = render(<SpeechModelDownloadNoticeLine />);
    await waitFor(() => expect(electron.listeners["speech-model-download-notice"]).toBeDefined());
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a download already under way when the screen opens, then follows it", async () => {
    electron.current = { state: "downloading", percent: 12, totalBytes: 480 * 1024 * 1024 };
    render(<SpeechModelDownloadNoticeLine />);
    const line = await screen.findByText(/Downloading extra Parakeet files .* 12%/);
    expect(line.textContent).not.toMatch(JARGON);
    expect(screen.getByRole("progressbar")).toBeInTheDocument();

    act(() => {
      electron.listeners["speech-model-download-notice"]({
        payload: { state: "downloading", percent: 64, totalBytes: 480 * 1024 * 1024 },
      });
    });
    expect(await screen.findByText(/64%/)).toBeInTheDocument();
  });

  it("says plainly when the download failed and that Parakeet still works", async () => {
    render(<SpeechModelDownloadNoticeLine />);
    await waitFor(() => expect(electron.listeners["speech-model-download-notice"]).toBeDefined());
    act(() => {
      electron.listeners["speech-model-download-notice"]({
        payload: { state: "failed", percent: 0, totalBytes: 480 * 1024 * 1024 },
      });
    });
    const line = await screen.findByText(/Couldn.t download the extra Parakeet files/);
    expect(line.textContent).toMatch(/Parakeet still works/);
    expect(line.textContent).not.toMatch(JARGON);
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("says dictation waits for a download Parakeet needs on this Mac", async () => {
    electron.current = { state: "downloading", percent: 30, totalBytes: 739_508_576, needed: true };
    render(<SpeechModelDownloadNoticeLine />);
    const line = await screen.findByText(/Downloading the Parakeet files this Mac needs .*: 30%/);
    expect(line.textContent).toMatch(/Dictation with Parakeet will be ready when it finishes/);
    expect(line.textContent).not.toMatch(/works as before/);
    expect(line.textContent).not.toMatch(JARGON);
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });

  it("tells an offline Mac to check the connection when a needed download failed", async () => {
    render(<SpeechModelDownloadNoticeLine />);
    await waitFor(() => expect(electron.listeners["speech-model-download-notice"]).toBeDefined());
    act(() => {
      electron.listeners["speech-model-download-notice"]({
        payload: { state: "failed", percent: 0, totalBytes: 739_508_576, needed: true },
      });
    });
    const line = await screen.findByText(/Couldn.t download the Parakeet files this Mac needs/);
    expect(line.textContent).toMatch(/Check your connection/);
    expect(line.textContent).not.toMatch(/still works/);
    expect(line.textContent).not.toMatch(JARGON);
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("reads anything unexpected as no download", () => {
    expect(parseSpeechModelDownloadNotice({ state: "downloading", percent: 5 }).needed).toBe(false);
    expect(parseSpeechModelDownloadNotice({ state: "downloading", needed: "yes" }).needed).toBe(false);
    expect(parseSpeechModelDownloadNotice(null).state).toBe("idle");
    expect(parseSpeechModelDownloadNotice({ state: "exploded", percent: 50 }).state).toBe("idle");
    expect(parseSpeechModelDownloadNotice({ state: "downloading", percent: 900 }).percent).toBe(100);
  });
});
