import { isRemoteAnalysisProvider } from "@/components/models/ai-lanes";
import { getOllamaStatus, hasProviderSecret } from "@/lib/backend";
import type { Settings } from "@/types/settings";

/**
 * Translate-to-English (roadmap item B7a), renderer side.
 *
 * The sidecar decides how a translation runs (`resolve_dictation_translation_route`
 * in rust-sidecar/src/lib.rs): multilingual whisper.cpp translates inside the
 * decode, every other recognizer transcribes and the dictation AI lane
 * translates afterwards. This module mirrors that decision so the toggle can
 * say up front what will happen -- and refuse, with a reason, when nothing
 * would.
 */

export type TranslateToEnglishRoute = "whisper_native" | "ai_lane";

export type TranslateToEnglishAvailability = {
  /** Whether the toggle may be switched on for this model. */
  enabled: boolean;
  route: TranslateToEnglishRoute;
  /** One sentence for the toggle's description line. */
  description: string;
};

export const TRANSLATE_NEEDS_AI_PROVIDER_COPY = "Needs an AI provider for this model";

export const TRANSLATE_ENGLISH_ONLY_MODEL_COPY =
  "This model is English-only and cannot translate. Pick a multilingual whisper model, or a model that uses the AI provider.";

/**
 * Pure routing + copy decision. `aiLaneReady` is the probe result for the
 * dictation AI lane (`probeDictationAiLane`): `true` when it can answer,
 * `false` when it cannot (Ollama down, no key), `null` when unknown -- the
 * toggle stays usable on `null` because claiming the lane is broken on a
 * failed probe would be as wrong as claiming it works.
 */
export function resolveTranslateToEnglishAvailability(input: {
  provider: string | null | undefined;
  modelId: string | null | undefined;
  aiLaneReady: boolean | null;
}): TranslateToEnglishAvailability {
  const provider = input.provider?.trim() ?? "";
  const modelId = input.modelId?.trim().toLowerCase() ?? "";
  if (provider === "whisper") {
    if (modelId.endsWith(".en")) {
      return {
        enabled: false,
        route: "ai_lane",
        description: TRANSLATE_ENGLISH_ONLY_MODEL_COPY,
      };
    }
    return {
      enabled: true,
      route: "whisper_native",
      description:
        "whisper translates to English while it transcribes; nothing else runs.",
    };
  }
  if (input.aiLaneReady === false) {
    return {
      enabled: false,
      route: "ai_lane",
      description: TRANSLATE_NEEDS_AI_PROVIDER_COPY,
    };
  }
  return {
    enabled: true,
    route: "ai_lane",
    description:
      "Transcribes in the language you speak, then the AI provider set in AI & Keys translates it to English before formatting and insert.",
  };
}

/** The provider/model the dictation lane resolves to from a settings snapshot. */
export function resolveDictationRecognizer(
  transcription: Pick<
    Settings["transcription"],
    | "useSharedAsrSelection"
    | "defaultProvider"
    | "selectedModelId"
    | "dictationProvider"
    | "dictationModelId"
  >,
): { provider: string; modelId: string } {
  if (transcription.useSharedAsrSelection ?? true) {
    return {
      provider: transcription.defaultProvider,
      modelId: transcription.selectedModelId,
    };
  }
  return {
    provider: transcription.dictationProvider ?? transcription.defaultProvider,
    modelId: transcription.dictationModelId ?? transcription.selectedModelId,
  };
}

type DictationAiLaneProbeDeps = {
  getOllamaStatus: () => Promise<boolean>;
  hasProviderSecret: (provider: string) => Promise<boolean>;
};

/**
 * Whether the dictation AI lane can actually answer: Ollama reachable for
 * the local route, a stored key for a cloud one. Same contract as the
 * meetings probe in `use-setup-status.ts`: a failed probe is `null`, never a
 * verdict.
 */
export async function probeDictationAiLane(
  privacy: Pick<Settings["privacy"], "dictationAi" | "remoteProcessingEnabled">,
  deps: DictationAiLaneProbeDeps = { getOllamaStatus, hasProviderSecret },
): Promise<boolean | null> {
  const provider = privacy.dictationAi?.provider?.trim() ?? "";
  if (!provider) {
    return null;
  }
  if (isRemoteAnalysisProvider(provider)) {
    if (!privacy.remoteProcessingEnabled) {
      return false;
    }
    return deps
      .hasProviderSecret(provider)
      .then((present) => (typeof present === "boolean" ? present : null))
      .catch(() => null);
  }
  return deps
    .getOllamaStatus()
    .then((ready) => (typeof ready === "boolean" ? ready : null))
    .catch(() => null);
}
