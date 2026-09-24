/**
 * Mute other audio while the microphone is live, the way Typeless's "Mute
 * when dictating" and Wispr Flow's music auto-mute work.
 *
 * It mutes the Mac's output rather than pausing a player: pausing needs a
 * private media API or per-app scripting, and muting works for every app.
 * It only ever restores what it muted itself, so a Mac that was already
 * muted stays muted. It mutes only once "recording" is reported, a moment
 * after the start sound played there, so the sound is heard; and the caller
 * waits for `onPhase` to restore before playing the done or error sound.
 */
import { execFile } from "child_process";

type RunAppleScript = (script: string) => Promise<string>;

const MUTE_PHASE = "recording";
// From "recording", where the start sound plays: Tink.aiff runs 0.56 s with
// its tail, and the state query plus the mute add roughly another 0.1 s.
const MUTE_DELAY_MS = 450;
const MUTE = "set volume with output muted";
const UNMUTE = "set volume without output muted";

export function runAppleScript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/osascript", ["-e", script], { timeout: 3000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout).trim());
    });
  });
}

type TimerHandle = unknown;

/**
 * A flag that outlives the process (a file in userData), so a launch after a
 * hard kill can undo a mute the killed run left behind.
 */
export type MediaMuteMarker = {
  set: () => void;
  clear: () => void;
  isSet: () => boolean;
};

export function createMediaMuteController(deps: {
  run: RunAppleScript;
  schedule?: (callback: () => void, ms: number) => TimerHandle;
  cancel?: (handle: TimerHandle) => void;
  log?: (message: string, error?: unknown) => void;
  marker?: MediaMuteMarker;
}) {
  const schedule = deps.schedule ?? ((callback, ms) => setTimeout(callback, ms));
  const cancel =
    deps.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let mutedByUs = false;
  let pending: TimerHandle | null = null;
  let generation = 0;
  // Whether this live session already asked for its mute. "recording" is
  // re-reported on every live-preview update; restarting the delay (or
  // dropping an osascript answer still on its way) each time could put the
  // mute off for the whole dictation.
  let armed = false;

  const unmute = async (): Promise<void> => {
    // One retry: a single osascript hiccup must not leave the Mac muted.
    // `mutedByUs` stays set until an unmute lands, so the next restore (or
    // the one at quit) tries again.
    for (let attempt = 1; ; attempt += 1) {
      try {
        await deps.run(UNMUTE);
        mutedByUs = false;
        deps.marker?.clear();
        return;
      } catch (error) {
        if (attempt >= 2) {
          deps.log?.("[media-mute] could not restore audio", error);
          return;
        }
      }
    }
  };

  const restore = async (): Promise<void> => {
    if (pending !== null) {
      cancel(pending);
      pending = null;
    }
    armed = false;
    generation += 1;
    if (!mutedByUs) return;
    await unmute();
  };

  const muteSoon = (): void => {
    if (armed || mutedByUs) return;
    armed = true;
    const mine = ++generation;
    pending = schedule(() => {
      pending = null;
      void (async () => {
        try {
          // Never mute over the user's own mute: that one is theirs to undo.
          const alreadyMuted = (await deps.run("output muted of (get volume settings)")) === "true";
          // The session may have ended while we asked.
          if (alreadyMuted || mine !== generation) return;
          mutedByUs = true;
          deps.marker?.set();
          try {
            await deps.run(MUTE);
          } catch (error) {
            mutedByUs = false;
            deps.marker?.clear();
            throw error;
          }
          if (mine !== generation) {
            // The session ended while muting: undo it now, whatever order
            // the two osascript calls finished in.
            await unmute();
          }
        } catch (error) {
          deps.log?.("[media-mute] could not mute audio", error);
        }
      })();
    }, MUTE_DELAY_MS);
  };

  return {
    /**
     * Call on every dictation phase change. Resolves once any mute of ours
     * is undone, so a sound played after it is heard.
     */
    onPhase(phase: string, enabled: boolean): Promise<void> {
      if (enabled && phase === MUTE_PHASE) {
        muteSoon();
        return Promise.resolve();
      }
      return restore();
    },
    /** Call before quitting so a crash-free exit never leaves the Mac muted. */
    restore,
    /** Call once at launch: undo a mute a hard-killed earlier run left on. */
    async recoverStaleMute(): Promise<void> {
      if (!deps.marker?.isSet()) return;
      mutedByUs = true;
      await restore();
    },
    get mutedByUs() {
      return mutedByUs;
    },
  };
}
