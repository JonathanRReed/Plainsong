import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindNotificationActions } from "../../electron/notification-actions";
import { notificationForCallDetected, notificationForSidecarEvent } from "../../electron/notification-policy";
import { consumePendingCallCaptureRequest, publishCallCaptureRequest, subscribeCallCaptureRequests } from "@/lib/call-capture-request";

const call = { callId: 3, app: "zoom", appLabel: "Zoom", videoService: "zoom", detectedAtMs: 123 };

function fixture() {
  const note = new EventEmitter();
  const notification = notificationForCallDetected(call, {
    activeMeetingRecordingId: null, mainWindowFocused: false,
  });
  if (!notification) throw new Error("Expected the detected call offer");
  const handlers = { openView: vi.fn(), recordMeeting: vi.fn(), release: vi.fn() };
  bindNotificationActions(note, notification, handlers);
  return { note, handlers };
}

afterEach(() => { consumePendingCallCaptureRequest(); });

describe("notification actions", () => {
  it("opens Recordings on a body click without requesting recording", () => {
    const { note, handlers } = fixture();
    note.emit("click");
    expect(handlers.openView).toHaveBeenCalledWith({ view: "recordings", recordingId: null, callCapture: call });
    expect(handlers.recordMeeting).not.toHaveBeenCalled();
    expect(handlers.release).toHaveBeenCalledOnce();
  });

  it("routes Record to the meeting consent path with the detected call", () => {
    const { note, handlers } = fixture();
    note.emit("action", { actionIndex: 0 });
    expect(handlers.recordMeeting).toHaveBeenCalledExactlyOnceWith(call);
    expect(handlers.openView).not.toHaveBeenCalled();
    expect(handlers.release).toHaveBeenCalledOnce();
  });

  it("keeps a Record request until the meeting view is ready, then consumes it once", () => {
    const { note, handlers } = fixture();
    handlers.recordMeeting.mockImplementation(publishCallCaptureRequest);
    note.emit("action", { actionIndex: 0 });
    const consent = vi.fn();
    const unsubscribe = subscribeCallCaptureRequests(consent);
    expect(consent).toHaveBeenCalledExactlyOnceWith(call);
    unsubscribe();
    const second = vi.fn();
    subscribeCallCaptureRequests(second)();
    expect(second).not.toHaveBeenCalled();
  });

  it.each([-1, 1, 99])("ignores an unknown action index %s", index => {
    const { note, handlers } = fixture();
    note.emit("action", { actionIndex: index });
    expect(handlers.recordMeeting).not.toHaveBeenCalled();
    expect(handlers.openView).not.toHaveBeenCalled();
  });

  it("does not record for actions on ordinary meeting notifications", () => {
    const notification = notificationForSidecarEvent("meeting-recording-state-changed", {
      phase: "recording", recordingId: "r1",
    }, {
      settings: { meetingEvents: true, dictationFailures: true }, mainWindowFocused: false,
      dictationOverlayVisible: false, previousMeetingPhase: null, previousMeetingRecordingId: null,
      lastAutoStoppedRecordingId: null,
    });
    if (!notification) throw new Error("Expected a meeting notification");
    const note = new EventEmitter();
    const handlers = { openView: vi.fn(), recordMeeting: vi.fn(), release: vi.fn() };
    bindNotificationActions(note, notification, handlers);
    note.emit("action", { actionIndex: 0 });
    expect(handlers.recordMeeting).not.toHaveBeenCalled();
    note.emit("click");
    expect(handlers.openView).toHaveBeenCalledExactlyOnceWith({ view: "recordings", recordingId: "r1" });
  });
});
