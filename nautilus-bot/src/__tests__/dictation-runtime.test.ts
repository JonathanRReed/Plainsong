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

  it("keeps an aside marked through its own updates and drops it at idle and for the next session", () => {
    const preparing = reduceDictationStateEvent(null, {
      phase: "preparing",
      sessionId: 12,
      meetingAside: true,
    });
    // Preview-only updates do not repeat the flag; the session keeps it.
    const partial = reduceDictationStateEvent(preparing, {
      phase: "recording",
      sessionId: 12,
      partialText: "reply to Dana",
    });
    expect(partial.meetingAside).toBe(true);
    expect(reduceDictationStateEvent(partial, { phase: "idle", sessionId: 12 }).meetingAside ?? null).toBeNull();
    expect(
      reduceDictationStateEvent(partial, { phase: "preparing", sessionId: 13 }).meetingAside ?? null,
    ).toBeNull();
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
  it("clears a streaming preview's split halves when the session goes idle", () => {
    const recording = reduceDictationStateEvent(null, {
      phase: "recording",
      sessionId: 12,
      partialText: "ship the release",
      partialStableText: "ship the",
      partialVolatileText: " release",
      partialEngine: "streaming",
    });
    expect(recording.preview).toBe("ship the release");
    expect(recording.partialStableText).toBe("ship the");

    const idle = reduceDictationStateEvent(recording, {
      phase: "idle",
      sessionId: 12,
    });
    // A preview that outlived its session would otherwise sit in the popup
    // as if it described the next one.
    expect(idle.partialStableText ?? null).toBeNull();
    expect(idle.partialVolatileText ?? null).toBeNull();
    expect(idle.partialEngine ?? null).toBeNull();
    expect(idle.preview ?? null).toBeNull();
  });

  it("carries a streaming preview's halves across non-idle updates", () => {
    const recording = reduceDictationStateEvent(null, {
      phase: "recording",
      sessionId: 13,
      partialText: "ship the release",
      partialStableText: "ship the",
      partialVolatileText: " release",
      partialEngine: "streaming",
    });
    const transcribing = reduceDictationStateEvent(recording, {
      phase: "transcribing",
      sessionId: 13,
      message: "Transcribing…",
    });
    expect(transcribing.partialStableText).toBe("ship the");
    expect(transcribing.partialVolatileText).toBe(" release");
    expect(transcribing.partialEngine).toBe("streaming");
  });

  it("starts a different session without carrying the prior session's context", () => {
    const previous = reduceDictationStateEvent(null, {
      phase: "done",
      sessionId: 21,
      partialText: "words from the old capture",
      partialStableText: "words from",
      partialVolatileText: " the old capture",
      partialEngine: "streaming",
      outcome: "pasted",
      appTarget: "Slack",
      targetApp: "Slack",
      dictationProvider: "whisper",
      actualProvider: "whisper",
      dictationModelId: "old-model",
      resolvedRoute: "local",
      fallbackReason: "old fallback",
    });

    const next = reduceDictationStateEvent(previous, {
      phase: "recording",
      sessionId: 22,
    });

    expect(next.preview).toBeNull();
    expect(next.partialText).toBeUndefined();
    expect(next.partialStableText).toBeUndefined();
    expect(next.partialVolatileText).toBeUndefined();
    expect(next.partialEngine).toBeUndefined();
    expect(next.outcome).toBeUndefined();
    expect(next.appTarget).toBeUndefined();
    expect(next.targetApp).toBeUndefined();
    expect(next.dictationProvider).toBeUndefined();
    expect(next.actualProvider).toBeUndefined();
    expect(next.dictationModelId).toBeUndefined();
    expect(next.resolvedRoute).toBeUndefined();
    expect(next.fallbackReason).toBeUndefined();
  });

  it("uses fields supplied by the new session", () => {
    const previous = reduceDictationStateEvent(null, {
      phase: "done",
      sessionId: 30,
      partialText: "old words",
      outcome: "pasted",
      appTarget: "Slack",
      dictationProvider: "whisper",
      resolvedRoute: "local",
    });

    const next = reduceDictationStateEvent(previous, {
      phase: "recording",
      sessionId: 31,
      partialText: "new words",
      appTarget: "Notes",
      dictationProvider: "parakeet",
      resolvedRoute: "cloud",
    });

    expect(next.preview).toBe("new words");
    expect(next.partialText).toBe("new words");
    expect(next.appTarget).toBe("Notes");
    expect(next.dictationProvider).toBe("parakeet");
    expect(next.resolvedRoute).toBe("cloud");
    expect(next.outcome).toBeUndefined();
  });

  it("retains omitted context for updates in the same session", () => {
    const recording = reduceDictationStateEvent(null, {
      phase: "recording",
      sessionId: 40,
      partialText: "keep these words",
      appTarget: "Mail",
      dictationProvider: "whisper",
      resolvedRoute: "local",
    });

    const transcribing = reduceDictationStateEvent(recording, {
      phase: "transcribing",
      sessionId: 40,
      message: "Transcribing…",
    });

    expect(transcribing.preview).toBe("keep these words");
    expect(transcribing.appTarget).toBe("Mail");
    expect(transcribing.dictationProvider).toBe("whisper");
    expect(transcribing.resolvedRoute).toBe("local");
  });

  it("keeps legacy merge behavior when session IDs are missing or invalid", () => {
    const withoutIds = reduceDictationStateEvent(
      {
        phase: "recording",
        partialText: "legacy words",
        appTarget: "Notes",
        dictationProvider: "whisper",
      },
      { phase: "transcribing", message: "Transcribing…" },
    );
    expect(withoutIds.preview).toBe("legacy words");
    expect(withoutIds.appTarget).toBe("Notes");
    expect(withoutIds.dictationProvider).toBe("whisper");

    const invalidIds = reduceDictationStateEvent(
      {
        phase: "recording",
        sessionId: 0,
        partialText: "invalid-ID words",
        appTarget: "Safari",
      },
      { phase: "transcribing", sessionId: Number.NaN },
    );
    expect(invalidIds.preview).toBe("invalid-ID words");
    expect(invalidIds.appTarget).toBe("Safari");
  });

  it("clears context when the session counter restarts at a smaller positive ID", () => {
    const previous = reduceDictationStateEvent(null, {
      phase: "done",
      sessionId: 99,
      partialText: "before restart",
      outcome: "pasted",
      appTarget: "Mail",
      dictationProvider: "whisper",
    });

    const restarted = reduceDictationStateEvent(previous, {
      phase: "recording",
      sessionId: 1,
    });

    expect(restarted.preview).toBeNull();
    expect(restarted.partialText).toBeUndefined();
    expect(restarted.outcome).toBeUndefined();
    expect(restarted.appTarget).toBeUndefined();
    expect(restarted.dictationProvider).toBeUndefined();
  });
});
