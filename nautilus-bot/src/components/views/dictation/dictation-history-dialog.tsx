import { SelectiveChangeReview } from "@/components/views/dictation/selective-change-review";
import { RecognitionWordReview } from "@/components/views/dictation/recognition-word-review";
import { DictationChangeReview } from "@/components/views/dictation/dictation-change-review";
import { AudioPlayer } from "@/components/meetings/audio-player";
import { useEffect, useRef, useState } from "react";
import { useScopedRequestGuard } from "@/hooks/use-scoped-request-guard";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Volume2 } from "lucide-react";
import type { Recording, Transcript } from "@/types";
import type {
  DictationHistoryDetails,
  DictationReprocessOutcome,
  DictationReprocessResult,
} from "@/lib/backend/dictation";
import type { DictationModePreset } from "@/features/dictation/runtime";
import {
  DICTATION_MODE_DEFINITIONS,
  DICTATION_MODE_DEFINITION_BY_ID,
} from "@/lib/dictation-profiles";
import {
  describeHistoryLanguage,
  historyModeLabel,
  historyPipelineStageLabel,
  historyPromptSourceLabel,
} from "@/lib/dictation-history-labels";
import { formatDateTime } from "@/lib/format-locale";

function formatStartupLatency(startupLatencyMs: number | null | undefined) {
  if (startupLatencyMs == null) {
    return "Unavailable";
  }
  return startupLatencyMs < 1000
    ? `${startupLatencyMs}ms`
    : `${(startupLatencyMs / 1000).toFixed(1)}s`;
}

function modeLabelFor(preset: string | null | undefined, fallback: string) {
  if (!preset) {
    return fallback;
  }
  return (
    DICTATION_MODE_DEFINITION_BY_ID[preset as DictationModePreset]?.label ??
    preset
  );
}

interface DictationHistoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusTarget?: HTMLElement | null;
  returnFocusFallback?: HTMLElement | null;
  recording: Recording | null;
  transcript: Transcript | null;
  historyDetails: DictationHistoryDetails | null;
  isLoadingTranscript: boolean;
  loadError?: string | null;
  onRetryLoad?: () => void;
  durationLabel: string;
  reprocessModePreset: DictationModePreset;
  onReprocessModePresetChange: (preset: DictationModePreset) => void;
  reprocessedResult: DictationReprocessResult | null;
  isReprocessing: boolean;
  reprocessError: string | null;
  onReprocess: () => void;
  onCancelReprocess?: () => void;
  reprocessCancelling?: boolean;
  onUseReprocessedResult: () => void;
  /** "Process again": the kept audio through the recognizer, not the text. */
  processAgainModeId: string;
  processAgainSpeechRoute: string;
  processAgainSpeechOptions: Array<{ value: string; label: string }>;
  onProcessAgainSpeechRouteChange: (route: string) => void;
  onProcessAgainModeIdChange: (modeId: string) => void;
  processAgainCustomModes: Array<{ id: string; name: string }>;
  processAgainOutcome: DictationReprocessOutcome | null;
  isProcessingAgain: boolean;
  processAgainBusyMessage?: string | null;
  processAgainError: string | null;
  processAgainRefreshWarning?: string | null;
  onProcessAgain: () => void;
  onOpenProcessAgainResult: () => void;
  correctionText: string;
  editDirty?: boolean;
  isSavingEdit?: boolean;
  editError?: string | null;
  editStatus?: string | null;
  onSaveEdit?: () => void;
  onDiscardEdit?: () => void;
  onRestoreOriginal?: () => void;
  onRestoreText?: (value: string) => void;
  onCorrectionTextChange: (value: string) => void;
  onCorrectionBlur: () => void;
  canLearnCorrection: boolean;
  onLearnCorrection: () => void;
  learnStatus: string | null;
  isReadingAloud: boolean;
  onToggleReadAloud: () => void;
  onCopyStart?: () => void;
  onDelete: () => void;
}

/**
 * The saved-dictation inspector: what Plainsong heard, the route and prompt it
 * used, and a reprocess bench for trying another mode on the same audio.
 */
export function DictationHistoryDialog({
  open,
  onOpenChange,
  returnFocusTarget = null,
  returnFocusFallback = null,
  recording,
  transcript,
  historyDetails,
  isLoadingTranscript,
  loadError,
  onRetryLoad,
  durationLabel,
  reprocessModePreset,
  onReprocessModePresetChange,
  reprocessedResult,
  isReprocessing,
  reprocessError,
  onReprocess,
  onCancelReprocess,
  reprocessCancelling = false,
  onUseReprocessedResult,
  processAgainModeId,
  processAgainSpeechRoute,
  processAgainSpeechOptions,
  onProcessAgainSpeechRouteChange,
  onProcessAgainModeIdChange,
  processAgainCustomModes,
  processAgainOutcome,
  isProcessingAgain,
  processAgainBusyMessage = null,
  processAgainError,
  processAgainRefreshWarning = null,
  onProcessAgain,
  onOpenProcessAgainResult,
  correctionText,
  editDirty = false,
  isSavingEdit = false,
  editError,
  editStatus,
  onSaveEdit,
  onDiscardEdit,
  onRestoreOriginal,
  onRestoreText,
  onCorrectionTextChange,
  onCorrectionBlur,
  canLearnCorrection,
  onLearnCorrection,
  learnStatus,
  isReadingAloud,
  onToggleReadAloud,
  onCopyStart,
  onDelete,
}: DictationHistoryDialogProps) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const [copyStatus, setCopyStatus] = useState<{ text: string; error: boolean; copiedEditableText?: string } | null>(null);
  const [copyPending, setCopyPending] = useState(false);
  const copyPendingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const [originalAudio, setOriginalAudio] = useState<{ recordingId: string; attempt: number } | null>(null);
  const [originalAudioError, setOriginalAudioError] = useState(false);
  const originalAudioRef = useRef(originalAudio);
  const currentAudioScopeRef = useRef({
    open,
    recordingId: recording?.id ?? null,
    audioAvailable: historyDetails?.audioAvailable === true,
  });
  originalAudioRef.current = originalAudio;
  currentAudioScopeRef.current = {
    open,
    recordingId: recording?.id ?? null,
    audioAvailable: historyDetails?.audioAvailable === true,
  };
  const copyRequestGuard = useScopedRequestGuard<string | null>();
  useEffect(() => {
    copyRequestGuard.setScope(open ? recording?.id ?? null : null);
    setCopyStatus(null);
    originalAudioRef.current = null;
    setOriginalAudio(null);
    setOriginalAudioError(false);
  }, [open, recording?.id, copyRequestGuard]);

  const showOriginalAudio = () => {
    if (!open || !recording || historyDetails?.audioAvailable !== true) return;
    const next = { recordingId: recording.id, attempt: 0 };
    originalAudioRef.current = next;
    setOriginalAudio(next);
    setOriginalAudioError(false);
  };

  const hideOriginalAudio = () => {
    originalAudioRef.current = null;
    setOriginalAudio(null);
    setOriginalAudioError(false);
  };

  const retryOriginalAudio = () => {
    if (!recording || originalAudio?.recordingId !== recording.id) return;
    const next = { recordingId: recording.id, attempt: originalAudio.attempt + 1 };
    originalAudioRef.current = next;
    setOriginalAudio(next);
    setOriginalAudioError(false);
  };

  const copyText = async (text: string, label: string, editableText = false) => {
    if (!open || !recording || copyPendingRef.current) return;
    const request = copyRequestGuard.beginRequest(recording.id);
    const isCurrent = () => mountedRef.current
      && currentAudioScopeRef.current.open
      && currentAudioScopeRef.current.recordingId === request.scope
      && copyRequestGuard.isCurrent(request);
    setCopyStatus(null);
    if (!text.trim()) {
      setCopyStatus({ text: "Nothing to copy. Enter some text first.", error: true });
      return;
    }
    copyPendingRef.current = true;
    setCopyPending(true);
    setCopyStatus({ text: "Copying…", error: false });
    try {
      onCopyStart?.();
      await navigator.clipboard.writeText(text);
      if (isCurrent()) setCopyStatus({
        text: `${label} copied.`,
        error: false,
        copiedEditableText: editableText ? text : undefined,
      });
    } catch {
      if (isCurrent()) setCopyStatus({
        text: "Couldn't copy to the clipboard. Select the text and copy it manually.",
        error: true,
      });
    } finally {
      copyPendingRef.current = false;
      if (mountedRef.current) setCopyPending(false);
    }
  };

  // `audioAvailable` is three-valued on purpose: true (the file is there),
  // false (audio was kept and is now gone) and null (none was ever kept).
  // Each gets its own sentence rather than one vague "unavailable".
  const canProcessAgain = historyDetails?.audioAvailable === true;
  const originalAudioIsOpen = open
    && canProcessAgain
    && recording !== null
    && originalAudio?.recordingId === recording.id;
  // A speech model the way the retry picker names it; the raw ids only when
  // the model is not in that list.
  const speechOptionLabel = (
    provider: string | null | undefined,
    modelId: string | null | undefined,
  ) =>
    processAgainSpeechOptions.find((option) => option.value === `${provider}:${modelId}`)?.label ??
    [provider, modelId].filter(Boolean).join(" · ");
  const previewUnchanged = reprocessedResult !== null
    && reprocessedResult.outputText === correctionText;
  const showUnchangedPreview = previewUnchanged && !reprocessedResult?.aiRewriteFailed;
  const showStyleComparison = isReprocessing
    || reprocessedResult !== null
    || reprocessError !== null;
  const reviewOriginal = historyDetails?.rawTranscript ?? transcript?.fullText ?? "";
  const savedComparisonRows = 2 + Number(Boolean(transcript && reviewOriginal !== correctionText)) + Number(Boolean(onSaveEdit)) + Number(Boolean(editError))
    + Number(Boolean(transcript && correctionText !== transcript.fullText))
    + Number(Boolean(historyDetails?.rawTranscript?.trim()
    && historyDetails.rawTranscript.trim() !== transcript?.fullText.trim())) + Number(Boolean(learnStatus));
  const comparisonRows = Math.max(savedComparisonRows,
    2 + Number(Boolean(reprocessedResult && reprocessedResult.outputText !== correctionText)));


  const processAgainUnavailableReason =
    historyDetails?.audioAvailable === false
      ? "This dictation's kept audio is no longer on disk, so it cannot be processed again. Auto-delete removes kept audio along with the history entry."
      : transcript
        ? "This dictation was saved without its audio, so only the words above can be restyled. Turn on “Keep dictation audio for Process again” in Capture and insert to keep the audio of future dictations."
        : "This dictation has no saved audio, so it cannot be processed again. Turn on “Keep dictation audio for Process again” in Capture and insert to keep the audio of future dictations.";

  const originalAudioReview = open && canProcessAgain && recording ? (
    <section
      aria-label="Original dictation audio"
      className="space-y-2 rounded-md border bg-background p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Original dictation audio</p>
          <p className="text-xs text-muted-foreground">
            Listen to what was recorded before correcting or processing it again.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={originalAudioIsOpen ? hideOriginalAudio : showOriginalAudio}
        >
          {originalAudioIsOpen ? "Hide original audio" : "Listen to original audio"}
        </Button>
      </div>
      {originalAudioIsOpen && (
        <div className="space-y-2">
          <AudioPlayer
            key={`${recording.id}:${originalAudio.attempt}`}
            recordingId={recording.id}
            waveform={[]}
            durationHint={recording.duration}
            onError={() => {
              const scope = currentAudioScopeRef.current;
              const active = originalAudioRef.current;
              if (
                scope.open
                && scope.audioAvailable
                && scope.recordingId === recording.id
                && active?.recordingId === recording.id
                && active.attempt === originalAudio.attempt
              ) {
                setOriginalAudioError(true);
              }
            }}
          />
          {originalAudioError && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-rust/30 bg-rust/10 px-3 py-2">
              <p role="alert" className="text-sm text-rust">
                Original audio could not be opened. Your text is unchanged.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={retryOriginalAudio}
              >
                Retry original audio
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  ) : null;

  const processAgainSection = (
    <div className="space-y-3 border-t pt-4">
      <div>
        <h3 className="section-heading">Process again</h3>
        <p className="text-sm text-muted-foreground">
          Runs this dictation&apos;s kept audio through the recognizer again and
          saves the result as a new history entry. Nothing is typed anywhere
          and this entry is left as it is.
        </p>
      </div>
      {canProcessAgain ? (
        <div className="space-y-3">
        {processAgainBusyMessage ? (
          <p className="rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
            {processAgainBusyMessage}
          </p>
        ) : null}
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)_auto] md:items-start">
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="dictation-process-again-mode">
              Style for the new entry
            </label>
            <select
              id="dictation-process-again-mode"
              className="w-full min-w-[220px] rounded-md border bg-background p-2 text-sm"
              value={processAgainModeId}
              disabled={isProcessingAgain}
              onChange={(event) => onProcessAgainModeIdChange(event.target.value)}
            >
              {DICTATION_MODE_DEFINITIONS.filter((mode) => mode.id !== "custom").map((mode) => (
                <option key={mode.id} value={mode.id}>{mode.label}</option>
              ))}
              {processAgainCustomModes.map((mode) => (
                <option key={mode.id} value={mode.id}>{mode.name} (saved profile)</option>
              ))}
            </select>
          </div>
          <div className="min-w-0 space-y-2">
            <label className="text-sm font-medium" htmlFor="dictation-process-again-speech">
              Speech model for this retry
            </label>
            <select
              id="dictation-process-again-speech"
              className="w-full min-w-0 max-w-sm rounded-md border bg-background p-2 text-sm"
              value={processAgainSpeechRoute}
              disabled={isProcessingAgain}
              onChange={(event) => onProcessAgainSpeechRouteChange(event.target.value)}
            >
              <option value="current">Current speech settings</option>
              {processAgainSpeechOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              Choose a downloaded model for this retry. Your usual settings stay unchanged.
            </p>
          </div>
          <Button
            variant="outline"
            className="self-end md:mt-7 md:self-start"
            onClick={onProcessAgain}
            disabled={isProcessingAgain}
          >
            {isProcessingAgain
              ? processAgainBusyMessage ? "Another retry is running…" : "Processing again…"
              : "Process again"}
          </Button>
        </div>
        </div>
      ) : (
        <p className="rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          {processAgainUnavailableReason}
        </p>
      )}
      {processAgainError && (
        <div className="rounded-md border border-rust/30 bg-rust/10 px-3 py-2 text-sm text-rust">
          {processAgainError}
        </div>
      )}
      {processAgainRefreshWarning && (
        <p role="status" className="rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          {processAgainRefreshWarning}
        </p>
      )}
      {processAgainOutcome && (
        <div className="space-y-2 rounded-md border border-gold/30 bg-gold/5 px-3 py-3">
          {processAgainOutcome.aiRewriteFailed && (
            <p role="status" className="text-sm text-foreground">
              AI rewrite wasn&apos;t applied. This entry uses the recognized text with local formatting.
            </p>
          )}
          <div className="flex flex-wrap items-start justify-between gap-2">
            <p className="text-sm font-medium">Saved as a new dictation</p>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={copyPending}
                onClick={() => void copyText(processAgainOutcome.finalText, "New dictation")}
              >
                Copy result
              </Button>
              <Button variant="ghost" size="sm" onClick={onOpenProcessAgainResult}>
                Open it
              </Button>
            </div>
          </div>
          <p className="whitespace-pre-wrap text-sm">{processAgainOutcome.finalText}</p>
          <p className="text-sm text-muted-foreground">
            {processAgainOutcome.customModeName ?? modeLabelFor(
              processAgainOutcome.modePreset,
              processAgainOutcome.modePreset,
            )}{" "}
            · {speechOptionLabel(processAgainOutcome.provider, processAgainOutcome.modelId)} ·{" "}
            {processAgainOutcome.usedAi ? "AI tuned" : "Rule based"} · Transcribed in{" "}
            <span className="time-spec">
              {formatStartupLatency(processAgainOutcome.transcriptionLatencyMs)}
            </span>
          </p>
        </div>
      )}
    </div>
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-2xl max-h-[80vh] overflow-y-auto"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          titleRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (openRef.current) return;
          const target = returnFocusTarget?.isConnected ? returnFocusTarget : returnFocusFallback;
          if (target?.isConnected) target.focus();
        }}
      >
        <DialogHeader>
          <div className="flex items-center justify-between gap-3">
            <DialogTitle ref={titleRef} tabIndex={-1}>{recording?.title ?? "Dictation"}</DialogTitle>
            {recording && (
              <div className="flex gap-2">
                {transcript?.fullText?.trim() && (
                  <Button variant="outline" size="sm" onClick={onToggleReadAloud}>
                    <Volume2 className="mr-2 h-4 w-4" />
                    {isReadingAloud ? "Stop reading" : "Read aloud"}
                  </Button>
                )}
                {transcript?.fullText?.trim() && (
                  <Button variant="outline" size="sm" disabled={copyPending} onClick={() => void copyText(correctionText, "Editor text", true)}>
                    Copy
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={onDelete}>
                  Delete
                </Button>
              </div>
            )}
          </div>
        </DialogHeader>
        {copyStatus && (
          <p role={copyStatus.error ? "alert" : "status"} className="text-sm text-muted-foreground">
            {copyStatus.copiedEditableText !== undefined && copyStatus.copiedEditableText !== correctionText
              ? "Earlier text copied. Copy again to include your latest edits."
              : copyStatus.text}
          </p>
        )}
        {originalAudioReview}
        {isLoadingTranscript ? (
          <p className="text-sm text-muted-foreground">Loading transcript…</p>
        ) : loadError ? (
          <div className="space-y-3">
            <p role="alert" className="text-sm text-rust">{loadError}</p>
            <Button variant="outline" onClick={onRetryLoad}>Retry</Button>
          </div>
        ) : transcript ? (
          <div className="space-y-5">
            <div className="space-y-3">
              <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                <div className="space-y-2">
                  <label
                    className="text-sm font-medium"
                    htmlFor="dictation-reprocess-mode"
                  >
                    Try another style
                  </label>
                  <select
                    id="dictation-reprocess-mode"
                    className="w-full min-w-[220px] rounded-md border bg-background p-2 text-sm"
                    value={reprocessModePreset}
                    disabled={isReprocessing}
                    onChange={(event) =>
                      onReprocessModePresetChange(
                        event.target.value as DictationModePreset,
                      )
                    }
                  >
                    {DICTATION_MODE_DEFINITIONS.filter(
                      (mode) => mode.id !== "custom",
                    ).map((mode) => (
                      <option key={mode.id} value={mode.id}>
                        {mode.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={onReprocess}
                    disabled={isReprocessing || !correctionText.trim()}
                  >
                    {isReprocessing ? "Reprocessing…" : "Reprocess"}
                  </Button>
                  {isReprocessing && onCancelReprocess && (
                    <Button variant="outline" onClick={onCancelReprocess} disabled={reprocessCancelling}>
                      {reprocessCancelling ? "Cancelling…" : "Cancel preview"}
                    </Button>
                  )}
                  {reprocessedResult && (
                    <Button variant="outline" onClick={onUseReprocessedResult} disabled={previewUnchanged}>
                      Use Result
                    </Button>
                  )}
                </div>
              </div>
              <p className="text-sm text-muted-foreground">
                Runs the words in the editor through another style, including
                your corrections, so you can compare before copying.
              </p>
              {reprocessError && (
                <div className="rounded-md border border-rust/30 bg-rust/10 px-3 py-2 text-sm text-rust">
                  {reprocessError}
                </div>
              )}
            </div>

            <div className={`grid gap-4 border-t pt-4 ${showStyleComparison ? "md:grid-cols-2" : ""}`}>
              <div
                className={`space-y-2 ${showStyleComparison ? "md:grid md:grid-rows-subgrid md:gap-2 md:space-y-0" : ""}`}
                style={showStyleComparison ? { gridRow: `span ${comparisonRows}` } : undefined}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">Saved result</p>
                    <p className="text-sm text-muted-foreground">
                      Correct your text here. Changes are kept when you save or close;
                      the original stays available.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {onSaveEdit && <Button size="sm" disabled={!editDirty || isSavingEdit} onClick={onSaveEdit}>
                      {isSavingEdit ? "Saving…" : "Save changes"}
                    </Button>}
                    {editDirty && onDiscardEdit && <Button variant="ghost" size="sm" disabled={isSavingEdit} onClick={onDiscardEdit}>Discard changes</Button>}
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={copyPending}
                      onClick={() =>
                        void copyText(correctionText, "Saved result", true)
                      }
                    >
                      Copy
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!canLearnCorrection}
                      onClick={onLearnCorrection}
                    >
                      Learn correction
                    </Button>
                  </div>
                </div>
                <div className="min-h-[180px] rounded-md bg-muted p-4">
                  <textarea
                    aria-label="Saved result"
                    className="min-h-[180px] w-full resize-y bg-transparent text-sm outline-none"
                    value={correctionText}
                    onChange={(event) =>
                      onCorrectionTextChange(event.target.value)
                    }
                    onBlur={onCorrectionBlur}
                  />
                </div>
                {recording?.id === transcript.recordingId && !isLoadingTranscript && <RecognitionWordReview
                  words={historyDetails?.recognitionReviewWords} original={historyDetails?.rawTranscript} />}
                <DictationChangeReview original={reviewOriginal} current={correctionText}
                  originalLabel={historyDetails?.rawTranscript != null ? "Recognizer output" : "Original result"} />
                <SelectiveChangeReview key={recording?.id} original={reviewOriginal} current={correctionText}
                  originalLabel={historyDetails?.rawTranscript != null ? "Recognizer output" : "Original result"}
                  disabled={isSavingEdit || isReprocessing} onChange={onRestoreText ?? onCorrectionTextChange} />
                {onSaveEdit && <p className="text-xs text-muted-foreground" role="status">
                  {isSavingEdit ? "Saving changes…" : editDirty ? "Unsaved changes" : editStatus ?? "Saved"}
                </p>}
                {editError && <p role="alert" className="text-sm text-rust">{editError}</p>}
                {correctionText !== transcript.fullText && (
                  <details className="rounded-md border p-3 text-sm">
                    <summary className="cursor-pointer font-medium">Original result</summary>
                    <pre className="mt-3 whitespace-pre-wrap break-words font-sans text-sm text-muted-foreground">{transcript.fullText}</pre>
                    {onRestoreOriginal && <Button variant="ghost" size="sm" className="mt-2" disabled={isSavingEdit || isReprocessing} onClick={onRestoreOriginal}>Restore original</Button>}
                  </details>
                )}
                {historyDetails?.rawTranscript?.trim() &&
                  historyDetails.rawTranscript.trim() !== transcript.fullText.trim() && (
                    <details className="rounded-md border p-3 text-sm">
                      <summary className="cursor-pointer font-medium">Show recognizer output</summary>
                      <Button variant="ghost" size="sm" className="mt-2"
                        disabled={copyPending}
                        onClick={() => void copyText(historyDetails.rawTranscript!, "Recognizer output")}>
                        Copy recognizer output
                      </Button>
                      <Button variant="ghost" size="sm" className="mt-2"
                        disabled={isSavingEdit || isReprocessing || correctionText === historyDetails.rawTranscript}
                        onClick={() => (onRestoreText ?? onCorrectionTextChange)(historyDetails.rawTranscript!)}>
                        Restore recognizer output
                      </Button>
                      <pre aria-label="Raw recognition" className="mt-3 whitespace-pre-wrap break-words font-sans text-sm text-muted-foreground">
                        {historyDetails.rawTranscript}
                      </pre>
                    </details>
                  )}
                {learnStatus && (
                  <p className="rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground">
                    {learnStatus}
                  </p>
                )}
              </div>
              {showStyleComparison && <div className="space-y-2 md:grid md:grid-rows-subgrid md:gap-2 md:space-y-0" style={{ gridRow: `span ${comparisonRows}` }}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">
                      {reprocessedResult?.aiRewriteFailed ? "Basic formatting" : showUnchangedPreview ? "No changes" : "Style preview"}
                    </p>
                    <p className="text-sm text-muted-foreground" role={reprocessedResult?.aiRewriteFailed || showUnchangedPreview ? "status" : undefined}>
                      {reprocessedResult?.aiRewriteFailed
                        ? "AI rewrite wasn't applied. Basic formatting is shown instead."
                         : showUnchangedPreview
                          ? reprocessedResult?.usedAi
                            ? "AI returned your text without changes."
                            : "This style left your text unchanged."
                          : reprocessedResult
                          ? `${modeLabelFor(reprocessedResult.modePreset, "Selected style")} preview. Compare with the saved result before copying.`
                          : "Try a different style without overwriting this saved entry."}
                    </p>
                  </div>
                  {reprocessedResult?.outputText && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={copyPending}
                      onClick={() =>
                        void copyText(reprocessedResult.outputText, "Style preview")
                      }
                    >
                      Copy
                    </Button>
                  )}
                </div>
                <div className="min-h-[180px] rounded-md bg-muted p-4">
                  {reprocessedResult ? (
                    <p className="whitespace-pre-wrap text-sm">
                      {reprocessedResult.outputText}
                    </p>
                  ) : isReprocessing ? (
                    <p className="text-sm text-muted-foreground" role="status">
                      Creating a style preview…
                    </p>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      No preview was created. Choose a style and try again.
                    </p>
                  )}
                </div>
                {reprocessedResult ? <DictationChangeReview original={correctionText}
                  current={reprocessedResult.outputText} originalLabel="Current text" currentLabel="New result" /> : null}
              </div>}
            </div>

            {processAgainSection}

            <details key={recording?.id} className="group border-t pt-4">
              <summary className="cursor-pointer rounded-sm py-1 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                Capture, prompt, and processing details
              </summary>
              <div className="mt-4 space-y-5">
                <div className="space-y-3">
                  <div>
                    <h3 className="section-heading">Capture details</h3>
                    <p className="text-sm text-muted-foreground">
                      The engine, model, and quality of the original capture.
                    </p>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    <div className="rounded-md border bg-muted/30 px-3 py-2">
                      <p className="rubric-muted">Requested engine</p>
                      <p className="mt-1 text-sm font-medium">
                        {transcript.requestedProvider || "The default"}
                      </p>
                    </div>
                    <div className="rounded-md border bg-muted/30 px-3 py-2">
                      <p className="rubric-muted">Actual engine</p>
                      <p className="mt-1 text-sm font-medium">
                        {transcript.actualProvider ||
                          transcript.requestedProvider ||
                          "Unknown"}
                      </p>
                    </div>
                    <div className="rounded-md border bg-muted/30 px-3 py-2">
                      <p className="rubric-muted">Model</p>
                      <p className="mt-1 text-sm font-medium">
                        {transcript.modelId || transcript.model || "Unknown"}
                      </p>
                    </div>
                    <div className="rounded-md border bg-muted/30 px-3 py-2">
                      <p className="rubric-muted">Language</p>
                      <p className="mt-1 text-sm font-medium">
                        {transcript.language || "Unknown"}
                      </p>
                    </div>
                    <div className="rounded-md border bg-muted/30 px-3 py-2">
                      <p className="rubric-muted">Segments</p>
                      <p className="mt-1 text-sm font-medium">
                        {transcript.segments?.length ?? 0}
                      </p>
                    </div>
                    <div className="rounded-md border bg-muted/30 px-3 py-2">
                      <p className="rubric-muted">Time to start</p>
                      <p className="mt-1 text-sm font-medium">
                        {formatStartupLatency(historyDetails?.startupLatencyMs)}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="space-y-3 border-t pt-4">
                  <div>
                    <h3 className="section-heading">Prompt and context</h3>
                    <p className="text-sm text-muted-foreground">
                      What Plainsong knew about the app, and which prompt it used.
                    </p>
                  </div>
                  {historyDetails ? (
                    <div className="space-y-3">
                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        <div className="rounded-md border bg-muted/30 px-3 py-2">
                          <p className="rubric-muted">Mode</p>
                          <p className="mt-1 text-sm font-medium">
                            {historyModeLabel(historyDetails)}
                          </p>
                        </div>
                        <div className="rounded-md border bg-muted/30 px-3 py-2">
                          <p className="rubric-muted">Base style</p>
                          <p className="mt-1 text-sm font-medium">
                            {historyDetails.baseModeLabel ??
                              modeLabelFor(
                                historyDetails.baseModePreset,
                                "Unavailable",
                              )}
                          </p>
                        </div>
                        <div className="rounded-md border bg-muted/30 px-3 py-2">
                          <p className="rubric-muted">Context source</p>
                          <p className="mt-1 text-sm font-medium">
                            {historyDetails.contextSource ?? "Unavailable"}
                          </p>
                        </div>
                        <div className="rounded-md border bg-muted/30 px-3 py-2">
                          <p className="rubric-muted">Asked to run</p>
                          <p className="mt-1 text-sm font-medium">
                            {historyDetails.routePreference
                              ? historyDetails.routePreference === "cloud"
                                ? "In the cloud"
                                : "On this Mac"
                              : "Unavailable"}
                          </p>
                        </div>
                        <div className="rounded-md border bg-muted/30 px-3 py-2">
                          <p className="rubric-muted">Actually ran</p>
                          <p className="mt-1 text-sm font-medium">
                            {historyDetails.resolvedHosting
                              ? historyDetails.resolvedHosting === "cloud"
                                ? "In the cloud"
                                : "On this Mac"
                              : "Unavailable"}
                          </p>
                        </div>
                        <div className="rounded-md border bg-muted/30 px-3 py-2">
                          <p className="rubric-muted">Prompt strategy</p>
                          <p className="mt-1 text-sm font-medium">
                            {historyPromptSourceLabel(historyDetails.promptSource)}
                          </p>
                        </div>
                        <div className="rounded-md border bg-muted/30 px-3 py-2">
                          <p className="rubric-muted">Language</p>
                          <p className="mt-1 text-sm font-medium">
                            {describeHistoryLanguage(historyDetails)}
                          </p>
                        </div>
                      </div>
                      {(historyDetails.customModeName ||
                        historyDetails.contextAppName ||
                        historyDetails.appTarget ||
                        historyDetails.activationMatcher ||
                        historyDetails.commandApplied) && (
                        <div className="flex flex-wrap gap-3 text-sm text-muted-foreground">
                          {historyDetails.customModeName && (
                            <span>Custom mode: {historyDetails.customModeName}</span>
                          )}
                          {historyDetails.contextAppName && (
                            <span>Context app: {historyDetails.contextAppName}</span>
                          )}
                          {historyDetails.appTarget && (
                            <span>Inserted into: {historyDetails.appTarget}</span>
                          )}
                          {historyDetails.activationMatcher && (
                            <span>
                              App rule:{" "}
                              {historyDetails.customModeName
                                ? `${historyDetails.customModeName} via ${historyDetails.activationMatcher}`
                                : historyDetails.activationMatcher}
                            </span>
                          )}
                          {historyDetails.commandApplied && (
                            <span>Command: {historyDetails.commandApplied}</span>
                          )}
                        </div>
                      )}
                      {(historyDetails.pipelineStageKeys.length > 0 ||
                        historyDetails.dictionaryAppliedCount != null ||
                        historyDetails.snippetAppliedCount != null ||
                        historyDetails.formattingApplied != null ||
                        historyDetails.recentInsertReused != null) && (
                        <div className="space-y-3 border-t pt-4">
                          <div>
                            <h3 className="section-heading">What changed the text</h3>
                            <p className="text-sm text-muted-foreground">
                              The steps that edited this transcript before it was
                              inserted.
                            </p>
                          </div>
                          {historyDetails.pipelineStageKeys.length > 0 && (
                            <div className="flex flex-wrap gap-2">
                              {historyDetails.pipelineStageKeys.map((stageKey) => (
                                <span
                                  key={stageKey}
                                  className="rounded-full border bg-background px-2 py-1 text-sm font-medium"
                                >
                                  {historyPipelineStageLabel(stageKey)}
                                </span>
                              ))}
                            </div>
                          )}
                          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                            <div className="rounded-md border bg-background px-3 py-2">
                              <p className="rubric-muted">Dictionary</p>
                              <p className="mt-1 text-sm font-medium">
                                {historyDetails.dictionaryAppliedCount ?? 0} rules
                              </p>
                            </div>
                            <div className="rounded-md border bg-background px-3 py-2">
                              <p className="rubric-muted">Snippets</p>
                              <p className="mt-1 text-sm font-medium">
                                {historyDetails.snippetAppliedCount ?? 0} expansions
                              </p>
                            </div>
                            <div className="rounded-md border bg-background px-3 py-2">
                              <p className="rubric-muted">Formatting</p>
                              <p className="mt-1 text-sm font-medium">
                                {historyDetails.formattingApplied
                                  ? "Applied"
                                  : "Not applied"}
                              </p>
                            </div>
                            <div className="rounded-md border bg-background px-3 py-2">
                              <p className="rubric-muted">Recent insert</p>
                              <p className="mt-1 text-sm font-medium">
                                {historyDetails.recentInsertReused
                                  ? "Reused"
                                  : "Not reused"}
                              </p>
                            </div>
                          </div>
                        </div>
                      )}
                      {historyDetails.promptPreview && (
                        <div className="space-y-2">
                          <p className="text-sm font-medium">Prompt preview</p>
                          <div className="min-h-[110px] rounded-md bg-muted p-4 text-sm">
                            <p className="whitespace-pre-wrap">
                              {historyDetails.promptPreview}
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      This dictation was saved before Plainsong started recording
                      these details.
                    </p>
                  )}
                </div>

              </div>
            </details>

            <p className="border-t pt-4 text-sm text-muted-foreground">
              Duration: <span className="time-spec">{durationLabel}</span> ·
              Created:{" "}
              {recording
                ? formatDateTime(recording.createdAt)
                : "N/A"}
              {historyDetails?.reprocessedFromId && (
                <>
                  {" "}
                  · Re-processed from{" "}
                  <span className="time-spec">
                    {historyDetails.reprocessedFromCreatedAt
                      ? formatDateTime(historyDetails.reprocessedFromCreatedAt)
                      : "a dictation that has since been deleted"}
                  </span>
                </>
              )}
              {reprocessedResult && (
                <>
                  {" "}
                  · Reprocessed as:{" "}
                  {modeLabelFor(
                    reprocessedResult.modePreset,
                    reprocessedResult.modePreset,
                  )}{" "}
                  · {reprocessedResult.usedAi ? previewUnchanged ? "AI checked" : "AI edited" : "Rule based"}
                  {reprocessedResult.provider || reprocessedResult.modelId
                    ? ` · ${speechOptionLabel(reprocessedResult.provider, reprocessedResult.modelId)}`
                    : ""}
                </>
              )}
            </p>
          </div>
        ) : recording ? (
          <div className="space-y-5">
            <p className="rounded-md border border-rust/30 bg-rust/10 px-3 py-2 text-sm text-rust">
              {recording.status === "error" && canProcessAgain
                ? "Transcription didn't finish. Plainsong saved the audio, so you can try again."
                : "No transcript is available for this dictation."}
            </p>
            {processAgainSection}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No dictation selected.</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
