import type { AsrProviderInfo, AsrProviderType } from "@/types";

export type DictationRoutePreference = "local" | "cloud";

const HIDDEN_PROVIDER_SET = new Set<AsrProviderType>(["mlx_audio"]);
const MLX_ACCELERATABLE_PROVIDER_SET = new Set<AsrProviderType>([
  "moonshine",
  "whisper",
  "parakeet",
  "voxtral",
]);

const DOWNLOADABLE_PROVIDER_SET = new Set<AsrProviderType>([
  "whisper",
  "parakeet",
  "whisper_candle",
  "distil_whisper",
  "moonshine",
  "voxtral",
]);

const MEETING_GRADE_PROVIDER_SET = new Set<AsrProviderType>([
  "distil_whisper",
  "parakeet",
  "voxtral",
  "groq",
  "openai_cloud",
  "elevenlabs_scribe",
  "cohere_transcribe",
]);

const DICTATION_ONLY_PROVIDER_SET = new Set<AsrProviderType>([
  "macos_apple_speech",
  "windows_sdk_dictation",
  "moonshine",
  "whisper",
  "whisper_candle",
]);

const CLOUD_PROVIDER_SET = new Set<AsrProviderType>([
  "groq",
  "openai_cloud",
  "elevenlabs_scribe",
  "cohere_transcribe",
]);

export function isDownloadableProvider(providerType: AsrProviderType) {
  return DOWNLOADABLE_PROVIDER_SET.has(providerType);
}

export function isVisibleAsrProvider(providerType: AsrProviderType) {
  return !HIDDEN_PROVIDER_SET.has(providerType);
}

export function providerCanUseMlxAcceleration(providerType: AsrProviderType) {
  return MLX_ACCELERATABLE_PROVIDER_SET.has(providerType);
}

export function mlxMappedModelId(
  providerType: AsrProviderType,
  modelId: string | null | undefined
) {
  const normalized = (modelId ?? "").trim();
  switch (providerType) {
    case "moonshine":
      if (normalized === "moonshine-tiny") return "UsefulSensors/moonshine-tiny";
      if (normalized === "moonshine-base" || normalized === "moonshine") {
        return "UsefulSensors/moonshine-base";
      }
      return null;
    case "whisper":
      switch (normalized) {
        case "tiny":
          return "mlx-community/whisper-tiny-asr-fp16";
        case "tiny.en":
          return "mlx-community/whisper-tiny.en-asr-fp16";
        case "base":
          return "mlx-community/whisper-base-asr-fp16";
        case "base.en":
          return "mlx-community/whisper-base.en-asr-fp16";
        case "small":
          return "mlx-community/whisper-small-asr-fp16";
        case "small.en":
          return "mlx-community/whisper-small.en-asr-fp16";
        case "medium":
          return "mlx-community/whisper-medium-asr-fp16";
        case "medium.en":
          return "mlx-community/whisper-medium.en-asr-fp16";
        case "large-v3":
          return "mlx-community/whisper-large-v3-asr-fp16";
        case "large-v3-turbo":
          return "mlx-community/whisper-large-v3-turbo-asr-fp16";
        default:
          return null;
      }
    case "parakeet":
      if (normalized === "parakeet-ctc-0.6b" || normalized === "parakeet-tdt-0.6b-v3") {
        return "mlx-community/parakeet-tdt-0.6b-v3";
      }
      return null;
    case "voxtral":
      if (normalized === "voxtral-local") return "mlx-community/Voxtral-Mini-3B-2507-bf16";
      return null;
    default:
      return null;
  }
}

export function modelSupportsMlxAcceleration(
  providerType: AsrProviderType,
  modelId: string | null | undefined
) {
  return mlxMappedModelId(providerType, modelId) !== null;
}

export function visibleRouteForMlxModel(modelId: string | null | undefined): {
  providerType: AsrProviderType;
  modelId: string;
} | null {
  const normalized = (modelId ?? "").trim();
  switch (normalized) {
    case "UsefulSensors/moonshine-tiny":
      return { providerType: "moonshine", modelId: "moonshine-tiny" };
    case "UsefulSensors/moonshine-base":
      return { providerType: "moonshine", modelId: "moonshine-base" };
    case "mlx-community/whisper-tiny-asr-fp16":
      return { providerType: "whisper", modelId: "tiny" };
    case "mlx-community/whisper-tiny.en-asr-fp16":
      return { providerType: "whisper", modelId: "tiny.en" };
    case "mlx-community/whisper-base-asr-fp16":
      return { providerType: "whisper", modelId: "base" };
    case "mlx-community/whisper-base.en-asr-fp16":
      return { providerType: "whisper", modelId: "base.en" };
    case "mlx-community/whisper-small-asr-fp16":
      return { providerType: "whisper", modelId: "small" };
    case "mlx-community/whisper-small.en-asr-fp16":
      return { providerType: "whisper", modelId: "small.en" };
    case "mlx-community/whisper-medium-asr-fp16":
      return { providerType: "whisper", modelId: "medium" };
    case "mlx-community/whisper-medium.en-asr-fp16":
      return { providerType: "whisper", modelId: "medium.en" };
    case "mlx-community/whisper-large-v3-asr-fp16":
      return { providerType: "whisper", modelId: "large-v3" };
    case "mlx-community/whisper-large-v3-turbo-asr-fp16":
      return { providerType: "whisper", modelId: "large-v3-turbo" };
    case "mlx-community/parakeet-tdt-0.6b-v3":
      return { providerType: "parakeet", modelId: "parakeet-ctc-0.6b" };
    case "mlx-community/Voxtral-Mini-3B-2507-bf16":
      return { providerType: "voxtral", modelId: "voxtral-local" };
    default:
      return null;
  }
}

export function isMeetingGradeProvider(providerType: AsrProviderType) {
  return MEETING_GRADE_PROVIDER_SET.has(providerType);
}

export function isDictationOnlyProvider(providerType: AsrProviderType) {
  return DICTATION_ONLY_PROVIDER_SET.has(providerType);
}

export function isCloudProvider(providerType: AsrProviderType) {
  return CLOUD_PROVIDER_SET.has(providerType);
}

export function providerHostingPreference(
  providerType: AsrProviderType,
  modelId?: string | null
): DictationRoutePreference {
  if (providerType === "voxtral" && (modelId ?? "").trim() === "voxtral-cloud") {
    return "cloud";
  }

  return isCloudProvider(providerType) ? "cloud" : "local";
}

export function isMeetingEligibleProvider(providerType: AsrProviderType) {
  return !isDictationOnlyProvider(providerType);
}

export function isMeetingEligibleModel(providerType: AsrProviderType, modelId: string) {
  if (!isMeetingEligibleProvider(providerType)) {
    return false;
  }

  const normalizedModelId = modelId.trim().toLowerCase();
  if (!normalizedModelId) {
    return true;
  }

  switch (providerType) {
    case "distil_whisper":
      return normalizedModelId.startsWith("distil");
    case "parakeet":
      return normalizedModelId.startsWith("parakeet-ctc");
    case "mlx_audio":
      return !normalizedModelId.includes("moonshine");
    case "voxtral":
      return normalizedModelId.startsWith("voxtral");
    case "groq":
    case "openai_cloud":
    case "elevenlabs_scribe":
    case "cohere_transcribe":
      return true;
    default:
      return false;
  }
}

export function isSharedMeetingCompatible(providerType: AsrProviderType, modelId: string) {
  return isMeetingEligibleProvider(providerType) && isMeetingEligibleModel(providerType, modelId);
}

export function providerCapabilityLabel(providerType: AsrProviderType) {
  if (isMeetingGradeProvider(providerType)) {
    return "Meeting-grade";
  }

  if (isDictationOnlyProvider(providerType)) {
    return "Dictation-only";
  }

  return "General";
}

export function providerHostingLabel(providerType: AsrProviderType) {
  return isCloudProvider(providerType) ? "Cloud" : "Local";
}

export function providerRecommendation(provider: AsrProviderInfo) {
  if (isMeetingGradeProvider(provider.providerType)) {
    if (provider.runtimeStatus === "ready" && provider.inferenceEnabled) {
      return "Ready for meeting-grade transcription.";
    }
    return "Best used for meetings once the runtime is ready.";
  }

  if (isDictationOnlyProvider(provider.providerType)) {
    return "Best used for fast dictation, not meeting transcription.";
  }

  return "Available for general transcription once the runtime is ready.";
}

export function providerActionLabel(provider: AsrProviderInfo) {
  if (provider.runtimeStatus === "missing_model" && isDownloadableProvider(provider.providerType)) {
    return "Download";
  }

  if (provider.runtimeStatus === "missing_runtime") {
    return "Fix setup";
  }

  return "Re-check";
}
