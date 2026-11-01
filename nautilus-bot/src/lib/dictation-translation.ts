import { isRemoteAnalysisProvider } from "@/components/models/ai-lanes";
import { getOllamaStatus, hasProviderSecret } from "@/lib/backend";
import {
  getAppleLanguageModelAvailability,
  getBundledCleanupModelStatus,
  getLocalTextRuntimeHealth,
  getNativeTextModelStatus,
  listOllamaModels,
  listOllamaModelCatalog,
} from "@/lib/backend/ai";
import { probeOllamaModelReadiness, type OllamaModelReadiness } from "@/lib/ollama-model-readiness";
import type { Settings } from "@/types/settings";
import {
  CHATGPT_PLAN_PROVIDER,
  getChatGptPlanStatus,
} from "@/lib/backend/chatgpt-plan";

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

export const TRANSLATE_NEEDS_AI_PROVIDER_COPY = "Needs AI cleanup set up in Models to translate with this speech model.";

export const TRANSLATE_ENGLISH_ONLY_MODEL_COPY =
  "This speech model is English-only and cannot translate. Pick a multilingual Whisper model, or one that translates with AI cleanup.";

/**
 * Pure routing + copy decision. `aiLaneReady` is the probe result for the
 * translation probe (`probeDictationAiLane`): `true` when it can translate,
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
      "Transcribes in the language you speak, then the AI service chosen in Models translates it to English before formatting and insert.",
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
  getChatGptPlanStatus?: typeof getChatGptPlanStatus;
  getNativeTextModelStatus?: typeof getNativeTextModelStatus;
  getBundledCleanupModelStatus?: typeof getBundledCleanupModelStatus;
  getAppleLanguageModelAvailability?: typeof getAppleLanguageModelAvailability;
  listOllamaModels?: typeof listOllamaModels;
  listOllamaModelCatalog?: typeof listOllamaModelCatalog;
  getLocalTextRuntimeHealth?: typeof getLocalTextRuntimeHealth;
};

export type DictationAiLaneReadiness = {
  ready: boolean | null;
  message: string | null;
};

export function describeOllamaDictationReadiness(
  readiness: OllamaModelReadiness,
): DictationAiLaneReadiness {
  if (readiness.runtimeReady === false) {
    return { ready: false, message: "Start Ollama before using this profile." };
  }
  if (readiness.modelReady === false) {
    return { ready: false, message: "Choose an installed and verified Ollama model before using this profile." };
  }
  if (readiness.runtimeReady === null || readiness.modelReady === null) {
    return { ready: null, message: "Plainsong could not check the selected Ollama model. Try again." };
  }
  return { ready: readiness.executionReady, message: readiness.executionMessage };
}

/**
 * Whether the dictation AI lane can translate, including native memory and
 * runtime health, Ollama execution eligibility, or cloud credentials. Cleanup-only
 * providers are refused. A failed probe returns `null`.
 */
export async function probeDictationAiLane(
  privacy: Pick<Settings["privacy"], "dictationAi" | "remoteProcessingEnabled">,
  deps: DictationAiLaneProbeDeps = { getOllamaStatus, hasProviderSecret },
): Promise<boolean | null> {
  // These cleanup providers discard the caller's translation instructions.
  const provider = privacy.dictationAi?.provider?.trim();
  if (provider === "bundled_local" || provider === "apple_language_model") return false;
  return (await probeDictationAiLaneReadiness(privacy, deps)).ready;
}

/** Checks provider setup without generating text. Request-time memory admission still applies. */
export async function probeDictationAiLaneReadiness(
  privacy: Pick<Settings["privacy"], "dictationAi" | "remoteProcessingEnabled">,
  deps: DictationAiLaneProbeDeps = { getOllamaStatus, hasProviderSecret },
): Promise<DictationAiLaneReadiness> {
  const provider = privacy.dictationAi?.provider?.trim() ?? "";
  if (!provider) {
    return { ready: null, message: null };
  }
  if (provider === "bundled_local") {
    try {
      const status = await (deps.getBundledCleanupModelStatus ?? getBundledCleanupModelStatus)();
      const modelId = privacy.dictationAi.modelId?.trim() || status.modelId;
      if (modelId !== status.modelId) {
        return { ready: false, message: "Choose S1-mini by Superwhisper in Models before using this profile." };
      }
      if (!status.backendPresent) {
        return { ready: false, message: "Built-in cleanup is unavailable in this build." };
      }
      if (!status.ready) {
        return { ready: false, message: "Download and verify S1-mini by Superwhisper in Models before using this profile." };
      }
      if (!status.backendMeetsBudget) {
        return { ready: false, message: "Built-in cleanup cannot finish within the dictation time limit on this Mac." };
      }
      return { ready: true, message: null };
    } catch {
      return { ready: null, message: "Could not check built-in cleanup. Try again." };
    }
  }
  if (provider === "apple_language_model") {
    try {
      const modelId = privacy.dictationAi.modelId?.trim();
      if (modelId && modelId !== "apple-on-device") {
        return { ready: false, message: "Choose the Apple on-device model in Models before using this profile." };
      }
      const status = await (deps.getAppleLanguageModelAvailability ?? getAppleLanguageModelAvailability)();
      return { ready: status.available, message: status.available ? null : status.detail };
    } catch {
      return { ready: null, message: "Could not check the Apple on-device model. Try again." };
    }
  }
  if (provider === "native_text") {
    try {
      const status = await (deps.getNativeTextModelStatus ?? getNativeTextModelStatus)();
      const modelId = privacy.dictationAi.modelId?.trim() || status.modelId;
      if (!status.runtimePresent) {
        return { ready: false, message: "The built-in text model isn't available in this version of Plainsong." };
      }
      if (modelId !== status.modelId) {
        return { ready: false, message: "Choose the managed built-in text model in Models before using this profile." };
      }
      if (!status.ready) {
        return { ready: false, message: "Download and verify the built-in text model before using this profile." };
      }
      if (!status.runtimeHealth) {
        return { ready: null, message: "Plainsong could not check the text model on this Mac. Try again." };
      }
      if (status.runtimeHealth.state !== "available") {
        return {
          ready: status.runtimeHealth.state === "busy" ? null : false,
          message: status.runtimeHealth.message ?? "Local text processing is unavailable. Check its status in Models.",
        };
      }
      if (status.memoryAvailableBytes === null) {
        return { ready: null, message: "Plainsong couldn't check free memory. Check the built-in text model in Models." };
      }
      return {
        ready: status.canLoadNow,
        message: status.canLoadNow ? null : "Not enough free memory right now. Close apps you aren't using, or try again later.",
      };
    } catch {
      return { ready: null, message: "Could not check the built-in text model. Try again." };
    }
  }
  if (provider === "ollama") {
    const readiness = await probeOllamaModelReadiness(privacy.dictationAi.modelId, {
      getRuntimeStatus: deps.getOllamaStatus,
      listInstalledModels: deps.listOllamaModels ?? listOllamaModels,
      listCatalog: deps.listOllamaModelCatalog ?? listOllamaModelCatalog,
      getRuntimeHealth: deps.getLocalTextRuntimeHealth ?? getLocalTextRuntimeHealth,
      remoteProcessingEnabled: privacy.remoteProcessingEnabled,
    });
    return describeOllamaDictationReadiness(readiness);
  }
  return { ready: await probeOtherDictationAiLane(provider, privacy, deps), message: null };
}

async function probeOtherDictationAiLane(
  provider: string,
  privacy: Pick<Settings["privacy"], "dictationAi" | "remoteProcessingEnabled">,
  deps: DictationAiLaneProbeDeps,
): Promise<boolean | null> {
  if (isRemoteAnalysisProvider(provider)) {
    if (!privacy.remoteProcessingEnabled) {
      return false;
    }
    if (provider === CHATGPT_PLAN_PROVIDER) {
      return (deps.getChatGptPlanStatus ?? getChatGptPlanStatus)()
        .then((status) => {
          if (!status.loaded || !status.modelsReady) return null;
          const active = status.accounts.find((account) => account.active);
          const selectedModel = privacy.dictationAi.modelId?.trim() ?? "";
          return Boolean(
            active?.connected &&
            active.planEnabled &&
            selectedModel &&
            status.models.some((model) => model.slug === selectedModel),
          );
        })
        .catch(() => null);
    }
    return deps
      .hasProviderSecret(provider)
      .then((present) => (typeof present === "boolean" ? present : null))
      .catch(() => null);
  }
  return null;
}
