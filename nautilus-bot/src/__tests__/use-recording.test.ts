import { describe, expect, it } from "vitest";
import { formatMeetingStartError } from "@/lib/meeting-start-error";

describe("formatMeetingStartError", () => {
  it("keeps automatic microphone recovery guidance focused on retrying", () => {
    const message =
      "Microphone setup stalled. Plainsong restarted audio capture automatically. Retry in a moment, then reconnect or choose another microphone if it happens again.";

    expect(formatMeetingStartError(new Error(message))).toBe(message);
  });

  it("adds permission guidance for ordinary microphone failures", () => {
    expect(formatMeetingStartError("No microphone input device available")).toBe(
      "No microphone input device available. Please check your microphone permissions in System Settings."
    );
  });
});
