/**
 * Keeps Plainsong open while a finished meeting is still being transcribed.
 *
 * A quit during a meeting's recording already stops it cleanly
 * (`meeting-quit-drafts.ts`), but the transcription that follows ran in the
 * sidecar and a quit simply ended it, with nothing said. Now the quit stays
 * cancelled while the active meeting is stopping or transcribing, and the
 * person quitting chooses:
 *
 * - Wait: Plainsong quits when the transcript is finished (or the meeting
 *   otherwise ends).
 * - Quit and Transcribe Later: Plainsong quits now. The meeting's audio is
 *   already saved; on the next launch the meeting is marked as interrupted
 *   and offers to transcribe the saved audio again (startup reconciliation in
 *   the sidecar, `reconcile_interrupted_recordings_for_sidecar`).
 *
 * Like the dictation guard, a release is one pass for the very next quit
 * attempt, so a shutdown cancelled further down re-arms the guard.
 */
export type MeetingTranscriptionQuitChoice = "wait" | "quit";

const TRANSCRIBING_PHASES = new Set(["stopping", "processing"]);

export interface MeetingTranscriptionQuitGuardDeps {
  ask: () => Promise<MeetingTranscriptionQuitChoice>;
  quit: () => void;
  log?: (message: string, details?: Record<string, unknown>) => void;
}

function isTranscribing(phase: string | null): boolean {
  return phase !== null && TRANSCRIBING_PHASES.has(phase);
}

export function createMeetingTranscriptionQuitGuard(deps: MeetingTranscriptionQuitGuardDeps) {
  let phase: string | null = null;
  let asking = false;
  let waiting = false;
  let passNext = false;

  const release = (reason: string) => {
    waiting = false;
    passNext = true;
    deps.log?.("meeting transcription quit guard releasing quit", { reason });
    deps.quit();
  };

  return {
    /**
     * `true` when this quit attempt may proceed. `meetingPhase` is the active
     * meeting's phase, or `null` when no meeting is active.
     */
    beforeQuit(meetingPhase: string | null): boolean {
      phase = meetingPhase;
      if (passNext) {
        passNext = false;
        return true;
      }
      if (!isTranscribing(meetingPhase)) {
        waiting = false;
        return true;
      }
      deps.log?.("meeting transcription quit guard holding quit", { phase: meetingPhase });
      if (!asking) {
        asking = true;
        void deps
          .ask()
          .catch((error: unknown) => {
            deps.log?.("meeting transcription quit prompt failed; waiting", { error: String(error) });
            return "wait" as const;
          })
          .then((choice) => {
            asking = false;
            if (choice === "quit") {
              release("transcribe later");
            } else if (!isTranscribing(phase)) {
              release(`meeting ${phase ?? "ended"} while asking`);
            } else {
              waiting = true;
            }
          });
      }
      return false;
    },
    /** Feed the active meeting's phase (`null` once no meeting is active). */
    onMeetingPhase(meetingPhase: string | null): void {
      phase = meetingPhase;
      if (meetingPhase === "recording" && !waiting && !asking) passNext = false;
      if (waiting && !isTranscribing(meetingPhase)) release(`meeting ${meetingPhase ?? "ended"}`);
    },
  };
}

export function meetingTranscriptionQuitPromptContent(): {
  message: string;
  detail: string;
  buttons: string[];
  choices: MeetingTranscriptionQuitChoice[];
} {
  return {
    message: "Quit while a meeting is being transcribed?",
    detail:
      "Plainsong is still turning your meeting into a transcript.\n\nWait finishes the transcript, then quits. Quit and Transcribe Later stops now; the meeting's audio is already saved, and when you open Plainsong again the meeting is marked as interrupted and Retry transcription is offered.",
    buttons: ["Wait", "Quit and Transcribe Later"],
    choices: ["wait", "quit"],
  };
}
