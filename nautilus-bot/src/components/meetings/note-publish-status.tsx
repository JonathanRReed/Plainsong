import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  getNotePublishStatus,
  retryNotePublish,
  type NotePublishStatus,
} from "@/lib/backend/publishing";
import { settingsErrorMessage } from "@/components/settings/settings-error-message";

export function NotePublishStatusLine({ recordingId }: { recordingId: string }) {
  const [status, setStatus] = useState<NotePublishStatus | null>(null);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    let live = true;
    setStatus(null);
    const refresh = () => {
      void getNotePublishStatus(recordingId)
        .then(value => { if (live) setStatus(value); })
        .catch(() => {
          if (live) {
            setStatus({ state: "error", error: "Couldn't check the notes folder." });
          }
        });
    };
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => { live = false; window.clearInterval(timer); };
  }, [recordingId]);

  if (!status || status.state === "none") return null;

  return (
    <div className="mt-2 flex items-center gap-3 text-sm" role="status">
      <span>
        {status.state === "saved"
          ? "Saved to folder"
          : status.state === "pending"
            ? "Waiting to save to folder"
            : `Couldn't save: ${status.error}`}
      </span>
      {status.state === "error" && (
        <Button
          size="sm"
          variant="outline"
          disabled={retrying}
          onClick={async () => {
            setRetrying(true);
            try {
              await retryNotePublish(recordingId);
              setStatus({ state: "pending", error: null });
            } catch (cause) {
              setStatus({
                state: "error",
                error: settingsErrorMessage(cause, "Couldn't retry saving notes."),
              });
            } finally {
              setRetrying(false);
            }
          }}
        >
          Retry
        </Button>
      )}
    </div>
  );
}
