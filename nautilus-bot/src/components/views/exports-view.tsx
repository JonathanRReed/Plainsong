import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import { useRecordings } from "@/hooks/use-recordings";
import {
  exportRecordingV2,
  exportWithTemplate,
  listExportTemplates,
  openExportPath,
  type ExportTemplate,
} from "@/lib/backend/exports";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { EmptyState } from "@/components/ui/empty-state";
import { requestMainView } from "@/lib/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ExternalLink, FileAudio, FileOutput, Loader2, Eye, RefreshCw } from "lucide-react";

type ExportFormat = "markdown" | "json" | "text";
type RedactionLevel = "none" | "basic" | "strict";

const previewClass =
  "min-h-[200px] whitespace-pre-wrap rounded-md bg-muted/20 p-4 font-mono text-sm leading-relaxed";

function PreviewPlaceholder({ children }: { children: string }) {
  return (
    <span className="flex min-h-[168px] flex-col items-center justify-center gap-2 text-center font-sans">
      <span className="neume neume-hollow" />
      <span className="font-serif text-sm text-muted-foreground">{children}</span>
    </span>
  );
}

export function ExportsView() {
  const { recordings, isLoading: recordingsLoading, error: recordingsError } = useRecordings();
  const [recordingId, setRecordingId] = useState<string>("");
  const [format, setFormat] = useState<ExportFormat>("markdown");
  const [redactionLevel, setRedactionLevel] = useState<RedactionLevel>("basic");
  const [targetPath, setTargetPath] = useState("");
  const [previewContent, setPreviewContent] = useState("");
  const [lastExportPath, setLastExportPath] = useState<string | null>(null);
  const [isWorking, setIsWorking] = useState(false);
  const [templates, setTemplates] = useState<ExportTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [templateLoadError, setTemplateLoadError] = useState<string | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [templatePreview, setTemplatePreview] = useState("");
  const [templateTargetPath, setTemplateTargetPath] = useState("");
  const [lastTemplateExportPath, setLastTemplateExportPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ensureRecording = () => {
    if (!recordingId) {
      throw new Error("Select a recording first");
    }
  };

  const loadTemplates = useCallback(async () => {
    setTemplatesLoading(true);
    setTemplateLoadError(null);
    try {
      const loadedTemplates = await listExportTemplates();
      setTemplates(loadedTemplates);
      setSelectedTemplateId((current) => {
        if (loadedTemplates.some((template) => template.id === current)) {
          return current;
        }
        return loadedTemplates[0]?.id ?? "";
      });
    } catch (e) {
      setTemplates([]);
      setSelectedTemplateId("");
      setTemplateLoadError(e instanceof Error ? e.message : "Export templates could not be loaded");
    } finally {
      setTemplatesLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTemplates();
  }, [loadTemplates]);

  const generatePreview = async () => {
    setError(null);
    setLastExportPath(null);
    setIsWorking(true);
    try {
      ensureRecording();
      const result = await exportRecordingV2(recordingId, format, {
        redactionLevel,
        preview: true,
      });
      setPreviewContent(result.content ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Preview failed");
    } finally {
      setIsWorking(false);
    }
  };

  const exportNow = async () => {
    setError(null);
    setIsWorking(true);
    try {
      ensureRecording();
      const result = await exportRecordingV2(recordingId, format, {
        redactionLevel,
        target: targetPath.trim() || undefined,
        preview: false,
      });
      setLastExportPath(result.exportPath ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed");
    } finally {
      setIsWorking(false);
    }
  };

  const openLastExport = async (path: string) => {
    setError(null);
    try {
      await openExportPath(path);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open export");
    }
  };

  const generateTemplatePreview = async () => {
    setError(null);
    setIsWorking(true);
    setLastTemplateExportPath(null);
    try {
      ensureRecording();
      if (!selectedTemplateId) {
        throw new Error("Select a template first");
      }
      const rendered = await exportWithTemplate(recordingId, selectedTemplateId, {
        preview: true,
        redactionLevel,
      });
      setTemplatePreview(rendered.content ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Template preview failed");
    } finally {
      setIsWorking(false);
    }
  };

  const exportTemplateNow = async () => {
    setError(null);
    setIsWorking(true);
    setLastTemplateExportPath(null);
    try {
      ensureRecording();
      if (!selectedTemplateId) {
        throw new Error("Select a template first");
      }
      const result = await exportWithTemplate(recordingId, selectedTemplateId, {
        preview: false,
        target: templateTargetPath.trim() || undefined,
        redactionLevel,
      });
      if (!result.exportPath) {
        throw new Error("Template export did not return a file path");
      }
      setLastTemplateExportPath(result.exportPath);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Template export failed");
    } finally {
      setIsWorking(false);
    }
  };

  return (
    <div className="h-full flex flex-col">
      <PageHeader
        eyebrow="SHARE"
        title="Exports"
        subtitle="Write a recording out as a file you can send: transcript, notes, or a saved layout"
      />

      <ScrollArea className="flex-1">
        <div className="mx-auto w-full max-w-5xl space-y-8 px-6 py-6 lg:px-8">
          {recordingsError ? (
            <div className="flex items-center gap-3 rounded-lg border border-rust/30 bg-rust/10 px-4 py-3 text-sm text-rust">
              <span className="neume neume-rust shrink-0" aria-hidden="true" />
              <span>{recordingsError}</span>
            </div>
          ) : null}

          {error ? (
            <div
              role="status"
              aria-live="polite"
              className="flex items-center gap-3 rounded-lg border border-rust/30 bg-rust/10 px-4 py-3 text-sm text-rust"
            >
              <span className="neume neume-rust shrink-0" aria-hidden="true" />
              <span>{error}</span>
            </div>
          ) : null}

          {!recordingsLoading && !recordingsError && recordings.length === 0 ? (
            <EmptyState
              icon={<FileAudio className="h-8 w-8" />}
              title="No recordings to export"
              description="Record a meeting first, then come back to preview, redact, and write it out."
              action={{
                label: "Open meetings",
                onClick: () => requestMainView("recordings"),
              }}
              className="py-14"
            />
          ) : null}

          <section className="space-y-4">
            <div className="space-y-1">
              <h2 className="section-heading">Export a recording</h2>
              <p className="text-sm text-muted-foreground">
                Pick a recording, choose a file format, and decide how much to hide before it
                leaves the app.
              </p>
            </div>

            <div className="space-y-2">
              <Label>Recording</Label>
              <Select value={recordingId} onValueChange={setRecordingId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select recording" />
                </SelectTrigger>
                <SelectContent>
                  {recordings.map((recording) => (
                    <SelectItem key={recording.id} value={recording.id}>
                      {recording.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>File format</Label>
                <Select value={format} onValueChange={(v) => setFormat(v as ExportFormat)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="markdown">Markdown</SelectItem>
                    <SelectItem value="json">JSON</SelectItem>
                    <SelectItem value="text">Plain text</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Redaction</Label>
                <Select
                  value={redactionLevel}
                  onValueChange={(v) => setRedactionLevel(v as RedactionLevel)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    <SelectItem value="basic">Basic</SelectItem>
                    <SelectItem value="strict">Strict</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <p className="text-sm text-muted-foreground">
              Basic replaces email addresses and phone numbers. Strict also replaces links, long
              numbers, and anything shaped like an API key.
            </p>

            <div className="space-y-2">
              <Label htmlFor="export-path">Save to (optional)</Label>
              <Input
                id="export-path"
                value={targetPath}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setTargetPath(e.target.value)}
                placeholder="/path/to/export.md"
              />
              <p className="text-sm text-muted-foreground">
                Leave this blank to write a timestamped file into Plainsong's exports folder.
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={generatePreview} disabled={isWorking || !recordingId}>
                {isWorking ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Eye className="mr-2 h-4 w-4" />}
                Preview
              </Button>
              <Button onClick={exportNow} disabled={isWorking || !recordingId}>
                {isWorking ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileOutput className="mr-2 h-4 w-4" />}
                Export
              </Button>
            </div>
            {!recordingId ? (
              <p className="text-sm text-muted-foreground">
                Select a recording before previewing or exporting.
              </p>
            ) : null}

            {lastExportPath ? (
              <div className="flex flex-wrap items-center gap-3 rounded-lg border border-gold/30 bg-gold/10 px-4 py-3 text-sm">
                <span className="neume neume-lit shrink-0" aria-hidden="true" />
                <span>
                  Export written to:{" "}
                  <span className="font-mono break-all">{lastExportPath}</span>
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void openLastExport(lastExportPath)}
                >
                  <ExternalLink data-icon="inline-start" />
                  Open export
                </Button>
              </div>
            ) : null}

            <pre className={previewClass}>
              {previewContent || (
                <PreviewPlaceholder>Nothing previewed yet.</PreviewPlaceholder>
              )}
            </pre>
          </section>

          <section className="space-y-4 border-t border-border/70 pt-8">
            <div className="space-y-1">
              <h2 className="section-heading">Export with a template</h2>
              <p className="text-sm text-muted-foreground">
                Render the same recording into a saved layout, such as a follow-up memo. Templates
                use the recording and redaction setting chosen above.
              </p>
            </div>

            <div className="space-y-2">
              <Label>Template</Label>
              <Select value={selectedTemplateId} onValueChange={setSelectedTemplateId}>
                <SelectTrigger>
                  <SelectValue
                    placeholder={
                      templatesLoading
                        ? "Loading templates"
                        : templateLoadError
                          ? "Templates unavailable"
                          : templates.length === 0
                            ? "No templates available"
                            : "Select template"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {templates.map((template) => (
                    <SelectItem key={template.id} value={template.id}>
                      {template.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {templateLoadError ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-rust/30 bg-rust/10 px-3 py-2 text-sm text-rust">
                <span>{templateLoadError}</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void loadTemplates()}
                  disabled={templatesLoading}
                >
                  {templatesLoading ? (
                    <Loader2 data-icon="inline-start" className="animate-spin" />
                  ) : (
                    <RefreshCw data-icon="inline-start" />
                  )}
                  Retry
                </Button>
              </div>
            ) : null}

            <div className="space-y-2">
              <Label htmlFor="template-export-path">Save to (optional)</Label>
              <Input
                id="template-export-path"
                value={templateTargetPath}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setTemplateTargetPath(e.target.value)}
                placeholder="/path/to/template-export.md"
              />
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                onClick={generateTemplatePreview}
                disabled={isWorking || templatesLoading || !recordingId || !selectedTemplateId}
              >
                {isWorking ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Eye className="mr-2 h-4 w-4" />}
                Render Preview
              </Button>
              <Button
                onClick={exportTemplateNow}
                disabled={isWorking || templatesLoading || !recordingId || !selectedTemplateId}
              >
                {isWorking ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileOutput className="mr-2 h-4 w-4" />}
                Export Template
              </Button>
            </div>
            {!recordingId || !selectedTemplateId ? (
              <p className="text-sm text-muted-foreground">
                Select a recording and a template before rendering.
              </p>
            ) : null}

            {lastTemplateExportPath ? (
              <div className="flex flex-wrap items-center gap-3 rounded-lg border border-gold/30 bg-gold/10 px-4 py-3 text-sm">
                <span className="neume neume-lit shrink-0" aria-hidden="true" />
                <span>
                  Template exported to{" "}
                  <span className="font-mono break-all">{lastTemplateExportPath}</span>
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void openLastExport(lastTemplateExportPath)}
                >
                  <ExternalLink data-icon="inline-start" />
                  Open export
                </Button>
              </div>
            ) : null}

            <pre className={previewClass}>
              {templatePreview || (
                <PreviewPlaceholder>Nothing rendered yet.</PreviewPlaceholder>
              )}
            </pre>
          </section>
        </div>
      </ScrollArea>
    </div>
  );
}
