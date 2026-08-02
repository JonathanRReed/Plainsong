const MICROPHONE_PREPARATION_TIMEOUTS: Partial<Record<string, string>> = {
  start_dictation: "Timed out waiting for dictation microphone stream to start",
  start_recording: "Timed out waiting for microphone stream preparation",
};

export const MICROPHONE_RECOVERY_MESSAGE =
  "Microphone setup stalled. Plainsong restarted audio capture automatically. Retry in a moment, then reconnect or choose another microphone if it happens again.";

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
  recover: () => Promise<void>,
): Promise<T> {
  try {
    return await attempt();
  } catch (firstError) {
    if (!shouldRecycleSidecarAfterCommandError(command, firstError)) {
      throw firstError;
    }
  }

  try {
    await recover();
  } catch {
    throw new Error(MICROPHONE_RECOVERY_MESSAGE);
  }

  try {
    return await attempt();
  } catch (secondError) {
    if (!shouldRecycleSidecarAfterCommandError(command, secondError)) {
      throw secondError;
    }
    try {
      await recover();
    } catch {
      // The actionable recovery message below is more useful than exposing a
      // second process-lifecycle error after both microphone starts stalled.
    }
    throw new Error(MICROPHONE_RECOVERY_MESSAGE);
  }
}
