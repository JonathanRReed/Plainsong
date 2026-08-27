import {
  describeAnalysisDestination,
  isRemoteAnalysisProvider,
} from "@/components/models/ai-lanes";

/**
 * Whether the meetings AI lane can actually write a summary, action items, or a
 * title right now.
 *
 * A default install points the lane at Ollama, which is not installed on a Mac
 * that has never been set up for it. Nothing checked that before the first
 * meeting finished, so the summary, action items and auto-title all failed with
 * no user-visible signal and Meetings still reported itself ready.
 */
export type MeetingNotesRouteState =
  | "ready"
  | "unconfigured"
  | "opted_out"
  | "unknown";

export interface MeetingNotesRouteFacts {
  /** The reader chose transcripts without AI notes. */
  optedOut: boolean;
  /** `privacy.meetingsAi.provider`, or null when settings have not loaded. */
  provider: string | null;
  /** `privacy.remoteProcessingEnabled`. */
  remoteProcessingEnabled: boolean;
  /**
   * Whether the local analysis runtime answered. `null` means the probe did not
   * return — never that it is ready.
   */
  localRuntimeReady: boolean | null;
  /** Whether a stored API key exists for a cloud provider. `null` when unknown. */
  credentialPresent: boolean | null;
}

export interface MeetingNotesRouteAssessment {
  state: MeetingNotesRouteState;
  /**
   * What is missing. For `unconfigured` this is a fragment written to follow
   * "Notes unavailable — "; for the other states it is a whole sentence.
   */
  reason: string | null;
}

const READY: MeetingNotesRouteAssessment = { state: "ready", reason: null };

/**
 * Resolve the lane from facts alone. Kept pure so both the readiness snapshot
 * and the first-run wizard can ask the same question and get the same answer.
 */
export function resolveMeetingNotesRoute(
  facts: MeetingNotesRouteFacts,
): MeetingNotesRouteAssessment {
  if (facts.optedOut) {
    return {
      state: "opted_out",
      reason: "Meeting notes are off. Plainsong keeps transcripts only.",
    };
  }

  const provider = facts.provider?.trim() ?? "";
  if (!provider) {
    return {
      state: "unknown",
      reason: "Plainsong could not confirm the AI route for meeting notes.",
    };
  }

  if (isRemoteAnalysisProvider(provider)) {
    if (!facts.remoteProcessingEnabled) {
      return {
        state: "unconfigured",
        reason: `cloud AI is turned off, so ${describeAnalysisDestination(
          provider,
        )} cannot write them.`,
      };
    }
    if (facts.credentialPresent === false) {
      return {
        state: "unconfigured",
        reason: `no API key is stored for ${describeAnalysisDestination(
          provider,
        )}.`,
      };
    }
    if (facts.credentialPresent === null) {
      return {
        state: "unknown",
        reason: "Plainsong could not confirm the AI route for meeting notes.",
      };
    }
    return READY;
  }

  if (facts.localRuntimeReady === false) {
    return {
      state: "unconfigured",
      reason: `${describeAnalysisDestination(provider)} is not running.`,
    };
  }
  if (facts.localRuntimeReady === null) {
    return {
      state: "unknown",
      reason: "Plainsong could not confirm the AI route for meeting notes.",
    };
  }

  return READY;
}
