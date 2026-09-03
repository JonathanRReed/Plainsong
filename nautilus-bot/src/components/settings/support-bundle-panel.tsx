import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  createSupportBundle,
  previewSupportBundle,
  type SupportBundlePreview,
  type SupportBundleResult,
} from "@/lib/backend/settings";

/**
 * "Create support bundle…", with the contents and the redaction rules shown
 * before anything is written.
 *
 * `docs/beta/KNOWN-LIMITATIONS.md` said the installed beta could not make one
 * of these, so a tester's only options were a screenshot or installing Bun and
 * cloning the repository. This is the in-app version of
 * `scripts/capture-support-bundle.mjs`.
 *
 * The reader sees the file list and the rules first, on purpose: a bundle is
 * something they will forward to somebody, and the moment to decide is before
 * the zip exists, not after it is on the Desktop.
 */
export function SupportBundlePanel() {
  const [preview, setPreview] = useState<SupportBundlePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [writing, setWriting] = useState(false);
  const [written, setWritten] = useState<SupportBundleResult | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);

  const loadPreview = useCallback(async () => {
    try {
      setPreview(await previewSupportBundle());
      setPreviewError(null);
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  const onCreate = async () => {
    setWriting(true);
    setWriteError(null);
    setWritten(null);
    try {
      const result = await createSupportBundle();
      // `null` is the reader cancelling the save dialog, which is not an error
      // and does not deserve a message.
      if (result) {
        setWritten(result);
      }
      void loadPreview();
    } catch (error) {
      setWriteError(error instanceof Error ? error.message : String(error));
    } finally {
      setWriting(false);
    }
  };

  return (
    <div className="space-y-3 border-t pt-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-1">
          <p className="section-heading">Diagnostics</p>
          <p className="text-sm text-muted-foreground">
            A support bundle is a zip you can open and read before you send it.
            It carries versions, switches, counts, and log lines. It never
            carries audio or anything you said, typed, or dictated.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            aria-expanded={expanded}
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded ? "Hide what is included" : "Show what is included"}
          </Button>
          {/* Outline, not the gilded CTA: this tab's one earned gold button is
              "Encrypt existing recordings". Making diagnostics compete with it
              would be the flood STYLE.md §0 warns about. */}
          <Button
            variant="outline"
            size="sm"
            disabled={writing || !preview}
            onClick={() => void onCreate()}
          >
            {writing ? "Writing…" : "Create support bundle…"}
          </Button>
        </div>
      </div>

      {previewError ? (
        <p className="text-sm text-rust">
          Plainsong could not describe the bundle: {previewError}. Nothing was
          written. Try again, or reopen Settings.
        </p>
      ) : null}

      {preview ? (
        <p className="text-sm text-muted-foreground">
          This bundle would hold {preview.sections.length} files, the last{" "}
          {preview.logLineCount} log{preview.logLineCount === 1 ? " line" : " lines"}{" "}
          from this session, {preview.auditEntryCount} audit{" "}
          {preview.auditEntryCount === 1 ? "entry" : "entries"}, and the state of{" "}
          {preview.modelArtifactCount} model{" "}
          {preview.modelArtifactCount === 1 ? "file" : "files"}.
        </p>
      ) : null}

      {expanded && preview ? (
        <div className="space-y-4 rounded-2xl border border-border/60 bg-muted/20 p-4">
          <div className="space-y-2">
            <p className="section-heading">What goes in</p>
            <ul className="space-y-1.5 text-sm text-muted-foreground">
              {preview.sections.map((section) => (
                <li key={section.file}>
                  <span className="font-mono text-sm text-foreground">
                    {section.file}
                  </span>{" "}
                  — {section.description}
                </li>
              ))}
            </ul>
          </div>
          <div className="space-y-2">
            <p className="section-heading">How it is redacted</p>
            <ul className="space-y-1.5 text-sm text-muted-foreground">
              {preview.redactionRules.map((rule) => (
                <li key={rule}>{rule}</li>
              ))}
            </ul>
          </div>
          <div className="space-y-2">
            <p className="section-heading">What is never in it</p>
            <ul className="space-y-1.5 text-sm text-muted-foreground">
              {preview.excludedByDesign.map((excluded) => (
                <li key={excluded}>{excluded}</li>
              ))}
            </ul>
          </div>
          <p className="text-sm text-muted-foreground">
            If a redaction rule fails to remove a path or an address, Plainsong
            refuses to write the file at all rather than write one you should
            not send.
          </p>
        </div>
      ) : null}

      {written ? (
        <p className="flex items-center gap-1.5 text-sm text-gold-text">
          <span aria-hidden="true" className="neume neume-lit" />
          Saved {written.fileName} ({Math.max(1, Math.round(written.bytes / 1024))} KB,{" "}
          {written.fileCount} files). Open it and read it before you send it.
        </p>
      ) : null}

      {writeError ? (
        <p className="text-sm text-rust">
          The bundle was not written: {writeError}. Nothing was saved.
        </p>
      ) : null}
    </div>
  );
}
