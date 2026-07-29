import {
  isKnownAsrProvider,
  isMeetingEligibleModel as sharedIsMeetingEligibleModel,
  isMeetingEligibleProvider,
  isSharedMeetingCompatible,
} from "@/lib/asr-capabilities";
import { laneProviderOrder } from "@/lib/asr-route-catalog";
import type {
  AsrProviderInfo,
  AsrProviderInventory,
  AsrProviderType,
  TranscriptionSettings,
} from "@/types";

export interface AsrRouteSelectionState {
  defaultProvider: AsrProviderType;
  defaultModelId: string;
  useSharedAsrSelection: boolean;
  dictationProvider: AsrProviderType;
  dictationModelId: string;
  meetingProvider: AsrProviderType;
  meetingModelId: string;
  meetingRoutePolicy: "prefer_local" | "best_available";
}

type RouteSelectableProvider = Pick<AsrProviderInfo, "providerType" | "modelOptions">;
type RouteSelectableInventory = RouteSelectableProvider | AsrProviderInventory;

type AsrRouteSelectionUpdate = Partial<AsrRouteSelectionState>;

// Matches settings.rs's Settings::default() -- whisper.cpp base.en is the
// deliberately fast documented default; this is only the fallback-of-last-
// resort when settings carry no parseable provider/model at all.
const DEFAULT_PROVIDER: AsrProviderType = "whisper";
const DEFAULT_MODEL_ID = "base.en";
function normalizeMeetingRoutePolicy(
  policy: string | null | undefined
): "prefer_local" | "best_available" {
  return policy === "best_available" ? "best_available" : "prefer_local";
}

function modelOptionsForProvider(
  providerList: RouteSelectableInventory[],
  providerType: AsrProviderType
) {
  return providerList.find((provider) => provider.providerType === providerType)?.modelOptions ?? [];
}

function firstModelIdForProvider(
  providerList: RouteSelectableInventory[],
  providerType: AsrProviderType
) {
  return modelOptionsForProvider(providerList, providerType)[0]?.id ?? providerType;
}

function knownModelForProvider(
  providerList: RouteSelectableInventory[],
  providerType: AsrProviderType,
  modelId: string
) {
  const normalizedModelId = modelId.trim();
  if (!normalizedModelId) {
    return true;
  }

  return modelOptionsForProvider(providerList, providerType).some(
    (option) => option.id === normalizedModelId
  );
}

function isMeetingEligibleModel(
  providerList: RouteSelectableInventory[],
  providerType: AsrProviderType,
  modelId: string
) {
  return (
    sharedIsMeetingEligibleModel(providerType, modelId) &&
    knownModelForProvider(providerList, providerType, modelId)
  );
}

function isListBackedSharedMeetingCompatible(
  providerList: RouteSelectableInventory[],
  providerType: AsrProviderType,
  modelId: string
) {
  return (
    isSharedMeetingCompatible(providerType, modelId) &&
    knownModelForProvider(providerList, providerType, modelId)
  );
}

function normalizeProviderModelSelection(
  providerList: RouteSelectableInventory[],
  providerType: AsrProviderType,
  modelId: string
) {
  if (knownModelForProvider(providerList, providerType, modelId)) {
    return {
      providerType,
      modelId: modelId.trim() || firstModelIdForProvider(providerList, providerType),
    };
  }

  return {
    providerType,
    modelId: firstModelIdForProvider(providerList, providerType),
  };
}

function preferredMeetingProviderCandidates(
  meetingRoutePolicy: "prefer_local" | "best_available",
  defaultProvider: AsrProviderType,
  dictationProvider: AsrProviderType,
  meetingProvider?: AsrProviderType
) {
  const orderedCandidates = [meetingProvider, defaultProvider, dictationProvider];
  orderedCandidates.push(...laneProviderOrder("meeting", meetingRoutePolicy));

  const seen = new Set<AsrProviderType>();
  const candidates: AsrProviderType[] = [];
  for (const candidate of orderedCandidates) {
    if (!candidate || seen.has(candidate) || !isMeetingEligibleProvider(candidate)) {
      continue;
    }
    seen.add(candidate);
    candidates.push(candidate);
  }
  return candidates;
}

function fallbackMeetingProvider(
  providerList: RouteSelectableInventory[],
  meetingRoutePolicy: "prefer_local" | "best_available",
  defaultProvider: AsrProviderType,
  dictationProvider: AsrProviderType,
  preferredMeetingProvider?: AsrProviderType
) {
  return (
    preferredMeetingProviderCandidates(
      meetingRoutePolicy,
      defaultProvider,
      dictationProvider,
      preferredMeetingProvider
    ).find((providerType) => modelOptionsForProvider(providerList, providerType).length > 0) ??
    DEFAULT_PROVIDER
  );
}

function fallbackMeetingModel(
  providerList: RouteSelectableInventory[],
  providerType: AsrProviderType,
  preferredModelId?: string
) {
  if (preferredModelId && isMeetingEligibleModel(providerList, providerType, preferredModelId)) {
    return preferredModelId;
  }

  return (
    modelOptionsForProvider(providerList, providerType).find((option) =>
      isMeetingEligibleModel(providerList, providerType, option.id)
    )?.id ?? firstModelIdForProvider(providerList, providerType)
  );
}

/**
 * Settings arrive as bare strings, so a file written before the Python-backed
 * engines were deleted can still name `mlx_audio` or `voxtral`. Those names are
 * in no provider list, and `normalizeProviderModelSelection` cannot rescue them
 * -- it replaces an unknown *model* but keeps whatever provider it was handed.
 * Falling back here is what stops a stale file pinning a lane to an engine that
 * no longer exists.
 */
function knownProviderOr(
  providerType: string | null | undefined,
  fallback: AsrProviderType
): AsrProviderType {
  return isKnownAsrProvider(providerType) ? providerType : fallback;
}

export function selectionStateFromSettings(
  providerList: RouteSelectableInventory[],
  transcription: TranscriptionSettings
): AsrRouteSelectionState {
  const normalizedDefault = normalizeProviderModelSelection(
    providerList,
    knownProviderOr(transcription.defaultProvider, DEFAULT_PROVIDER),
    transcription.selectedModelId ?? DEFAULT_MODEL_ID
  );
  const normalizedDictation = normalizeProviderModelSelection(
    providerList,
    knownProviderOr(transcription.dictationProvider, normalizedDefault.providerType),
    transcription.dictationModelId ?? normalizedDefault.modelId
  );
  const normalizedMeeting = normalizeProviderModelSelection(
    providerList,
    knownProviderOr(transcription.meetingProvider, normalizedDefault.providerType),
    transcription.meetingModelId ?? normalizedDefault.modelId
  );
  const meetingRoutePolicy = normalizeMeetingRoutePolicy(transcription.meetingRoutePolicy);
  const useRequestedShared = transcription.useSharedAsrSelection ?? true;
  const useSharedAsrSelection =
    useRequestedShared &&
    isListBackedSharedMeetingCompatible(
      providerList,
      normalizedDefault.providerType,
      normalizedDefault.modelId
    );
  const dictationSelection = useSharedAsrSelection ? normalizedDefault : normalizedDictation;
  const meetingProvider = useSharedAsrSelection
    ? normalizedDefault.providerType
    : fallbackMeetingProvider(
        providerList,
        meetingRoutePolicy,
        normalizedDefault.providerType,
        dictationSelection.providerType,
        normalizedMeeting.providerType
      );
  const meetingModelId = useSharedAsrSelection
    ? normalizedDefault.modelId
    : fallbackMeetingModel(
        providerList,
        meetingProvider,
        normalizedMeeting.providerType === meetingProvider
          ? normalizedMeeting.modelId
          : undefined
      );

  return {
    defaultProvider: normalizedDefault.providerType,
    defaultModelId: normalizedDefault.modelId,
    useSharedAsrSelection,
    dictationProvider: dictationSelection.providerType,
    dictationModelId: dictationSelection.modelId,
    meetingProvider,
    meetingModelId,
    meetingRoutePolicy,
  };
}

export function mergeSelectionStateUpdate(
  providerList: RouteSelectableInventory[],
  currentSelection: AsrRouteSelectionState,
  updates: AsrRouteSelectionUpdate
): AsrRouteSelectionState {
  const normalizedDefault = normalizeProviderModelSelection(
    providerList,
    updates.defaultProvider ?? currentSelection.defaultProvider,
    updates.defaultModelId ?? currentSelection.defaultModelId
  );
  const normalizedDictation = normalizeProviderModelSelection(
    providerList,
    updates.dictationProvider ?? currentSelection.dictationProvider,
    updates.dictationModelId ?? currentSelection.dictationModelId
  );
  const normalizedMeeting = normalizeProviderModelSelection(
    providerList,
    updates.meetingProvider ?? currentSelection.meetingProvider,
    updates.meetingModelId ?? currentSelection.meetingModelId
  );
  const meetingRoutePolicy = normalizeMeetingRoutePolicy(
    updates.meetingRoutePolicy ?? currentSelection.meetingRoutePolicy
  );
  const useRequestedShared =
    updates.useSharedAsrSelection ?? currentSelection.useSharedAsrSelection;
  const useSharedAsrSelection =
    useRequestedShared &&
    isListBackedSharedMeetingCompatible(
      providerList,
      normalizedDefault.providerType,
      normalizedDefault.modelId
    );
  const dictationSelection = useSharedAsrSelection ? normalizedDefault : normalizedDictation;
  const meetingProvider = useSharedAsrSelection
    ? normalizedDefault.providerType
    : fallbackMeetingProvider(
        providerList,
        meetingRoutePolicy,
        normalizedDefault.providerType,
        dictationSelection.providerType,
        normalizedMeeting.providerType
      );
  const meetingModelId = useSharedAsrSelection
    ? normalizedDefault.modelId
    : fallbackMeetingModel(
        providerList,
        meetingProvider,
        normalizedMeeting.providerType === meetingProvider
          ? normalizedMeeting.modelId
          : undefined
      );

  return {
    defaultProvider: normalizedDefault.providerType,
    defaultModelId: normalizedDefault.modelId,
    useSharedAsrSelection,
    dictationProvider: dictationSelection.providerType,
    dictationModelId: dictationSelection.modelId,
    meetingProvider,
    meetingModelId,
    meetingRoutePolicy,
  };
}
