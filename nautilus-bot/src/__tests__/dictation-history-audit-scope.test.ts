import { describe, expect, it } from "vitest";

import { dispatcherArm, sidecarSource } from "./sidecar-source";

/**
 * What the audit log is for: things that changed. Reading is not one of them.
 *
 * Dictation history search used to append an audit row per call, and the
 * renderer's search effect runs on a 250 ms debounce *and* re-runs whenever
 * the recordings list changes — so a minute of typing in the search field
 * wrote dozens of rows and buried the entries that record an actual change.
 *
 * Read from the source because the dispatcher is not reachable from a test
 * without a whole `AppState`; the same reason `ipc-contract-gate` reads it.
 */
const SIDECAR = sidecarSource();

describe("the audit log records changes, not reads", () => {
  it("does not write a row for a dictation history search", () => {
    const arm = dispatcherArm("search_dictation_history");

    expect(arm).toContain("search_dictation_history(&query, limit, offset)");
    expect(arm).not.toContain("log_audit_event");
    // And the retired event name is gone from the sidecar entirely, so a
    // grep for it does not find a dormant caller.
    expect(SIDECAR).not.toContain("dictation_history_searched");
  });

  it("still writes a row when Process again creates a new history entry", () => {
    // Reprocessing makes a new dictation from kept audio. That is a change,
    // and it stays audited.
    expect(SIDECAR).toContain('"dictation_reprocessed"');
  });

  it("still writes a row when an audio file is imported as a meeting", () => {
    expect(SIDECAR).toContain('"meeting_audio_imported"');
  });
});
