/**
 * Start, finish and failure sounds for dictation.
 *
 * Wispr Flow and Typeless both confirm a dictation by ear, so the user never
 * has to look at the HUD to know the mic went live or the text landed. The
 * main process plays them, not the overlay, so they still work with the
 * dictation mini window turned off.
 *
 * macOS system sounds through `afplay`: nothing to bundle, short enough that
 * the start sound is over before the first word, and quiet (volume 0.25).
 */
import { spawn } from "child_process";

export type DictationSound = "start" | "done" | "error";

/** Outcomes where the words reached the user; others finish silently. */
const DELIVERED_OUTCOMES = new Set([
  "pasted",
  "paste_dispatched",
  "replaced",
  "copied",
  "copied_replacement",
]);

/** Which sound, if any, a phase change should play. */
export function dictationSoundForTransition(
  previousPhase: string,
  nextPhase: string,
  outcome: unknown,
): DictationSound | null {
  if (nextPhase === previousPhase) return null;
  if (nextPhase === "recording") return "start";
  if (nextPhase === "done") {
    return typeof outcome === "string" && DELIVERED_OUTCOMES.has(outcome) ? "done" : null;
  }
  if (nextPhase === "error") return "error";
  return null;
}

const MACOS_SOUND_FILES: Record<DictationSound, string> = {
  start: "/System/Library/Sounds/Tink.aiff",
  done: "/System/Library/Sounds/Pop.aiff",
  error: "/System/Library/Sounds/Funk.aiff",
};

export function playDictationSound(sound: DictationSound, platform = process.platform): void {
  if (platform !== "darwin") return;
  try {
    const child = spawn("/usr/bin/afplay", ["-v", "0.25", MACOS_SOUND_FILES[sound]], {
      stdio: "ignore",
      detached: false,
    });
    child.on("error", () => {
      // A missing sound file or afplay is not worth surfacing.
    });
    child.unref();
  } catch {
    // Same: a sound is a courtesy, never a failure.
  }
}
