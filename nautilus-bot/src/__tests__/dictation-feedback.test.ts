import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DICTATION_DELIVERY_FEEDBACK, dictationDeliveryFeedback } from "../../electron/dictation-feedback";
import { dictationSoundForTransition } from "../../electron/dictation-sounds";
import { describePillStatus } from "@/lib/dictation-hud-status";

const outcomes = [
  ["pasted", "Inserted", "success", "done"],
  ["replaced", "Replaced", "success", "done"],
  ["paste_dispatched", "Check text", "quiet", "attention"],
  ["copied", "Copied", "quiet", "attention"],
  ["copied_replacement", "Copied", "quiet", "attention"],
  ["copied_instead", "Copied, press ⌘V", "quiet", "attention"],
  ["secure_field", "Secure field", "alert", "error"],
  ["clipboard_kept", "Clipboard kept", "alert", "error"],
  ["error", "Not inserted", "alert", "error"],
  ["aborted", "Cancelled", "quiet", null],
  ["previewed", "Ready", "quiet", "attention"],
  ["ready", "Ready", "quiet", "attention"],
  ["empty", "No speech", "quiet", null],
  ["undone", "Undone", "quiet", null],
] as const;

describe("dictation delivery feedback", () => {
  it.each(outcomes)("agrees on label, tone and sound for %s", (outcome, label, tone, sound) => {
    expect(dictationDeliveryFeedback(outcome)).toMatchObject({ label, tone, sound });
    expect(describePillStatus({ phase: "done", stage: "delivering", outcome, message: null }))
      .toMatchObject({ label, tone, barComplete: tone === "success", showBar: tone === "success" });
    expect(dictationSoundForTransition("delivering", "done", outcome)).toBe(sound);
    expect(dictationSoundForTransition("done", "done", outcome)).toBeNull();
  });

  it("covers every native delivery result and terminal outcome", () => {
    const source = readFileSync("rust-sidecar/src/dictation_session.rs", "utf8");
    const resolver = source.split("pub(crate) fn resolve_dictation_delivery_outcome")[1].split("/// Facts")[0];
    const native = [...resolver.matchAll(/"([a-z_]+)"\.to_string\(\)/g)].map(match => match[1]);
    const terminal = [...source.matchAll(/(?:outcome\s*=\s*|"outcome":\s*)"([a-z_]+)"/g)].map(match => match[1]);
    const preview = source.split("outcome = if final_text.is_empty() {")[1]?.split("};")[0] ?? "";
    const previews = [...preview.matchAll(/"([a-z_]+)"\.to_string\(\)/g)].map(match => match[1]);
    expect(native.length).toBeGreaterThan(0);
    expect(previews).toContain("previewed");
    const covered = outcomes.map(([outcome]) => outcome);
    expect(Object.keys(DICTATION_DELIVERY_FEEDBACK).sort()).toEqual([...covered].sort());
    for (const outcome of new Set([...native, ...terminal, ...previews, "secure_field"])) {
      expect(covered, outcome).toContain(outcome);
    }
  });

  it("does not claim clipboard recovery after a newer clipboard was preserved", () => {
    const status = describePillStatus({ phase: "done", stage: "delivering", outcome: "clipboard_kept", message: null });
    expect(status).toMatchObject({ label: "Clipboard kept", tone: "alert" });
    expect(status.detail).toContain("clipboard was left alone");
    expect(status.detail).not.toMatch(/Cmd\+V|⌘V/);
    expect(dictationSoundForTransition("delivering", "done", "clipboard_kept")).toBe("error");
  });

  it("shows cancellation on the native idle transition without playing a sound", () => {
    expect(describePillStatus({ phase: "idle", stage: "transcribing", outcome: "aborted", message: null }))
      .toMatchObject({ label: "Cancelled", tone: "quiet", barComplete: false });
    expect(dictationSoundForTransition("transcribing", "idle", "aborted")).toBeNull();
  });

  it.each([null, undefined, "future_outcome", "toString", "__proto__"])("never claims success for %s", outcome => {
    expect(dictationDeliveryFeedback(outcome).tone).toBe("alert");
  });
});
