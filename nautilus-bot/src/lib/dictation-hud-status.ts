/**
 * What the dictation pill says and shows, per phase and delivery outcome.
 *
 * The pill has room for one short label, so each state gets one word or two
 * that are true on their own: a refused or empty delivery never reads as
 * success, and an error names its cause instead of "Problem". The full
 * message stays available as the pill's tooltip and accessible name.
 */
import type { DictationProcessingStage } from "@/lib/dictation-progress";
import { SLOW_STAGE_DETAIL, SLOW_STAGE_LABEL } from "@/lib/dictation-slow-stage";

export type HudTone = "live" | "settling" | "success" | "quiet" | "alert";

export interface PillStatus {
  label: string;
  tone: HudTone;
  /** Show the finishing bar (processing, or filled on a successful done). */
  showBar: boolean;
  barComplete: boolean;
  /** Full sentence for the tooltip and screen readers. */
  detail: string | null;
}

const SUCCESS_OUTCOME_LABELS: Record<string, string> = {
  pasted: "Inserted",
  paste_dispatched: "Inserted",
  replaced: "Replaced",
  copied: "Copied",
  copied_replacement: "Copied",
  previewed: "Ready",
};

/** A short cause for the error pill, from the sidecar's user-facing message. */
export function shortErrorLabel(message: string | null | undefined): string {
  const text = (message ?? "").toLowerCase();
  if (/microphone|mic access|mic permission/.test(text)) return "Mic blocked";
  if (/accessibility/.test(text)) return "Needs access";
  if (/no speech|didn't hear|did not hear|silence/.test(text)) return "No speech";
  if (/api key|no key|credential/.test(text)) return "Needs API key";
  if (/download|not downloaded|model is missing|missing model/.test(text)) return "Model missing";
  if (/network|offline|timed out|timeout|connection/.test(text)) return "Offline";
  return "Didn't finish";
}

export function describePillStatus(input: {
  phase: string;
  stage: DictationProcessingStage;
  outcome: string | null;
  message: string | null;
  /** The current processing stage has run well past its expected time. */
  slow?: boolean;
}): PillStatus {
  const { phase, stage, outcome, message, slow } = input;
  switch (phase) {
    case "preparing":
      return { label: "Starting", tone: "quiet", showBar: false, barComplete: false, detail: null };
    case "primed":
      return { label: "Speak now", tone: "quiet", showBar: false, barComplete: false, detail: null };
    case "recording":
      return { label: "Listening", tone: "live", showBar: false, barComplete: false, detail: null };
    case "stopping":
    case "transcribing":
      return {
        label: slow
          ? SLOW_STAGE_LABEL
          : stage === "stopping"
            ? "Finishing"
            : stage === "polishing"
              ? "Polishing"
              : "Transcribing",
        tone: "settling",
        showBar: true,
        barComplete: false,
        detail: slow ? SLOW_STAGE_DETAIL : null,
      };
    case "delivering":
      return { label: "Inserting", tone: "settling", showBar: true, barComplete: false, detail: null };
    case "done": {
      const success = outcome === null ? "Done" : SUCCESS_OUTCOME_LABELS[outcome];
      if (success) {
        return { label: success, tone: "success", showBar: true, barComplete: true, detail: message };
      }
      if (outcome === "empty") {
        return { label: "No speech", tone: "quiet", showBar: false, barComplete: false, detail: message };
      }
      if (outcome === "undone") {
        return { label: "Undone", tone: "quiet", showBar: false, barComplete: false, detail: message };
      }
      // secure_field, error, or anything unrecognized: the words were not
      // delivered. History still has them.
      return {
        label: "Not inserted",
        tone: "alert",
        showBar: false,
        barComplete: false,
        detail: message ?? "Not inserted. The words are in your dictation history.",
      };
    }
    case "error":
      return {
        label: shortErrorLabel(message),
        tone: "alert",
        showBar: false,
        barComplete: false,
        detail: message,
      };
    default:
      return { label: "Ready", tone: "quiet", showBar: false, barComplete: false, detail: null };
  }
}
