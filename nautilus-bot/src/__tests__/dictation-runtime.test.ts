import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/electron", () => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

import { reduceDictationStateEvent } from "@/features/dictation/runtime";

describe("reduceDictationStateEvent", () => {
  it("clears a finished session's message and outcome when the overlay goes idle", () => {
    // The idle event does not repeat the finished session's fields, so a
    // plain merge left "Not inserted — secure field" on the Dictation view
    // after the popup had already reset.
    const done = reduceDictationStateEvent(null, {
      phase: "done",
      sessionId: 9,
      outcome: "secure_field",
      message:
        "Not inserted: the field in front is a password or secure input. Plainsong did not insert or copy the words; they are saved in your dictation history.",
      preview: "hunter two",
      stopReason: "hotkey_release",
      fallbackReason: null,
      appTarget: "Safari",
      dictationProvider: "whisper",
      resolvedRoute: "local",
    });
    expect(done.outcome).toBe("secure_field");

    const idle = reduceDictationStateEvent(done, { phase: "idle", sessionId: 9 });
    expect(idle.phase).toBe("idle");
    expect(idle.message ?? null).toBeNull();
    expect(idle.outcome ?? null).toBeNull();
    expect(idle.preview ?? null).toBeNull();
    expect(idle.partialText ?? null).toBeNull();
    expect(idle.stopReason ?? null).toBeNull();
    // Configuration metadata is sticky by design and survives the reset.
    expect(idle.dictationProvider).toBe("whisper");
    expect(idle.resolvedRoute).toBe("local");
    expect(idle.appTarget).toBe("Safari");
  });

  it("keeps a live session's fields across non-idle updates", () => {
    const recording = reduceDictationStateEvent(null, {
      phase: "recording",
      sessionId: 10,
      partialText: "ship the",
      appTarget: "Slack",
    });
    const transcribing = reduceDictationStateEvent(recording, {
      phase: "transcribing",
      sessionId: 10,
      message: "Transcribing…",
    });
    expect(transcribing.preview).toBe("ship the");
    expect(transcribing.appTarget).toBe("Slack");
    expect(transcribing.message).toBe("Transcribing…");
  });

  it("lets an idle event that carries its own fields set them", () => {
    const idle = reduceDictationStateEvent(
      { phase: "done", outcome: "pasted", message: "Inserted into the target app." },
      { phase: "idle", message: "Ready." },
    );
    expect(idle.message).toBe("Ready.");
    expect(idle.outcome ?? null).toBeNull();
  });
});
