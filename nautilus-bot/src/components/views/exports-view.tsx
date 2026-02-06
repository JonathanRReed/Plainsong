import { useMemo, useState, type ChangeEvent } from "react";
import { useRecordings } from "@/hooks/use-recordings";
import { exportRecordingV2, verifyEvidenceBundle } from "@/lib/tauri";
import type { EvidenceVerificationResult } from "@/lib/tauri";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AlertCircle, CheckCircle2, FileOutput, Loader2, ShieldCheck, XCircle } from "lucide-react";

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

  return (
    <div className="h-full flex flex-col">
      <div className="p-6 border-b">
        <h1 className="text-2xl font-semibold">Exports</h1>
        <p className="text-muted-foreground">Preview and export evidence bundles with redaction controls</p>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-6 space-y-6 max-w-5xl">
          <Card>
            <CardHeader>
              <CardTitle>Export Settings</CardTitle>
              <CardDescription>Choose recording, format, policy, and destination</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Recording</Label>
                <select
                  value={recordingId}
                  onChange={(e) => setRecordingId(e.target.value)}
                  className="w-full p-2 border rounded-md bg-background"
                >
                  <option value="">Select recording</option>
                  {recordings.map((recording) => (
                    <option key={recording.id} value={recording.id}>
                      {recording.title}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Format</Label>
                  <select
                    value={format}
                    onChange={(e) => setFormat(e.target.value as ExportFormat)}
                    className="w-full p-2 border rounded-md bg-background"
                  >
                    <option value="markdown">Markdown</option>
                    <option value="json">JSON</option>
                    <option value="text">Plain Text</option>
                    <option value="evidence_bundle">Signed Evidence Bundle (JSON)</option>
                  </select>
                </div>

                <div className="space-y-2">
                  <Label>Redaction Level</Label>
                  <select
                    value={redactionLevel}
                    onChange={(e) => setRedactionLevel(e.target.value as RedactionLevel)}
                    className="w-full p-2 border rounded-md bg-background"
                  >
                    <option value="none">None</option>
                    <option value="basic">Basic</option>
                    <option value="strict">Strict</option>
                  </select>
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
                  {isWorking ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                  Preview
                </Button>
                <Button onClick={exportNow} disabled={isWorking || !recordingId}>
                  {isWorking ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <FileOutput className="h-4 w-4 mr-2" />}
                  Export
                </Button>
              </div>
            </CardContent>
          </Card>

          {error && (
            <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-lg flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4" />
              {error}
            </div>
          )}

          {lastExportPath && (
            <div className="p-3 bg-trusted/10 border border-trusted/20 rounded-lg flex items-center gap-2 text-sm">
              <CheckCircle2 className="h-4 w-4 text-trusted" />
              Export written to: <span className="font-mono break-all">{lastExportPath}</span>
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
                {isVerifying ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <ShieldCheck className="h-4 w-4 mr-2" />}
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
              <pre className="text-xs whitespace-pre-wrap p-3 rounded-md border bg-muted/30 min-h-[240px]">
                {previewContent || "No preview generated yet."}
              </pre>
            </CardContent>
          </Card>
        </div>
      </ScrollArea>
    </div>
  );
}
