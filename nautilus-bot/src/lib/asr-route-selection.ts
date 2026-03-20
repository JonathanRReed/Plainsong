import {
  isMeetingEligibleModel as sharedIsMeetingEligibleModel,
  isMeetingEligibleProvider,
  isSharedMeetingCompatible,
  modelSupportsMlxAcceleration,
  visibleRouteForMlxModel,
} from "@/lib/asr-capabilities";
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
  dictationMlxEnabled: boolean;
  meetingMlxEnabled: boolean;
  meetingRoutePolicy: "prefer_local" | "best_available";
}

type RouteSelectableProvider = Pick<AsrProviderInfo, "providerType" | "modelOptions">;
type RouteSelectableInventory = RouteSelectableProvider | AsrProviderInventory;

export type AsrRouteSelectionUpdate = Partial<AsrRouteSelectionState>;

const DEFAULT_PROVIDER: AsrProviderType = "distil_whisper";
const DEFAULT_MODEL_ID = "distil-large-v3.5";
const LOCAL_MEETING_DEFAULTS: AsrProviderType[] = [
  "distil_whisper",
  "mlx_audio",
  "parakeet",
  "voxtral",
];
const CLOUD_MEETING_DEFAULTS: AsrProviderType[] = [
  "elevenlabs_scribe",
  "openai_cloud",
  "groq",
];

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

function migrateLegacyMlxSelection(providerType: AsrProviderType, modelId: string) {
  if (providerType !== "mlx_audio") {
    return {
      providerType,
      modelId,
      migratedProviderType: null as AsrProviderType | null,
    };
  }

  const mapped = visibleRouteForMlxModel(modelId);
  if (!mapped) {
    return {
      providerType,
      modelId,
      migratedProviderType: null as AsrProviderType | null,
    };
  }

  return {
    providerType: mapped.providerType,
    modelId: mapped.modelId,
    migratedProviderType: mapped.providerType,
  };
}

function preferredMeetingProviderCandidates(
  meetingRoutePolicy: "prefer_local" | "best_available",
  defaultProvider: AsrProviderType,
  dictationProvider: AsrProviderType,
  meetingProvider?: AsrProviderType
) {
  const orderedCandidates = [meetingProvider, defaultProvider, dictationProvider];
  if (meetingRoutePolicy === "best_available") {
    orderedCandidates.push(...CLOUD_MEETING_DEFAULTS, ...LOCAL_MEETING_DEFAULTS);
  } else {
    orderedCandidates.push(...LOCAL_MEETING_DEFAULTS, ...CLOUD_MEETING_DEFAULTS);
  }

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

function sanitizeMlxFlag(
  enabled: boolean,
  providerType: AsrProviderType,
  modelId: string
) {
  return enabled && modelSupportsMlxAcceleration(providerType, modelId);
}

export function selectionStateFromSettings(
  providerList: RouteSelectableInventory[],
  transcription: TranscriptionSettings
): AsrRouteSelectionState {
  const migratedDefault = migrateLegacyMlxSelection(
    (transcription.defaultProvider as AsrProviderType) ?? DEFAULT_PROVIDER,
    transcription.selectedModelId ?? DEFAULT_MODEL_ID
  );
  const migratedDictation = migrateLegacyMlxSelection(
    (transcription.dictationProvider as AsrProviderType) ?? migratedDefault.providerType,
    transcription.dictationModelId ?? migratedDefault.modelId
  );
  const migratedMeeting = migrateLegacyMlxSelection(
    (transcription.meetingProvider as AsrProviderType) ?? migratedDefault.providerType,
    transcription.meetingModelId ?? migratedDefault.modelId
  );

  const normalizedDefault = normalizeProviderModelSelection(
    providerList,
    migratedDefault.providerType,
    migratedDefault.modelId
  );
  const normalizedDictation = normalizeProviderModelSelection(
    providerList,
    migratedDictation.providerType,
    migratedDictation.modelId
  );
  const normalizedMeeting = normalizeProviderModelSelection(
    providerList,
    migratedMeeting.providerType,
    migratedMeeting.modelId
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
  const dictationSelection = useSharedAsrSelection ? normalizedDefault : useRequestedShared ? normalizedDefault : normalizedDictation;
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

  let dictationMlxEnabled = transcription.dictationMlxEnabled ?? false;
  let meetingMlxEnabled = transcription.meetingMlxEnabled ?? false;
  if (!dictationMlxEnabled && !meetingMlxEnabled) {
    const legacyMlxProviders = (transcription.mlxAcceleratedProviders ?? []) as AsrProviderType[];
    if (
      legacyMlxProviders.includes(dictationSelection.providerType) ||
      migratedDefault.migratedProviderType === dictationSelection.providerType ||
      migratedDictation.migratedProviderType === dictationSelection.providerType
    ) {
      dictationMlxEnabled = true;
    }
    if (
      legacyMlxProviders.includes(meetingProvider) ||
      migratedDefault.migratedProviderType === meetingProvider ||
      migratedMeeting.migratedProviderType === meetingProvider
    ) {
      meetingMlxEnabled = true;
    }
  }

  return {
    defaultProvider: normalizedDefault.providerType,
    defaultModelId: normalizedDefault.modelId,
    useSharedAsrSelection,
    dictationProvider: dictationSelection.providerType,
    dictationModelId: dictationSelection.modelId,
    meetingProvider,
    meetingModelId,
    dictationMlxEnabled: sanitizeMlxFlag(
      dictationMlxEnabled,
      dictationSelection.providerType,
      dictationSelection.modelId
    ),
    meetingMlxEnabled: sanitizeMlxFlag(meetingMlxEnabled, meetingProvider, meetingModelId),
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
  const dictationSelection = useSharedAsrSelection ? normalizedDefault : useRequestedShared ? normalizedDefault : normalizedDictation;
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
    dictationMlxEnabled: sanitizeMlxFlag(
      updates.dictationMlxEnabled ?? currentSelection.dictationMlxEnabled,
      dictationSelection.providerType,
      dictationSelection.modelId
    ),
    meetingMlxEnabled: sanitizeMlxFlag(
      updates.meetingMlxEnabled ?? currentSelection.meetingMlxEnabled,
      meetingProvider,
      meetingModelId
    ),
    meetingRoutePolicy,
  };
}
