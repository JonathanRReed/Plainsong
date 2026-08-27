import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CaptureAdmissionController } from "../../electron/capture-admission";

function localCommandHandler(): string {
  const source = readFileSync(path.resolve(process.cwd(), "electron/main.ts"), "utf8");
  const start = source.indexOf("async function handleLocalCommand(");
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("type DictationShortcutPhase", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

function caseBody(handler: string, command: string, nextCommand: string): string {
  const start = handler.indexOf(`case "${command}"`);
  expect(start).toBeGreaterThan(-1);
  const end = handler.indexOf(`case "${nextCommand}"`, start);
  expect(end).toBeGreaterThan(start);
  return handler.slice(start, end);
}

describe("privileged native dialog admission", () => {
  it("requires a fresh gesture before every storage-location dialog", () => {
    // The finding: these three opened a native modal parented to whatever
    // window sent the command, with no main-window guard and no user gesture.
    // begin_meeting_capture already had both; these did not.
    const handler = localCommandHandler();

    expect(
      caseBody(handler, "select_export_location", "select_backup_location"),
    ).toContain('requireMainWindowGesture("Choosing an export folder")');
    expect(
      caseBody(handler, "select_backup_location", "select_cloud_backup_location"),
    ).toContain('requireMainWindowGesture("Choosing a backup folder")');
    expect(
      caseBody(handler, "select_cloud_backup_location", "begin_meeting_capture"),
    ).toContain('requireMainWindowGesture("Choosing a cloud backup destination")');
  });

  it("parents every dialog to the main window rather than the sender", () => {
    // `dialog.showOpenDialog(senderWindow, …)` accepted a hidden, non-focusable
    // overlay as the modal's parent — a modal on a window the user cannot see.
    const handler = localCommandHandler();

    expect(handler).toContain("senderWindow !== mainWindow");
    expect(handler).toContain("captureAdmission.consume(senderWindow.id, route)");
    // No dialog is opened without a parent window any more.
    expect(handler).not.toContain("await dialog.showOpenDialog(options)");
    expect(handler).not.toContain("await dialog.showMessageBox(messageOptions)");
    expect(handler).not.toContain("dialog.showOpenDialog(senderWindow,");
    expect(handler).not.toContain("dialog.showMessageBox(senderWindow,");
  });

  it("consumes the gesture before the dialog opens, once per command", () => {
    const handler = localCommandHandler();
    const cloud = caseBody(
      handler,
      "select_cloud_backup_location",
      "begin_meeting_capture",
    );
    // One gesture covers whichever of the two branches runs; the iCloud picker
    // and the non-iCloud confirmation must not each demand their own.
    expect(cloud.match(/requireMainWindowGesture\(/g)).toHaveLength(1);
    expect(cloud.indexOf("requireMainWindowGesture(")).toBeLessThan(
      cloud.indexOf("chooseDirectory("),
    );
  });

  it("registers the capture nonce with the sidecar before starting a meeting", () => {
    // The sidecar's admission registry enforces from the first registered
    // nonce onward; skipping this call leaves its check permanently decorative.
    const handler = localCommandHandler();
    const capture = caseBody(handler, "begin_meeting_capture", "end_meeting_capture");
    const consumeAt = capture.indexOf("captureAdmission.consume(");
    const registerAt = capture.indexOf('invoke("register_capture_admission"');
    const startAt = capture.indexOf('invoke("start_recording"');
    expect(consumeAt).toBeGreaterThanOrEqual(0);
    expect(registerAt).toBeGreaterThan(consumeAt);
    expect(startAt).toBeGreaterThan(registerAt);
  });

  it("rejects a stale, reused, cross-window or cross-route gesture", () => {
    // The same single-use, route-bound, time-bounded grant meeting capture
    // relies on, now also standing between a renderer and a native modal.
    let now = 10_000;
    const admission = new CaptureAdmissionController({
      maxAgeMs: 1_000,
      now: () => now,
    });

    expect(() => admission.consume(1, "plainsong://bundle/index.html")).toThrow(
      "recent click or key press",
    );

    admission.observe(1, "plainsong://bundle/index.html");
    expect(admission.consume(1, "plainsong://bundle/index.html").windowId).toBe(1);
    // Single use: a second dialog needs a second click.
    expect(() => admission.consume(1, "plainsong://bundle/index.html")).toThrow(
      "recent click or key press",
    );

    admission.observe(1, "plainsong://bundle/index.html");
    expect(() => admission.consume(2, "plainsong://bundle/index.html")).toThrow(
      "recent click or key press",
    );
    expect(() => admission.consume(1, "plainsong://bundle/other.html")).toThrow(
      "same page",
    );

    admission.observe(1, "plainsong://bundle/index.html");
    now += 1_001;
    expect(() => admission.consume(1, "plainsong://bundle/index.html")).toThrow(
      "recent click or key press",
    );
  });

  it("phrases the refusal for any action, not only meeting capture", () => {
    const admission = new CaptureAdmissionController();
    expect(() => admission.consume(1, "plainsong://bundle/index.html")).toThrow(
      /^This action requires a recent click or key press$/,
    );
  });
});
