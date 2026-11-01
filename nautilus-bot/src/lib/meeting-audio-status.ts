import type { SystemAudioCapability } from "@/lib/backend/recordings";

/**
 * What Me + Them records, in one sentence. Shown wherever someone chooses it
 * (the meeting start dialog, Settings → Meetings → Mac audio, Setup), because
 * "will it hear the other people if I wear headphones?" is the question a
 * reader brings to this choice, and "what else will it hear?" is the one they
 * should be told without asking: the built-in route records the whole Mac's
 * output, not only the meeting app (see PRIVACY.md).
 */
export const MEETING_AUDIO_EXPLAINER =
  "Plainsong records your microphone and every sound this Mac plays during the meeting, music, videos and notifications included, and it works with headphones.";

export type MeetingAudioState =
  | "checking"
  | "ready"
  | "needs_permission"
  | "denied"
  | "needs_check"
  | "unavailable";

/**
 * The one thing the reader can do next.
 *
 * - `allow`: run Plainsong's silent check, which is what makes macOS show its
 *   one-time permission prompt. Offered only when the reader has chosen to set
 *   up meeting audio, never on launch.
 * - `check`: run the same check again after something changed.
 * - `open_settings`: macOS has refused; only System Settings can change that.
 */
export type MeetingAudioAction = "allow" | "check" | "open_settings";

export interface MeetingAudioStatus {
  state: MeetingAudioState;
  tone: "ready" | "not-yet" | "problem";
  /** A short label for a status row. */
  label: string;
  sentence: string;
  action: MeetingAudioAction | null;
  actionLabel: string | null;
}

const MEETING_AUDIO_DENIED_SENTENCE =
  "macOS is blocking Plainsong from recording meeting audio, so only your microphone would be recorded. Turn on Plainsong in System Settings → Privacy & Security → Screen & System Audio Recording, then check again.";

const ACTION_LABELS: Record<MeetingAudioAction, string> = {
  allow: "Allow meeting audio",
  check: "Check meeting audio",
  open_settings: "Open System Settings",
};

function status(
  state: MeetingAudioState,
  tone: MeetingAudioStatus["tone"],
  label: string,
  sentence: string,
  action: MeetingAudioAction | null,
): MeetingAudioStatus {
  return {
    state,
    tone,
    label,
    sentence,
    action,
    actionLabel: action ? ACTION_LABELS[action] : null,
  };
}

export function isMeetingAudioReady(capability: SystemAudioCapability | null): boolean {
  return Boolean(
    capability?.ready &&
      capability.readiness === "ready" &&
      capability.backend !== "none",
  );
}

/**
 * Plain-language state of the "meeting audio" half of Me + Them.
 *
 * The sidecar's capability distinguishes the built-in route (macOS shares the
 * sound every app plays, whatever the output device) from an audio routing app
 * such as BlackHole. Normal UI never names either mechanism; the routing app's
 * own name appears only when the reader set one up themselves.
 */
export function describeMeetingAudio(
  capability: SystemAudioCapability | null,
  checkFailed = false,
): MeetingAudioStatus {
  if (checkFailed) {
    return { ...status("needs_check", "problem", "Check failed", "Couldn't check meeting audio. Try again.", "check"), actionLabel: "Retry" };
  }
  if (capability === null) {
    return status(
      "checking",
      "not-yet",
      "Checking",
      "Checking whether Plainsong can hear the meeting audio on this Mac…",
      null,
    );
  }

  const builtIn = capability.backend === "core_audio_process_tap";
  const device = capability.routeDevice?.trim() || null;

  if (isMeetingAudioReady(capability)) {
    return status(
      "ready",
      "ready",
      "Ready",
      builtIn
        ? "Ready. Records all audio playing on this Mac, including other apps and notification sounds, with or without headphones."
        : `Ready. Plainsong hears the meeting through ${device ?? "your audio routing app"}.`,
      null,
    );
  }

  if (capability.backend === "none") {
    return status(
      "unavailable",
      "problem",
      "Not available",
      capability.actionableReason ??
        "Plainsong can't record meeting audio on this Mac, so meetings record your microphone only.",
      null,
    );
  }

  if (
    builtIn &&
    (capability.permission === "denied" || capability.reason === "permission_denied")
  ) {
    return status("denied", "problem", "Blocked by macOS", MEETING_AUDIO_DENIED_SENTENCE, "open_settings");
  }

  if (builtIn && capability.reason === null) {
    return status(
      "needs_permission",
      "not-yet",
      "Needs your OK",
      "Plainsong needs your OK to record the meeting audio playing on this Mac. macOS asks once; the check is silent.",
      "allow",
    );
  }

  if (builtIn) {
    return status(
      "needs_check",
      "problem",
      "Not working yet",
      capability.actionableReason ??
        "Plainsong couldn't hear the meeting audio on this Mac. Check again in a moment.",
      "check",
    );
  }

  return status(
    "needs_check",
    capability.reason ? "problem" : "not-yet",
    "Not checked",
    capability.reason && capability.actionableReason
      ? capability.actionableReason
      : `Play some audio through ${device ?? "your audio routing app"}, then check that Plainsong hears it.`,
    "check",
  );
}
