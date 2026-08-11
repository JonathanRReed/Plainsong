import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");

describe("macOS frontmost target capture", () => {
  it("uses one NSWorkspace snapshot for every user-facing insertion target", () => {
    const source = fs.readFileSync(
      path.join(repoRoot, "rust-sidecar", "src", "lib.rs"),
      "utf8",
    );
    const splitLookup =
      "sanitize_dictation_target(get_frontmost_app_name(), get_frontmost_app_bundle_id())";

    // The single remaining split lookup is the compatibility fallback inside
    // capture_hotkey_target_context after its atomic NSWorkspace query fails.
    expect(source.split(splitLookup)).toHaveLength(2);

    for (const functionName of [
      "smoke_test_cursor_insert_impl",
      "capture_selected_text_for_playback_impl",
      "transform_selected_text_impl",
      "resolve_recent_dictation_repaste_target",
    ]) {
      const start = source.indexOf(`fn ${functionName}`);
      const nextFunction = source.indexOf("\nfn ", start + 3);
      const body = source.slice(start, nextFunction === -1 ? undefined : nextFunction);

      expect(start, `${functionName} must exist`).toBeGreaterThan(-1);
      expect(body).toContain("capture_hotkey_target_context(false)");
      expect(body).not.toContain(splitLookup);
    }
  });
});
