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
  { value: "ollama", label: "Ollama (on this Mac)" },
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "gemini", label: "Google Gemini" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "ollama-cloud", label: "Ollama Cloud" },
];

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

export function describeAnalysisDestination(provider: string | undefined): string {
  return (
    ANALYSIS_PROVIDER_DESTINATIONS[provider ?? ""]?.label ??
    "an unrecognized analysis provider"
  );
}

// The models a provider actually offers for analysis. OpenAI's /models
// endpoint also returns embedding, audio and moderation models, and Google's
// returns non-Gemini endpoints; none of them can write a summary, so they
// never belong in this picker.
export function analysisModelChoices(
  providerName: string,
  models: string[],
): string[] {
  switch (providerName) {
    case "openai":
      return models
        .filter(
          (model) =>
            model.includes("gpt") ||
            model.includes("o1") ||
            model.includes("o3") ||
            model.includes("o4"),
        )
        .sort();
    case "gemini":
      return models.filter((model) => model.includes("gemini"));
    default:
      return models;
  }
}
