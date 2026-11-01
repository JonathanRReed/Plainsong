import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDictationQuitGuard,
  dictationQuitPromptContent,
  type DictationQuitChoice,
  type DictationQuitPrompt,
} from "../../electron/dictation-quit-guard";
import { createMeetingQuitDraftCoordinator } from "../../electron/meeting-quit-drafts";

async function settle() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function harness(options: {
  choices?: DictationQuitChoice[];
  text?: () => string | null;
  stop?: () => Promise<unknown>;
} = {}) {
  const choices = [...(options.choices ?? ["wait"])];
  const prompts: DictationQuitPrompt[] = [];
  const quit = vi.fn();
  const stop = vi.fn(options.stop ?? (async () => undefined));
  const discard = vi.fn(async () => undefined);
  const copied: string[] = [];
  const guard = createDictationQuitGuard({
    stop,
    discard,
    readText: async () => options.text?.() ?? null,
    copyText: (text) => copied.push(text),
    ask: async (prompt) => {
      prompts.push(prompt);
      return choices.shift() ?? "wait";
    },
    quit,
  });
  return { guard, quit, stop, discard, copied, prompts };
}

describe("dictation quit guard", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lets an idle or not-yet-capturing app quit at once", () => {
    for (const phase of ["idle", "done", "error", "preparing", "primed"]) {
      const { guard, stop, prompts } = harness();
      expect(guard.beforeQuit(phase)).toBe(true);
      expect(stop).not.toHaveBeenCalled();
      expect(prompts).toHaveLength(0);
    }
  });

  it("stops a live recording, asks, and quits once the words are delivered", async () => {
    const { guard, quit, stop, prompts } = harness({ choices: ["wait"] });
    expect(guard.beforeQuit("recording")).toBe(false);
    expect(stop).toHaveBeenCalledTimes(1);
    await settle();
    expect(prompts).toEqual([{ phase: "recording", hasText: false }]);
    for (const phase of ["stopping", "transcribing", "delivering"]) guard.onPhase(phase);
    expect(quit).not.toHaveBeenCalled();
    guard.onPhase("done");
    expect(quit).toHaveBeenCalledTimes(1);
    // The re-issued quit passes straight through.
    expect(guard.beforeQuit("done")).toBe(true);
  });

  it("never releases the quit on a timer or a failed stop", async () => {
    vi.useFakeTimers();
    const { guard, quit } = harness({
      choices: ["wait"],
      stop: async () => {
        throw new Error("IPC bridge is not ready");
      },
    });
    expect(guard.beforeQuit("recording")).toBe(false);
    await settle();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(quit).not.toHaveBeenCalled();
    expect(guard.isHolding()).toBe(true);
    // Still unresolved: another quit attempt is held and asks again.
    expect(guard.beforeQuit("transcribing")).toBe(false);
  });

  it("asks again on a second quit while waiting, and Discard cancels and quits", async () => {
    const { guard, quit, discard, prompts } = harness({ choices: ["wait", "discard"] });
    expect(guard.beforeQuit("transcribing")).toBe(false);
    await settle();
    expect(quit).not.toHaveBeenCalled();
    expect(guard.beforeQuit("transcribing")).toBe(false);
    await settle();
    expect(prompts).toHaveLength(2);
    expect(discard).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
    expect(guard.beforeQuit("transcribing")).toBe(true);
  });

  it("does not stack prompts while one is open", async () => {
    let answer: (choice: DictationQuitChoice) => void = () => undefined;
    const prompts: DictationQuitPrompt[] = [];
    const guard = createDictationQuitGuard({
      stop: async () => undefined,
      discard: async () => undefined,
      readText: async () => null,
      copyText: () => undefined,
      ask: (prompt) => {
        prompts.push(prompt);
        return new Promise((resolve) => {
          answer = resolve;
        });
      },
      quit: vi.fn(),
    });
    expect(guard.beforeQuit("transcribing")).toBe(false);
    await settle();
    expect(guard.beforeQuit("transcribing")).toBe(false);
    await settle();
    expect(prompts).toHaveLength(1);
    answer("wait");
  });

  it("Copy puts recognized words on the clipboard, cancels insertion, and quits", async () => {
    const { guard, quit, discard, copied, prompts } = harness({
      choices: ["copy"],
      text: () => "Meet at 3, not 4.",
    });
    expect(guard.beforeQuit("transcribing")).toBe(false);
    await settle();
    expect(prompts[0]).toEqual({ phase: "transcribing", hasText: true });
    expect(copied).toEqual(["Meet at 3, not 4."]);
    expect(discard).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("Copy before recognition waits for the words, then copies them", async () => {
    let words: string | null = null;
    const { guard, quit, discard, copied } = harness({ choices: ["copy"], text: () => words });
    expect(guard.beforeQuit("recording")).toBe(false);
    await settle();
    guard.onPhase("transcribing");
    await settle();
    expect(copied).toEqual([]);
    expect(quit).not.toHaveBeenCalled();
    words = "the words";
    guard.onWordsChanged();
    await settle();
    expect(copied).toEqual(["the words"]);
    expect(discard).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("Copy for a dictation that ends with no words quits without copying", async () => {
    const { guard, quit, copied } = harness({ choices: ["copy"] });
    expect(guard.beforeQuit("transcribing")).toBe(false);
    await settle();
    guard.onPhase("done");
    await settle();
    expect(copied).toEqual([]);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("says what each choice does", () => {
    const waiting = dictationQuitPromptContent({ phase: "transcribing", hasText: false });
    expect(waiting.buttons).toEqual(["Wait", "Copy Text and Quit", "Discard and Quit"]);
    expect(waiting.choices).toEqual(["wait", "copy", "discard"]);
    expect(waiting.detail).toContain("as soon as they are ready");
    expect(dictationQuitPromptContent({ phase: "delivering", hasText: true }).detail).toContain(
      "on the clipboard now",
    );
  });

  it("guards both of two quit attempts when the first shutdown is cancelled", async () => {
    // Electron's before-quit runs the dictation guard, then the meeting and
    // draft coordinator, exactly as main.ts orders them.
    let phase = "idle";
    let draftsAllowed = false;
    let shutdowns = 0;
    const prompts: DictationQuitPrompt[] = [];
    let appQuit: () => void = () => undefined;
    const guard = createDictationQuitGuard({
      stop: async () => undefined,
      discard: async () => undefined,
      readText: async () => null,
      copyText: () => undefined,
      ask: async (prompt) => {
        prompts.push(prompt);
        return "wait";
      },
      quit: () => appQuit(),
    });
    const coordinator = createMeetingQuitDraftCoordinator({
      flushRendererDrafts: async () => draftsAllowed,
      finalizeMeeting: async () => ({ status: "confirmed" }),
      reissueQuit: () => appQuit(),
      setQuitPending: () => undefined,
      onFinalizationFailure: () => undefined,
    });
    appQuit = () => {
      if (!guard.beforeQuit(phase)) return;
      if (!coordinator.beforeQuit({ activeMeetingId: null, needsRendererFlush: true })) return;
      shutdowns += 1;
    };
    const setPhase = (next: string) => {
      phase = next;
      guard.onPhase(next);
    };

    // Attempt 1: quit while transcribing. The guard holds; the person waits.
    setPhase("recording");
    setPhase("transcribing");
    appQuit();
    await settle();
    expect(prompts).toHaveLength(1);
    expect(shutdowns).toBe(0);
    // The dictation finishes; the guard re-issues the quit, which an unsaved
    // draft then cancels further down.
    setPhase("done");
    await settle();
    expect(shutdowns).toBe(0);
    setPhase("idle");

    // Attempt 2: a new dictation. Quit must be held again, not waved through
    // by the pass the first release left behind.
    setPhase("recording");
    appQuit();
    await settle();
    expect(prompts).toHaveLength(2);
    expect(prompts[1]?.phase).toBe("recording");
    expect(shutdowns).toBe(0);
    draftsAllowed = true;
    setPhase("transcribing");
    setPhase("done");
    await settle();
    expect(shutdowns).toBe(1);
  });
});
