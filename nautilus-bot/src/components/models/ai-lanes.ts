// The two AI lanes, as they are keyed on `Settings["privacy"]`. Dictation
// cleanup runs on every capture behind a short timeout and wants a fast
// model; meeting summaries are batch work that can afford a slower one, so
// each lane picks its own provider and model.
//
// This vocabulary moved out of settings-view-simple.tsx with the pickers: the
// Models screen is now the one place either lane is chosen, and the Settings
// view still imports `describeAnalysisDestination` for the disclosures that
// name where a finished meeting goes.
export const AI_LANE_KEYS = ["dictationAi", "meetingsAi"] as const;
export type AiLaneKey = (typeof AI_LANE_KEYS)[number];

// Every analysis provider we can name, and whether using it sends the
// transcript off this machine. A provider missing from this map is a provider
// we cannot make a claim about -- see `isRemoteAnalysisProvider`.
const ANALYSIS_PROVIDER_DESTINATIONS: Record<
  string,
  { label: string; remote: boolean }
> = {
  // The license on the bundled model requires this exact name wherever it is
  // used: "S1-mini" by "Superwhisper". Do not shorten it.
  bundled_local: { label: "S1-mini by Superwhisper, on this Mac", remote: false },
  apple_language_model: {
    label: "Apple's on-device model on this Mac",
    remote: false,
  },
  ollama: { label: "Ollama on this machine", remote: false },
  openai: { label: "OpenAI", remote: true },
  anthropic: { label: "Anthropic", remote: true },
  gemini: { label: "Google Gemini", remote: true },
  deepseek: { label: "DeepSeek", remote: true },
  "ollama-cloud": { label: "Ollama Cloud", remote: true },
};

export const ANALYSIS_PROVIDER_OPTIONS: ReadonlyArray<{
  value: string;
  label: string;
}> = [
  { value: "bundled_local", label: "Built-in (no setup)" },
  { value: "apple_language_model", label: "Apple on-device model" },
  { value: "ollama", label: "Ollama (on this Mac)" },
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "gemini", label: "Google Gemini" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "ollama-cloud", label: "Ollama Cloud" },
];

/**
 * Providers that can only clean up dictation.
 *
 * The bundled model is a text normalizer -- its own model card says it "is not
 * a chat model and will not follow general instructions" -- and Apple's
 * on-device model shares a 4,096-token window between the prompt and the
 * response, which is smaller than one chunk of a meeting transcript plus its
 * summary. Both refuse meeting work in the sidecar, so offering them in the
 * meetings picker would only be a way to choose a guaranteed failure. Mirrors
 * `Provider::supports_meeting_analysis` in rust-sidecar/src/llm/transport.rs.
 */
const DICTATION_ONLY_ANALYSIS_PROVIDERS = new Set([
  "bundled_local",
  "apple_language_model",
]);

export function isDictationOnlyAnalysisProvider(
  provider: string | undefined,
): boolean {
  return DICTATION_ONLY_ANALYSIS_PROVIDERS.has(provider ?? "");
}

/**
 * Providers that run with nothing installed and no key pasted. Ollama is local
 * but is still a service the user has to install and keep running, so it is
 * not in this set.
 */
export function isZeroSetupAnalysisProvider(
  provider: string | undefined,
): boolean {
  return DICTATION_ONLY_ANALYSIS_PROVIDERS.has(provider ?? "");
}

/** The provider choices a lane may offer. */
export function analysisProviderOptionsForLane(
  lane: AiLaneKey,
): ReadonlyArray<{ value: string; label: string }> {
  if (lane === "meetingsAi") {
    return ANALYSIS_PROVIDER_OPTIONS.filter(
      (option) => !isDictationOnlyAnalysisProvider(option.value),
    );
  }
  return ANALYSIS_PROVIDER_OPTIONS;
}

/**
 * Whether analysis with this provider would leave the machine. Remote
 * providers are refused outright when remote processing is off, so the
 * disclosure must not promise a summary that policy will block.
 *
 * An absent or unrecognized provider returns false on purpose. The old
 * `provider !== "ollama"` shape treated `undefined` as remote, so any drift
 * in the settings schema made the UI announce that transcripts were leaving
 * the machine when they were not. A claim we can't substantiate is worse
 * than no claim, so an unknown provider suppresses the disclosure instead of
 * inventing one; `describeAnalysisDestination` renders it as unknown.
 */
export function isRemoteAnalysisProvider(provider: string | undefined): boolean {
  return ANALYSIS_PROVIDER_DESTINATIONS[provider ?? ""]?.remote ?? false;
}

/**
 * Whether this is a provider we can make any claim about at all.
 *
 * Callers that assert a privacy property ("nothing leaves this machine") need
 * the three-way answer, not the two-way one: an unrecognized provider is not
 * local *and* not remote, it is a settings shape we do not understand, and
 * saying either would be a claim we cannot verify.
 */
export function isKnownAnalysisProvider(provider: string | undefined): boolean {
  return (provider ?? "") in ANALYSIS_PROVIDER_DESTINATIONS;
}

export function describeAnalysisDestination(provider: string | undefined): string {
  return (
    ANALYSIS_PROVIDER_DESTINATIONS[provider ?? ""]?.label ??
    "an AI service this build does not recognize"
  );
}

// The models a provider actually offers for analysis. OpenAI's /models
// endpoint also returns embedding, audio and moderation models, and Google's
// returns non-Gemini endpoints; none of them can write a summary, so they
// never belong in this picker.
// Families that share a completion-model prefix but cannot answer a chat
// completion. An allowlist on "gpt" alone still offered gpt-4o-transcribe and
// gpt-4o-audio-preview, which fail at request time with a provider error the
// user cannot act on.
const NON_COMPLETION_MODEL_MARKERS = [
  "audio",
  "realtime",
  "transcribe",
  "tts",
  "whisper",
  "embedding",
  "embed",
  "moderation",
  "image",
  "dall-e",
  "search",
  "computer-use",
];

function canWriteCompletions(model: string): boolean {
  const normalized = model.toLowerCase();
  return !NON_COMPLETION_MODEL_MARKERS.some((marker) => normalized.includes(marker));
}

export function analysisModelChoices(
  providerName: string,
  models: string[],
): string[] {
  switch (providerName) {
    // Both on-device providers serve exactly one model, and neither has a
    // catalogue endpoint to list it from. Returning nothing here is what tells
    // the lane row to render the fixed-model card instead of a picker.
    case "bundled_local":
    case "apple_language_model":
      return [];
    case "openai":
      return models
        .filter(
          (model) =>
            model.includes("gpt") ||
            model.includes("o1") ||
            model.includes("o3") ||
            model.includes("o4"),
        )
        .filter(canWriteCompletions)
        .sort();
    case "gemini":
      return models.filter((model) => model.includes("gemini")).filter(canWriteCompletions);
    default:
      return models.filter(canWriteCompletions);
  }
}
