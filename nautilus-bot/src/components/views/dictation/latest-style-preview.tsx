import { useCallback, useEffect, useRef, useState } from "react";

import { registerMainWindowIdleGuard } from "@/lib/main-window-idle";
import { Button } from "@/components/ui/button";
import { DictationChangeReview } from "@/components/views/dictation/dictation-change-review";
import {
  reprocessDictationText,
  type DictationReprocessResult,
} from "@/lib/backend/dictation";
import { cancelAnalysisRun } from "@/lib/backend/ai";
import {
  DICTATION_MODE_DEFINITIONS,
} from "@/lib/dictation-profiles";
import { sanitizeUserFacingDictationMessage } from "@/lib/dictation-ui-message";

interface LatestStylePreviewProps {
  text: string;
  sourceKey: unknown;
  disabled?: boolean;
  appTarget?: string | null;
  onUsePreview: (text: string) => void;
}

const STYLE_OPTIONS = DICTATION_MODE_DEFINITIONS.filter(
  (definition) => definition.id !== "custom",
);

const DEFAULT_STYLE =
  STYLE_OPTIONS.find((definition) => definition.id === "voice")?.id ??
  STYLE_OPTIONS[0]?.id ??
  "voice";

interface CurrentInputs {
  text: string;
  sourceKey: unknown;
  style: string;
  appTarget: string | null;
  revision: number;
}

interface PreviewState {
  result: DictationReprocessResult;
  original: string;
  revision: number;
}

interface ActivePreviewRun {
  runId: string;
  revision: number;
  cancelRequested: boolean;
}

export function LatestStylePreview({
  text,
  sourceKey,
  disabled = false,
  appTarget = null,
  onUsePreview,
}: LatestStylePreviewProps) {
  const [selectedStyle, setSelectedStyle] = useState<string>(DEFAULT_STYLE);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelStatus, setCancelStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mountedRef = useRef(false);
  const activeRunRef = useRef<ActivePreviewRun | null>(null);
  const currentInputsRef = useRef<CurrentInputs>({
    text,
    sourceKey,
    style: selectedStyle,
    appTarget,
    revision: 0,
  });

  useEffect(() => registerMainWindowIdleGuard(() => !busyRef.current && !preview), [preview]);

  const currentInputs = currentInputsRef.current;
  if (
    currentInputs.text !== text ||
    !Object.is(currentInputs.sourceKey, sourceKey) ||
    currentInputs.style !== selectedStyle ||
    currentInputs.appTarget !== appTarget
  ) {
    currentInputsRef.current = {
      text,
      sourceKey,
      style: selectedStyle,
      appTarget,
      revision: currentInputs.revision + 1,
    };
  }

  const cancelActivePreview = useCallback(() => {
    const activeRun = activeRunRef.current;
    if (!activeRun || activeRun.cancelRequested) return;

    activeRun.cancelRequested = true;
    setPreview(null);
    setError(null);
    setCancelStatus("Cancelling preview…");
    void cancelAnalysisRun(activeRun.runId).catch(() => {
      if (mountedRef.current && activeRunRef.current === activeRun) {
        setCancelStatus("Couldn't cancel immediately. Waiting for the preview to stop.");
      }
    });
  }, []);

  useEffect(() => {
    setPreview(null);
    setError(null);
    const activeRun = activeRunRef.current;
    if (
      activeRun &&
      activeRun.revision !== currentInputsRef.current.revision
    ) {
      cancelActivePreview();
    }
  }, [text, sourceKey, selectedStyle, appTarget, cancelActivePreview]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const activeRun = activeRunRef.current;
      if (activeRun && !activeRun.cancelRequested) {
        activeRun.cancelRequested = true;
        void cancelAnalysisRun(activeRun.runId).catch(() => undefined);
      }
    };
  }, []);

  const handleStyleChange = (style: string) => {
    const current = currentInputsRef.current;
    if (style !== current.style) {
      currentInputsRef.current = {
        ...current,
        style,
        revision: current.revision + 1,
      };
    }
    setPreview(null);
    setError(null);
    cancelActivePreview();
    setSelectedStyle(style);
  };

  const handlePreview = async () => {
    if (busyRef.current || disabled || !text.trim()) return;

    const snapshot = currentInputsRef.current;
    const activeRun: ActivePreviewRun = {
      runId: crypto.randomUUID(),
      revision: snapshot.revision,
      cancelRequested: false,
    };
    activeRunRef.current = activeRun;
    busyRef.current = true;
    setPreview(null);
    setError(null);
    setCancelStatus(null);
    setBusy(true);
    try {
      const result = await reprocessDictationText(
        snapshot.text,
        snapshot.style,
        snapshot.appTarget,
        { runId: activeRun.runId },
      );
      if (
        !result ||
        typeof result !== "object" ||
        typeof result.outputText !== "string" ||
        !result.outputText.trim()
      ) {
        throw new Error("Couldn't create a style preview. Try again.");
      }
      if (
        mountedRef.current &&
        activeRunRef.current === activeRun &&
        !activeRun.cancelRequested &&
        currentInputsRef.current.revision === snapshot.revision
      ) {
        setPreview({ result, original: snapshot.text, revision: snapshot.revision });
      }
    } catch (caught) {
      if (
        !mountedRef.current ||
        activeRunRef.current !== activeRun ||
        activeRun.cancelRequested ||
        currentInputsRef.current.revision !== snapshot.revision
      ) return;
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(
        sanitizeUserFacingDictationMessage(message, { phase: "error" }) ??
          "Couldn't create a style preview. Try again.",
      );
    } finally {
      if (activeRunRef.current === activeRun) {
        activeRunRef.current = null;
        busyRef.current = false;
        if (mountedRef.current) {
          setBusy(false);
          setCancelStatus(null);
        }
      }
    }
  };

  const visiblePreview =
    preview?.revision === currentInputsRef.current.revision ? preview : null;
  const unchanged = visiblePreview?.result.outputText === visiblePreview?.original;

  return (
    <details className="rounded-md border border-border/60 bg-muted/20 px-3 py-2">
      <summary className="cursor-pointer select-none text-sm font-medium text-foreground">
        Try another style
      </summary>
      <div className="mt-3 space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1 space-y-1">
            <label htmlFor="latest-style-preview-mode" className="text-sm font-medium">
              Style
            </label>
            <select
              id="latest-style-preview-mode"
              className="w-full rounded-md border bg-background p-2 text-sm"
              value={selectedStyle}
              disabled={disabled}
              onChange={(event) => handleStyleChange(event.target.value)}
            >
              {STYLE_OPTIONS.map((style) => (
                <option key={style.id} value={style.id}>
                  {style.label}
                </option>
              ))}
            </select>
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={disabled || busy || !text.trim()}
            onClick={() => void handlePreview()}
          >
            {busy ? "Creating preview…" : "Preview style"}
          </Button>
          {busy ? (
            <Button
              type="button"
              variant="ghost"
              disabled={activeRunRef.current?.cancelRequested === true}
              onClick={cancelActivePreview}
            >
              {activeRunRef.current?.cancelRequested ? "Cancelling…" : "Cancel preview"}
            </Button>
          ) : null}
        </div>

        {cancelStatus ? (
          <p className="text-sm text-muted-foreground" role="status">
            {cancelStatus}
          </p>
        ) : null}

        {error ? (
          <p role="alert" className="text-sm text-rust">
            {error}
          </p>
        ) : null}

        {visiblePreview ? (
          <div className="space-y-3 border-t pt-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="text-sm font-medium">
                  {visiblePreview.result.aiRewriteFailed
                    ? "Basic formatting"
                    : unchanged
                      ? "No changes"
                      : "Style preview"}
                </p>
                {visiblePreview.result.aiRewriteFailed ? (
                  <p className="text-sm text-muted-foreground" role="status">
                    AI rewrite wasn't applied. Basic formatting is shown instead.
                  </p>
                ) : unchanged ? (
                  <p className="text-sm text-muted-foreground" role="status">
                    {visiblePreview.result.usedAi
                      ? "AI returned your text without changes."
                      : "This style left your text unchanged."}
                  </p>
                ) : null}
              </div>
              <Button
                type="button"
                size="sm"
                onClick={() => onUsePreview(visiblePreview.result.outputText)}
                disabled={disabled || busy || unchanged}
              >
                Use preview
              </Button>
            </div>
            <p className="whitespace-pre-wrap rounded-md bg-muted p-3 text-sm">
              {visiblePreview.result.outputText}
            </p>
            <DictationChangeReview
              original={visiblePreview.original}
              current={visiblePreview.result.outputText}
              originalLabel="Current text"
              currentLabel="Preview"
            />
          </div>
        ) : busy ? (
          <p className="text-sm text-muted-foreground" role="status">
            Creating a style preview…
          </p>
        ) : null}
      </div>
    </details>
  );
}
