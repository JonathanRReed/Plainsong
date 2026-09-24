// Fair use for "unlimited for normal personal use". Numbers are published in
// the terms; past a cap the app falls back to local models, it is never cut
// off. See nautilus-bot/docs/plainsong-plus.md for the arithmetic behind each one.

export const MONTHLY_CAPS = {
  // About 135k spoken words: 3-4x the heaviest dictation users we know of.
  dictationSeconds: 15 * 60 * 60,
  meetingSeconds: 30 * 60 * 60,
  // Cleanup, voice edits and summaries together.
  llmTokens: 20_000_000,
};

export const REQUEST_LIMITS = {
  // One dictation clip, and one meeting upload (the app sends meetings in
  // chunks, so this only guards against a runaway client).
  dictationSeconds: 10 * 60,
  meetingSeconds: 60 * 60,
  maxAudioBytes: 90 * 1024 * 1024,
  maxLlmInputChars: 400_000,
};

export function usagePeriod(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 7); // YYYY-MM, UTC
}

/**
 * Which launch state lets this customer in. "off" (default) lets nobody in,
 * "testers" only the listed customer ids, "on" everyone with a valid license.
 */
export function launchAllows(env, customerId) {
  const state = String(env.PLUS_LAUNCH_STATE ?? "off").trim();
  if (state === "on") return true;
  if (state === "testers") {
    return String(env.TESTER_CUSTOMER_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
      .includes(customerId);
  }
  return false;
}

export function remainingAllowance(usage) {
  return {
    dictationSeconds: Math.max(0, MONTHLY_CAPS.dictationSeconds - (usage.dictationSeconds ?? 0)),
    meetingSeconds: Math.max(0, MONTHLY_CAPS.meetingSeconds - (usage.meetingSeconds ?? 0)),
    llmTokens: Math.max(0, MONTHLY_CAPS.llmTokens - (usage.llmTokens ?? 0)),
  };
}
