/**
 * Which sidecar events become an OS notification, and what they say.
 *
 * Pure on purpose: the main process hands this the event, the payload and
 * what it knows about the windows, and gets back either nothing or one
 * notification to show. Every rule about when Plainsong is allowed to speak
 * up lives here, where a test can reach it, rather than in `main.ts` next to
 * the `Notification` constructor.
 *
 * The register is one plain sentence per notification, no exclamation marks:
 * these arrive while the reader is doing something else, and the honest
 * version of "your transcript is ready" is exactly that.
 */

export interface NotificationSettingsInput {
  notifications?: {
    meetingEvents?: boolean;
    dictationFailures?: boolean;
  };
}

export interface NotificationSettings {
  /** Meeting started, stopped, auto-stopped, transcript ready, notes done. */
  meetingEvents: boolean;
  /**
   * A dictation that was refused or failed, shown only while the dictation
   * mini window is hidden — when it is on screen it already says so.
   */
  dictationFailures: boolean;
}

/**
 * Both classes default to on, so a settings file written before they existed
 * behaves like a fresh install. Mirrors `NotificationsSettings` in
 * rust-sidecar/src/settings.rs.
 */
export function resolveNotificationSettings(
  settings: NotificationSettingsInput | null | undefined,
): NotificationSettings {
  const notifications = settings?.notifications;
  return {
    meetingEvents: notifications?.meetingEvents !== false,
    dictationFailures: notifications?.dictationFailures !== false,
  };
}

/** What a detected call carries into the consent dialog when clicked. */
export interface CallCaptureRequest {
  callId: number;
  app: string;
  appLabel: string;
  videoService: string | null;
  detectedAtMs: number;
}

export type NotificationFocus =
  | { view: "recordings"; recordingId: string | null; callCapture?: CallCaptureRequest }
  | { view: "dictation" };

export interface PlainsongNotification {
  /** Stable name for tests and logs. */
  kind:
    | "meeting_started"
    | "meeting_stopped"
    | "meeting_auto_stopped"
    | "transcript_ready"
    | "meeting_notes_ready"
    | "meeting_notes_failed"
    | "dictation_refused"
    | "dictation_failed"
    | "call_detected";
  title: string;
  body: string;
  /** Where a click on the notification takes the reader. */
  focus: NotificationFocus;
  /**
   * Two notifications with the same key are the same news; the second is
   * dropped. A dictation failure is reported by more than one sidecar event,
   * and must reach the reader once.
   */
  dedupeKey: string;
}

export interface NotificationContext {
  settings: NotificationSettings;
  /**
   * A person looking at the app does not need to be told what they just
   * clicked: "meeting started" and "meeting stopped" are only for the reader
   * who is elsewhere. Completions that happen in the background are shown
   * either way.
   */
  mainWindowFocused: boolean;
  /** Whether the dictation mini window is on screen right now. */
  dictationOverlayVisible: boolean;
  /**
   * The last meeting lifecycle phase and recording seen, so "started" fires
   * once per meeting rather than on every re-asserted `recording` event (the
   * sidecar re-emits that phase to carry warnings).
   */
  previousMeetingPhase: string | null;
  previousMeetingRecordingId: string | null;
  /**
   * The meeting the sidecar most recently stopped on its own. Its `processing`
   * transition must not also produce the generic "meeting stopped".
   */
  lastAutoStoppedRecordingId: string | null;
}

function record(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function stringField(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** One sentence at most: a stack trace is not a notification body. */
const BODY_MAX_LENGTH = 160;

function oneSentence(text: string | null, fallback: string): string {
  if (!text) return fallback;
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return fallback;
  return collapsed.length > BODY_MAX_LENGTH
    ? `${collapsed.slice(0, BODY_MAX_LENGTH - 1).trimEnd()}…`
    : collapsed;
}

function meetingFocus(recordingId: string | null): NotificationFocus {
  return { view: "recordings", recordingId };
}

/**
 * The notification, if any, that `eventName` should produce.
 */
export function notificationForSidecarEvent(
  eventName: string,
  rawPayload: unknown,
  context: NotificationContext,
): PlainsongNotification | null {
  const payload = record(rawPayload);

  switch (eventName) {
    case "meeting-recording-state-changed": {
      if (!context.settings.meetingEvents) return null;
      const phase = stringField(payload, "phase");
      const recordingId = stringField(payload, "recordingId");
      if (!phase || !recordingId) return null;

      const enteredCapture =
        phase === "recording" &&
        (context.previousMeetingPhase !== "recording" ||
          context.previousMeetingRecordingId !== recordingId);
      if (enteredCapture) {
        if (context.mainWindowFocused) return null;
        return {
          kind: "meeting_started",
          title: "Meeting recording started",
          body: "Plainsong is capturing this meeting now.",
          focus: meetingFocus(recordingId),
          dedupeKey: `meeting_started:${recordingId}`,
        };
      }

      const leftCapture =
        (phase === "processing" || phase === "transcribing") &&
        (context.previousMeetingPhase === "recording" ||
          context.previousMeetingPhase === "stopping") &&
        context.previousMeetingRecordingId === recordingId;
      if (leftCapture) {
        if (context.mainWindowFocused) return null;
        if (context.lastAutoStoppedRecordingId === recordingId) return null;
        return {
          kind: "meeting_stopped",
          title: "Meeting stopped",
          body: "Plainsong is saving the audio and preparing the transcript.",
          focus: meetingFocus(recordingId),
          dedupeKey: `meeting_stopped:${recordingId}`,
        };
      }
      return null;
    }

    case "meeting-auto-stopped": {
      if (!context.settings.meetingEvents) return null;
      const recordingId = stringField(payload, "recordingId");
      if (!recordingId) return null;
      const reason = stringField(payload, "reason");
      const app = stringField(payload, "app");
      const minutes =
        typeof payload.silenceMinutes === "number" && payload.silenceMinutes > 0
          ? Math.round(payload.silenceMinutes)
          : null;
      const title =
        reason === "silence" && minutes !== null
          ? `Meeting stopped: ${minutes} minutes of silence`
          : reason === "call_ended"
            ? `Meeting stopped: ${app ?? "the call app"} closed`
            : "Meeting stopped";
      return {
        kind: "meeting_auto_stopped",
        title,
        body: "Plainsong saved the audio and is preparing the transcript.",
        focus: meetingFocus(recordingId),
        dedupeKey: `meeting_auto_stopped:${recordingId}`,
      };
    }

    case "recording-status-changed": {
      if (!context.settings.meetingEvents) return null;
      const recordingId = stringField(payload, "recordingId");
      // `transcriptFirstAvailableAt` is only on the completion the pipeline
      // emits; the acknowledge-incomplete path also says "completed" and is a
      // click the reader just made.
      if (
        !recordingId ||
        stringField(payload, "status") !== "completed" ||
        !stringField(payload, "transcriptFirstAvailableAt")
      ) {
        return null;
      }
      const degraded = payload.degraded === true;
      return {
        kind: "transcript_ready",
        title: "Transcript ready",
        body: degraded
          ? "The transcript is ready but incomplete; open the meeting to see where."
          : "The meeting transcript is ready in Meetings.",
        focus: meetingFocus(recordingId),
        dedupeKey: `transcript_ready:${recordingId}`,
      };
    }

    case "meeting-analysis-status": {
      if (!context.settings.meetingEvents) return null;
      const recordingId = stringField(payload, "recordingId");
      const phase = stringField(payload, "phase");
      if (!recordingId) return null;
      if (phase === "completed") {
        return {
          kind: "meeting_notes_ready",
          title: "Meeting notes ready",
          body: "The summary and action items are ready in Meetings.",
          focus: meetingFocus(recordingId),
          dedupeKey: `meeting_notes_ready:${recordingId}`,
        };
      }
      if (phase === "failed") {
        return {
          kind: "meeting_notes_failed",
          title: "Meeting notes failed",
          // Analysis errors can include response bodies supplied by a remote
          // provider. Keep those diagnostics inside the app, where the user
          // chose to view them, rather than exposing them in an OS preview.
          body: "Plainsong could not write the summary; open the meeting to retry.",
          focus: meetingFocus(recordingId),
          dedupeKey: `meeting_notes_failed:${recordingId}`,
        };
      }
      return null;
    }

    case "dictation-text-ready": {
      if (!context.settings.dictationFailures || context.dictationOverlayVisible) {
        return null;
      }
      const outcome = stringField(payload, "outcome");
      const sessionId =
        typeof payload.sessionId === "number" ? String(payload.sessionId) : "unknown";
      if (outcome === "secure_field") {
        return {
          kind: "dictation_refused",
          title: "Dictation not inserted",
          body: "The focused field is a secure text field, so the words stayed in dictation history.",
          focus: { view: "dictation" },
          dedupeKey: `dictation:${sessionId}`,
        };
      }
      const pasteError = stringField(payload, "pasteError");
      const delivered = payload.pasted === true || payload.copied === true;
      if (outcome === "error" || (!delivered && pasteError)) {
        return {
          kind: "dictation_failed",
          title: "Dictation not delivered",
          body: oneSentence(
            pasteError,
            "Plainsong could not insert the text; it is in dictation history.",
          ),
          focus: { view: "dictation" },
          dedupeKey: `dictation:${sessionId}`,
        };
      }
      return null;
    }

    case "dictation-state-changed": {
      if (!context.settings.dictationFailures || context.dictationOverlayVisible) {
        return null;
      }
      if (stringField(payload, "phase") !== "error") return null;
      const sessionId =
        typeof payload.sessionId === "number" ? String(payload.sessionId) : "unknown";
      return {
        kind: "dictation_failed",
        title: "Dictation failed",
        body: oneSentence(
          stringField(payload, "message"),
          "Plainsong could not finish this dictation.",
        ),
        focus: { view: "dictation" },
        dedupeKey: `dictation:${sessionId}`,
      };
    }

    default:
      return null;
  }
}

export interface CallDetectedContext {
  /** A meeting already recording means there is nothing to offer. */
  activeMeetingRecordingId: string | null;
  /**
   * Whether the reader is looking at Plainsong. The Meetings header renders
   * its own cue for the same call, so a banner would be the second copy of
   * one offer.
   */
  mainWindowFocused: boolean;
}

/**
 * The offer to record a call detection just found, or nothing.
 *
 * Not gated on the notification settings: this is the feature the reader
 * turned on with `meetings.callDetectionEnabled`, and the sidecar already
 * emits nothing when that is off. A call the reader dismissed stays quiet
 * until it ends, and a reader who is already in the app gets the in-app cue
 * instead of both at once — the same rule "meeting started" follows.
 */
export function notificationForCallDetected(
  rawPayload: unknown,
  context: CallDetectedContext,
): PlainsongNotification | null {
  const payload = record(rawPayload);
  if (context.activeMeetingRecordingId) return null;
  if (context.mainWindowFocused) return null;
  if (payload.dismissed === true) return null;
  const callId = typeof payload.callId === "number" ? payload.callId : null;
  const appLabel = stringField(payload, "appLabel");
  const app = stringField(payload, "app");
  if (callId === null || !appLabel || !app) return null;
  const detectedAtMs =
    typeof payload.detectedAtMs === "number" ? payload.detectedAtMs : Date.now();
  return {
    kind: "call_detected",
    title: `${appLabel} call started`,
    body: "Record it with Plainsong?",
    focus: {
      view: "recordings",
      recordingId: null,
      callCapture: {
        callId,
        app,
        appLabel,
        videoService: stringField(payload, "videoService"),
        detectedAtMs,
      },
    },
    dedupeKey: `call_detected:${callId}`,
  };
}

/**
 * The lifecycle bookkeeping the context needs between events, kept pure so
 * the order of "update then decide" is pinned by a test rather than by the
 * position of two lines in main.ts.
 */
export function nextMeetingNotificationMemory(
  eventName: string,
  rawPayload: unknown,
  memory: Pick<
    NotificationContext,
    "previousMeetingPhase" | "previousMeetingRecordingId" | "lastAutoStoppedRecordingId"
  >,
): Pick<
  NotificationContext,
  "previousMeetingPhase" | "previousMeetingRecordingId" | "lastAutoStoppedRecordingId"
> {
  const payload = record(rawPayload);
  if (eventName === "meeting-auto-stopped") {
    return {
      ...memory,
      lastAutoStoppedRecordingId: stringField(payload, "recordingId") ?? memory.lastAutoStoppedRecordingId,
    };
  }
  if (eventName === "meeting-recording-state-changed") {
    const phase = stringField(payload, "phase");
    if (!phase) return memory;
    return {
      ...memory,
      previousMeetingPhase: phase,
      previousMeetingRecordingId:
        stringField(payload, "recordingId") ?? memory.previousMeetingRecordingId,
    };
  }
  return memory;
}
