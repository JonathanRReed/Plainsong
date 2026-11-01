import type { AsrProviderInfo, AsrProviderType } from "@/types";
import { providerHostingPreference, type DictationRoutePreference } from "@/lib/asr-capabilities";
import { buildProductReadinessSnapshot, type ProductReadinessEvidence, type ReadinessAssessment } from "@/features/readiness/product-readiness";

// The backend tries configured providers, then these defaults. A provider
// outside that set cannot rescue a one-off capture merely because it is ready.
const DEFAULT_CANDIDATES: AsrProviderType[] = [
  "distil_whisper", "macos_apple_speech", "windows_sdk_dictation", "whisper",
  "moonshine", "parakeet", "whisper_candle", "openai_cloud", "elevenlabs_scribe", "groq",
];

// In-app captures never send a paste to another app. Their readiness must
// still include the speech route, microphone and source observations.
export function assessInAppDictationCapture(evidence: ProductReadinessEvidence): ReadinessAssessment {
  return buildProductReadinessSnapshot({ ...evidence, cursorInsertionRequired: false }).dictation;
}

export function assessOneOffDictationCapture({
  evidence, providers, preference, remoteProcessingEnabled, configuredProviders,
  requestedProvider, deliveryMode = "system",
}: {
  evidence: ProductReadinessEvidence | null | undefined;
  providers: AsrProviderInfo[];
  preference: DictationRoutePreference;
  remoteProcessingEnabled: boolean;
  configuredProviders: Array<string | null | undefined>;
  requestedProvider: string | null | undefined;
  deliveryMode?: "system" | "preview";
}): ReadinessAssessment {
  if (!evidence) return {
    domain: "dictation", state: "unknown",
    cause: { id: "source_unavailable", message: "Plainsong is still checking this capture route.",
      action: { id: "retry", label: "Check again", destination: "setup" } },
  };
  const allowed = new Set<string>([...DEFAULT_CANDIDATES, ...configuredProviders.filter((id): id is string => Boolean(id))]);
  const privacyBlocked = preference === "cloud" && !remoteProcessingEnabled;
  const ready = !privacyBlocked && providers.some(provider =>
    allowed.has(provider.providerType) && provider.isAvailable && provider.inferenceEnabled &&
    provider.runtimeStatus === "ready" && providerHostingPreference(provider.providerType) === preference &&
    provider.providerType !== "moonshine" &&
    // Apple Speech has no automatic substitution when explicitly requested.
    (requestedProvider !== "macos_apple_speech" || preference !== "local" ||
      (provider.providerType === "macos_apple_speech" && evidence.dictationRouteReady === true))
  );
  return buildProductReadinessSnapshot({ ...evidence,
    cursorInsertionRequired: deliveryMode === "preview" ? false : evidence.cursorInsertionRequired,
    dictationRouteReady: ready,
    dictationRouteReason: privacyBlocked
      ? "Remote processing is disabled. Choose This Mac or enable remote processing before a cloud capture."
      : ready ? null : `No ${preference === "cloud" ? "cloud" : "local"} speech route is ready for this capture. Review models to prepare one.`,
  }).dictation;
}
