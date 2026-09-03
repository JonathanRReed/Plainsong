import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

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
const LIB_RS = readFileSync(
  path.resolve(__dirname, "../../rust-sidecar/src/lib.rs"),
  "utf8",
);

/** The body of one `"name" => { … }` dispatcher arm. */
function dispatcherArm(name: string): string {
  const start = LIB_RS.indexOf(`        "${name}" => {`);
  expect(start, `dispatcher arm for ${name}`).toBeGreaterThan(-1);
  const end = LIB_RS.indexOf('\n        "', start + 1);
  expect(end, `end of the ${name} arm`).toBeGreaterThan(start);
  return LIB_RS.slice(start, end);
}

describe("the audit log records changes, not reads", () => {
  it("does not write a row for a dictation history search", () => {
    const arm = dispatcherArm("search_dictation_history");

    expect(arm).toContain("search_dictation_history(&query, limit, offset)");
    expect(arm).not.toContain("log_audit_event");
    // And the retired event name is gone from the sidecar entirely, so a
    // grep for it does not find a dormant caller.
    expect(LIB_RS).not.toContain("dictation_history_searched");
  });

  it("still writes a row when Process again creates a new history entry", () => {
    // Reprocessing makes a new dictation from kept audio. That is a change,
    // and it stays audited.
    expect(LIB_RS).toContain('"dictation_reprocessed"');
  });

  it("still writes a row when an audio file is imported as a meeting", () => {
    expect(LIB_RS).toContain('"meeting_audio_imported"');
  });
});
