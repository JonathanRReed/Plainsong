import { isRemoteAnalysisProvider } from "@/components/models/ai-lanes";
import type { LocalTextRuntimeStatus, OllamaCatalogEntry } from "@/lib/backend/ai";
import { describeOllamaDictationReadiness, type DictationAiLaneReadiness } from "@/lib/dictation-translation";
import {
  DEFAULT_OLLAMA_MODEL_ID,
  probeOllamaModelReadiness,
} from "@/lib/ollama-model-readiness";

export const DEFAULT_OLLAMA_REWRITE_MODEL = DEFAULT_OLLAMA_MODEL_ID;

export type DictationRewriteReadiness = {
  title: string;
  message: string;
  tone: "rust" | "muted";
  role: "alert" | "status";
} | null;

const CLEANUP_ONLY_PROVIDERS = new Set([
  "bundled_local",
  "apple_language_model",
]);

export function dictationModeNeedsRewrite(input: {
  profile: "normal_speed" | "power_rewrite";
  customPrompt?: string | null;
}): boolean {
  return (
    input.profile === "power_rewrite" ||
    Boolean(input.customPrompt?.trim())
  );
}

export function resolveDictationCleanupReadiness(input: {
  aiFormattingEnabled: boolean;
  needsRewrite: boolean;
  readinessMatchesCapture: boolean;
  aiLaneReady: boolean | null;
  aiLaneMessage?: string | null;
}): DictationRewriteReadiness {
  if (!input.aiFormattingEnabled || input.needsRewrite
    || !input.readinessMatchesCapture || input.aiLaneReady !== false) return null;
  return {
    title: "AI cleanup is unavailable",
    message: ["Basic local formatting will be used.", input.aiLaneMessage].filter(Boolean).join(" "),
    tone: "muted",
    role: "status",
  };
}

export async function probeOllamaRewriteReadiness(
  modelId: string | null | undefined,
  listInstalledModels: () => Promise<string[]>,
  listCatalog: () => Promise<OllamaCatalogEntry[]>,
  options: {
    getRuntimeHealth?: (modelId: string) => Promise<LocalTextRuntimeStatus>;
    remoteProcessingEnabled?: boolean;
  } = {},
): Promise<DictationAiLaneReadiness> {
  const readiness = await probeOllamaModelReadiness(modelId, {
    // Inventory calls fail to unknown when Ollama is unreachable. A usable
    // model also needs execution eligibility and permission for remote aliases.
    getRuntimeStatus: async () => true,
    listInstalledModels,
    listCatalog,
    ...options,
  });
  return describeOllamaDictationReadiness(readiness);
}

export async function probeOllamaRewriteModel(
  ...args: Parameters<typeof probeOllamaRewriteReadiness>
): Promise<boolean | null> {
  return (await probeOllamaRewriteReadiness(...args)).ready;
}

export function resolveDictationRewriteReadiness(input: {
  needsRewrite: boolean;
  profileName: string;
  provider?: string | null;
  remoteProcessingEnabled: boolean;
  aiLaneReady: boolean | null;
  aiLaneMessage?: string | null;
}): DictationRewriteReadiness {
  if (!input.needsRewrite) {
    return null;
  }

  const provider = input.provider?.trim() ?? "";
  if (!provider) {
    return {
      title: `${input.profileName} needs a rewrite model`,
      message:
        "Choose Ollama on this Mac or an optional cloud model. General dictation cleanup still works without one.",
      tone: "rust",
      role: "alert",
    };
  }

  if (CLEANUP_ONLY_PROVIDERS.has(provider)) {
    return {
      title: `${input.profileName} needs a rewrite model`,
      message:
        "The selected on-device model can clean up dictation, but it cannot follow rewrite instructions. Choose Ollama on this Mac or an optional cloud model.",
      tone: "rust",
      role: "alert",
    };
  }

  if (isRemoteAnalysisProvider(provider) && !input.remoteProcessingEnabled) {
    return {
      title: "Cloud rewriting is off",
      message:
        "Remote processing is disabled. Choose Ollama for local rewriting, or enable remote processing before using this cloud model.",
      tone: "rust",
      role: "alert",
    };
  }

  if (input.aiLaneReady === false) {
    return {
      title: provider === "ollama" ? "Ollama is not ready" : "Rewrite model is not ready",
      message:
        input.aiLaneMessage ?? (provider === "ollama"
          ? "Start Ollama and choose an installed model before using this profile. General dictation cleanup still works."
          : provider === "native_text"
            ? "The built-in text model is not ready. Check model and memory in Models."
            : "The selected provider cannot answer yet. Review its model and credentials before using this profile."),
      tone: "rust",
      role: "alert",
    };
  }

  if (input.aiLaneReady === null) {
    return {
      title: input.aiLaneMessage ? "Rewrite model is not ready" : "Checking rewrite model",
      message: input.aiLaneMessage ?? "Plainsong is checking whether the selected model can run this profile.",
      tone: "muted",
      role: "status",
    };
  }

  return null;
}
