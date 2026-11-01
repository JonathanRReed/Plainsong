/**
 * Keeps Plainsong open while a dictation still has words in flight.
 *
 * Quitting (Cmd+Q, the menu bar Quit, an update restart) used to shut the
 * sidecar down mid-session, and a timeout let the quit through after 30
 * seconds even when recognition was still running. A long local decode could
 * therefore lose the words. Now the quit stays cancelled for as long as any
 * dictation is unresolved, and the person quitting decides what happens:
 *
 * - Wait: the dictation finishes as usual (inserted or copied), then
 *   Plainsong quits.
 * - Copy text and quit: the words go on the clipboard as soon as they are
 *   recognized, the dictation is cancelled so nothing is inserted later, and
 *   Plainsong quits.
 * - Discard and quit: the dictation is cancelled and nothing is kept.
 *
 * A live recording is stopped through the ordinary stop path first, so its
 * words are on their way whichever choice is made. Nothing here releases a
 * quit on a timer or on a failed stop; only a resolved dictation or the
 * person's choice does.
 *
 * Each quit the guard lets through is a single pass, used by the very next
 * quit attempt. If that shutdown is then cancelled further down (an unsaved
 * draft, a meeting that could not finalize), the guard is armed again for the
 * next attempt.
 *
 * `preparing` and `primed` hold no audio yet and do not delay a quit.
 */
const RECORDING_PHASES = new Set(["recording"]);
const FINISHING_PHASES = new Set(["stopping", "transcribing", "delivering"]);

export type DictationQuitChoice = "wait" | "copy" | "discard";

export interface DictationQuitPrompt {
  phase: string;
  /** Whether recognized words already exist, so Copy can act at once. */
  hasText: boolean;
}

export interface DictationQuitGuardDeps {
  /** The ordinary stop path, as a manual stop takes it. */
  stop: () => Promise<unknown>;
  /** Cancel the unresolved dictation so nothing is inserted. */
  discard: () => Promise<unknown>;
  /** The words recognized so far for the unresolved dictation, if any. */
  readText: () => Promise<string | null>;
  copyText: (text: string) => void;
  /** Ask the person quitting what to do. */
  ask: (prompt: DictationQuitPrompt) => Promise<DictationQuitChoice>;
  /** Re-issue the quit. */
  quit: () => void;
  log?: (message: string, details?: Record<string, unknown>) => void;
}

function isUnresolvedDictationPhase(phase: string): boolean {
  return RECORDING_PHASES.has(phase) || FINISHING_PHASES.has(phase);
}

export function createDictationQuitGuard(deps: DictationQuitGuardDeps) {
  let phase = "idle";
  // The standing instruction once the person chose Wait or Copy.
  let choice: Exclude<DictationQuitChoice, "discard"> | null = null;
  let asking = false;
  let copying = false;
  // One quit attempt may pass: the one this guard re-issued.
  let passNext = false;

  const readText = async (): Promise<string | null> => {
    try {
      const text = await deps.readText();
      return typeof text === "string" && text.trim() ? text : null;
    } catch (error) {
      deps.log?.("dictation quit guard could not read the words", { error: String(error) });
      return null;
    }
  };

  const release = (reason: string) => {
    choice = null;
    passNext = true;
    deps.log?.("dictation quit guard releasing quit", { reason });
    deps.quit();
  };

  const discardThenRelease = async (reason: string) => {
    try {
      await deps.discard();
    } catch (error) {
      // The person chose to discard; a cancel that could not run (the
      // session already finished, the engine is gone) does not keep the app
      // open against that choice.
      deps.log?.("dictation quit guard discard did not complete", { error: String(error) });
    }
    release(reason);
  };

  const tryCopy = async () => {
    if (copying || choice !== "copy") return;
    copying = true;
    try {
      const text = await readText();
      if (choice !== "copy") return;
      if (text) {
        deps.copyText(text);
        if (isUnresolvedDictationPhase(phase)) {
          await discardThenRelease("copied");
        } else {
          release("copied");
        }
        return;
      }
      // Finished without any words (no speech, an error): nothing to copy.
      if (!isUnresolvedDictationPhase(phase)) release(`phase ${phase} without words`);
    } finally {
      copying = false;
    }
  };

  const decide = async (prompt: DictationQuitPrompt) => {
    let picked: DictationQuitChoice;
    try {
      picked = await deps.ask(prompt);
    } catch (error) {
      deps.log?.("dictation quit guard prompt failed; waiting", { error: String(error) });
      picked = "wait";
    } finally {
      asking = false;
    }
    deps.log?.("dictation quit guard choice", { choice: picked });
    if (picked === "discard") {
      choice = null;
      await discardThenRelease("discarded");
      return;
    }
    choice = picked;
    if (picked === "copy") {
      await tryCopy();
    } else if (!isUnresolvedDictationPhase(phase)) {
      release(`phase ${phase} while asking`);
    }
  };

  return {
    /** `true` when this quit attempt may proceed now. */
    beforeQuit(currentPhase: string): boolean {
      phase = currentPhase;
      if (passNext) {
        passNext = false;
        return true;
      }
      if (!isUnresolvedDictationPhase(currentPhase)) {
        choice = null;
        return true;
      }
      if (RECORDING_PHASES.has(currentPhase)) {
        void deps.stop().catch((error: unknown) => {
          // A failed stop keeps the quit cancelled; the prompt still offers
          // Discard for a session that cannot finish.
          deps.log?.("dictation quit guard stop failed", { error: String(error) });
        });
      }
      deps.log?.("dictation quit guard holding quit", { phase: currentPhase });
      if (!asking) {
        asking = true;
        void (async () => {
          const hasText = (await readText()) !== null;
          await decide({ phase: currentPhase, hasText });
        })();
      }
      return false;
    },
    /** Feed every observed dictation phase. */
    onPhase(nextPhase: string): void {
      phase = nextPhase;
      // A new recording means any pass from an earlier release was not used
      // by a shutdown, so the next quit protects this session.
      if (RECORDING_PHASES.has(nextPhase) && choice === null && !asking) {
        passNext = false;
      }
      if (asking || choice === null) return;
      if (choice === "copy") {
        void tryCopy();
        return;
      }
      if (!isUnresolvedDictationPhase(nextPhase)) release(`phase ${nextPhase}`);
    },
    /** The recognized words changed (raw text arrived, or a result finished). */
    onWordsChanged(): void {
      if (!asking && choice === "copy") void tryCopy();
    },
    isHolding(): boolean {
      return asking || choice !== null;
    },
  };
}

/** What the quit prompt says, and which choice each button makes. */
export function dictationQuitPromptContent(prompt: DictationQuitPrompt): {
  message: string;
  detail: string;
  buttons: string[];
  choices: DictationQuitChoice[];
} {
  const stage = RECORDING_PHASES.has(prompt.phase)
    ? "Plainsong is stopping your dictation and still has to turn it into text."
    : prompt.hasText
      ? "Plainsong has your words and is still finishing this dictation."
      : "Plainsong is still turning your dictation into text.";
  const copy = prompt.hasText
    ? "Copy puts the words on the clipboard now, without inserting them."
    : "Copy puts the words on the clipboard as soon as they are ready, without inserting them.";
  return {
    message: "Quit while a dictation is unfinished?",
    detail: `${stage}\n\nWait finishes it as usual, then quits. ${copy} Discard drops this dictation.`,
    buttons: ["Wait", "Copy Text and Quit", "Discard and Quit"],
    choices: ["wait", "copy", "discard"],
  };
}
