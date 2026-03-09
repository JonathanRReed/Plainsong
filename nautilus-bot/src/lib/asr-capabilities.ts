import type { AsrProviderInfo, AsrProviderType } from "@/types";

const DOWNLOADABLE_PROVIDER_SET = new Set<AsrProviderType>([
  "whisper",
  "parakeet",
  "canary",
  "distil_whisper",
  "moonshine",
  "voxtral",
]);

const MEETING_GRADE_PROVIDER_SET = new Set<AsrProviderType>([
  "distil_whisper",
  "parakeet",
  "canary",
  "voxtral",
  "groq",
  "openai_cloud",
  "elevenlabs_scribe",
]);

const DICTATION_ONLY_PROVIDER_SET = new Set<AsrProviderType>([
  "macos_apple_speech",
  "windows_sdk_dictation",
  "moonshine",
  "whisper",
]);

const CLOUD_PROVIDER_SET = new Set<AsrProviderType>([
  "groq",
  "openai_cloud",
  "elevenlabs_scribe",
]);

export function isDownloadableProvider(providerType: AsrProviderType) {
  return DOWNLOADABLE_PROVIDER_SET.has(providerType);
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
      return normalizedModelId.startsWith("parakeet");
    case "canary":
      return normalizedModelId.startsWith("canary");
    case "voxtral":
      return normalizedModelId.startsWith("voxtral");
    case "groq":
    case "openai_cloud":
    case "elevenlabs_scribe":
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
