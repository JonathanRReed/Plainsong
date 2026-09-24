/**
 * What the menu-bar item says, from the dictation and meeting state.
 *
 * The item is how a live microphone stays visible when the HUD is hidden or
 * on another Space, so it names the state in the menu bar itself: a dot and
 * a running clock while dictating or recording a meeting, an ellipsis while
 * the words are being finished, and nothing when idle (a quiet menu bar is
 * the point). The menu's first line says the same thing in words.
 */

export type TrayStatusInput = {
  dictationPhase: string;
  /** When the current dictation went live, or null. */
  dictationStartedAt: number | null;
  /** When the current meeting recording started, or null if none. */
  meetingStartedAt: number | null;
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
};

const LIVE_PHASES = new Set(["primed", "recording"]);
const FINISHING_PHASES = new Set(["stopping", "transcribing", "delivering"]);

export function formatTrayClock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

export function describeTrayStatus(input: TrayStatusInput): TrayStatus {
  const { dictationPhase, dictationStartedAt, meetingStartedAt, now } = input;
  if (LIVE_PHASES.has(dictationPhase)) {
    const clock = formatTrayClock(now - (dictationStartedAt ?? now));
    return {
      title: `● ${clock}`,
      tooltip: "Plainsong is listening",
      statusLine: "Listening",
      ticking: true,
    };
  }
  if (FINISHING_PHASES.has(dictationPhase)) {
    return {
      title: "…",
      tooltip: "Plainsong is finishing your dictation",
      statusLine: dictationPhase === "delivering" ? "Inserting…" : "Transcribing…",
      ticking: false,
    };
  }
  if (meetingStartedAt !== null) {
    const clock = formatTrayClock(now - meetingStartedAt);
    return {
      title: `● ${clock}`,
      tooltip: "Plainsong is recording a meeting",
      statusLine: "Recording a meeting",
      ticking: true,
    };
  }
  if (dictationPhase === "error") {
    return {
      title: "",
      tooltip: "Plainsong",
      statusLine: "The last dictation did not finish",
      ticking: false,
    };
  }
  return { title: "", tooltip: "Plainsong", statusLine: "Ready to dictate", ticking: false };
}
