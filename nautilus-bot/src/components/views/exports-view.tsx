import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { useRecordings } from "@/hooks/use-recordings";
import {
  exportRecordingV2,
  exportWithTemplate,
  listExportTemplates,
  verifyEvidenceBundle,
  type EvidenceVerificationResult,
  type ExportTemplate,
} from "@/lib/backend/exports";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AlertCircle, CheckCircle2, FileOutput, Loader2, ShieldCheck, XCircle, Eye } from "lucide-react";

type ExportFormat = "markdown" | "json" | "text" | "evidence_bundle";
type RedactionLevel = "none" | "basic" | "strict";

export function ExportsView() {
  const { recordings } = useRecordings();
  const [recordingId, setRecordingId] = useState<string>("");
  const [format, setFormat] = useState<ExportFormat>("markdown");
  const [redactionLevel, setRedactionLevel] = useState<RedactionLevel>("basic");
  const [targetPath, setTargetPath] = useState("");
  const [previewContent, setPreviewContent] = useState("");
  const [lastExportPath, setLastExportPath] = useState<string | null>(null);
  const [isWorking, setIsWorking] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [verifyPath, setVerifyPath] = useState("");
  const [verificationResult, setVerificationResult] = useState<EvidenceVerificationResult | null>(null);
  const [templates, setTemplates] = useState<ExportTemplate[]>([]);
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

  useEffect(() => {
    void listExportTemplates()
      .then((loadedTemplates) => {
        setTemplates(loadedTemplates);
        if (loadedTemplates.length > 0) {
          setSelectedTemplateId(loadedTemplates[0].id);
        }
      })
      .catch((e) => {
        console.warn("Failed to load export templates:", e);
      });
  }, []);

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
      if (format === "evidence_bundle" && result.exportPath) {
        setVerifyPath(result.exportPath);
        setVerificationResult(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed");
    } finally {
      setIsWorking(false);
    }
  };

  const verifyBundle = async () => {
    setError(null);
    setIsVerifying(true);
    try {
      if (!verifyPath.trim()) {
        throw new Error("Provide an evidence bundle path to verify");
      }
      const result = await verifyEvidenceBundle(verifyPath.trim());
      setVerificationResult(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Verification failed");
    } finally {
      setIsVerifying(false);
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
      const rendered = await exportWithTemplate(recordingId, selectedTemplateId, { preview: true });
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
      <div className="border-b px-6 py-5">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Exports</h1>
          <Badge variant="outline" className="text-[10px] font-medium uppercase tracking-widest">
            <FileOutput className="mr-1 h-3 w-3" />
            Share
          </Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">Create shareable transcripts, notes, and evidence-ready exports</p>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-6 space-y-6 max-w-5xl">
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
                      <SelectItem value="evidence_bundle">Signed Evidence Bundle</SelectItem>
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
                  placeholder={
                    format === "evidence_bundle"
                      ? "/path/to/evidence_bundle.json"
                      : "/path/to/export.md"
                  }
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
                    <SelectValue placeholder={templates.length === 0 ? "No templates available" : "Select template"} />
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
              <Button
                variant="outline"
                onClick={generateTemplatePreview}
                disabled={isWorking || !recordingId || !selectedTemplateId}
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
                disabled={isWorking || !recordingId || !selectedTemplateId}
              >
                {isWorking ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileOutput className="mr-2 h-4 w-4" />}
                Export Template
              </Button>
              {lastTemplateExportPath && (
                <p className="text-xs text-muted-foreground">
                  Template exported to <span className="font-mono break-all">{lastTemplateExportPath}</span>
                </p>
              )}
              <pre className="text-xs leading-relaxed whitespace-pre-wrap rounded-lg border bg-muted/20 p-4 font-mono min-h-[180px]">
                {templatePreview || <span className="text-muted-foreground">No template preview generated yet.</span>}
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
            <div className="flex items-center gap-3 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-4 py-3 text-sm">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
              <span>Export written to: <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs break-all">{lastExportPath}</code></span>
            </div>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Evidence Verification</CardTitle>
              <CardDescription>Verify signed evidence bundle integrity and signature</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-2">
                <Label>Evidence bundle path</Label>
                <Input
                  value={verifyPath}
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setVerifyPath(e.target.value)}
                  placeholder="/path/to/evidence_bundle.json"
                />
              </div>
              <Button variant="outline" onClick={verifyBundle} disabled={isVerifying || !verifyPath.trim()}>
                {isVerifying ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}
                Verify Bundle
              </Button>

              {verificationResult && (
                <div className="space-y-2 pt-1">
                  <div className="flex items-center justify-between rounded-md border p-2">
                    <span className="text-sm font-medium">Verification status</span>
                    <span className={`text-xs font-medium ${verificationResult.valid ? "text-emerald-600" : "text-amber-600"}`}>
                      {verificationResult.valid ? "VALID" : "INVALID"}
                    </span>
                  </div>
                  {verificationResult.checks.map((check) => (
                    <div key={check.id} className="rounded-md border p-2">
                      <div className="flex items-center gap-2">
                        {check.status === "pass" ? (
                          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                        ) : (
                          <XCircle className="h-4 w-4 text-amber-600" />
                        )}
                        <span className="text-sm font-medium">{check.label}</span>
                      </div>
                      <p className="pl-6 text-xs text-muted-foreground">{check.message}</p>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Preview</CardTitle>
              <CardDescription>
                {selectedRecording ? `Redacted output preview for ${selectedRecording.title}` : "Choose a recording to preview"}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <pre className="text-xs leading-relaxed whitespace-pre-wrap rounded-lg border bg-muted/20 p-4 font-mono min-h-[240px]">
                {previewContent || <span className="text-muted-foreground">No preview generated yet.</span>}
              </pre>
            </CardContent>
          </Card>
        </div>
      </ScrollArea>
    </div>
  );
}
