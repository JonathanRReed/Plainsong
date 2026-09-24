import { describe, expect, it } from "vitest";
import {
  dictationHistoryAppName,
  dictationHistoryPreview,
  dictationHistoryStatusLabel,
  formatHistoryTime,
  groupDictationHistory,
} from "@/lib/dictation-history-groups";
import type { Recording } from "@/types";

function recording(id: string, createdAt: Date, extra: Partial<Recording> = {}): Recording {
  return {
    id,
    title: `Dictation ${id}`,
    projectId: "inbox",
    duration: 4,
    createdAt: createdAt.toISOString(),
    updatedAt: createdAt.toISOString(),
    sourceType: "dictation",
    audioPath: "",
    status: "completed",
    ...extra,
  };
}

describe("dictation history groups", () => {
  const now = new Date(2026, 8, 24, 15, 0);

  it("labels today, yesterday, then the date, keeping newest first", () => {
    const groups = groupDictationHistory(
      [
        recording("a", new Date(2026, 8, 24, 14, 0)),
        recording("b", new Date(2026, 8, 24, 9, 0)),
        recording("c", new Date(2026, 8, 23, 22, 0)),
        recording("d", new Date(2026, 8, 20, 8, 0)),
        recording("e", new Date(2025, 11, 31, 8, 0)),
      ],
      now,
    );
    expect(groups.map((group) => group.label)).toEqual([
      "Today",
      "Yesterday",
      "Sunday, September 20",
      "Wednesday, December 31, 2025",
    ]);
    expect(groups[0].recordings.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("shows hours and minutes only", () => {
    expect(formatHistoryTime(new Date(2026, 8, 24, 14, 37, 23).toISOString())).toBe(
      "2:37 PM",
    );
  });

  it("prefers the words over the title and hides the normal status", () => {
    const withText = recording("a", now, {
      transcript: {
        id: "t",
        recordingId: "a",
        segments: [],
        fullText: "  Running late, save me a seat. ",
        language: "en",
        confidence: 1,
        model: "test",
      },
    });
    expect(dictationHistoryPreview(withText)).toBe("Running late, save me a seat.");
    expect(dictationHistoryPreview(recording("b", now))).toBe("Dictation b");
    expect(dictationHistoryStatusLabel("completed")).toBeNull();
    expect(dictationHistoryStatusLabel("error")).toBe("Failed");
  });

  it("names the app only when the row carries one", () => {
    expect(dictationHistoryAppName(recording("a", now))).toBeNull();
    const withApp = recording("b", now, {
      metadata: {
        sampleRate: 16000,
        channels: 1,
        systemAudio: false,
        appTarget: "Slack",
      } as Recording["metadata"],
    });
    expect(dictationHistoryAppName(withApp)).toBe("Slack");
  });
});
