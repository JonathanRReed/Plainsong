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
  DictationReprocessResult,
} from "@/lib/backend/dictation";
import type { DictationModePreset } from "@/features/dictation/runtime";
import {
  DICTATION_MODE_DEFINITIONS,
  DICTATION_MODE_DEFINITION_BY_ID,
} from "@/lib/dictation-profiles";
import {
  historyModeLabel,
  historyPipelineStageLabel,
  historyPromptSourceLabel,
} from "@/lib/dictation-history-labels";

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
  recording: Recording | null;
  transcript: Transcript | null;
  historyDetails: DictationHistoryDetails | null;
  isLoadingTranscript: boolean;
  durationLabel: string;
  reprocessModePreset: DictationModePreset;
  onReprocessModePresetChange: (preset: DictationModePreset) => void;
  reprocessedResult: DictationReprocessResult | null;
  isReprocessing: boolean;
  reprocessError: string | null;
  onReprocess: () => void;
  onUseReprocessedResult: () => void;
  correctionText: string;
  onCorrectionTextChange: (value: string) => void;
  onCorrectionBlur: () => void;
  canLearnCorrection: boolean;
  showFixCapitalization: boolean;
  onLearnCorrection: () => void;
  learnStatus: string | null;
  isReadingAloud: boolean;
  onToggleReadAloud: () => void;
  onCopyTranscript: () => void;
  onDelete: () => void;
}

/**
 * The saved-dictation inspector: what Plainsong heard, the route and prompt it
 * used, and a reprocess bench for trying another mode on the same audio.
 */
export function DictationHistoryDialog({
  open,
  onOpenChange,
  recording,
  transcript,
  historyDetails,
  isLoadingTranscript,
  durationLabel,
  reprocessModePreset,
  onReprocessModePresetChange,
  reprocessedResult,
  isReprocessing,
  reprocessError,
  onReprocess,
  onUseReprocessedResult,
  correctionText,
  onCorrectionTextChange,
  onCorrectionBlur,
  canLearnCorrection,
  showFixCapitalization,
  onLearnCorrection,
  learnStatus,
  isReadingAloud,
  onToggleReadAloud,
  onCopyTranscript,
  onDelete,
}: DictationHistoryDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-center justify-between gap-3">
            <DialogTitle>{recording?.title ?? "Dictation"}</DialogTitle>
            {recording && (
              <div className="flex gap-2">
                {transcript?.fullText?.trim() && (
                  <Button variant="outline" size="sm" onClick={onToggleReadAloud}>
                    <Volume2 className="mr-2 h-4 w-4" />
                    {isReadingAloud ? "Stop reading" : "Read aloud"}
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={onCopyTranscript}>
                  Copy
                </Button>
                <Button variant="outline" size="sm" onClick={onDelete}>
                  Delete
                </Button>
              </div>
            )}
          </div>
        </DialogHeader>
        {isLoadingTranscript ? (
          <p className="text-sm text-muted-foreground">Loading transcript...</p>
        ) : transcript ? (
          <div className="space-y-5">
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
                  <p className="rubric-muted">Confidence</p>
                  <p className="mt-1 text-sm font-medium">
                    {Number.isFinite(transcript.confidence)
                      ? `${Math.round(transcript.confidence * 100)}%`
                      : "Unavailable"}
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

            <div className="space-y-3 border-t pt-4">
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
                    disabled={isReprocessing}
                  >
                    {isReprocessing ? "Reprocessing..." : "Reprocess"}
                  </Button>
                  {reprocessedResult && (
                    <Button variant="outline" onClick={onUseReprocessedResult}>
                      Use Result
                    </Button>
                  )}
                </div>
              </div>
              <p className="text-sm text-muted-foreground">
                Re-runs the saved words through another style so you can compare
                before copying.
              </p>
              {reprocessError && (
                <div className="rounded-md border border-rust/30 bg-rust/10 px-3 py-2 text-sm text-rust">
                  {reprocessError}
                </div>
              )}
            </div>

            <div className="grid gap-4 border-t pt-4 md:grid-cols-2">
              <div className="space-y-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">What Plainsong heard</p>
                    <p className="text-sm text-muted-foreground">
                      The saved raw transcript from the original capture. Edit it
                      to teach Plainsong a correction.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        navigator.clipboard.writeText(correctionText)
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
                    {showFixCapitalization && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={onLearnCorrection}
                      >
                        Fix capitalization
                      </Button>
                    )}
                  </div>
                </div>
                <div className="min-h-[180px] rounded-md bg-muted p-4">
                  <textarea
                    aria-label="What Plainsong heard"
                    className="min-h-[180px] w-full resize-y bg-transparent text-sm outline-none"
                    value={correctionText}
                    onChange={(event) =>
                      onCorrectionTextChange(event.target.value)
                    }
                    onBlur={onCorrectionBlur}
                  />
                </div>
                {learnStatus && (
                  <p className="rounded-md border bg-background px-3 py-2 text-sm text-muted-foreground">
                    {learnStatus}
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">Ready to use</p>
                    <p className="text-sm text-muted-foreground">
                      The same words in the style you picked above.
                    </p>
                  </div>
                  {reprocessedResult?.outputText && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        navigator.clipboard.writeText(
                          reprocessedResult.outputText,
                        )
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
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Pick a style above and press Reprocess to see it here.
                    </p>
                  )}
                </div>
              </div>
            </div>

            <p className="border-t pt-4 text-sm text-muted-foreground">
              Duration: <span className="time-spec">{durationLabel}</span> ·
              Created:{" "}
              {recording
                ? new Date(recording.createdAt).toLocaleString()
                : "N/A"}
              {reprocessedResult && (
                <>
                  {" "}
                  · Reprocessed as:{" "}
                  {modeLabelFor(
                    reprocessedResult.modePreset,
                    reprocessedResult.modePreset,
                  )}{" "}
                  · {reprocessedResult.usedAi ? "AI tuned" : "Rule based"}
                  {reprocessedResult.provider
                    ? ` · Engine: ${reprocessedResult.provider}`
                    : ""}
                  {reprocessedResult.modelId
                    ? ` · Model: ${reprocessedResult.modelId}`
                    : ""}
                </>
              )}
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No transcript available for this dictation.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
