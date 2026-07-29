import { formatModelSize, getAsrModelCapability } from "@/lib/asr-capabilities";
import type { AsrProviderType } from "@/types";

export interface SpeechRouteTarget {
  providerType: AsrProviderType;
  modelId: string;
}

export type ModelPresetId =
  | "light"
  | "balanced"
  | "widest_languages"
  | "largest_models";

/**
 * A preset sets the two speech lanes and nothing else.
 *
 * It deliberately does not touch `privacy.dictationAi` / `privacy.meetingsAi`.
 * A preset can only name an AI *provider* -- which models exist is a question
 * only the provider can answer, since Ollama lists what you pulled -- and the
 * provider every preset would name is `ollama`, which is already the default.
 * So the AI half of a preset could never change anything except in the one
 * case where changing it is destructive: a user who deliberately moved a lane
 * to Anthropic or OpenAI would have that choice, and its model id, silently
 * replaced by clicking a tile whose label only talks about speech. A field
 * that never varies between presets is not a choice; it is a hidden reset.
 * The AI lanes are chosen in their own rows, and only there.
 */
export interface ModelPreset {
  id: ModelPresetId;
  name: string;
  dictationSpeech: SpeechRouteTarget;
  meetingSpeech: SpeechRouteTarget;
  /** What you get. One sentence, no superlatives. */
  buys: string;
  /** What it costs you. Always populated -- a preset with no downside is a lie. */
  costs: string;
}

export const MODEL_PRESETS: readonly ModelPreset[] = [
  {
    id: "light",
    name: "Light",
    dictationSpeech: { providerType: "whisper", modelId: "base.en" },
    meetingSpeech: {
      providerType: "parakeet",
      modelId: "parakeet-tdt-0.6b-v3",
    },
    // Not "the smallest model we ship" -- tiny and tiny.en are smaller, and
    // they are in the drawer. This is the smallest of the promoted three.
    buys: "The smallest of the promoted models for dictation, with the smallest local engine that is wired for long recordings handling meetings.",
    costs:
      "Dictation is English only: speak Spanish into base.en and it returns English-sounding nonsense rather than admitting it cannot.",
  },
  {
    id: "balanced",
    name: "Balanced",
    dictationSpeech: {
      providerType: "parakeet",
      modelId: "parakeet-tdt-0.6b-v3",
    },
    meetingSpeech: {
      providerType: "parakeet",
      modelId: "parakeet-tdt-0.6b-v3",
    },
    buys: "One engine for both jobs, and a transducer that emits silence during silence — so stopping mid-sentence to think does not become invented words.",
    costs:
      "25 European languages, not 100: Mandarin, Hindi and Arabic are not covered at all.",
  },
  {
    id: "widest_languages",
    name: "Widest languages",
    dictationSpeech: { providerType: "whisper", modelId: "large-v3-turbo" },
    meetingSpeech: {
      providerType: "parakeet",
      modelId: "parakeet-tdt-0.6b-v3",
    },
    buys: "Dictation covers roughly 100 languages — the widest coverage of anything you can download here.",
    costs:
      "large-v3-turbo is slower per utterance and fills long pauses with invented text, and meetings still cover 25 languages rather than 100.",
  },
  {
    id: "largest_models",
    name: "Largest models",
    dictationSpeech: { providerType: "whisper", modelId: "large-v3-turbo" },
    meetingSpeech: {
      providerType: "distil_whisper",
      modelId: "distil-large-v3.5",
    },
    // Deliberately not called "most accurate": we have not measured these
    // models against each other on this Mac, and the spec says to measure
    // before promoting. Size is a fact; the ranking would be a claim.
    // Not "bigger on both jobs": dictation is large-v3-turbo here and in
    // Widest languages, so the two are equal on that lane. Only meetings
    // change. Claiming both would be the kind of small, checkable
    // overstatement that costs a reader their trust in everything else here.
    buys: "The largest meeting engine available locally, paired with the same large dictation model as Widest languages.",
    costs:
      "The largest download here, slower on every utterance, and meetings become English only.",
  },
];

function routeKey(target: SpeechRouteTarget): string {
  return `${target.providerType}:${target.modelId}`;
}

/**
 * What this preset costs in disk, summed from `asr-capabilities` and nowhere
 * else. Two lanes on one model count once. Returns null if any target has no
 * recorded size, so the UI omits the figure rather than inventing one.
 */
function presetDiskMib(preset: ModelPreset): number | null {
  const seen = new Set<string>();
  let total = 0;

  for (const target of [preset.dictationSpeech, preset.meetingSpeech]) {
    const key = routeKey(target);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const capability = getAsrModelCapability(target.providerType, target.modelId);
    if (!capability) {
      return null;
    }
    total += capability.sizeMib;
  }

  return total;
}

export function presetDiskLabel(preset: ModelPreset): string | null {
  const total = presetDiskMib(preset);
  return total === null ? null : formatModelSize(total);
}

/** The lanes a preset sets, as they read back out of settings. */
export interface ModelLaneSelection {
  dictationSpeech: SpeechRouteTarget;
  meetingSpeech: SpeechRouteTarget;
}

/**
 * Which preset the current speech lanes match, or null for "Custom".
 *
 * Only the two speech lanes are compared, because they are the only thing a
 * preset writes. Comparing the AI lanes here would be the mirror of the same
 * lie: a user on Anthropic would see "Custom" the instant they clicked
 * "Balanced", even though the preset had done exactly what it said. Changing
 * either speech lane underneath a preset still moves this to Custom.
 */
export function resolveActivePresetId(
  selection: ModelLaneSelection,
): ModelPresetId | null {
  const match = MODEL_PRESETS.find(
    (preset) =>
      routeKey(preset.dictationSpeech) === routeKey(selection.dictationSpeech) &&
      routeKey(preset.meetingSpeech) === routeKey(selection.meetingSpeech),
  );

  return match?.id ?? null;
}
