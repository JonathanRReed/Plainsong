import { describe, expect, it } from "vitest";

import { sidecarSource, topLevelItem } from "./sidecar-source";

describe("macOS frontmost target capture", () => {
  it("uses one NSWorkspace snapshot for every user-facing insertion target", () => {
    // Every module lib.rs was split into: the split lookup must be unique
    // across all of them, not merely across whatever is left in lib.rs.
    const source = sidecarSource();
    const splitLookup =
      "sanitize_dictation_target(get_frontmost_app_name(), get_frontmost_app_bundle_id())";

    // The single remaining split lookup is the compatibility fallback inside
    // capture_hotkey_target_context after its atomic NSWorkspace query fails.
    expect(source.split(splitLookup)).toHaveLength(2);

    for (const declaration of [
      "async fn smoke_test_cursor_insert_impl(",
      "async fn capture_selected_text_for_playback_impl(",
      "async fn transform_selected_text_impl(",
      "fn resolve_recent_dictation_repaste_target(",
    ]) {
      const body = topLevelItem(source, declaration);

      expect(body).toContain("capture_hotkey_target_context(false)");
      expect(body).not.toContain(splitLookup);
    }
  });
});
