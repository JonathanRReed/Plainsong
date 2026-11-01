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
import { MEETING_ASIDE_LABEL, MEETING_ASIDE_NOTICE } from "@/lib/meeting-aside";
import { dictationDeliveryFeedback } from "../../electron/dictation-feedback";

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

export const PREPARING_MODEL_LABEL = "Preparing model";
/** Mirrors `SPEECH_MODEL_PREPARING_MESSAGE` in `dictation_session.rs`. */
const PREPARING_MODEL_DETAIL = "Preparing the speech model for this Mac. This happens once.";

/** A short cause for the error pill, from the sidecar's user-facing message. */
export function shortErrorLabel(message: string | null | undefined): string {
  const text = (message ?? "").toLowerCase();
  if (/memory/.test(text)) return "Low memory";
  if (/microphone|mic access|mic permission/.test(text)) return "Mic blocked";
  if (/accessibility/.test(text)) return "Needs access";
  if (/no speech|didn't hear|did not hear|silence/.test(text)) return "No speech";
  if (/meeting is recording|meeting recording is active|while a meeting records/.test(text)) return "Meeting recording";
  // `meeting_asides.rs`: the meeting is saving, or changed under the start.
  if (/meeting is still saving/.test(text)) return "Meeting saving";
  if (/meeting started or stopped/.test(text)) return "Meeting changed";
  if (/api key|no key|credential/.test(text)) return "Needs API key";
  // The speech model is fetching a file it needs (`transcribe_cpp.rs`
  // `NEEDED_DOWNLOAD_*`): not missing, and not something to download by hand.
  if (/couldn't download|could not download/.test(text)) return "Download failed";
  if (/is downloading/.test(text)) return "Downloading";
  if (/download|not downloaded|model is missing|missing model/.test(text)) return "Model missing";
  if (/network|offline|connection/.test(text)) return "Offline";
  if (/timed out|timeout|took too long/.test(text)) return "Took too long";
  return "Didn't finish";
}

export function describePillStatus(input: {
  phase: string;
  stage: DictationProcessingStage | "delivering";
  outcome: string | null;
  message: string | null;
  /** The current processing stage has run well past its expected time. */
  slow?: boolean;
  /** The speech model is being prepared for this Mac before transcribing. */
  preparingModel?: boolean;
  /** The dictation takes its audio from a meeting that is recording. */
  meetingAside?: boolean;
}): PillStatus {
  const { phase, stage, outcome, message, slow, preparingModel, meetingAside } = input;
  switch (phase) {
    case "preparing":
      return { label: "Starting", tone: "quiet", showBar: false, barComplete: false, detail: null };
    case "primed":
      return { label: "Starting mic", tone: "quiet", showBar: false, barComplete: false, detail: null };
    case "recording":
      // The call hears an aside too, so the reminder rides along as the
      // pill's tooltip and accessible name every time, not only the first.
      return meetingAside
        ? { label: MEETING_ASIDE_LABEL, tone: "live", showBar: false, barComplete: false, detail: MEETING_ASIDE_NOTICE }
        : { label: "Listening", tone: "live", showBar: false, barComplete: false, detail: null };
    case "stopping":
    case "transcribing": {
      // A first-use compile runs long by nature; "Still working" would hide
      // the reason the user is waiting.
      const preparing = preparingModel === true && phase === "transcribing" && stage === "transcribing";
      return {
        label: preparing
          ? PREPARING_MODEL_LABEL
          : slow
            ? SLOW_STAGE_LABEL
            : stage === "stopping"
              ? "Finishing"
              : stage === "polishing"
                ? "Polishing"
                : "Transcribing",
        tone: "settling",
        showBar: true,
        barComplete: false,
        detail: preparing ? PREPARING_MODEL_DETAIL : slow ? SLOW_STAGE_DETAIL : null,
      };
    }
    case "delivering":
      return { label: slow ? SLOW_STAGE_LABEL : "Inserting", tone: "settling", showBar: true, barComplete: false, detail: slow ? SLOW_STAGE_DETAIL : null };
    case "idle":
    case "done": {
      if (phase === "idle" && outcome !== "aborted") {
        return { label: "Ready", tone: "quiet", showBar: false, barComplete: false, detail: null };
      }
      const feedback = dictationDeliveryFeedback(outcome);
      const complete = feedback.tone === "success";
      return {
        label: feedback.label,
        tone: feedback.tone,
        showBar: complete,
        barComplete: complete,
        detail: message ?? feedback.detail ?? null,
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
