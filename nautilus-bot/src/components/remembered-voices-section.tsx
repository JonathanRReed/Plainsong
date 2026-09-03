import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SettingsSwitch } from "@/components/ui/settings-control";
import { useToast } from "@/components/toast";
import {
  forgetAllRememberedVoices,
  forgetRememberedVoice,
  listRememberedVoices,
  type RememberedVoice,
} from "@/lib/backend/asr";

interface RememberedVoicesSectionProps {
  /** `meetings.rememberVoices`. */
  rememberVoices: boolean;
  /** `meetings.autoApplyConfidentVoices`. */
  autoApplyConfidentVoices: boolean;
  onRememberVoicesChange: (enabled: boolean) => void;
  onAutoApplyChange: (enabled: boolean) => void;
}

/** "2 samples" / "1 sample", so the list never reads "1 samples". */
function describeSamples(count: number): string {
  return `${count} ${count === 1 ? "sample" : "samples"}`;
}

/**
 * Settings > General > Meetings > Remembered voices.
 *
 * Two switches and the list of what is actually stored. The list is the point:
 * a feature that keeps a number derived from someone's voice has to show every
 * one it kept, and let you delete them one at a time or all at once, in the
 * same place you turned it on.
 */
export function RememberedVoicesSection({
  rememberVoices,
  autoApplyConfidentVoices,
  onRememberVoicesChange,
  onAutoApplyChange,
}: RememberedVoicesSectionProps) {
  const { toast } = useToast();
  const [voices, setVoices] = useState<RememberedVoice[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmingDeleteAll, setConfirmingDeleteAll] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setVoices(await listRememberedVoices());
      setLoadError(null);
    } catch (error) {
      setVoices(null);
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleForget = async (voice: RememberedVoice) => {
    setBusyId(voice.id);
    try {
      await forgetRememberedVoice(voice.id);
      await refresh();
      toast(`Forgot ${voice.displayName}'s voice.`, "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusyId(null);
    }
  };

  const handleForgetAll = async () => {
    setBusyId("__all__");
    try {
      const removed = await forgetAllRememberedVoices();
      await refresh();
      setConfirmingDeleteAll(false);
      toast(
        removed === 1 ? "Forgot 1 voice." : `Forgot ${removed} voices.`,
        "success",
      );
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="pt-4 border-t space-y-4">
      <div className="space-y-1">
        <p className="section-heading">Remembered voices</p>
        {/* What is stored, where, and that it never leaves — said plainly,
            because this is the paragraph someone reads before deciding. */}
        <p className="text-sm text-muted-foreground">
          Plainsong can keep a numeric voice signature for each speaker it has
          been given a name for, so the same person is recognized in later
          meetings. The signature is a list of numbers derived from the audio,
          not a recording — it cannot be played back — and it is stored in
          Plainsong&rsquo;s database on this Mac, encrypted with everything else
          when the vault is on. It is never exported, never readable by the
          plainsong command or its MCP server, and never sent anywhere. It is
          included in a local backup, like the rest of the database. Speakers
          you never name are not written down at all: their numbers stay in
          memory while Plainsong is open, which is why a meeting reopened after
          a restart offers no suggestions for them.
        </p>
      </div>

      <SettingsSwitch
        className="py-0"
        label="Remember voices"
        description="Off by default. While it is off nothing about anyone's voice is stored, and speaker separation works exactly as it does now. Turning it on stores a signature only for speakers you name, or that Plainsong offers to name and you confirm — everyone else's stays in memory until you quit."
        checked={rememberVoices}
        onCheckedChange={onRememberVoicesChange}
      />

      <SettingsSwitch
        className="py-0"
        label="Apply a confident match without asking"
        description="When a speaker's voice clears a stricter threshold, put the remembered name on the transcript straight away. The transcript marks such a name “auto” until you confirm it, and a name you typed yourself is never overwritten."
        checked={autoApplyConfidentVoices}
        disabled={!rememberVoices}
        onCheckedChange={onAutoApplyChange}
      />

      <div className="space-y-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-1">
            <p className="text-sm font-medium">Stored on this Mac</p>
            <p className="flex items-start gap-2 text-sm text-muted-foreground">
              <span
                aria-hidden="true"
                className={
                  loadError
                    ? "neume neume-rust mt-1.5 shrink-0"
                    : voices && voices.length > 0
                      ? "neume neume-lit mt-1.5 shrink-0"
                      : "neume neume-hollow mt-1.5 shrink-0"
                }
              />
              <span data-testid="remembered-voices-status">
                {loadError
                  ? `Could not read the remembered voices: ${loadError}`
                  : voices === null
                    ? "Reading the remembered voices…"
                    : voices.length === 0
                      ? "No voices are remembered yet."
                      : `${voices.length} ${voices.length === 1 ? "voice" : "voices"} remembered.`}
              </span>
            </p>
          </div>
          {voices && voices.length > 0 && !confirmingDeleteAll && (
            <Button
              variant="destructive"
              onClick={() => setConfirmingDeleteAll(true)}
              disabled={busyId !== null}
            >
              Delete all
            </Button>
          )}
        </div>

        {confirmingDeleteAll && (
          <div className="flex flex-col gap-3 rounded-md border border-rust/30 bg-rust/5 p-3 lg:flex-row lg:items-center lg:justify-between">
            <p className="text-sm text-foreground">
              Delete every remembered voice and every voice signature kept
              alongside a meeting&rsquo;s speakers? Speaker names already on
              your transcripts stay. This cannot be undone.
            </p>
            <div className="flex shrink-0 gap-2">
              <Button
                variant="ghost"
                onClick={() => setConfirmingDeleteAll(false)}
                disabled={busyId !== null}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => void handleForgetAll()}
                disabled={busyId !== null}
              >
                {busyId === "__all__" ? "Deleting…" : "Delete all"}
              </Button>
            </div>
          </div>
        )}

        {voices && voices.length > 0 && (
          <ul className="divide-y rounded-md border">
            {voices.map((voice) => (
              <li
                key={voice.id}
                className="flex items-center justify-between gap-3 px-3 py-2"
              >
                <div className="min-w-0 space-y-0.5">
                  <p className="truncate text-sm font-medium">{voice.displayName}</p>
                  <p className="rubric-muted truncate">
                    {describeSamples(voice.sampleCount)} · {voice.embeddingModelId}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 text-rust"
                  disabled={busyId !== null}
                  onClick={() => void handleForget(voice)}
                  aria-label={`Forget ${voice.displayName}'s voice`}
                >
                  {busyId === voice.id ? "Deleting…" : "Forget"}
                </Button>
              </li>
            ))}
          </ul>
        )}

        <p className="text-sm text-muted-foreground">
          A signature is tied to the speaker separation model that produced it,
          so a voice remembered under one model is never compared with another.
          Changing the model in Transcription means the next meeting starts
          fresh rather than matching against the wrong numbers.
        </p>
      </div>
    </div>
  );
}
