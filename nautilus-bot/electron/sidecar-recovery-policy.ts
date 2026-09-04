const MICROPHONE_PREPARATION_TIMEOUTS: Partial<Record<string, string>> = {
  start_dictation: "Timed out waiting for dictation microphone stream to start",
  start_recording: "Timed out waiting for microphone stream preparation",
};

export const MICROPHONE_RECOVERY_MESSAGE =
  "Microphone setup stalled. Plainsong restarted audio capture automatically. Retry in a moment, then reconnect or choose another microphone if it happens again.";

// One Core Audio preparation attempt is bounded to 1.5 seconds in Rust. This
// budget leaves room for that attempt, one process replacement, and one final
// attempt without ever stacking the old 1.5s + 10s + 1.5s + 10s path.
const MICROPHONE_RECOVERY_BUDGET_MS = 6_000;

export const SIDECAR_SHUTDOWN_MESSAGE = "Plainsong is shutting down";

export function isExpectedSidecarStdinClose(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return false;
  }
  const code = String(error.code);
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function shouldRecycleSidecarAfterCommandError(
  command: string,
  error: unknown,
): boolean {
  const timeoutMessage = MICROPHONE_PREPARATION_TIMEOUTS[command];
  return Boolean(timeoutMessage && errorMessage(error).includes(timeoutMessage));
}

export async function retryOnceAfterMicrophonePreparationTimeout<T>(
  command: string,
  attempt: () => Promise<T>,
  recover: (remainingMs: number) => Promise<void>,
  recoveryBudgetMs = MICROPHONE_RECOVERY_BUDGET_MS,
): Promise<T> {
  // The six-second budget exists only for microphone startup recovery. Model
  // downloads and other legitimate long-running sidecar work already use the
  // command-specific timeout in IpcBridge and must not be cut off here.
  if (!MICROPHONE_PREPARATION_TIMEOUTS[command]) {
    return await attempt();
  }

  const startedAt = Date.now();

  const runWithinBudget = async <R>(work: () => Promise<R>): Promise<R> => {
    const remainingMs = recoveryBudgetMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      throw new Error(MICROPHONE_RECOVERY_MESSAGE);
    }

    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        work(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error(MICROPHONE_RECOVERY_MESSAGE)),
            remainingMs,
          );
        }),
      ]);
    } finally {
      if (timeout !== null) clearTimeout(timeout);
    }
  };

  try {
    return await runWithinBudget(attempt);
  } catch (firstError) {
    if (!shouldRecycleSidecarAfterCommandError(command, firstError)) {
      throw firstError;
    }
  }

  try {
    const remainingMs = recoveryBudgetMs - (Date.now() - startedAt);
    await runWithinBudget(() => recover(Math.max(0, remainingMs)));
  } catch {
    throw new Error(MICROPHONE_RECOVERY_MESSAGE);
  }

  try {
    return await runWithinBudget(attempt);
  } catch (secondError) {
    if (!shouldRecycleSidecarAfterCommandError(command, secondError)) {
      throw secondError;
    }
    throw new Error(MICROPHONE_RECOVERY_MESSAGE);
  }
}
