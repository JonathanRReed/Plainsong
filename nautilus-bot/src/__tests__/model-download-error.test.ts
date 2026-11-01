import { describe, expect, it } from "vitest";
import { describeModelDownloadError } from "@/lib/model-download-error";

const ipc = (message: string) =>
  new Error(`Error invoking remote method 'sidecar:invoke': Error: ${message}`);

describe("describeModelDownloadError", () => {
  it("turns a dropped connection into advice, without the release URL", () => {
    const text = describeModelDownloadError(
      ipc(
        "error sending request for url (https://github.com/JonathanRReed/Plainsong/releases/download/models-2026-10/parakeet-tdt-0.6b-v3-q8_0.gguf)",
      ),
    );
    expect(text).toBe(
      "Plainsong couldn't reach the download server. Check your internet connection, then try again.",
    );
    expect(text).not.toMatch(/https?:|sidecar|invoking/);
  });

  it("keeps how much space the download needs and how much is free", () => {
    expect(
      describeModelDownloadError(
        ipc(
          "Not enough disk space to download https://example.com/model.gguf: need 739.0 MB free, only 210.4 MB available.",
        ),
      ),
    ).toBe(
      "There isn't enough free disk space. The download needs 739.0 MB free, and this Mac has 210.4 MB. Free up space, then try again.",
    );
    expect(describeModelDownloadError(ipc("No space left on device (os error 28)"))).toMatch(
      /ran out of space/,
    );
  });

  it("names a bad copy without digests or paths", () => {
    const text = describeModelDownloadError(
      ipc(
        "Integrity verification failed for /Users/someone/Library/Application Support/Plainsong/models/x.gguf. Expected sha256 abc, got def",
      ),
    );
    expect(text).toBe(
      "The downloaded file didn't match the expected copy, so Plainsong discarded it. Try again.",
    );
  });

  it("names an installed file this session found wrong without its file name", () => {
    const text = describeModelDownloadError(
      ipc("s1-mini-q4_k_m.gguf failed its integrity check. Download the model again in Settings > Models."),
    );
    expect(text).toBe(
      "A model file on this Mac didn't match the expected copy, so Plainsong won't use it. Download it again to replace it.",
    );
  });

  it("explains an interrupted download and a client-side time limit the same way", () => {
    expect(
      describeModelDownloadError(
        ipc("Download of https://x/y.gguf is incomplete: got 10 bytes, expected 20. Re-try download."),
      ),
    ).toMatch(/picks up where it left off/);
    expect(
      describeModelDownloadError(new Error("Command timed out after 900000ms: download_asr_models")),
    ).toMatch(/picks up where it left off/);
  });

  it("separates a missing file from a busy server", () => {
    expect(
      describeModelDownloadError(ipc("Download failed for https://x/y: HTTP 404 Not Found")),
    ).toMatch(/isn't available from the download server/);
    expect(
      describeModelDownloadError(ipc("Download failed for https://x/y: HTTP 503 Service Unavailable")),
    ).toMatch(/busy/);
  });

  it("keeps the missing release-file explanation without its technical filename", () => {
    const message = describeModelDownloadError(ipc(
      "pyannote community-1 can't be downloaded yet: Plainsong's model release doesn't have this file yet (pyannote-community-1-embedding.onnx, HTTP 404).",
    ));
    expect(message).toBe("Plainsong's model release doesn't have this file yet. Try again later.");
    expect(message).not.toMatch(/onnx|HTTP|pyannote/);
  });

  it("says a second click found the download already running", () => {
    expect(
      describeModelDownloadError(
        ipc("SIDECAR_DUPLICATE: download_asr_models is already running for this target."),
      ),
    ).toBe("This model is already downloading. Wait for that download to finish.");
  });

  it("says the download slots are full instead of the sidecar's capacity code", () => {
    expect(
      describeModelDownloadError(
        ipc("SIDECAR_BUSY: model download capacity is full. Wait for active work to finish and retry."),
      ),
    ).toMatch(/^Two other downloads are already running/);
  });

  it("keeps a message already written for people, minus any URL", () => {
    expect(
      describeModelDownloadError(
        ipc("The download finished, but the speaker model did not pass its check."),
      ),
    ).toBe("The download finished, but the speaker model did not pass its check.");
    expect(describeModelDownloadError("")).toBe("The download did not finish. Try again.");
  });
});

describe("describeModelDownloadError fallbacks", () => {
  it.each([
    "CoreML failed to compile the speech model",
    "ANE load failed for the quantization format",
    "Failed to parse GGUF tensor metadata",
    "Unexpected response\n    at download (/Users/test/model.ts:24:8)",
    "Traceback (most recent call last): download.py line 5",
  ])("replaces technical diagnostics with recovery advice: %s", (message) => {
    expect(describeModelDownloadError(ipc(message))).toBe("The download did not finish. Try again.");
  });

  it("drops a URL or a path from an unrecognised message", () => {
    expect(
      describeModelDownloadError(ipc("Unexpected reply for https://example.com/a/b.gguf: weird")),
    ).toBe("Unexpected reply: weird.");
    expect(
      describeModelDownloadError(ipc("Could not open /Users/someone/models/a.gguf. Try again.")),
    ).toBe("Could not open. Try again.");
  });
});
