import { getLocalTextRuntimeHealth, type OllamaCatalogEntry, type LocalTextRuntimeStatus } from "@/lib/backend/ai";

export const DEFAULT_OLLAMA_MODEL_ID = "qwen3.5:4b";

export interface OllamaModelReadiness {
  modelId: string;
  runtimeReady: boolean | null;
  modelReady: boolean | null;
  executionReady: boolean | null;
  executionMessage: string | null;
}

export async function probeOllamaModelReadiness(
  selectedModelId: string | null | undefined,
  dependencies: {
    getRuntimeStatus: () => Promise<boolean>;
    listInstalledModels: () => Promise<string[]>;
    listCatalog: () => Promise<OllamaCatalogEntry[]>;
    getRuntimeHealth?: (modelId: string) => Promise<LocalTextRuntimeStatus>;
    remoteProcessingEnabled?: boolean;
  },
): Promise<OllamaModelReadiness> {
  const modelId = selectedModelId?.trim() || DEFAULT_OLLAMA_MODEL_ID;
  let runtimeReady: boolean | null;
  try {
    const status = await dependencies.getRuntimeStatus();
    runtimeReady = typeof status === "boolean" ? status : null;
  } catch {
    runtimeReady = null;
  }
  if (runtimeReady !== true) {
    return { modelId, runtimeReady, modelReady: null, executionReady: null, executionMessage: null };
  }

  try {
    const [installedModels, catalog] = await Promise.all([
      dependencies.listInstalledModels(),
      dependencies.listCatalog(),
    ]);
    if (!installedModels.includes(modelId)) {
      return { modelId, runtimeReady: true, modelReady: false, executionReady: null, executionMessage: null };
    }
    const curated = catalog.find((entry) => entry.id === modelId);
    const modelReady = curated ? curated.installed && curated.ready : true;
    if (!modelReady) {
      return { modelId, runtimeReady: true, modelReady: false, executionReady: null, executionMessage: null };
    }
    const status = await (dependencies.getRuntimeHealth ?? getLocalTextRuntimeHealth)(modelId).catch(() => null);
    let executionReady: boolean | null = null;
    let executionMessage: string | null = "Plainsong could not confirm where the selected Ollama model runs.";
    if (status?.localGateApplies === true) {
      executionReady = status.runtimeHealth.state === "available" ? true
        : status.runtimeHealth.state === "busy" ? null : false;
      executionMessage = status.runtimeHealth.message;
    } else if (status?.localGateApplies === false) {
      executionReady = dependencies.remoteProcessingEnabled === true;
      executionMessage = executionReady ? "The selected Ollama model runs remotely with your permission." : "The selected Ollama model runs remotely, but remote processing is disabled.";
    }
    return {
      modelId,
      runtimeReady: true,
      modelReady,
      executionReady,
      executionMessage,
    };
  } catch {
    return { modelId, runtimeReady: true, modelReady: null, executionReady: null, executionMessage: null };
  }
}
