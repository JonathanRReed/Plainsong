import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SettingsGroup, SettingsSwitch } from "@/components/ui/settings-control";
import { useToast } from "@/components/toast";
import {
  forgetAllRememberedVoices,
  forgetRememberedVoice,
  listRememberedVoices,
  type RememberedVoice,
} from "@/lib/backend/asr";
import { speakerModelName } from "@/lib/speaker-models";

interface RememberedVoicesSectionProps {
  /** `meetings.rememberVoices`. */
  rememberVoices: boolean;
  /** `meetings.autoApplyConfidentVoices`. */
  autoApplyConfidentVoices: boolean;
  onRememberVoicesChange: (enabled: boolean) => void;
  onAutoApplyChange: (enabled: boolean) => void;
  /** The speaker model selected under Meetings > Speakers, when known. */
  activeModelId?: string;
  /**
   * The model the next meeting will actually run: the selected one when it is
   * downloaded, otherwise a downloaded stand-in, or `null` when no speaker
   * model is on this Mac. `undefined` while unknown, which reads as the
   * selected model.
   */
  runModelId?: string | null;
  /** Picker labels by model id, so a stored voice names its model plainly. */
  modelLabels?: Record<string, string>;
}

/**
 * Models that compute no voice signature: a meeting separated with one of
 * them neither remembers nor recognises a voice.
 */
const MODELS_WITHOUT_SIGNATURES = new Set(["nemotron3_diarization"]);

/**
 * Remembered voices recorded under other models than the one that will run, as
 * "3 voices remembered with ECAPA-TDNN 512" phrases, or null when every voice
 * can be matched.
 */
function voicesOutsideModel(
  voices: RememberedVoice[],
  runModelId: string,
  label: (id: string) => string,
): string | null {
  const counts = new Map<string, number>();
  for (const voice of voices) {
    if (voice.embeddingModelId === runModelId) continue;
    counts.set(voice.embeddingModelId, (counts.get(voice.embeddingModelId) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  return [...counts.entries()]
    .map(([id, count]) => `${count} ${count === 1 ? "voice" : "voices"} remembered with ${label(id)}`)
    .join(" and ");
}

/**
 * The note under the list: which stored voices the next meeting cannot match,
 * keyed off the model that produced each voice and the model that will
 * actually run, so a selected-but-missing model is not mistaken for the one
 * separating speakers.
 */
export function rememberedVoicesModelNote({
  voices,
  activeModelId,
  runModelId,
  label,
}: {
  voices: RememberedVoice[];
  activeModelId: string | undefined;
  runModelId: string | null | undefined;
  label: (id: string) => string;
}): string | null {
  const runs = runModelId === undefined ? activeModelId : runModelId;
  if (runs === undefined) return null;
  if (runs === null) {
    return voices.length > 0
      ? "No speaker model is downloaded, so meetings are saved without speaker labels and remembered voices can’t be matched. They are kept: download a speaker model under Speakers to use them."
      : null;
  }
  const standIn = activeModelId !== undefined && activeModelId !== runs;
  const standInSentence = standIn
    ? ` ${label(activeModelId)} is selected but isn’t downloaded, so meetings use ${label(runs)}.`
    : "";
  if (MODELS_WITHOUT_SIGNATURES.has(runs)) {
    return `${label(runs)} tells speakers apart without voice signatures, so while it runs Plainsong neither remembers nor recognises voices.${standInSentence} Choose another speaker model under Speakers to use this list.`;
  }
  const outside = voicesOutsideModel(voices, runs, label);
  if (!outside) return null;
  const advice = standIn
    ? `download ${label(activeModelId)} under Speakers to use the voices remembered with it, or name those speakers in a meeting to remember them with ${label(runs)}.`
    : `choose that model again under Speakers to use them, or name those speakers in a meeting to remember them with ${label(runs)}.`;
  return `${outside[0].toUpperCase() + outside.slice(1)} can’t be matched while ${label(runs)} tells speakers apart.${standInSentence} They are kept: ${advice} Only the signatures are stored, not the audio, so they cannot be converted.`;
}

/** "2 samples" / "1 sample", so the list never reads "1 samples". */
function describeSamples(count: number): string {
  return `${count} ${count === 1 ? "sample" : "samples"}`;
}

/**
 * Settings > Meetings > Remembered voices.
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
  activeModelId,
  runModelId,
  modelLabels,
}: RememberedVoicesSectionProps) {
  // Voices remembered with a model the picker no longer offers still name it.
  const label = (id: string) => modelLabels?.[id] ?? speakerModelName(id) ?? id;
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
    <SettingsGroup
      title="Remembered voices"
      settingId="remembered-voices"
      description="Recognize a speaker you have named in later meetings. Only a numeric signature is kept, on this Mac."
    >
      <SettingsSwitch
        label="Remember voices"
        description="Off by default. On, Plainsong stores a signature only for speakers you name, or that Plainsong offers to name and you confirm — everyone else's stays in memory until you quit."
        checked={rememberVoices}
        onCheckedChange={onRememberVoicesChange}
      />

      <SettingsSwitch
        label="Apply a confident match without asking"
        description="A very close match is named on the transcript straight away, marked “auto” until you confirm it. A name you typed is never replaced."
        checked={autoApplyConfidentVoices}
        disabled={!rememberVoices}
        onCheckedChange={onAutoApplyChange}
      />

      <div className="space-y-3 py-3.5">
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
                    {describeSamples(voice.sampleCount)} · {label(voice.embeddingModelId)}
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

        {(() => {
          const note = rememberedVoicesModelNote({
            voices: voices ?? [],
            activeModelId,
            runModelId,
            label,
          });
          return note ? (
            <p
              className="text-sm text-rust"
              data-testid="remembered-voices-model-notice"
            >
              {note}
            </p>
          ) : null;
        })()}

        {/* What is stored, where, and that it never leaves — said plainly,
            because this is the paragraph someone reads before deciding. */}
        <details className="group/stored text-sm">
          <summary className="cursor-pointer list-none text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            What exactly is stored
          </summary>
          <div className="mt-2 space-y-2 text-muted-foreground">
            <p>
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
            <p>
              A signature is tied to the speaker model that produced it, so a
              voice remembered under one model is never compared with another.
              Changing the speaker model means the next meeting starts fresh
              rather than matching against the wrong numbers.
            </p>
          </div>
        </details>
      </div>
    </SettingsGroup>
  );
}
