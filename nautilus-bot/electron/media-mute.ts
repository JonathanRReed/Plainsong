/**
 * Mute other audio while the microphone is live, the way Typeless's "Mute
 * when dictating" and Wispr Flow's music auto-mute work.
 *
 * It mutes the Mac's output rather than pausing a player: pausing needs a
 * private media API or per-app scripting, and muting works for every app.
 * It only ever restores what it muted itself, so a Mac that was already
 * muted stays muted, and it waits a moment before muting so the start sound
 * is heard.
 */
import { execFile } from "child_process";

type RunAppleScript = (script: string) => Promise<string>;

const LIVE_PHASES = new Set(["primed", "recording"]);
const MUTE_DELAY_MS = 250;

export function runAppleScript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/osascript", ["-e", script], { timeout: 3000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout).trim());
    });
  });
}

type TimerHandle = unknown;

export function createMediaMuteController(deps: {
  run: RunAppleScript;
  schedule?: (callback: () => void, ms: number) => TimerHandle;
  cancel?: (handle: TimerHandle) => void;
  log?: (message: string, error?: unknown) => void;
}) {
  const schedule = deps.schedule ?? ((callback, ms) => setTimeout(callback, ms));
  const cancel =
    deps.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let mutedByUs = false;
  let pending: TimerHandle | null = null;
  let generation = 0;

  const restore = async (): Promise<void> => {
    if (pending !== null) {
      cancel(pending);
      pending = null;
    }
    generation += 1;
    if (!mutedByUs) return;
    mutedByUs = false;
    try {
      await deps.run("set volume without output muted");
    } catch (error) {
      deps.log?.("[media-mute] could not restore audio", error);
    }
  };

  const muteSoon = (): void => {
    if (mutedByUs || pending !== null) return;
    const mine = ++generation;
    pending = schedule(() => {
      pending = null;
      void (async () => {
        try {
          const alreadyMuted = (await deps.run("output muted of (get volume settings)")) === "true";
          // The session may have ended while we asked.
          if (alreadyMuted || mine !== generation) return;
          mutedByUs = true;
          await deps.run("set volume with output muted");
          if (mine !== generation) {
            // The session ended while muting: undo it now, whatever order
            // the two osascript calls finished in.
            mutedByUs = false;
            await deps.run("set volume without output muted");
          }
        } catch (error) {
          deps.log?.("[media-mute] could not mute audio", error);
        }
      })();
    }, MUTE_DELAY_MS);
  };

  return {
    /** Call on every dictation phase change. */
    onPhase(phase: string, enabled: boolean): void {
      if (enabled && LIVE_PHASES.has(phase)) {
        muteSoon();
      } else {
        void restore();
      }
    },
    /** Call before quitting so a crash-free exit never leaves the Mac muted. */
    restore,
    get mutedByUs() {
      return mutedByUs;
    },
  };
}
