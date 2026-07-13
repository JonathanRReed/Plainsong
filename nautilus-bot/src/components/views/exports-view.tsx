import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from "react";
import { useRecordings } from "@/hooks/use-recordings";
import {
  exportRecordingV2,
  exportWithTemplate,
  listExportTemplates,
  openExportPath,
  type ExportTemplate,
} from "@/lib/backend/exports";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { requestMainView } from "@/lib/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AlertCircle, CheckCircle2, ExternalLink, FileAudio, FileOutput, Loader2, Eye, RefreshCw } from "lucide-react";

type ExportFormat = "markdown" | "json" | "text";
type RedactionLevel = "none" | "basic" | "strict";

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

  const selectedRecording = useMemo(
    () => recordings.find((recording) => recording.id === recordingId) ?? null,
    [recordings, recordingId]
  );

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
      <div className="border-b border-border/70 bg-background/82 px-6 py-5 backdrop-blur-xl">
        <p className="rubric mb-1.5">SHARE</p>
        <div className="flex items-center gap-3">
          <h1 className="font-serif text-2xl font-semibold tracking-tight">Exports</h1>
          <Badge variant="outline" className="text-[10px] font-medium uppercase tracking-widest">
            <FileOutput className="mr-1 h-3 w-3" />
            Share
          </Badge>
        </div>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">Create shareable transcripts, notes, and structured exports</p>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-6 space-y-6 max-w-5xl">
          {recordingsError ? (
            <div className="flex items-center gap-3 rounded-lg border border-rust/30 bg-rust/10 px-4 py-3 text-sm text-rust">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{recordingsError}</span>
            </div>
          ) : null}

          {!recordingsLoading && !recordingsError && recordings.length === 0 ? (
            <Card>
              <CardContent>
                <EmptyState
                  icon={<FileAudio className="h-8 w-8" />}
                  title="No recordings to export"
                  description="Record a meeting first, then return here to preview, redact, and export the transcript or notes."
                  action={{
                    label: "Open meetings",
                    onClick: () => requestMainView("recordings"),
                  }}
                  className="py-14"
                />
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Export Setup</CardTitle>
              <CardDescription>Choose the source, format, privacy level, and destination</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
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

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Format</Label>
                  <Select value={format} onValueChange={(v) => setFormat(v as ExportFormat)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="markdown">Markdown</SelectItem>
                      <SelectItem value="json">JSON</SelectItem>
                      <SelectItem value="text">Plain Text</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Redaction Level</Label>
                  <Select value={redactionLevel} onValueChange={(v) => setRedactionLevel(v as RedactionLevel)}>
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

              <div className="space-y-2">
                <Label>Destination path (optional)</Label>
                <Input
                  value={targetPath}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setTargetPath(e.target.value)}
                  placeholder="/path/to/export.md"
                />
              </div>

              <div className="flex gap-2">
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
                <p className="text-xs text-muted-foreground">
                  Select a recording before previewing or exporting.
                </p>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Structured Templates</CardTitle>
              <CardDescription>Render transcripts into repeatable, shareable formats</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
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
              <Button
                variant="outline"
                onClick={generateTemplatePreview}
                disabled={isWorking || templatesLoading || !recordingId || !selectedTemplateId}
              >
                {isWorking ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Eye className="mr-2 h-4 w-4" />}
                Render Preview
              </Button>
              <div className="space-y-2">
                <Label>Template export path (optional)</Label>
                <Input
                  value={templateTargetPath}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setTemplateTargetPath(e.target.value)}
                  placeholder="/path/to/template-export.md"
                />
              </div>
              <Button
                onClick={exportTemplateNow}
                disabled={isWorking || templatesLoading || !recordingId || !selectedTemplateId}
              >
                {isWorking ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileOutput className="mr-2 h-4 w-4" />}
                Export Template
              </Button>
              {!recordingId || !selectedTemplateId ? (
                <p className="text-xs text-muted-foreground">
                  Select a recording and template before rendering structured exports.
                </p>
              ) : null}
              {lastTemplateExportPath && (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-gold/30 bg-gold/10 px-3 py-2 text-xs">
                  <span className="text-muted-foreground">
                    Template exported to <span className="font-mono break-all">{lastTemplateExportPath}</span>
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
              )}
              <pre className="text-xs leading-relaxed whitespace-pre-wrap rounded-lg border bg-muted/20 p-4 font-mono min-h-[180px]">
                {templatePreview || (
                  <span className="flex h-[148px] flex-col items-center justify-center gap-2 text-center font-sans">
                    <span className="neume neume-hollow" />
                    <span className="font-serif text-sm text-muted-foreground">No template preview generated yet.</span>
                  </span>
                )}
              </pre>
            </CardContent>
          </Card>

          {error && (
            <div className="flex items-center gap-3 rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {lastExportPath && (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-gold/30 bg-gold/10 px-4 py-3 text-sm">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-gold-text" />
              <span>Export written to: <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs break-all">{lastExportPath}</code></span>
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
          )}

          <Card>
            <CardHeader>
              <CardTitle>Preview</CardTitle>
              <CardDescription>
                {selectedRecording ? `Redacted output preview for ${selectedRecording.title}` : "Choose a recording to preview"}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <pre className="text-xs leading-relaxed whitespace-pre-wrap rounded-lg border bg-muted/20 p-4 font-mono min-h-[240px]">
                {previewContent || (
                  <span className="flex h-[208px] flex-col items-center justify-center gap-2 text-center font-sans">
                    <span className="neume neume-hollow" />
                    <span className="font-serif text-sm text-muted-foreground">No preview generated yet.</span>
                  </span>
                )}
              </pre>
            </CardContent>
          </Card>
        </div>
      </ScrollArea>
    </div>
  );
}
