import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  deleteModelFile,
  listDownloadedModels,
  type DownloadedModelFile,
} from "@/lib/backend/asr";
import { TURNED_OFF_SPEAKER_MODEL_ID } from "@/lib/speaker-models";

const TURNED_OFF_FILE_NAME = `${TURNED_OFF_SPEAKER_MODEL_ID}.onnx`;

function isTurnedOffSpeakerFile(file: DownloadedModelFile): boolean {
  const path = file.path.replaceAll("\\", "/");
  return file.provider === "diarization" && path.endsWith(`/diarization/${TURNED_OFF_FILE_NAME}`);
}

/** Decimal megabytes, the way Finder counts them. */
function megabytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1_000_000))} MB`;
}

/**
 * An ERes2NetV2 file downloaded before the model was turned off. Plainsong
 * no longer runs it, and does not delete it on its own: this row says it is
 * there and removes it when asked. Renders nothing when no such file exists.
 */
export function TurnedOffSpeakerModelFile() {
  const [file, setFile] = useState<DownloadedModelFile | null>(null);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void listDownloadedModels()
      .then((files) => {
        if (active) setFile(files.find(isTurnedOffSpeakerFile) ?? null);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const remove = useCallback(async () => {
    if (!file) return;
    setRemoving(true);
    setError(null);
    try {
      await deleteModelFile(file.path);
      setFile(null);
    } catch {
      setError("Plainsong couldn't remove the file. Try again.");
    } finally {
      setRemoving(false);
    }
  }, [file]);

  if (!file) return null;
  return (
    <div className="space-y-2 text-sm text-muted-foreground">
      <p>
        An earlier ERes2NetV2 download ({megabytes(file.sizeBytes)}) is still on
        this Mac. It&apos;s turned off while its license is unresolved, so
        Plainsong doesn&apos;t use it.
      </p>
      {error ? <p role="alert" className="text-destructive">{error}</p> : null}
      <Button type="button" variant="outline" size="sm" disabled={removing} onClick={() => void remove()}>
        {removing ? "Removing…" : "Remove ERes2NetV2 file"}
      </Button>
    </div>
  );
}
