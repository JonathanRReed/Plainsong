import { describe, expect, it } from "vitest";
import { describePillStatus, shortErrorLabel } from "@/lib/dictation-hud-status";

const done = (outcome: string | null, message: string | null = null) =>
  describePillStatus({ phase: "done", stage: "transcribing", outcome, message });

describe("dictation pill status", () => {
  it("only shows the filled bar when the words were actually delivered", () => {
    for (const outcome of ["pasted", "replaced"]) {
      const status = done(outcome);
      expect(status.tone).toBe("success");
      expect(status.barComplete).toBe(true);
    }
    for (const outcome of ["paste_dispatched", "copied", "copied_replacement", "copied_instead", "previewed", "secure_field", "error", "empty", "undone", "aborted", "ready", "something_new", null]) {
      const status = done(outcome);
      expect(status.barComplete).toBe(false);
      expect(status.tone).not.toBe("success");
    }
  });

  it("distinguishes an unconfirmed paste from confirmed insertion", () => {
    const sent = done("paste_dispatched");
    expect(sent.label).toBe("Check text");
    expect(sent.tone).toBe("quiet");
    expect(sent.showBar).toBe(false);
    expect(sent.detail).toContain("couldn't confirm the text landed");
    expect(done("paste_dispatched", "AI formatting was unavailable.").detail).toContain("AI formatting was unavailable.");
    expect(done("copied_instead").label).toBe("Copied, press ⌘V");
    expect(done("copied_instead").tone).toBe("quiet");
    expect(done("pasted").label).toBe("Inserted");
    expect(done("pasted").barComplete).toBe(true);
  });

  it("names a refused delivery and an empty one plainly", () => {
    expect(done("secure_field").label).toBe("Secure field");
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
    expect(slow.detail).toBe("Taking longer than usual. Still processing your dictation.");
    expect(slow.showBar).toBe(true);
    // A slow flag outside processing changes nothing.
    expect(describePillStatus({ phase: "recording", stage: "transcribing", outcome: null, message: null, slow: true }).label).toBe("Listening");
  });

  it("says the model is being prepared on a first-use compile, even past the expected time", () => {
    for (const slow of [false, true]) {
      const preparing = describePillStatus({
        phase: "transcribing",
        stage: "transcribing",
        outcome: null,
        message: null,
        slow,
        preparingModel: true,
      });
      expect(preparing.label).toBe("Preparing model");
      expect(preparing.detail).toBe("Preparing the speech model for this Mac. This happens once.");
      expect(preparing.showBar).toBe(true);
    }
    // Once the AI pass starts, or delivery, the flag no longer applies.
    expect(
      describePillStatus({ phase: "transcribing", stage: "polishing", outcome: null, message: null, preparingModel: true }).label,
    ).toBe("Polishing");
    expect(
      describePillStatus({ phase: "error", stage: "transcribing", outcome: null, message: "x", preparingModel: true }).label,
    ).not.toBe("Preparing model");
  });

  it("names a download Parakeet waits for, not a missing model", () => {
    // `NEEDED_DOWNLOAD_*` in transcribe_cpp.rs, as dictation_session.rs wraps them.
    expect(
      shortErrorLabel(
        "Couldn't transcribe with Parakeet v3. Parakeet is downloading a file it needs on this Mac. Dictation will be ready when it finishes; see Settings > Models.",
      ),
    ).toBe("Downloading");
    expect(
      shortErrorLabel(
        "Couldn't transcribe with Parakeet v3. Parakeet couldn't download a file it needs on this Mac. Check your connection; Plainsong will try again.",
      ),
    ).toBe("Download failed");
  });

  it("turns an error message into a short cause", () => {
    expect(shortErrorLabel("Microphone access is off. Turn it on in System Settings.")).toBe("Mic blocked");
    expect(shortErrorLabel("Plainsong needs Accessibility access to insert text.")).toBe("Needs access");
    expect(shortErrorLabel("No OpenAI API key is set.")).toBe("Needs API key");
    expect(shortErrorLabel("Parakeet is not downloaded yet.")).toBe("Model missing");
    expect(shortErrorLabel("A meeting is recording. Stop it to dictate.")).toBe("Meeting recording");
    expect(shortErrorLabel("Cannot start dictation while a meeting recording is active")).toBe("Meeting recording");
    expect(shortErrorLabel("Something unexpected")).toBe("Didn't finish");
    expect(shortErrorLabel(null)).toBe("Didn't finish");
  });
});

describe("dictation pill status during a meeting", () => {
  const recording = (meetingAside?: boolean) =>
    describePillStatus({ phase: "recording", stage: "transcribing", outcome: null, message: null, meetingAside });

  it("says an aside is dictating during a meeting and keeps the reminder in its detail", () => {
    const aside = recording(true);
    expect(aside.label).toBe("Dictating during a meeting");
    expect(aside.tone).toBe("live");
    expect(aside.detail).toBe("Your call can still hear you. Mute the call if this is private.");
  });

  it("leaves an ordinary dictation listening", () => {
    expect(recording(false).label).toBe("Listening");
    expect(recording().label).toBe("Listening");
    expect(recording().detail).toBeNull();
  });

  it("only changes the live label: processing and outcomes read the same", () => {
    const processing = (meetingAside: boolean) =>
      describePillStatus({ phase: "transcribing", stage: "transcribing", outcome: null, message: null, meetingAside });
    expect(processing(true)).toEqual(processing(false));
    expect(
      describePillStatus({ phase: "done", stage: "transcribing", outcome: "pasted", message: null, meetingAside: true }),
    ).toEqual(done("pasted"));
  });

  it("names each refusal a meeting can cause", () => {
    expect(shortErrorLabel("A meeting is recording. Stop it to dictate.")).toBe("Meeting recording");
    expect(
      shortErrorLabel("Hands-free dictation pauses while a meeting records. Use the dictation shortcut instead."),
    ).toBe("Meeting recording");
    expect(shortErrorLabel("The meeting is still saving. Dictate again in a moment.")).toBe("Meeting saving");
    expect(
      shortErrorLabel("The meeting started or stopped while dictation was starting. Try again."),
    ).toBe("Meeting changed");
  });
});
