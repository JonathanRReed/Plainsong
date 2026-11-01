import {
  RECOMMENDED_SPEECH_ROUTE,
  isOnnxParakeetRoute,
} from "@/lib/asr-route-catalog";
import type { Settings } from "@/types/settings";

type TranscriptionSlots = Pick<
  Settings["transcription"],
  | "useSharedAsrSelection"
  | "defaultProvider"
  | "selectedModelId"
  | "dictationProvider"
  | "dictationModelId"
  | "meetingProvider"
  | "meetingModelId"
>;

/** Which speech lanes still name ONNX Parakeet v3. */
export function onnxParakeetLanes(transcription: TranscriptionSlots): {
  dictation: boolean;
  meeting: boolean;
} {
  if (transcription.useSharedAsrSelection ?? true) {
    const shared = isOnnxParakeetRoute(
      transcription.defaultProvider,
      transcription.selectedModelId,
    );
    return { dictation: shared, meeting: shared };
  }
  return {
    dictation: isOnnxParakeetRoute(
      transcription.dictationProvider,
      transcription.dictationModelId,
    ),
    meeting: isOnnxParakeetRoute(
      transcription.meetingProvider,
      transcription.meetingModelId,
    ),
  };
}

/**
 * Move every lane that names ONNX Parakeet v3 to GGUF Parakeet, the same
 * model in the build that made fewer mistakes at about half the memory.
 *
 * Mirrors `upgrade_onnx_parakeet_slots` in rust-sidecar/src/settings.rs,
 * which does this at launch once the GGUF build is on the Mac: lanes on any
 * other model are left alone, and the shared default stays ONNX Parakeet as
 * the sidecar's nearest substitute. Call it only after the GGUF build has
 * downloaded and passed its check.
 */
export function withParakeetUpgrade(settings: Settings): Settings {
  const lanes = onnxParakeetLanes(settings.transcription);
  if (!lanes.dictation && !lanes.meeting) {
    return settings;
  }
  // A shared selection only reaches here when it names ONNX Parakeet, so
  // both lanes move and the split keeps the shared pair as the fallback.
  const { providerType, modelId } = RECOMMENDED_SPEECH_ROUTE;
  const current = settings.transcription;
  return {
    ...settings,
    transcription: {
      ...current,
      useSharedAsrSelection: false,
      dictationProvider: lanes.dictation ? providerType : current.dictationProvider,
      dictationModelId: lanes.dictation ? modelId : current.dictationModelId,
      meetingProvider: lanes.meeting ? providerType : current.meetingProvider,
      meetingModelId: lanes.meeting ? modelId : current.meetingModelId,
      parakeetUpgradeApplied: true,
      parakeetUpgradeNoticePending: false,
    },
  };
}
