import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const mainSource = fs.readFileSync(path.join(root, "electron/main.ts"), "utf8");
const dispatchSource = fs.readFileSync(
  path.join(root, "rust-sidecar/src/dispatch.rs"),
  "utf8",
);
const permissionsSource = fs.readFileSync(
  path.join(root, "rust-sidecar/src/permissions.rs"),
  "utf8",
);

describe("selected-text playback admission", () => {
  it("limits capture to a focused main-window gesture and forwards a native nonce", () => {
    const start = mainSource.indexOf('case "capture_selected_text_for_playback"');
    const end = mainSource.indexOf('case "__window_set_size__"', start);
    const handler = mainSource.slice(start, end);

    expect(handler).toContain("senderWindow !== mainWindow");
    expect(handler).toContain("!senderWindow.isFocused()");
    expect(handler).toContain("captureAdmission.consume(senderWindow.id, route)");
    expect(handler).toContain('invoke("register_capture_admission"');
    expect(handler).toContain("admissionNonce: grant.nonce");
  });

  it("requires and consumes the privileged proof before native selection capture", () => {
    const dispatchStart = dispatchSource.indexOf(
      '"capture_selected_text_for_playback" =>',
    );
    const dispatchEnd = dispatchSource.indexOf('"reprocess_dictation_text" =>', dispatchStart);
    const dispatch = dispatchSource.slice(dispatchStart, dispatchEnd);
    const implementationStart = permissionsSource.indexOf(
      "async fn capture_selected_text_for_playback_impl",
    );
    const implementationEnd = permissionsSource.indexOf(
      "async fn open_recording_audio_impl",
      implementationStart,
    );
    const implementation = permissionsSource.slice(implementationStart, implementationEnd);

    expect(dispatch).toContain('get("admissionNonce")');
    expect(dispatch).toContain("capture_selected_text_for_playback_impl(state.as_ref()");
    expect(implementation).toContain("capture_admission.is_enforcing()");
    expect(implementation).toContain(".consume(admission_nonce)");
    expect(implementation.indexOf(".consume(admission_nonce)")).toBeLessThan(
      implementation.indexOf("capture_selected_text_via_clipboard"),
    );
  });
});
