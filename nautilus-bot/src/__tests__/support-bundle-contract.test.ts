import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  captureMainProcessConsole,
  DiagnosticLogBuffer,
  DIAGNOSTIC_LOG_BUFFER_MAX_LINES,
  DIAGNOSTIC_LOG_LINE_MAX_CHARS,
} from "../../electron/diagnostic-log-buffer";

const repoRoot = process.cwd();
const read = (relative: string) =>
  readFileSync(path.join(repoRoot, relative), "utf8");

describe("support bundle IPC contract", () => {
  const bridge = read("electron/ipc-bridge.ts");
  const main = read("electron/main.ts");
  const sidecar = read("rust-sidecar/src/lib.rs");
  const gate = read("scripts/verify-ipc-contract.mjs");

  it("admits only the two renderer-facing commands", () => {
    expect(bridge).toContain('"preview_support_bundle"');
    expect(bridge).toContain('"create_support_bundle"');
    // The sidecar RPCs take a filesystem path and the in-memory log tail, so a
    // renderer must never be able to name them.
    expect(bridge).not.toContain('"write_support_bundle_privileged"');
    expect(bridge).not.toContain('"describe_support_bundle"');
  });

  it("answers both renderer commands in the Electron main process", () => {
    expect(main).toContain('case "preview_support_bundle": {');
    expect(main).toContain('case "create_support_bundle": {');
  });

  it("consumes a user gesture before opening the save dialog", () => {
    const createCase = main.slice(
      main.indexOf('case "create_support_bundle": {'),
      main.indexOf('case "select_backup_location": {'),
    );
    expect(createCase).toContain(
      'requireMainWindowGesture("Creating a support bundle")',
    );
    expect(createCase).toContain("dialog.showSaveDialog");
    // The renderer hands over no path: `targetPath` comes from the dialog.
    expect(createCase).toContain("targetPath,");
  });

  it("keeps the preview read-only, with no dialog and no write", () => {
    const previewCase = main.slice(
      main.indexOf('case "preview_support_bundle": {'),
      main.indexOf('case "create_support_bundle": {'),
    );
    expect(previewCase).toContain("describe_support_bundle");
    expect(previewCase).not.toContain("showSaveDialog");
    expect(previewCase).not.toContain("requireMainWindowGesture");
  });

  it("implements both sidecar arms and declares them main-process only", () => {
    expect(sidecar).toContain('"describe_support_bundle" => {');
    expect(sidecar).toContain('"write_support_bundle_privileged" => {');
    const unreachable = gate.slice(
      gate.indexOf("intentionallyUnreachableSidecarCommands"),
      gate.indexOf("const bridge = read(bridgePath)"),
    );
    expect(unreachable).toContain('"describe_support_bundle"');
    expect(unreachable).toContain('"write_support_bundle_privileged"');
  });
});

describe("diagnostic log buffer", () => {
  it("splits chunks into lines and tags their source", () => {
    const buffer = new DiagnosticLogBuffer(10);
    buffer.record("sidecar", "INFO one\nINFO two\n");
    expect(buffer.snapshot()).toEqual(["[sidecar] INFO one", "[sidecar] INFO two"]);
  });

  it("drops blank lines rather than padding the tail with them", () => {
    const buffer = new DiagnosticLogBuffer(10);
    buffer.record("main", "\n\n  \nINFO real\n");
    expect(buffer.snapshot()).toEqual(["[main] INFO real"]);
  });

  it("keeps only the newest lines once it is full", () => {
    const buffer = new DiagnosticLogBuffer(3);
    for (const index of [1, 2, 3, 4, 5]) {
      buffer.record("sidecar", `INFO ${index}`);
    }
    expect(buffer.snapshot()).toEqual([
      "[sidecar] INFO 3",
      "[sidecar] INFO 4",
      "[sidecar] INFO 5",
    ]);
    expect(buffer.size).toBe(3);
  });

  it("truncates a single enormous line instead of holding it whole", () => {
    const buffer = new DiagnosticLogBuffer(2);
    buffer.record("sidecar", "x".repeat(DIAGNOSTIC_LOG_LINE_MAX_CHARS + 500));
    const [line] = buffer.snapshot();
    expect(line.endsWith("…[truncated]")).toBe(true);
    expect(line.length).toBeLessThan(DIAGNOSTIC_LOG_LINE_MAX_CHARS + 40);
  });

  it("defaults to the documented cap", () => {
    const buffer = new DiagnosticLogBuffer();
    for (let index = 0; index < DIAGNOSTIC_LOG_BUFFER_MAX_LINES + 25; index += 1) {
      buffer.record("main", `INFO ${index}`);
    }
    expect(buffer.size).toBe(DIAGNOSTIC_LOG_BUFFER_MAX_LINES);
  });

  it("mirrors console output without swallowing it", () => {
    const buffer = new DiagnosticLogBuffer(10);
    const seen: unknown[][] = [];
    const fake = {
      log: (...args: unknown[]) => seen.push(args),
      warn: (...args: unknown[]) => seen.push(args),
      error: (...args: unknown[]) => seen.push(args),
    } as unknown as Console;

    captureMainProcessConsole(fake, buffer);
    fake.log("[main] started", { ok: true });
    fake.error(new Error("boom"));

    expect(seen).toHaveLength(2);
    expect(buffer.snapshot()).toEqual([
      '[main] LOG [main] started {"ok":true}',
      "[main] ERROR Error: boom",
    ]);
  });
});
