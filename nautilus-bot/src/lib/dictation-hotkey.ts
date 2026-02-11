export type DictationPhase = "idle" | "recording" | "stopping" | "transcribing" | "done" | "error";
export type HotkeyEvent = "pressed" | "released" | "emergency_stop" | "watchdog_timeout";

export function nextDictationPhase(current: DictationPhase, event: HotkeyEvent): DictationPhase {
  if (current === "recording" && (event === "released" || event === "emergency_stop" || event === "watchdog_timeout")) {
    return "stopping";
  }
  if (current === "idle" && event === "pressed") {
    return "recording";
  }
  return current;
}
