import type { DictationBinding } from "@/types/settings";
import { normalizeShortcut } from "./shortcuts";

export type DictationHotkeyMode = "hold_to_talk" | "toggle" | "hands_free";

function resolveDictationHotkeyMode(
  pushToTalk: boolean,
  handsFreeEnabled: boolean,
): DictationHotkeyMode {
  if (handsFreeEnabled) {
    return "hands_free";
  }
  return pushToTalk ? "hold_to_talk" : "toggle";
}

export function resolveDisplayedDictationHotkeyMode(input: {
  shortcut: string;
  bindings: readonly DictationBinding[] | undefined;
  pushToTalk: boolean;
  handsFreeEnabled: boolean;
}): DictationHotkeyMode {
  const shortcut = normalizeShortcut(input.shortcut);
  const binding = shortcut ? input.bindings?.find((candidate) =>
    candidate.trigger.kind === "key" &&
    candidate.action.kind === "dictation" &&
    normalizeShortcut(candidate.trigger.accelerator) === shortcut,
  ) : undefined;
  if (binding?.action.kind === "dictation") {
    if (binding.action.behavior === "hold") return "hold_to_talk";
    if (binding.action.behavior === "toggle") return "toggle";
  }
  return resolveDictationHotkeyMode(input.pushToTalk, input.handsFreeEnabled);
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
