import { describe, expect, it } from "vitest";
import {
  nextMeetingNotificationMemory,
  notificationForCallDetected,
  notificationForSidecarEvent,
  resolveNotificationSettings,
  type NotificationContext,
} from "../../electron/notification-policy";

function context(overrides: Partial<NotificationContext> = {}): NotificationContext {
  return {
    settings: { meetingEvents: true, dictationFailures: true },
    mainWindowFocused: false,
    dictationOverlayVisible: false,
    previousMeetingPhase: null,
    previousMeetingRecordingId: null,
    lastAutoStoppedRecordingId: null,
    ...overrides,
  };
}

describe("resolveNotificationSettings", () => {
  it("defaults both classes to on and honours an explicit off", () => {
    expect(resolveNotificationSettings(null)).toEqual({
      meetingEvents: true,
      dictationFailures: true,
    });
    expect(resolveNotificationSettings({})).toEqual({
      meetingEvents: true,
      dictationFailures: true,
    });
    expect(
      resolveNotificationSettings({
        notifications: { meetingEvents: false },
      }),
    ).toEqual({ meetingEvents: false, dictationFailures: true });
    expect(
      resolveNotificationSettings({
        notifications: { dictationFailures: false },
      }),
    ).toEqual({ meetingEvents: true, dictationFailures: false });
  });
});

describe("meeting lifecycle notifications", () => {
  const recording = { phase: "recording", recordingId: "rec-1" };

  it("announces a meeting start once, and not while the reader is looking", () => {
    const started = notificationForSidecarEvent(
      "meeting-recording-state-changed",
      recording,
      context(),
    );
    expect(started?.kind).toBe("meeting_started");
    expect(started?.title).toBe("Meeting recording started");
    expect(started?.focus).toEqual({ view: "recordings", recordingId: "rec-1" });
    expect(started?.title).not.toContain("!");

    // The sidecar re-asserts `recording` to carry a warning: not a new start.
    expect(
      notificationForSidecarEvent(
        "meeting-recording-state-changed",
        { ...recording, message: "Disk is nearly full" },
        context({ previousMeetingPhase: "recording", previousMeetingRecordingId: "rec-1" }),
      ),
    ).toBeNull();

    // A different meeting is a new start.
    expect(
      notificationForSidecarEvent(
        "meeting-recording-state-changed",
        { phase: "recording", recordingId: "rec-2" },
        context({ previousMeetingPhase: "recording", previousMeetingRecordingId: "rec-1" }),
      )?.kind,
    ).toBe("meeting_started");

    expect(
      notificationForSidecarEvent(
        "meeting-recording-state-changed",
        recording,
        context({ mainWindowFocused: true }),
      ),
    ).toBeNull();
  });

  it("announces a stop on the recording→processing edge, except after an auto-stop", () => {
    const processing = { phase: "processing", recordingId: "rec-1" };
    const stopped = notificationForSidecarEvent(
      "meeting-recording-state-changed",
      processing,
      context({ previousMeetingPhase: "recording", previousMeetingRecordingId: "rec-1" }),
    );
    expect(stopped?.kind).toBe("meeting_stopped");

    expect(
      notificationForSidecarEvent(
        "meeting-recording-state-changed",
        processing,
        context({ previousMeetingPhase: "stopping", previousMeetingRecordingId: "rec-1" }),
      )?.kind,
    ).toBe("meeting_stopped");

    // Processing again (retranscribe, a later status) is not a stop.
    expect(
      notificationForSidecarEvent(
        "meeting-recording-state-changed",
        processing,
        context({ previousMeetingPhase: "processing", previousMeetingRecordingId: "rec-1" }),
      ),
    ).toBeNull();

    expect(
      notificationForSidecarEvent(
        "meeting-recording-state-changed",
        processing,
        context({
          previousMeetingPhase: "recording",
          previousMeetingRecordingId: "rec-1",
          lastAutoStoppedRecordingId: "rec-1",
        }),
      ),
    ).toBeNull();

    expect(
      notificationForSidecarEvent(
        "meeting-recording-state-changed",
        processing,
        context({
          previousMeetingPhase: "recording",
          previousMeetingRecordingId: "rec-1",
          mainWindowFocused: true,
        }),
      ),
    ).toBeNull();
  });

  it("names the reason for an automatic stop, even while focused", () => {
    const closed = notificationForSidecarEvent(
      "meeting-auto-stopped",
      { recordingId: "rec-1", reason: "call_ended", app: "Zoom" },
      context({ mainWindowFocused: true }),
    );
    expect(closed?.kind).toBe("meeting_auto_stopped");
    expect(closed?.title).toBe("Meeting stopped: Zoom closed");

    const silence = notificationForSidecarEvent(
      "meeting-auto-stopped",
      { recordingId: "rec-1", reason: "silence", silenceMinutes: 15 },
      context(),
    );
    expect(silence?.title).toBe("Meeting stopped: 15 minutes of silence");
    expect(silence?.body).toBe("Plainsong saved the audio and is preparing the transcript.");
  });

  it("stays silent when meeting notifications are off", () => {
    const off = context({ settings: { meetingEvents: false, dictationFailures: true } });
    expect(
      notificationForSidecarEvent("meeting-recording-state-changed", recording, off),
    ).toBeNull();
    expect(
      notificationForSidecarEvent(
        "meeting-auto-stopped",
        { recordingId: "rec-1", reason: "silence", silenceMinutes: 15 },
        off,
      ),
    ).toBeNull();
    expect(
      notificationForSidecarEvent(
        "recording-status-changed",
        {
          recordingId: "rec-1",
          status: "completed",
          transcriptFirstAvailableAt: "2026-09-02T10:00:00Z",
        },
        off,
      ),
    ).toBeNull();
    expect(
      notificationForSidecarEvent(
        "meeting-analysis-status",
        { recordingId: "rec-1", phase: "completed" },
        off,
      ),
    ).toBeNull();
  });
});

describe("transcript and notes notifications", () => {
  it("reports a transcript only on the pipeline's own completion", () => {
    const ready = notificationForSidecarEvent(
      "recording-status-changed",
      {
        recordingId: "rec-1",
        status: "completed",
        transcriptFirstAvailableAt: "2026-09-02T10:00:00Z",
      },
      context({ mainWindowFocused: true }),
    );
    expect(ready?.kind).toBe("transcript_ready");
    expect(ready?.body).toBe("The meeting transcript is ready in Meetings.");
    expect(ready?.focus).toEqual({ view: "recordings", recordingId: "rec-1" });

    const degraded = notificationForSidecarEvent(
      "recording-status-changed",
      {
        recordingId: "rec-1",
        status: "completed",
        degraded: true,
        transcriptFirstAvailableAt: "2026-09-02T10:00:00Z",
      },
      context(),
    );
    expect(degraded?.body).toContain("incomplete");

    // The acknowledge-incomplete path also says "completed", from a click.
    expect(
      notificationForSidecarEvent(
        "recording-status-changed",
        { recordingId: "rec-1", status: "completed", degraded: true },
        context(),
      ),
    ).toBeNull();
    expect(
      notificationForSidecarEvent(
        "recording-status-changed",
        { recordingId: "rec-1", status: "processing", progress: 0.4 },
        context(),
      ),
    ).toBeNull();
  });

  it("reports notes ready or failed without exposing failure diagnostics", () => {
    expect(
      notificationForSidecarEvent(
        "meeting-analysis-status",
        { recordingId: "rec-1", phase: "completed" },
        context(),
      )?.title,
    ).toBe("Meeting notes ready");
    expect(
      notificationForSidecarEvent(
        "meeting-analysis-status",
        { recordingId: "rec-1", phase: "running" },
        context(),
      ),
    ).toBeNull();

    const failed = notificationForSidecarEvent(
      "meeting-analysis-status",
      { recordingId: "rec-1", phase: "failed", error: "summary:   Ollama is not\n running" },
      context(),
    );
    expect(failed?.title).toBe("Meeting notes failed");
    expect(failed?.body).toBe(
      "Plainsong could not write the summary; open the meeting to retry.",
    );
    expect(failed?.body).not.toContain("Ollama");

    const noReason = notificationForSidecarEvent(
      "meeting-analysis-status",
      { recordingId: "rec-1", phase: "failed" },
      context(),
    );
    expect(noReason?.body).toBe("Plainsong could not write the summary; open the meeting to retry.");
  });
});

describe("dictation failure notifications", () => {
  it("speaks only while the mini window is hidden and the setting is on", () => {
    const refused = { sessionId: 7, outcome: "secure_field", pasted: false, copied: false };
    const shown = notificationForSidecarEvent("dictation-text-ready", refused, context());
    expect(shown?.kind).toBe("dictation_refused");
    expect(shown?.title).toBe("Dictation not inserted");
    expect(shown?.focus).toEqual({ view: "dictation" });
    expect(shown?.dedupeKey).toBe("dictation:7");

    expect(
      notificationForSidecarEvent(
        "dictation-text-ready",
        refused,
        context({ dictationOverlayVisible: true }),
      ),
    ).toBeNull();
    expect(
      notificationForSidecarEvent(
        "dictation-text-ready",
        refused,
        context({ settings: { meetingEvents: true, dictationFailures: false } }),
      ),
    ).toBeNull();
  });

  it("treats a delivered dictation as no news and a failed one as one sentence", () => {
    expect(
      notificationForSidecarEvent(
        "dictation-text-ready",
        { sessionId: 8, outcome: "ready", pasted: true, copied: false },
        context(),
      ),
    ).toBeNull();
    // Copied as a fallback counts as delivered: the popup and clipboard say so.
    expect(
      notificationForSidecarEvent(
        "dictation-text-ready",
        { sessionId: 8, outcome: "ready", pasted: false, copied: true, pasteError: "x" },
        context(),
      ),
    ).toBeNull();

    const failed = notificationForSidecarEvent(
      "dictation-text-ready",
      {
        sessionId: 9,
        outcome: "ready",
        pasted: false,
        copied: false,
        pasteError: "The target app refused the paste",
      },
      context(),
    );
    expect(failed?.kind).toBe("dictation_failed");
    expect(failed?.body).toBe("The target app refused the paste");

    const errored = notificationForSidecarEvent(
      "dictation-state-changed",
      { phase: "error", sessionId: 9, message: "Transcription timed out" },
      context(),
    );
    expect(errored?.kind).toBe("dictation_failed");
    expect(errored?.body).toBe("Transcription timed out");
    // Same session, same key: main drops the second one.
    expect(errored?.dedupeKey).toBe(failed?.dedupeKey);

    expect(
      notificationForSidecarEvent(
        "dictation-state-changed",
        { phase: "recording", sessionId: 10 },
        context(),
      ),
    ).toBeNull();
  });
});

describe("call detected offer", () => {
  const detected = {
    callId: 3,
    app: "zoom",
    appLabel: "Zoom",
    videoService: "zoom",
    detectedAtMs: 1_700_000_000_000,
    dismissed: false,
  };

  const away = { activeMeetingRecordingId: null, mainWindowFocused: false };

  it("offers to record a call, carrying what the consent dialog needs", () => {
    const offer = notificationForCallDetected(detected, away);
    expect(offer?.kind).toBe("call_detected");
    expect(offer?.title).toBe("Zoom call started");
    expect(offer?.body).toBe("Record it with Plainsong?");
    expect(offer?.focus).toEqual({
      view: "recordings",
      recordingId: null,
      callCapture: {
        callId: 3,
        app: "zoom",
        appLabel: "Zoom",
        videoService: "zoom",
        detectedAtMs: 1_700_000_000_000,
      },
    });
  });

  it("stays quiet while a meeting records, after a dismissal, or on a malformed payload", () => {
    expect(
      notificationForCallDetected(detected, { ...away, activeMeetingRecordingId: "rec-1" }),
    ).toBeNull();
    expect(notificationForCallDetected({ ...detected, dismissed: true }, away)).toBeNull();
    expect(notificationForCallDetected({ appLabel: "Zoom" }, away)).toBeNull();
    expect(notificationForCallDetected(null, away)).toBeNull();
  });

  it("leaves the offer to the in-app cue while the reader is in Plainsong", () => {
    // The Meetings header renders the same offer. Two copies of one offer,
    // one of them an OS banner over the window that already shows it, is the
    // thing every other notification here is careful not to do.
    expect(
      notificationForCallDetected(detected, { ...away, mainWindowFocused: true }),
    ).toBeNull();
    expect(notificationForCallDetected(detected, away)?.kind).toBe("call_detected");
  });
});

describe("nextMeetingNotificationMemory", () => {
  it("tracks the lifecycle so the decision can be made before the update", () => {
    const empty = {
      previousMeetingPhase: null,
      previousMeetingRecordingId: null,
      lastAutoStoppedRecordingId: null,
    };
    const afterStart = nextMeetingNotificationMemory(
      "meeting-recording-state-changed",
      { phase: "recording", recordingId: "rec-1" },
      empty,
    );
    expect(afterStart).toEqual({
      previousMeetingPhase: "recording",
      previousMeetingRecordingId: "rec-1",
      lastAutoStoppedRecordingId: null,
    });
    // A warning event without a recordingId keeps the id it had.
    expect(
      nextMeetingNotificationMemory(
        "meeting-recording-state-changed",
        { phase: "recording" },
        afterStart,
      ).previousMeetingRecordingId,
    ).toBe("rec-1");
    expect(
      nextMeetingNotificationMemory(
        "meeting-auto-stopped",
        { recordingId: "rec-1", reason: "silence" },
        afterStart,
      ).lastAutoStoppedRecordingId,
    ).toBe("rec-1");
    expect(nextMeetingNotificationMemory("dictation-text-ready", {}, afterStart)).toBe(
      afterStart,
    );
  });
});
