/**
 * What the menu-bar item says, from the dictation and meeting state.
 *
 * The item is how a live microphone stays visible when the HUD is hidden or
 * on another Space, so it names the state in the menu bar itself: a dot and
 * a running clock while dictating or recording a meeting, an ellipsis while
 * the words are being finished (or a meeting is starting or being finished),
 * and nothing when idle (a quiet menu bar is the point). The menu's first
 * line says the same thing in words.
 */

export type TrayStatusInput = {
  dictationPhase: string;
  /** When the current dictation went live, or null. */
  dictationStartedAt: number | null;
  /**
   * Phase of the meeting being tracked, or null if none. A meeting is only
   * "recording" between its preparing and stopping phases; before and after
   * it the microphone is not capturing, so there is no clock and nothing to
   * stop.
   */
  meetingPhase: string | null;
  /** When the current meeting started recording, or null. */
  meetingStartedAt: number | null;
  /** Whether the recording meeting is paused (capture held, frames dropped). */
  meetingPaused?: boolean;
  /** Paused time so far, including the current pause, in milliseconds. */
  meetingPausedMs?: number;
  now: number;
};

export type TrayStatus = {
  /** Text beside the icon (macOS only). Empty when idle. */
  title: string;
  tooltip: string;
  /**
   * First, disabled line of the menu. No clock: the menu is rebuilt only on
   * state changes, since replacing it every second would close it while
   * the user is reading it. The running clock lives in `title`.
   */
  statusLine: string;
  /** Whether the title shows a running clock, so the caller ticks it. */
  ticking: boolean;
  /**
   * The menu's meeting item: "stop" while a meeting records, "busy" while one
   * is starting or finishing (shown disabled), "start" otherwise.
   */
  meetingControl: "start" | "stop" | "busy";
};

const FINISHING_PHASES = new Set(["stopping", "transcribing", "delivering"]);
const MEETING_FINISHING_PHASES = new Set(["stopping", "processing", "transcribing"]);

function meetingControlFor(meetingPhase: string | null): TrayStatus["meetingControl"] {
  if (meetingPhase === "recording") return "stop";
  return meetingPhase === null ? "start" : "busy";
}

export function formatTrayClock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

export function describeTrayStatus(input: TrayStatusInput): TrayStatus {
  const { dictationPhase, dictationStartedAt, meetingPhase, meetingStartedAt, now } = input;
  const meetingPausedMs = Math.max(0, input.meetingPausedMs ?? 0);
  const meetingControl = meetingControlFor(meetingPhase);
  if (dictationPhase === "primed") {
    return {
      title: "…",
      tooltip: "Plainsong is opening the microphone",
      statusLine: "Opening microphone…",
      ticking: false,
      meetingControl,
    };
  }
  if (dictationPhase === "recording") {
    const clock = formatTrayClock(now - (dictationStartedAt ?? now));
    return {
      title: `● ${clock}`,
      tooltip: "Plainsong is listening",
      statusLine: "Listening",
      ticking: true,
      meetingControl,
    };
  }
  if (FINISHING_PHASES.has(dictationPhase)) {
    return {
      title: "…",
      tooltip: "Plainsong is finishing your dictation",
      statusLine: dictationPhase === "delivering" ? "Inserting…" : "Transcribing…",
      ticking: false,
      meetingControl,
    };
  }
  if (meetingPhase === "recording" && input.meetingPaused) {
    // Same clock as the app's: recorded time only, frozen while paused.
    const clock = formatTrayClock(now - (meetingStartedAt ?? now) - meetingPausedMs);
    return {
      title: `❚❚ ${clock}`,
      tooltip: "The meeting recording is paused",
      statusLine: "Meeting paused",
      ticking: false,
      meetingControl,
    };
  }
  if (meetingPhase === "recording") {
    const clock = formatTrayClock(now - (meetingStartedAt ?? now) - meetingPausedMs);
    return {
      title: `● ${clock}`,
      tooltip: "Plainsong is recording a meeting",
      statusLine: "Recording a meeting",
      ticking: true,
      meetingControl,
    };
  }
  if (meetingPhase !== null) {
    const finishing = MEETING_FINISHING_PHASES.has(meetingPhase);
    return {
      title: "…",
      tooltip: finishing
        ? "Plainsong is finishing the meeting recording"
        : "Plainsong is starting a meeting recording",
      statusLine: finishing ? "Finishing the meeting…" : "Starting the meeting…",
      ticking: false,
      meetingControl,
    };
  }
  if (dictationPhase === "error") {
    return {
      title: "",
      tooltip: "Plainsong",
      statusLine: "The last dictation did not finish",
      ticking: false,
      meetingControl,
    };
  }
  return {
    title: "",
    tooltip: "Plainsong",
    statusLine: "Ready to dictate",
    ticking: false,
    meetingControl,
  };
}
export function nextTrayRecoveryResults(
  current: Array<{ text: string }>,
  eventName: string,
  payload: unknown,
): Array<{ text: string }> {
  if (eventName !== "dictation-recovery-results-changed") return current;
  if (!payload || typeof payload !== "object" || !("results" in payload) || !Array.isArray(payload.results) || payload.results.length > 3) return [];
  const results: Array<{ text: string }> = [];
  for (const result of payload.results) {
    if (!result || typeof result !== "object" || !("text" in result) || typeof result.text !== "string" || !result.text.trim()) return [];
    results.push({ text: result.text });
  }
  return results;
}
