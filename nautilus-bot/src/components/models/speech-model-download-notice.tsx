import { useEffect, useState } from "react";
import { formatModelSize } from "@/lib/asr-capabilities";
import { listen } from "@/lib/electron";
import {
  getSpeechModelDownloadNotice,
  IDLE_SPEECH_MODEL_DOWNLOAD_NOTICE,
  parseSpeechModelDownloadNotice,
  type SpeechModelDownloadNotice,
} from "@/lib/speech-model-download-notice";
import { ModelDownloadProgress } from "@/components/models/model-download-progress";

const NAME = "extra Parakeet files";
const NEEDED_NAME = "Parakeet files";

/**
 * Parakeet's extra files (the faster build and, for English, the vocabulary
 * model) download in the background for people who already chose Parakeet
 * before this version shipped them. Without this line hundreds of megabytes
 * leave the Mac with nothing on screen.
 *
 * A `needed` download is one Parakeet waits for: the other copy of the model
 * when the faster build can't run on this Mac, or the build for a newly
 * chosen language. Dictation is not ready until it finishes, so the line says
 * that instead of "works as before".
 */
export function SpeechModelDownloadNoticeLine() {
  const [notice, setNotice] = useState<SpeechModelDownloadNotice>(IDLE_SPEECH_MODEL_DOWNLOAD_NOTICE);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen("speech-model-download-notice", ({ payload }) => {
      if (!disposed) setNotice(parseSpeechModelDownloadNotice(payload));
    })
      .then((dispose) => {
        if (disposed) dispose();
        else unlisten = dispose;
      })
      .catch((error) => console.warn("Failed to subscribe to speech model download notices:", error));
    void getSpeechModelDownloadNotice()
      .then((current) => {
        if (!disposed) setNotice((previous) => (previous.state === "idle" ? current : previous));
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  if (notice.state === "idle") return null;
  const size = notice.totalBytes > 0 ? ` (${formatModelSize(notice.totalBytes / (1024 * 1024))})` : "";

  if (notice.needed) {
    if (notice.state === "failed") {
      return (
        <p className="text-sm leading-6 text-muted-foreground">
          Couldn&apos;t download the Parakeet files this Mac needs{size}, so dictation with Parakeet
          isn&apos;t ready yet. Check your connection; Plainsong tries again the next time it opens
          or you change speech settings.
        </p>
      );
    }
    return (
      <div className="space-y-2">
        <p className="text-sm leading-6 text-muted-foreground">
          Downloading the Parakeet files this Mac needs{size}: {notice.percent}%. Dictation with
          Parakeet will be ready when it finishes.
        </p>
        <ModelDownloadProgress name={NEEDED_NAME} active value={notice.percent} className="max-w-md" />
      </div>
    );
  }

  if (notice.state === "failed") {
    return (
      <p className="text-sm leading-6 text-muted-foreground">
        Couldn&apos;t download the extra Parakeet files{size}. Parakeet still works as before, and
        Plainsong tries again the next time it opens or you change speech settings.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-sm leading-6 text-muted-foreground">
        Downloading extra Parakeet files{size} in the background: {notice.percent}%. Parakeet works
        as before until they are ready.
      </p>
      <ModelDownloadProgress name={NAME} active value={notice.percent} className="max-w-md" />
    </div>
  );
}
