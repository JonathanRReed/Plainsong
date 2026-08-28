/**
 * Why a meeting would not start, said once, with one thing to do about it.
 *
 * The old version substring-matched the backend's own sentence and bolted
 * advice onto the end of it, which produced doubled periods ("…available.
 * Please check…") and contradictory guidance — a system-audio failure whose
 * message happened to contain the word "audio" was answered with microphone
 * permission advice. The sidecar now sends a typed `code`, so the mapping is a
 * table: one code, one message, one action.
 *
 * The substring heuristic survives only as the fallback for a payload that
 * carries no code, because a build whose sidecar half has not landed must still
 * say something useful.
 */

export type MeetingStartErrorCode =
  | "mic_permission_denied"
  | "system_audio_unavailable"
  | "audio_device_not_found"
  | "sidecar_unavailable"
  | "disk_full"
  | "already_recording"
  | "consent_required"
  | "unknown";

export type MeetingStartActionId =
  | "open_microphone_settings"
  | "open_system_audio_settings"
  | "open_audio_input_settings"
  | "open_storage_settings"
  | "retry"
  | "none";

export interface MeetingStartAction {
  id: MeetingStartActionId;
  /** Null for `none`: some failures have no button worth offering. */
  label: string | null;
}

export interface MeetingStartFailure {
  code: MeetingStartErrorCode;
  /** One sentence. Never two glued together. */
  message: string;
  action: MeetingStartAction;
}

const CODES: readonly MeetingStartErrorCode[] = [
  "mic_permission_denied",
  "system_audio_unavailable",
  "audio_device_not_found",
  "sidecar_unavailable",
  "disk_full",
  "already_recording",
  "consent_required",
  "unknown",
];

const FAILURES: Record<
  MeetingStartErrorCode,
  { message: string; action: MeetingStartAction }
> = {
  mic_permission_denied: {
    message:
      "Plainsong does not have microphone access, so there is nothing to record.",
    action: {
      id: "open_microphone_settings",
      label: "Open Microphone settings",
    },
  },
  system_audio_unavailable: {
    message:
      "System audio is not available, so the other side of the call would not be recorded.",
    action: {
      id: "open_system_audio_settings",
      label: "Set up system audio",
    },
  },
  audio_device_not_found: {
    message: "The microphone Plainsong was set to use is no longer connected.",
    action: {
      id: "open_audio_input_settings",
      label: "Choose a microphone",
    },
  },
  sidecar_unavailable: {
    message:
      "The local transcription engine is not answering. Plainsong is restarting it.",
    action: { id: "retry", label: "Try again" },
  },
  disk_full: {
    message: "There is not enough free disk space to save this meeting's audio.",
    action: { id: "open_storage_settings", label: "Review storage" },
  },
  already_recording: {
    message: "A meeting is already being recorded.",
    action: { id: "none", label: null },
  },
  consent_required: {
    message: "This meeting needs the consent notice confirmed before it starts.",
    action: { id: "retry", label: "Start again" },
  },
  unknown: {
    message: "Plainsong could not start this meeting.",
    action: { id: "retry", label: "Try again" },
  },
};

/**
 * A message that already tells the reader what to do next. Passed through
 * whole rather than replaced, because the backend's own words about a specific
 * device or a specific automatic recovery are more useful than a generic line.
 */
const CARRIES_ITS_OWN_NEXT_STEP =
  /\b(system settings|try again|retry|reconnect|restarted|choose another|free up|turn on|reconnect)\b/i;

/** The failure carried by a meeting start that could not begin. */
export class MeetingStartError extends Error {
  readonly failure: MeetingStartFailure;

  constructor(failure: MeetingStartFailure) {
    super(failure.message);
    this.name = "MeetingStartError";
    this.failure = failure;
  }
}

function readCode(error: unknown): MeetingStartErrorCode | null {
  if (!error || (typeof error !== "object" && typeof error !== "string")) {
    return null;
  }
  if (typeof error === "string") {
    return null;
  }
  const record = error as Record<string, unknown>;
  const candidates = [
    record.code,
    (record.data as Record<string, unknown> | undefined)?.code,
    (record.cause as Record<string, unknown> | undefined)?.code,
    record.meetingStartCode,
  ];
  for (const candidate of candidates) {
    if (
      typeof candidate === "string" &&
      CODES.includes(candidate as MeetingStartErrorCode)
    ) {
      return candidate as MeetingStartErrorCode;
    }
  }
  return null;
}

function readMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") {
      return message;
    }
  }
  return String(error);
}

/**
 * The fallback for a payload with no code: the same substring reading as
 * before, but choosing a *code* rather than appending a sentence, so the result
 * is still one message and one action.
 */
function guessCode(message: string): MeetingStartErrorCode {
  if (/already (recording|in progress)/i.test(message)) {
    return "already_recording";
  }
  if (/consent/i.test(message)) {
    return "consent_required";
  }
  if (/disk|space/i.test(message)) {
    return "disk_full";
  }
  if (/sidecar|engine (is )?(not|un)available|exited/i.test(message)) {
    return "sidecar_unavailable";
  }
  if (/no (usable )?(microphone|input device)|device (not found|is gone)/i.test(message)) {
    return "audio_device_not_found";
  }
  if (/screen recording|system audio|loopback/i.test(message)) {
    return "system_audio_unavailable";
  }
  if (/microphone|permission/i.test(message)) {
    return "mic_permission_denied";
  }
  return "unknown";
}

export function describeMeetingStartFailure(
  error: unknown,
): MeetingStartFailure {
  if (error instanceof MeetingStartError) {
    return error.failure;
  }

  const rawMessage = readMessage(error).trim();
  const code = readCode(error) ?? guessCode(rawMessage);
  const mapped = FAILURES[code];

  return {
    code,
    message:
      rawMessage && CARRIES_ITS_OWN_NEXT_STEP.test(rawMessage)
        ? rawMessage
        : mapped.message,
    action: mapped.action,
  };
}

/** The one line to show. Kept for callers that only need the sentence. */
export function formatMeetingStartError(error: unknown): string {
  return describeMeetingStartFailure(error).message;
}
