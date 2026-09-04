import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getCommandTimeoutMs } from "../../electron/ipc-command-policy";
import { dispatcher } from "./sidecar-source";

/**
 * The renderer↔sidecar contract for pause/resume and live-call detection.
 *
 * `scripts/verify-ipc-contract.mjs` proves every allowlisted command has a
 * handler; this pins the other direction for these four — that the renderer
 * is actually allowed to call them, and that the two the UI waits on
 * synchronously get the fast timeout — so a refactor that drops one from the
 * allowlist fails here, in words, rather than as a rejected IPC at runtime.
 */
const repoRoot = path.resolve(__dirname, "..", "..");
const bridge = readFileSync(path.join(repoRoot, "electron/ipc-bridge.ts"), "utf8");
const main = readFileSync(path.join(repoRoot, "electron/main.ts"), "utf8");
// The router: the only file that can hold an arm the renderer can reach.
const sidecar = dispatcher();
const backend = readFileSync(path.join(repoRoot, "src/lib/backend.ts"), "utf8");

const COMMANDS = [
  "pause_meeting_capture",
  "resume_meeting_capture",
  "get_meeting_call_status",
  "dismiss_detected_call",
] as const;

const SIDECAR_COMMANDS = ["pause_recording", "resume_recording"] as const;

describe("meeting pause and call-detection IPC contract", () => {
  it("allowlists each renderer command and gives it a wrapper", () => {
    for (const command of COMMANDS) {
      expect(bridge, `${command} missing from ALLOWED_RENDERER_COMMANDS`).toContain(
        `"${command}",`,
      );
      expect(backend, `${command} has no renderer wrapper`).toContain(`invoke("${command}"`);
    }
    for (const command of SIDECAR_COMMANDS) {
      expect(sidecar, `${command} has no dispatch arm`).toMatch(
        new RegExp(`^ {8}"${command}"\\s*=>`, "m"),
      );
    }
  });

  it("answers the ones the UI waits on quickly", () => {
    for (const command of COMMANDS) {
      expect(getCommandTimeoutMs(command)).toBe(15_000);
    }
  });

  it("keeps start and stop where they were: main-process only", () => {
    // Raw capture mutations stay main-process only. Renderers use privileged
    // aliases that consume gesture admission and choose the main-owned ID.
    expect(bridge).not.toContain('"start_recording",');
    expect(bridge).not.toContain('"stop_recording",');
    expect(bridge).not.toContain('"pause_recording",');
    expect(bridge).not.toContain('"resume_recording",');
    expect(bridge).toContain('"begin_meeting_capture",');
    expect(bridge).toContain('"end_meeting_capture",');
  });

  it("routes pause and resume through gesture admission and the main-owned ID", () => {
    const start = main.indexOf('case "pause_meeting_capture"');
    const end = main.indexOf('case "prepare_recording_playback"', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const privilegedCases = main.slice(start, end);

    expect(privilegedCases).toContain("captureAdmission.consume(senderWindow.id, route)");
    expect(privilegedCases).toContain("recordingId: activeMeetingRecordingId");
    expect(privilegedCases).not.toContain("payload.recordingId");
    expect(privilegedCases.indexOf("captureAdmission.consume(")).toBeLessThan(
      privilegedCases.indexOf("ipcBridge.invokeSidecar("),
    );
  });
});
