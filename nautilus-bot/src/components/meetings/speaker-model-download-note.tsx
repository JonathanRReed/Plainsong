import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { stripTransportPrefix } from "@/lib/meeting-start-error";
import { containsTechnicalTerms } from "@/lib/meeting-ui-message";
import {
  downloadDiarizationModel,
  type DiarizationModelPlan,
} from "@/lib/backend/asr";

/**
 * "speaker model (33 MB)", or "speaker model" when the size is unknown. The
 * model's own name (`plan.selectedLabel`) is a Settings detail; a meeting
 * only needs to know what the download is for and how big it is.
 */
export function speakerModelDownloadName(plan: DiarizationModelPlan): string {
  return plan.selectedDownloadSize
    ? `speaker model (${plan.selectedDownloadSize})`
    : "speaker model";
}

/**
 * Why the speaker model download stopped, in words the reader can act on.
 * The raw error (a request URL, an OS error number, a checksum) is for the
 * log.
 */
export function describeSpeakerModelDownloadError(raw: string): string {
  const text = stripTransportPrefix(raw).trim();
  const lower = text.toLowerCase();
  if (/no space left|os error 28|disk (is )?full|not enough (free )?(disk )?space/.test(lower)) {
    return "There isn't enough free disk space. Free some space, then try again.";
  }
  if (/can't be downloaded yet|http 404|not found/.test(lower)) {
    return "This speaker model isn't available to download yet. Try again after Plainsong updates.";
  }
  if (/sending request|connect|network|timed out|dns|offline|unreachable|could not resolve/.test(lower)) {
    return "Plainsong couldn't reach the download server. Check your internet connection, then try again.";
  }
  if (/sha-?256|checksum|mismatch|verif/.test(lower)) {
    return "The downloaded file didn't match what Plainsong expected, so it was not used. Try again.";
  }
  if (text && !containsTechnicalTerms(text) && !/https?:\/\/|\.(onnx|gguf|bin)\b/i.test(text)) {
    return text;
  }
  return "Try again in a moment.";
}

/**
 * The note a finished meeting carries when it was saved without speaker
 * labels because no speaker model is on this Mac. Meetings never download a
 * model on their own; this button is the one place the meeting offers it, and
 * it fetches only the model named on it.
 */
export function SpeakerModelDownloadNote({
  plan,
  hasSpeakerLabels = false,
  onDownloaded,
}: {
  plan: DiarizationModelPlan;
  /** The transcript already has speakers (from a provider, say). */
  hasSpeakerLabels?: boolean;
  /** Re-read the plan, so the meeting can offer "Label the speakers". */
  onDownloaded(): Promise<void> | void;
}) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = speakerModelDownloadName(plan);

  const download = async () => {
    setDownloading(true);
    setError(null);
    try {
      await downloadDiarizationModel(plan.selectedModelId);
      await onDownloaded();
    } catch (cause) {
      const raw =
        cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
      console.error("Speaker model download failed:", raw);
      setError(describeSpeakerModelDownloadError(raw));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="space-y-2" data-testid="speaker-model-download-note">
      <p className="text-sm text-muted-foreground">
        {hasSpeakerLabels
          ? "No speaker model is downloaded, so these speakers can't be relabelled on this Mac."
          : "No speaker model is downloaded, so this meeting was saved without speaker labels."}
      </p>
      <Button
        size="sm"
        variant="outline"
        onClick={() => void download()}
        disabled={downloading}
      >
        {downloading ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            Downloading speaker model…
          </>
        ) : (
          <>
            <Download className="mr-2 h-4 w-4" aria-hidden="true" />
            Download {name}
          </>
        )}
      </Button>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          The download didn&apos;t finish: {error}
        </p>
      ) : null}
    </div>
  );
}
