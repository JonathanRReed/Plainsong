import { isSharedMeetingCompatible } from "@/lib/asr-capabilities";
import {
  mergeSelectionStateUpdate,
  selectionStateFromSettings,
} from "@/lib/asr-route-selection";
import type {
  ModelLaneSelection,
  ModelPreset,
  SpeechRouteTarget,
} from "@/components/models/model-presets";
import type { AsrProviderInfo, AsrProviderInventory } from "@/types";
import type { Settings } from "@/types/settings";

export type SpeechLane = "dictation" | "meeting";

type RouteSelectableProvider = AsrProviderInfo | AsrProviderInventory;

const GGUF_PROVIDER = "transcribe_cpp";

/** ONNX Parakeet v3: the same weights as GGUF Parakeet, on the processor. */
const GGUF_SUBSTITUTE_ROUTE: SpeechRouteTarget = {
  providerType: "parakeet",
  modelId: "parakeet-tdt-0.6b-v3",
};

function sameRoute(left: SpeechRouteTarget, right: SpeechRouteTarget): boolean {
  return (
    left.providerType === right.providerType && left.modelId === right.modelId
  );
}

/** The two speech lanes as they currently read out of settings. */
export function readLaneSelection(
  providerList: RouteSelectableProvider[],
  settings: Settings,
): ModelLaneSelection {
  const state = selectionStateFromSettings(providerList, settings.transcription);

  return {
    dictationSpeech: {
      providerType: state.dictationProvider,
      modelId: state.dictationModelId,
    },
    meetingSpeech: {
      providerType: state.meetingProvider,
      modelId: state.meetingModelId,
    },
  };
}

/**
 * Write a dictation/meeting speech pair into settings.
 *
 * `useSharedAsrSelection` is derived, not asked for: the rest of the app reads
 * it to decide whether the per-lane fields are live at all, so leaving it
 * saying "shared" while the two lanes point at different models would make the
 * meeting lane silently unreachable. Two identical, meeting-capable lanes are
 * shared; anything else is split.
 *
 * The shared default never names a transcribe.cpp (GGUF) route, the same shape
 * `Settings::fresh_install` writes: it is the sidecar's fallback when a lane
 * cannot run, and the fallback for a missing GGUF model is ONNX Parakeet, the
 * same weights on the processor. So GGUF lanes are always split, and the
 * default names ONNX Parakeet while dictation runs on GGUF.
 */
function withSpeechPair(
  settings: Settings,
  providerList: RouteSelectableProvider[],
  dictation: SpeechRouteTarget,
  meeting: SpeechRouteTarget,
): Settings {
  const current = selectionStateFromSettings(providerList, settings.transcription);
  const dictationIsGguf = dictation.providerType === GGUF_PROVIDER;
  const shared =
    !dictationIsGguf &&
    sameRoute(dictation, meeting) &&
    isSharedMeetingCompatible(dictation.providerType, dictation.modelId);
  // The "default" route is what every fallback in asr-route-selection reads
  // when a lane cannot be honoured, so it mirrors dictation rather than being
  // left pointing at whatever was selected before -- except that it never
  // names GGUF (see above).
  const defaultRoute = dictationIsGguf ? GGUF_SUBSTITUTE_ROUTE : dictation;

  const next = mergeSelectionStateUpdate(providerList, current, {
    useSharedAsrSelection: shared,
    defaultProvider: defaultRoute.providerType,
    defaultModelId: defaultRoute.modelId,
    dictationProvider: dictation.providerType,
    dictationModelId: dictation.modelId,
    meetingProvider: meeting.providerType,
    meetingModelId: meeting.modelId,
  });

  return {
    ...settings,
    transcription: {
      ...settings.transcription,
      useSharedAsrSelection: next.useSharedAsrSelection,
      defaultProvider: next.defaultProvider,
      selectedModelId: next.defaultModelId,
      dictationProvider: next.dictationProvider,
      dictationModelId: next.dictationModelId,
      meetingProvider: next.meetingProvider,
      meetingModelId: next.meetingModelId,
      meetingRoutePolicy: next.meetingRoutePolicy,
    },
  };
}

export function withSpeechLaneRoute(
  settings: Settings,
  providerList: RouteSelectableProvider[],
  lane: SpeechLane,
  target: SpeechRouteTarget,
): Settings {
  const selection = readLaneSelection(providerList, settings);

  return withSpeechPair(
    settings,
    providerList,
    lane === "dictation" ? target : selection.dictationSpeech,
    lane === "meeting" ? target : selection.meetingSpeech,
  );
}

/**
 * Both speech lanes at once, in one write.
 *
 * `settings.privacy` is passed through untouched on purpose. An earlier
 * version rewrote both AI lanes to the preset's provider, which meant a user
 * who had deliberately pointed meeting notes at Anthropic lost that provider
 * *and* its model id to a tile whose whole label was about speech — and when
 * the replacement provider had listed no models yet, the lane was left naming
 * no model at all. Presets say what they set; the AI lanes are set in their
 * own rows.
 */
export function withModelPreset(
  settings: Settings,
  providerList: RouteSelectableProvider[],
  preset: ModelPreset,
): Settings {
  return withSpeechPair(
    settings,
    providerList,
    preset.dictationSpeech,
    preset.meetingSpeech,
  );
}
