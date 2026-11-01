import {
  FLUID_SPEECH_MINI_MODEL_ID,
  UNDERDOG_BARK_PRO_MODEL_ID,
} from "@/lib/asr-capabilities";
import {
  ONNX_PARAKEET_ROUTE,
  RECOMMENDED_SPEECH_ROUTE,
  isOnnxParakeetRoute,
  isRecommendedSpeechRoute,
  routeIdFor,
  type AsrRouteCatalogEntry,
} from "@/lib/asr-route-catalog";
import { compareStrings } from "@/lib/format-locale";

export type SpeechChoiceLane = "dictation" | "meeting";

/**
 * One distinct speech model a picker offers: the recommended one, or one of
 * the others this Mac can run, each with the one thing that sets it apart.
 */
export interface SpeechChoice {
  route: AsrRouteCatalogEntry;
  recommended: boolean;
  /** What sets this model apart, in a few words. No chips, formats or engines. */
  note: string;
  sizeMib: number | null;
}

/**
 * Optional English models that the catalog sorts with the experimental
 * routes (they are never recommended or inherited) but that are offered
 * beside the main models: they are finished models with a measured reason to
 * choose them, not previews.
 */
const OPTIONAL_LOCAL_ROUTE_IDS: ReadonlySet<string> = new Set([
  routeIdFor("transcribe_cpp", FLUID_SPEECH_MINI_MODEL_ID),
  routeIdFor("transcribe_cpp", UNDERDOG_BARK_PRO_MODEL_ID),
]);

const PARAKEET_V3_NOTE = "Dictation and meetings in one download, 25 European languages";

/**
 * What sets each model apart from the others, short enough for one line.
 * Each note says the difference a reader would choose it for; the full
 * trade-off lives in Settings > Models.
 */
const SPEECH_CHOICE_NOTES: Readonly<Record<string, string>> = {
  [routeIdFor(RECOMMENDED_SPEECH_ROUTE.providerType, RECOMMENDED_SPEECH_ROUTE.modelId)]:
    PARAKEET_V3_NOTE,
  [routeIdFor(ONNX_PARAKEET_ROUTE.providerType, ONNX_PARAKEET_ROUTE.modelId)]: PARAKEET_V3_NOTE,
  "whisper:tiny": "Smallest download, about 100 languages",
  "whisper:tiny.en": "Smallest download, English only",
  "whisper:base": "Small download, about 100 languages",
  "whisper:base.en": "Small download, English only",
  "whisper:small": "Mid-size download, about 100 languages",
  "whisper:small.en": "Mid-size download, English only",
  "whisper:medium": "Large download, about 100 languages, slower",
  "whisper:medium.en": "Large download, English only, slower",
  "whisper:large-v3-turbo": "About 100 languages, larger download",
  "whisper:large-v3": "Largest Whisper, about 100 languages, slowest",
  "distil_whisper:distil-large-v3.5": "English only, large download, slower on long meetings",
  "moonshine:moonshine-tiny": "Tiny English download, for very short phrases",
  "moonshine:moonshine-base": "Small English download, for short phrases",
  [routeIdFor("transcribe_cpp", FLUID_SPEECH_MINI_MODEL_ID)]:
    "English only. Fewer stray words when someone else talks nearby in our synthetic audio tests; can miss very short replies.",
  [routeIdFor("transcribe_cpp", UNDERDOG_BARK_PRO_MODEL_ID)]:
    "English only. Did better on short distant-microphone meeting clips in our tests; dictation may lose capitals and punctuation.",
};

/** Engines built into the operating system, whatever model id they report. */
const PLATFORM_NOTES: Partial<Record<AsrRouteCatalogEntry["providerType"], string>> = {
  macos_apple_speech: "Built into macOS, nothing to download",
  windows_sdk_dictation: "Built into Windows, nothing to download",
};

/**
 * The model the app recommends: GGUF Parakeet wherever this build lists it
 * (Apple Silicon), ONNX Parakeet everywhere else. Null when neither can run.
 */
export function recommendedSpeechRoute(
  routes: readonly AsrRouteCatalogEntry[],
): AsrRouteCatalogEntry | null {
  const runnable = (route: AsrRouteCatalogEntry) => route.readiness !== "unavailable";
  return (
    routes.find(
      (route) => runnable(route) && isRecommendedSpeechRoute(route.providerType, route.modelId),
    ) ??
    routes.find(
      (route) =>
        runnable(route) &&
        !route.superseded &&
        isOnnxParakeetRoute(route.providerType, route.modelId),
    ) ??
    null
  );
}

/**
 * Whether a route is one of the distinct models a picker lists for a lane:
 * a model on this Mac (cloud services are chosen in their own section),
 * runnable by this build, not experimental (the two optional English models
 * excepted), and never the ONNX build of Parakeet v3 where the GGUF build
 * can run.
 */
function isMainSpeechChoice(route: AsrRouteCatalogEntry, lane: SpeechChoiceLane): boolean {
  return (
    route.laneCompatibility[lane] &&
    route.hosting !== "cloud" &&
    !route.superseded &&
    route.readiness !== "unavailable" &&
    // Apple Speech is listed while it waits on a permission (Settings says
    // which); any other built-in engine only where it actually runs, so a
    // Mac never lists Windows' engine.
    (route.hosting !== "platform" ||
      route.providerType === "macos_apple_speech" ||
      route.readiness === "ready") &&
    (!route.experimental || OPTIONAL_LOCAL_ROUTE_IDS.has(route.routeId))
  );
}

/**
 * The one-line difference for a route. Whether it also records meetings is
 * said once, by the section it is listed under (`groupSpeechChoices`), not
 * repeated on every line.
 */
function speechChoiceNote(route: AsrRouteCatalogEntry): string {
  return (
    SPEECH_CHOICE_NOTES[route.routeId] ??
    PLATFORM_NOTES[route.providerType] ??
    route.capability?.languages.label ??
    route.summary.replace(/\.$/, "")
  );
}

/**
 * Every distinct model this Mac can run for a lane: the recommended one
 * first, then the rest from smallest download to largest (nothing to
 * download sorts first). No model appears twice.
 */
export function speechChoicesForLane(
  routes: readonly AsrRouteCatalogEntry[],
  lane: SpeechChoiceLane,
): SpeechChoice[] {
  const recommended = recommendedSpeechRoute(routes);
  const seen = new Set<string>();
  const choices: SpeechChoice[] = [];
  for (const route of routes) {
    if (seen.has(route.routeId) || !isMainSpeechChoice(route, lane)) {
      continue;
    }
    seen.add(route.routeId);
    choices.push({
      route,
      recommended: route.routeId === recommended?.routeId,
      note: speechChoiceNote(route),
      sizeMib: route.capability?.sizeMib ?? (route.hosting === "platform" ? 0 : null),
    });
  }
  return choices.sort((left, right) => {
    if (left.recommended !== right.recommended) {
      return left.recommended ? -1 : 1;
    }
    const sizeDelta =
      (left.sizeMib ?? Number.MAX_SAFE_INTEGER) - (right.sizeMib ?? Number.MAX_SAFE_INTEGER);
    return sizeDelta !== 0 ? sizeDelta : compareStrings(left.route.label, right.route.label);
  });
}

/**
 * The route a picker shows for what a slot names: GGUF Parakeet in place of
 * the ONNX build where the GGUF build can run, so a slot still on the ONNX
 * build reads as Parakeet v3 rather than as a second model.
 */
export function canonicalSpeechRoute(
  routes: readonly AsrRouteCatalogEntry[],
  route: AsrRouteCatalogEntry | null,
): AsrRouteCatalogEntry | null {
  if (!route?.superseded) {
    return route;
  }
  return (
    routes.find((candidate) =>
      isRecommendedSpeechRoute(candidate.providerType, candidate.modelId),
    ) ?? route
  );
}

/**
 * A dictation list split the way a reader decides: the models that also
 * transcribe meetings (recommended first), then the ones for dictation only.
 * Meeting capability is the catalog's own `laneCompatibility.meeting`, the
 * same answer the meetings list is built from. Order within each section is
 * kept.
 */
export function groupSpeechChoices<T extends { route: AsrRouteCatalogEntry }>(
  choices: readonly T[],
): { dictationAndMeetings: T[]; dictationOnly: T[] } {
  return {
    dictationAndMeetings: choices.filter((choice) => choice.route.laneCompatibility.meeting),
    dictationOnly: choices.filter((choice) => !choice.route.laneCompatibility.meeting),
  };
}

/**
 * The meetings model to offer beside a dictation-only choice: the model
 * meetings already use when it is on this Mac, else any meeting model already
 * here (recommended first), else the one meetings name, else the recommended
 * one. A model already on this Mac costs nothing, so it wins over a download.
 */
export function defaultMeetingChoice(
  meetingChoices: readonly SpeechChoice[],
  available: (route: AsrRouteCatalogEntry) => boolean,
  configuredRouteId: string | null,
): SpeechChoice | null {
  const configured = meetingChoices.find((choice) => choice.route.routeId === configuredRouteId);
  if (configured && available(configured.route)) {
    return configured;
  }
  return (
    meetingChoices.find((choice) => choice.recommended && available(choice.route)) ??
    meetingChoices.find((choice) => available(choice.route)) ??
    configured ??
    meetingChoices.find((choice) => choice.recommended) ??
    meetingChoices[0] ??
    null
  );
}
