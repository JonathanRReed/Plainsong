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
    expect(implementation).toContain(".consume_required(admission_nonce)");
    expect(implementation.indexOf(".consume_required(admission_nonce)")).toBeLessThan(
      implementation.indexOf("capture_selected_text_via_clipboard"),
    );
  });
});

describe("selected-text transform admission", () => {
  it("routes transforms through the focused main-window gesture gate", () => {
    const start = mainSource.indexOf('case "transform_selected_text"');
    expect(start).toBeGreaterThan(-1);
    const handler = mainSource.slice(start, mainSource.indexOf('case "__window_set_size__"', start));
    expect(handler).toContain("senderWindow !== mainWindow");
    expect(handler).toContain("!senderWindow.isFocused()");
    expect(handler).toContain("captureAdmission.consume(senderWindow.id, route)");
    expect(handler).toContain('invoke("register_capture_admission"');
    expect(handler).toContain("admissionNonce: grant.nonce");
    expect(handler).toContain("commandKey");
  });

  it("consumes a required sidecar proof before reading or transforming text", () => {
    const start = dispatchSource.indexOf('"transform_selected_text" =>');
    const dispatch = dispatchSource.slice(start, dispatchSource.indexOf('"get_recent_dictation_results" =>', start));
    expect(dispatch).toContain('get("admissionNonce")');
    expect(dispatch).toContain("&admission_nonce");
    const source = fs.readFileSync(path.join(root, "rust-sidecar/src/dictation_reprocess.rs"), "utf8");
    const implementationStart = source.indexOf("async fn transform_selected_text_impl");
    const implementation = source.slice(implementationStart, source.indexOf("/// Pure scope-selection policy", implementationStart));
    const consumeAt = implementation.indexOf(".consume_required(admission_nonce)");
    expect(consumeAt).toBeGreaterThan(-1);
    expect(consumeAt).toBeLessThan(implementation.indexOf("capture_hotkey_target_context"));
    expect(consumeAt).toBeLessThan(implementation.indexOf("capture_selected_text_transform_target"));
  });
});

it("uses full, ownership-aware macOS clipboard preservation for selected text", () => {
  const source = fs.readFileSync(path.join(root, "rust-sidecar/src/text_insert.rs"), "utf8");
  const start = source.indexOf("pub(crate) fn capture_selected_text_via_clipboard");
  const capture = source.slice(start, source.indexOf('#[cfg(target_os = "windows")]', start));
  expect(capture).toContain("capture_selection_preserving_clipboard(");
  expect(capture).toContain("snapshot_macos_clipboard");
  expect(capture).toContain("restore_macos_clipboard_if_owned");
  expect(capture).not.toContain("copy_to_clipboard(");
});

it("requires registration before any selected-text proof can be consumed", () => {
  const source = fs.readFileSync(path.join(root, "rust-sidecar/src/admission.rs"), "utf8");
  const start = source.indexOf("pub fn consume_required(");
  const required = source.slice(start, source.indexOf("/// Redeem a nonce", start));
  expect(required.indexOf("!self.is_enforcing()")).toBeGreaterThan(-1);
  expect(required.indexOf("!self.is_enforcing()")).toBeLessThan(required.indexOf("self.consume(nonce)"));
});
