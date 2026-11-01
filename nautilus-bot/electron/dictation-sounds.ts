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
import { dictationDeliveryFeedback } from "./dictation-feedback";

export type DictationSound = "start" | NonNullable<ReturnType<typeof dictationDeliveryFeedback>["sound"]>;

/**
 * Which sound, if any, a phase change should play.
 *
 * The start sound means the microphone is delivering audio, so it plays on
 * the "recording" event that carries `captureReady: true` (the sidecar sends
 * it on the first captured sample), not on any earlier recording event.
 */
export function dictationSoundForTransition(
  previousPhase: string,
  nextPhase: string,
  outcome: unknown,
  captureReady?: unknown,
): DictationSound | null {
  if (nextPhase === previousPhase) return null;
  if (nextPhase === "recording") return captureReady === true ? "start" : null;
  if (nextPhase === "done") {
    return outcome == null ? null : dictationDeliveryFeedback(outcome).sound;
  }
  if (nextPhase === "error") return "error";
  return null;
}

/** Longest start-sound hold the sidecar may ask for. */
const MAX_START_SOUND_DELAY_MS = 2_000;

/**
 * How long to hold the start sound: the sidecar's `startSoundDelayMs` for the
 * input that opened (about 300 ms for AirPods, 1.2 s for other Bluetooth
 * headsets, which swallow audio while they switch profile), bounded.
 */
export function dictationStartSoundDelayMs(delay: unknown): number {
  if (typeof delay !== "number" || !Number.isFinite(delay) || delay <= 0) return 0;
  return Math.min(Math.round(delay), MAX_START_SOUND_DELAY_MS);
}

const MACOS_SOUND_FILES: Record<DictationSound, string> = {
  start: "/System/Library/Sounds/Tink.aiff",
  done: "/System/Library/Sounds/Pop.aiff",
  attention: "/System/Library/Sounds/Purr.aiff",
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
