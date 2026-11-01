#!/usr/bin/env bun
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { createPackagedQaProfile } from "./lib/packaged-qa-profile.ts";

import { captureAppReceiptBinding, bindAppReceipt } from "./lib/app-receipt-binding.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);

function valueFor(name: string): string | null;
function valueFor(name: string, fallback: string): string;
function valueFor(name: string, fallback: string | null = null): string | null {
  const index = args.indexOf(name);
  if (index < 0 || index === args.length - 1) return fallback;
  return args[index + 1];
}

const appPath = path.resolve(repoRoot, valueFor("--app", "release/mac-arm64/Plainsong.app"));
const appBinding = captureAppReceiptBinding(appPath);
const qaProfile = createPackagedQaProfile({
  args,
  prefix: "plainsong-exports-qa-",
});
const outPath = path.resolve(repoRoot, valueFor("--out", "artifacts/qa/macos/exports.json"));
const timeoutMs = Number(valueFor("--timeout-ms", "300000"));
const sidecarPath = path.join(appPath, "Contents", "Resources", "sidecar", "plainsong-sidecar");
const dataRoot = qaProfile.dataRoot;
const dataDir = path.join(dataRoot, "Plainsong");
const dbPath = path.join(dataDir, "plainsong.db");
const dbSidecarPaths = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
const dbBackups = new Map<string, Buffer | null>();
const recordingId = `qa-exports-${Date.now()}`;
const transcriptId = `${recordingId}-transcript`;
const now = new Date().toISOString();
const exportDir = path.join(
  path.join(dataDir, "qa-exports"),
  `qa-packaged-exports-${Date.now()}`
);
const transcriptText =
  "Maya confirmed the macOS packaged export workflow must produce Markdown, JSON, text, and reusable meeting templates. " +
  "Jon owns the Windows release validation after signing material is available. " +
  "Priya will review action items before launch claims are expanded.";
const segments = [
  {
    id: `${recordingId}-seg-1`,
    startTime: 0,
    endTime: 8,
    text: "Maya confirmed the macOS packaged export workflow must produce Markdown, JSON, text, and reusable meeting templates.",
    speakerId: "speaker-1",
    confidence: 0.98,
  },
  {
    id: `${recordingId}-seg-2`,
    startTime: 8,
    endTime: 14,
    text: "Jon owns the Windows release validation after signing material is available.",
    speakerId: "speaker-2",
    confidence: 0.97,
  },
  {
    id: `${recordingId}-seg-3`,
    startTime: 14,
    endTime: 20,
    text: "Priya will review action items before launch claims are expanded.",
    speakerId: "speaker-3",
    confidence: 0.97,
  },
];

function fail(message: string): never {
  const receipt = bindAppReceipt({
    generatedAt: new Date().toISOString(),
    appPath,
    pass: false,
    error: message,
  }, appBinding);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  console.error(message);
  process.exit(1);
}

if (process.platform !== "darwin") {
  fail("capture-packaged-macos-exports can only run on macOS.");
}
if (!fs.existsSync(sidecarPath)) {
  fail(`Packaged sidecar not found at ${sidecarPath}`);
}
if (!fs.existsSync(dbPath)) {
  fail(`Plainsong database not found at ${dbPath}`);
}

function hashBytes(bytes: Buffer | null): string | null {
  if (!bytes) return null;
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function pathsReferToSameFile(left: unknown, right: string): boolean {
  if (!left || !right) return false;
  try {
    return fs.realpathSync(left as string) === fs.realpathSync(right);
  } catch {
    return false;
  }
}

function snapshotDbFiles() {
  for (const filePath of dbSidecarPaths) {
    dbBackups.set(filePath, fs.existsSync(filePath) ? fs.readFileSync(filePath) : null);
  }
}

function restoreDbFiles() {
  for (const [filePath, bytes] of dbBackups.entries()) {
    if (bytes) {
      fs.writeFileSync(filePath, bytes);
    } else if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true });
    }
  }
}

function dbHashes() {
  return Object.fromEntries(
    dbSidecarPaths.map((filePath) => [
      filePath,
      fs.existsSync(filePath) ? hashBytes(fs.readFileSync(filePath)) : null,
    ])
  );
}

function sqlString(value: unknown): string {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runSql(sql: string): void {
  const result = spawnSync("sqlite3", [dbPath], {
    input: sql,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `sqlite3 exited ${result.status}`);
  }
}

function seedFixture() {
  runSql(`
BEGIN IMMEDIATE;
DELETE FROM speaker_aliases WHERE recording_id = ${sqlString(recordingId)};
DELETE FROM transcripts WHERE recording_id = ${sqlString(recordingId)};
DELETE FROM recordings WHERE id = ${sqlString(recordingId)};
INSERT INTO recordings (
  id, title, project_id, duration, created_at, updated_at, source_type, audio_path, status,
  summary, action_items, meeting_notes, meeting_template_id, meeting_capture_mode,
  notes_updated_at, consent_prompt_shown, consent_notice_mode, consent_notice_surface,
  consent_notice_message, consent_notice_updated_at
) VALUES (
  ${sqlString(recordingId)},
  'QA Packaged Export Fixture',
  'inbox',
  20,
  ${sqlString(now)},
  ${sqlString(now)},
  'meeting',
  '',
  'completed',
  'The export workflow produces launch evidence and reusable meeting notes.',
  ${sqlString(JSON.stringify([{ task: "Review packaged export evidence", owner: "Priya" }]))},
  'QA fixture for packaged export validation. Remove after test.',
  'meeting',
  'mic',
  ${sqlString(now)},
  1,
  'manual',
  'qa',
  'QA fixture consent notice',
  ${sqlString(now)}
);
INSERT INTO transcripts (
  id, recording_id, segments, full_text, language, confidence, model,
  model_id, requested_provider, actual_provider, created_at
) VALUES (
  ${sqlString(transcriptId)},
  ${sqlString(recordingId)},
  ${sqlString(JSON.stringify(segments))},
  ${sqlString(transcriptText)},
  'en',
  0.98,
  'qa-fixture',
  'qa-fixture',
  'qa-fixture',
  'qa-fixture',
  ${sqlString(now)}
);
COMMIT;
`);
}

function stderrEvidence(chunks: string[]): { length: number; tail: string } {
  const value = chunks.join("").trim();
  return {
    length: value.length,
    tail: value.slice(-12000),
  };
}

interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
}

interface ExportResponse {
  exportPath?: unknown;
}

interface ExportTemplate {
  id: string;
  format: unknown;
}

interface FileSummary {
  path: string;
  sizeBytes: number;
  sha256: string | null;
  containsTitle: boolean;
  containsTranscript: boolean;
  preview: string;
}

interface ExportResult {
  ok: boolean;
  response: unknown;
  file: FileSummary | null;
}

interface TemplateExportResult extends ExportResult {
  templateId: string;
  format: unknown;
}

interface ExportsArtifact {
  generatedAt: string;
  appPath: string;
  sidecarPath: string;
  recordingId: string;
  transcriptId: string;
  exportDir: string;
  pass: boolean;
  timedOut: boolean;
  templates: ExportTemplate[];
  exports: Record<string, ExportResult>;
  templateExports: TemplateExportResult[];
  checks: Record<string, boolean>;
  dbHashesBefore: Record<string, string | null>;
  dbHashesAfterRestore: Record<string, string | null>;
  databaseRestored: boolean;
  exportDirectoryCleaned: boolean;
  stderr: { length: number; tail: string };
  error: string | null;
  sidecarExit?: { code: number | null; signal: NodeJS.Signals | null; pending: string[] };
}

function launchSidecar() {
  const child = spawn(sidecarPath, [], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...qaProfile.env },
  });
  const childExit = new Promise<ChildExit>((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  const stderr: string[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderr.push(String(chunk)));
  const rl = createInterface({ input: child.stdout });
  const pending = new Map<string, PendingCommand>();
  let nextId = 1;
  let didTimeOut = false;

  function sendCommand(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = String(nextId++);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, method });
    });
  }

  rl.on("line", (line) => {
    let message: { id?: unknown; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const pendingCommand = pending.get(String(message.id));
    if (!pendingCommand) return;
    pending.delete(String(message.id));
    if (message.error) {
      pendingCommand.reject(new Error(message.error.message ?? String(message.error)));
    } else {
      pendingCommand.resolve(message.result);
    }
  });

  const timeout = setTimeout(() => {
    didTimeOut = true;
    child.kill("SIGTERM");
    for (const { reject, method } of pending.values()) {
      reject(new Error(`Timed out waiting for ${method}`));
    }
    pending.clear();
  }, timeoutMs);

  async function shutdown() {
    if (child.stdin.writable) {
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: String(nextId++), method: "shutdown", params: {} })}\n`
      );
    }
    const exit = await childExit;
    clearTimeout(timeout);
    return { ...exit, didTimeOut, pending: [...pending.values()].map((item) => item.method), stderr };
  }

  return { sendCommand, shutdown };
}

function readFileSummary(filePath: string): FileSummary {
  const bytes = fs.readFileSync(filePath);
  let text = bytes.toString("utf8");
  if (path.extname(filePath).toLowerCase() === ".docx") {
    const converted = spawnSync("/usr/bin/textutil", [
      "-convert", "txt", "-stdout", filePath,
    ], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    if (converted.error || converted.status !== 0) {
      throw new Error(`Could not read exported Word document: ${
        converted.error?.message ?? converted.stderr?.trim() ?? "conversion failed"
      }`);
    }
    text = converted.stdout;
  }
  return {
    path: filePath,
    sizeBytes: bytes.length,
    sha256: hashBytes(bytes),
    containsTitle: text.includes("QA Packaged Export Fixture"),
    containsTranscript: text.includes("macOS packaged export workflow"),
    preview: text.slice(0, 400),
  };
}

function writeMarkdownArtifact(artifact: ExportsArtifact): void {
  const mdPath = outPath.replace(/\.json$/i, ".md");
  const exportRows = Object.entries(artifact.exports)
    .map(
      ([format, result]) =>
        `| ${format} | ${result.ok ? "PASS" : "FAIL"} | ${result.file?.path ?? ""} |`
    )
    .join("\n");
  const templateRows = artifact.templateExports
    .map(
      (result) =>
        `| ${result.templateId} | ${result.ok ? "PASS" : "FAIL"} | ${result.file?.path ?? ""} |`
    )
    .join("\n");
  const content = `# Packaged macOS Export QA

Generated: ${artifact.generatedAt}

## Result

- Status: ${artifact.pass ? "PASS" : "FAIL"}
- App: ${artifact.appPath}
- Recording fixture: ${artifact.recordingId}
- Export directory: ${artifact.exportDir}
- Export directory cleaned: ${artifact.exportDirectoryCleaned ? "yes" : "no"}
- Built-in templates: ${artifact.templates.length}
- Database restored: ${artifact.databaseRestored ? "yes" : "no"}

## Standard Exports

| Format | Status | Path |
| --- | --- | --- |
${exportRows}

## Template Exports

| Template | Status | Path |
| --- | --- | --- |
${templateRows}
`;
  fs.writeFileSync(mdPath, content, "utf8");
}

let artifact: ExportsArtifact = {
  generatedAt: new Date().toISOString(),
  appPath,
  sidecarPath,
  recordingId,
  transcriptId,
  exportDir,
  pass: false,
  timedOut: false,
  templates: [],
  exports: {},
  templateExports: [],
  checks: {},
  dbHashesBefore: {},
  dbHashesAfterRestore: {},
  databaseRestored: false,
  exportDirectoryCleaned: false,
  stderr: { length: 0, tail: "" },
  error: null,
};

snapshotDbFiles();
artifact.dbHashesBefore = dbHashes();
fs.mkdirSync(exportDir, { recursive: true });

let sidecar: ReturnType<typeof launchSidecar> | null = null;
try {
  seedFixture();
  sidecar = launchSidecar();
  const templates = (await sidecar.sendCommand("list_export_templates", {})) as ExportTemplate[];
  artifact.templates = templates;

  const exportRequests = [
    { format: "markdown", extension: "md" },
    { format: "json", extension: "json" },
    { format: "text", extension: "txt" },
  ];

  for (const request of exportRequests) {
    const target = path.join(exportDir, `${request.format}.${request.extension}`);
    const response = (await sidecar.sendCommand("export_recording_v2", {
      recordingId,
      format: request.format,
      redactionLevel: "none",
      preview: false,
      target,
    })) as ExportResponse | null;
    const file = fs.existsSync(target) ? readFileSummary(target) : null;
    const ok =
      Boolean(response?.exportPath) &&
      pathsReferToSameFile(response!.exportPath, target) &&
      file !== null &&
      file.sizeBytes > 0 &&
      file.containsTranscript;
    artifact.exports[request.format] = { ok, response, file };
  }

  for (const template of templates) {
    const target = path.join(exportDir, `template-${template.id}.${String(template.format)}`);
    const response = (await sidecar.sendCommand("export_with_template", {
      recordingId,
      templateId: template.id,
      preview: false,
      target,
    })) as ExportResponse | null;
    const file = fs.existsSync(target) ? readFileSummary(target) : null;
    artifact.templateExports.push({
      templateId: template.id,
      format: template.format,
      ok:
        pathsReferToSameFile(response?.exportPath, target) &&
        file !== null &&
        file.sizeBytes > 0 &&
        file.containsTranscript,
      response,
      file,
    });
  }
} catch (error) {
  artifact.error = error instanceof Error ? error.message : String(error);
} finally {
  if (sidecar) {
    const exit = await sidecar.shutdown();
    artifact.timedOut = exit.didTimeOut;
    artifact.sidecarExit = { code: exit.code, signal: exit.signal, pending: exit.pending };
    artifact.stderr = stderrEvidence(exit.stderr);
  }
  restoreDbFiles();
  artifact.dbHashesAfterRestore = dbHashes();
  artifact.databaseRestored =
    JSON.stringify(artifact.dbHashesBefore) === JSON.stringify(artifact.dbHashesAfterRestore);
  try {
    fs.rmSync(exportDir, { recursive: true, force: true });
    artifact.exportDirectoryCleaned = !fs.existsSync(exportDir);
  } catch (error) {
    const cleanupError = error instanceof Error ? error.message : String(error);
    artifact.error = artifact.error
      ? `${artifact.error}; export cleanup failed: ${cleanupError}`
      : `Export cleanup failed: ${cleanupError}`;
  }
}

const expectedTemplates = ["meeting", "meeting_word", "journal", "medical", "interview", "quick", "podcast", "research"];
artifact.checks = {
  noError: artifact.error === null,
  sidecarCleanExit: artifact.sidecarExit?.code === 0 && !artifact.timedOut,
  expectedTemplatesPresent: expectedTemplates.every((id) =>
    artifact.templates.some((template) => template.id === id)
  ),
  standardExportsPass: Object.values(artifact.exports).every((result) => result.ok),
  templateExportsPass:
    artifact.templateExports.length >= expectedTemplates.length &&
    artifact.templateExports.every((result) => result.ok),
  databaseRestored: artifact.databaseRestored,
  exportDirectoryCleaned: artifact.exportDirectoryCleaned,
};
artifact.pass = Object.values(artifact.checks).every(Boolean);
artifact = bindAppReceipt(artifact, appBinding);

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
writeMarkdownArtifact(artifact);
console.log(JSON.stringify(artifact, null, 2));
process.exit(artifact.pass ? 0 : 1);
