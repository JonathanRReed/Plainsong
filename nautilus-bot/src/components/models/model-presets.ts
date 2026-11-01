import { formatModelSize, getAsrModelCapability } from "@/lib/asr-capabilities";
import type { AsrProviderType } from "@/types";

export interface SpeechRouteTarget {
  providerType: AsrProviderType;
  modelId: string;
}

export type ModelPresetId =
  | "recommended"
  | "light"
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
 *
 * Presets name Parakeet v3 by its ONNX route; `presetForThisMac` swaps in the
 * GGUF build wherever it can run, the only Parakeet v3 offered there.
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
  /**
   * `costs` where only the ONNX build of Parakeet v3 runs, for a preset whose
   * downside was measured on the GGUF build.
   */
  costsWithOnnxParakeet?: string;
}

const PARAKEET_V3: SpeechRouteTarget = {
  providerType: "parakeet",
  modelId: "parakeet-tdt-0.6b-v3",
};

const GGUF_PARAKEET_V3: SpeechRouteTarget = {
  providerType: "transcribe_cpp",
  modelId: "parakeet-tdt-0.6b-v3-q8_0",
};

export const MODEL_PRESETS: readonly ModelPreset[] = [
  {
    // What a new install starts with: Parakeet v3 on both lanes, the GGUF
    // build on Apple Silicon (see RECOMMENDED_SPEECH_ROUTE).
    //
    // The claims stop at what was measured. Speed was not a difference worth
    // claiming for meetings (both builds ran far faster than real time), so
    // "faster" appears nowhere here. The size is left to the tile, which
    // prints it in the same unit as every other preset.
    id: "recommended",
    name: "Recommended",
    dictationSpeech: PARAKEET_V3,
    meetingSpeech: PARAKEET_V3,
    buys: "Parakeet v3 for dictation and meetings, in one download. It stays quiet through pauses, so stopping mid-sentence to think doesn't turn into invented words.",
    costs:
      "It can write stray words when only background chatter is audible. Tested in English only so far.",
    costsWithOnnxParakeet: "Tested in English only so far.",
  },
  {
    id: "light",
    name: "Light",
    dictationSpeech: { providerType: "whisper", modelId: "base.en" },
    meetingSpeech: PARAKEET_V3,
    // Not "the smallest model we ship" -- tiny and tiny.en are smaller.
    buys: "A small English dictation download, with Parakeet v3 for meetings.",
    costs:
      "Dictation is English only. Meetings are tested in English only so far.",
  },
  {
    id: "widest_languages",
    name: "Widest languages",
    dictationSpeech: { providerType: "whisper", modelId: "large-v3-turbo" },
    meetingSpeech: PARAKEET_V3,
    buys: "Dictation with Whisper Large Turbo, built for about 100 languages, the most of any model you can download here.",
    costs:
      "Dictation is slower and can fill long pauses with invented text. Other languages aren't tested in Plainsong yet, and meetings are tested in English only.",
  },
  {
    id: "largest_models",
    name: "Whisper Turbo + Distil-Whisper",
    dictationSpeech: { providerType: "whisper", modelId: "large-v3-turbo" },
    meetingSpeech: {
      providerType: "distil_whisper",
      modelId: "distil-large-v3.5",
    },
    // Named for what it selects. Whether these models beat Recommended on
    // accuracy has not been measured, so the tile makes no ranking claim.
    buys: "Whisper Large Turbo for dictation and Distil-Whisper for English meetings.",
    costs:
      "Dictation is slower and can fill long pauses with invented text. Meetings are English only.",
  },
];

function forThisMac(target: SpeechRouteTarget, efficientParakeet: boolean): SpeechRouteTarget {
  return efficientParakeet && routeKey(target) === routeKey(PARAKEET_V3)
    ? GGUF_PARAKEET_V3
    : target;
}

/**
 * A preset as this Mac runs it: Parakeet v3 is the GGUF build where it can
 * run (`efficientParakeet`), and the ONNX build everywhere else.
 */
export function presetForThisMac(
  preset: ModelPreset,
  efficientParakeet: boolean,
): ModelPreset {
  return {
    ...preset,
    dictationSpeech: forThisMac(preset.dictationSpeech, efficientParakeet),
    meetingSpeech: forThisMac(preset.meetingSpeech, efficientParakeet),
    costs: efficientParakeet ? preset.costs : preset.costsWithOnnxParakeet ?? preset.costs,
  };
}

function routeKey(target: SpeechRouteTarget): string {
  return `${target.providerType}:${target.modelId}`;
}

/**
 * The size a Download fetches for one target on this Mac, when the sidecar
 * reports more than the catalog's file (see `withDownloadSize`).
 */
export type DownloadSizeMibFor = (target: SpeechRouteTarget) => number | null | undefined;

/**
 * What this preset costs in disk, summed from `asr-capabilities` (or, where
 * the sidecar reports it, what this Mac's download fetches) and nowhere
 * else. Two lanes on one model count once. Returns null if any target has no
 * recorded size, so the UI omits the figure rather than inventing one.
 */
function presetDiskMib(preset: ModelPreset, sizeMibFor?: DownloadSizeMibFor): number | null {
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
    total += sizeMibFor?.(target) ?? capability.sizeMib;
  }

  return total;
}

export function presetDiskLabel(
  preset: ModelPreset,
  sizeMibFor?: DownloadSizeMibFor,
): string | null {
  const total = presetDiskMib(preset, sizeMibFor);
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
  efficientParakeet: boolean,
): ModelPresetId | null {
  // A lane still on the ONNX build reads as Parakeet v3, the same model the
  // preset names; Settings offers the GGUF download beside it.
  const dictation = forThisMac(selection.dictationSpeech, efficientParakeet);
  const meeting = forThisMac(selection.meetingSpeech, efficientParakeet);
  const match = MODEL_PRESETS.map((preset) =>
    presetForThisMac(preset, efficientParakeet),
  ).find(
    (preset) =>
      routeKey(preset.dictationSpeech) === routeKey(dictation) &&
      routeKey(preset.meetingSpeech) === routeKey(meeting),
  );

  return match?.id ?? null;
}
