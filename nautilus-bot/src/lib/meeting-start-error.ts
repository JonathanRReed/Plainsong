export function formatMeetingStartError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("Microphone setup stalled") ||
    message.includes("restarted audio capture automatically")
  ) {
    return message;
  }
  if (message.includes("audio") || message.includes("microphone")) {
    return `${message}. Please check your microphone permissions in System Settings.`;
  }
  if (message.includes("screen") || message.includes("system")) {
    return `${message}. Please check screen recording permissions in System Settings.`;
  }
  return message;
}
