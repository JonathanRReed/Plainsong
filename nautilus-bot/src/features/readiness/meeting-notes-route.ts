import {
  describeAnalysisDestination,
  isDictationOnlyAnalysisProvider,
  isRemoteAnalysisProvider,
} from "@/components/models/ai-lanes";
import { CHATGPT_PLAN_PROVIDER } from "@/lib/backend/chatgpt-plan";

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
  /** Whether the exact selected local model is installed and usable. */
  localModelReady: boolean | null;
  /** Exact selected model, or the provider default resolved by the probe. */
  localModelId: string | null;
  /** Whether a stored API key exists for a cloud provider. `null` when unknown. */
  credentialPresent: boolean | null;
  nativeMemoryReady?: boolean;
  localExecutionReady?: boolean | null;
  localExecutionMessage?: string | null;
  accountRoute?: "ready" | "check_account" | "connect" | "choose_model";
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

function localExecutionAssessment(facts: MeetingNotesRouteFacts): MeetingNotesRouteAssessment {
  if (facts.localExecutionReady === false) {
    return { state: "unconfigured", reason: facts.localExecutionMessage ?? "The text model selected on this Mac can't write meeting notes." };
  }
  if (facts.localExecutionReady !== true) {
    return { state: "unknown", reason: facts.localExecutionMessage ?? "Plainsong could not confirm that the selected text model can write meeting notes." };
  }
  return READY;
}

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

  if (provider === CHATGPT_PLAN_PROVIDER) {
    if (!facts.remoteProcessingEnabled) {
      return {
        state: "unconfigured",
        reason: "cloud AI is turned off, so ChatGPT cannot write them.",
      };
    }
    switch (facts.accountRoute) {
      case "ready":
        return READY;
      case "connect":
        return {
          state: "unconfigured",
          reason: "connect a ChatGPT account with access to plan models.",
        };
      case "choose_model":
        return {
          state: "unconfigured",
          reason: "choose an available ChatGPT model in Models.",
        };
      default:
        return {
          state: "unknown",
          reason: "Check the saved ChatGPT account in Models.",
        };
    }
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

  if (isDictationOnlyAnalysisProvider(provider)) {
    return {
      state: "unconfigured",
      reason: `${describeAnalysisDestination(provider)} only cleans up dictation and cannot write meeting notes.`,
    };
  }

  if (provider === "apple_language_model") {
    if (facts.localModelReady === false) return { state: "unconfigured", reason: facts.localExecutionMessage ?? "Apple Intelligence is unavailable on this Mac." };
    if (facts.localModelReady !== true) return { state: "unknown", reason: "Check Apple Intelligence in Models." };
    return localExecutionAssessment(facts);
  }

  if (provider === "native_text") {
    if (facts.localRuntimeReady === false) return { state: "unconfigured", reason: "the built-in text model isn't available in this version of Plainsong." };
    if (facts.localRuntimeReady === null || facts.localModelReady === null) return { state: "unknown", reason: "Plainsong could not confirm the built-in text model." };
    if (!facts.localModelReady) return { state: "unconfigured", reason: "download the built-in text model in Models." };
    const execution = localExecutionAssessment(facts);
    if (execution.state !== "ready") return execution;
    if (facts.nativeMemoryReady === false) return { state: "unconfigured", reason: "there isn't enough free memory for the built-in text model right now. Close apps you aren't using or try again later." };
    if (facts.nativeMemoryReady === undefined) return { state: "unknown", reason: "Plainsong could not confirm there is enough free memory for the built-in text model." };
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
  if (facts.localModelReady === false) {
    return {
      state: "unconfigured",
      reason: `${facts.localModelId ?? "The selected Ollama model"} is not installed and ready for meeting notes.`,
    };
  }
  if (facts.localModelReady === null) {
    return {
      state: "unknown",
      reason: "Plainsong could not confirm the selected model for meeting notes.",
    };
  }

  return localExecutionAssessment(facts);
}
