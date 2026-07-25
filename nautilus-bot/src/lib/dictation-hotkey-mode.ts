/**
 * The single resolver for "what does the dictation hotkey do right now".
 *
 * Two booleans in settings (`dictationPushToTalk`, `dictationHandsFreeEnabled`)
 * describe three behaviors, so every surface that renders the behavior has to
 * collapse them the same way. The Dictation page used to collapse them twice —
 * once for the header chip and once for the instruction line — which let the
 * page assert two different behaviors at the same time. Resolve once, here.
 */
export type DictationHotkeyMode = "hold_to_talk" | "toggle" | "hands_free";

export function resolveDictationHotkeyMode(
  pushToTalk: boolean,
  handsFreeEnabled: boolean,
): DictationHotkeyMode {
  if (handsFreeEnabled) {
    return "hands_free";
  }
  return pushToTalk ? "hold_to_talk" : "toggle";
}

/** Compact label for the header chip beside the keycap. */
export const DICTATION_HOTKEY_MODE_CHIP_LABELS: Record<
  DictationHotkeyMode,
  string
> = {
  hold_to_talk: "hold to talk",
  toggle: "toggle",
  hands_free: "hands-free",
};
