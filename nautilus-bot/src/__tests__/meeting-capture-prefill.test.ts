import { describe, expect, it } from "vitest";
import {
  meetingCapturePrefillFromCalendarEvent,
  meetingCapturePrefillFromDetectedCall,
} from "@/lib/meeting-capture-prefill";

describe("meetingCapturePrefillFromCalendarEvent", () => {
  it("carries the title and the service, and binds no call", () => {
    expect(
      meetingCapturePrefillFromCalendarEvent({
        eventId: "event-1",
        title: "Design review",
        videoService: "zoom",
      }),
    ).toEqual({ title: "Design review", videoService: "zoom", detectedCallId: null });
  });

  it("keeps a null service null", () => {
    expect(
      meetingCapturePrefillFromCalendarEvent({
        eventId: "event-2",
        title: "Standup",
        videoService: null,
      }).videoService,
    ).toBeNull();
  });
});

describe("meetingCapturePrefillFromDetectedCall", () => {
  it("carries the call id so the sidecar binds this meeting to that call", () => {
    expect(
      meetingCapturePrefillFromDetectedCall({
        callId: 7,
        title: "Zoom call, 14:05",
        videoService: "zoom",
      }),
    ).toEqual({ title: "Zoom call, 14:05", videoService: "zoom", detectedCallId: 7 });
  });

  it("carries a call whose app has no service key with the call id intact", () => {
    expect(
      meetingCapturePrefillFromDetectedCall({
        callId: 3,
        title: "FaceTime call, 09:30",
        videoService: null,
      }),
    ).toEqual({ title: "FaceTime call, 09:30", videoService: null, detectedCallId: 3 });
  });
});
