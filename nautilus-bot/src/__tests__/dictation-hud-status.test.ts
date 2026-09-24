import { describe, expect, it } from "vitest";
import { describePillStatus, shortErrorLabel } from "@/lib/dictation-hud-status";

const done = (outcome: string | null, message: string | null = null) =>
  describePillStatus({ phase: "done", stage: "transcribing", outcome, message });

describe("dictation pill status", () => {
  it("only shows the filled bar when the words were actually delivered", () => {
    for (const outcome of ["pasted", "paste_dispatched", "replaced", "copied", "copied_replacement"]) {
      const status = done(outcome);
      expect(status.tone).toBe("success");
      expect(status.barComplete).toBe(true);
    }
    for (const outcome of ["secure_field", "error", "empty", "undone", "something_new"]) {
      const status = done(outcome);
      expect(status.barComplete).toBe(false);
      expect(status.tone).not.toBe("success");
    }
  });

  it("names a refused delivery and an empty one plainly", () => {
    expect(done("secure_field").label).toBe("Not inserted");
    expect(done("secure_field").tone).toBe("alert");
    expect(done("empty").label).toBe("No speech");
    expect(done("copied").label).toBe("Copied");
  });

  it("gives every live phase a distinct label", () => {
    const labels = ["preparing", "primed", "recording"].map(
      (phase) => describePillStatus({ phase, stage: "transcribing", outcome: null, message: null }).label,
    );
    expect(new Set(labels).size).toBe(3);
    expect(labels).not.toContain(done("pasted").label);
  });

  it("follows the processing stage", () => {
    const stage = (s: "stopping" | "transcribing" | "polishing") =>
      describePillStatus({ phase: s === "stopping" ? "stopping" : "transcribing", stage: s, outcome: null, message: null }).label;
    expect([stage("stopping"), stage("transcribing"), stage("polishing")]).toEqual([
      "Finishing",
      "Transcribing",
      "Polishing",
    ]);
  });

  it("says a long-running stage is still working, and keeps the bar", () => {
    const slow = describePillStatus({ phase: "transcribing", stage: "polishing", outcome: null, message: null, slow: true });
    expect(slow.label).toBe("Still working");
    expect(slow.detail).toBe("Taking longer than usual. Your words are safe.");
    expect(slow.showBar).toBe(true);
    // A slow flag outside processing changes nothing.
    expect(describePillStatus({ phase: "recording", stage: "transcribing", outcome: null, message: null, slow: true }).label).toBe("Listening");
  });

  it("turns an error message into a short cause", () => {
    expect(shortErrorLabel("Microphone access is off. Turn it on in System Settings.")).toBe("Mic blocked");
    expect(shortErrorLabel("Plainsong needs Accessibility access to insert text.")).toBe("Needs access");
    expect(shortErrorLabel("No OpenAI API key is set.")).toBe("Needs API key");
    expect(shortErrorLabel("Parakeet is not downloaded yet.")).toBe("Model missing");
    expect(shortErrorLabel("Something unexpected")).toBe("Didn't finish");
    expect(shortErrorLabel(null)).toBe("Didn't finish");
  });
});
