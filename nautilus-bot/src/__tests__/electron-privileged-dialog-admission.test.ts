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

/**
 * Every case in the switch, sliced at the arms' own indentation.
 *
 * The named-pair `caseBody` above only checks the cases someone thought to
 * list, which is how `open_calendar_privacy_settings` shipped for review as
 * the one command able to reach a native surface with no gesture behind it.
 * This enumerates the switch instead, so a new case has to be gated rather
 * than merely remembered.
 */
function caseBodies(handler: string): Array<{ command: string; body: string }> {
  const labels = [...handler.matchAll(/^ {4}case "([^"]+)":/gm)];
  expect(labels.length).toBeGreaterThan(0);
  const switchEnd = handler.indexOf("\n    default:");
  expect(switchEnd).toBeGreaterThan(-1);

  return labels.map((label, index) => ({
    command: label[1],
    body: handler.slice(label.index ?? 0, labels[index + 1]?.index ?? switchEnd),
  }));
}

/**
 * Anything that puts an OS-owned surface in front of the user: a native modal,
 * a folder picker, or a jump to System Settings. `chooseDirectory` is listed
 * because the `dialog.showOpenDialog` call itself lives in a helper above the
 * switch, so the case bodies only ever name the wrapper.
 */
const NATIVE_SURFACE = /chooseDirectory\(|dialog\.show[A-Za-z]*\(|shell\.openExternal\(/;

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

  it("gates every case that can put a native surface in front of the user", () => {
    // The generalization of the three tests above. `open_calendar_privacy_
    // settings` was ungated precisely because it is not a modal — it "only"
    // brings System Settings to the front, which a hidden overlay could have
    // driven on a loop. Reaching an OS surface is the property that matters,
    // not which kind.
    const bodies = caseBodies(localCommandHandler());
    const reachesNativeSurface = bodies.filter(({ body }) =>
      NATIVE_SURFACE.test(body),
    );

    // The scan has to find the known ones, or every assertion below is
    // vacuously true. Sorted, so reordering the switch is not a test failure —
    // the set is the claim, not the order.
    expect(reachesNativeSurface.map(({ command }) => command).sort()).toEqual(
      [
        // The support-bundle save dialog: the reader picks the file, and the
        // path goes from the dialog straight to the sidecar.
        "create_support_bundle",
        "open_calendar_privacy_settings",
        // The audio-import picker: a native open dialog like the storage
        // ones, and gated the same way.
        "select_audio_file_to_import",
        "select_backup_location",
        "select_cloud_backup_location",
        "select_export_location",
      ].sort(),
    );

    const ungated = reachesNativeSurface
      .filter(
        ({ body }) =>
          !body.includes("requireMainWindowGesture(") &&
          !body.includes("captureAdmission.consume("),
      )
      .map(({ command }) => command);

    expect(ungated, "commands reaching a native surface with no gesture").toEqual(
      [],
    );
  });

  it("gates the calendar prompt and the System Settings jump, but not the read", () => {
    const handler = localCommandHandler();

    expect(
      caseBody(handler, "request_calendar_access", "open_calendar_privacy_settings"),
    ).toContain('requireMainWindowGesture("Connecting your calendar")');

    const openSettings = caseBody(
      handler,
      "open_calendar_privacy_settings",
      "select_export_location",
    );
    expect(openSettings).toContain(
      'requireMainWindowGesture("Opening calendar privacy settings")',
    );
    // Gate first, then the jump — the same ordering the folder pickers use.
    expect(openSettings.indexOf("requireMainWindowGesture(")).toBeLessThan(
      openSettings.indexOf("shell.openExternal("),
    );

    // Reading the calendar deliberately carries no gesture: it cannot prompt
    // and opens nothing, and the Meetings view calls it on mount. Pinned here
    // so that if reading ever gains a prompt, this expectation has to change
    // with it.
    const snapshot = caseBody(
      handler,
      "get_calendar_snapshot",
      "request_calendar_access",
    );
    expect(snapshot).not.toContain("requireMainWindowGesture(");
    expect(NATIVE_SURFACE.test(snapshot)).toBe(false);
  });

  it("keeps shell.openExternal out of every other local command", () => {
    // Everything else leaves the app through the vetted https allowlist in
    // electron/external-url-policy.ts. A second raw egress point in this
    // handler would bypass it entirely.
    const openExternalCases = caseBodies(localCommandHandler())
      .filter(({ body }) => body.includes("shell.openExternal("))
      .map(({ command }) => command);

    expect(openExternalCases).toEqual(["open_calendar_privacy_settings"]);
  });
});
