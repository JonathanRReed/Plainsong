import type { DiarizationModelOption } from "@/lib/backend";

// What the picker says about each model (`description`) is the sidecar's own
// sentence, from `list_diarization_models` in rust-sidecar/src/permissions.rs,
// printed as it is: one copy of each claim, beside the measurements.

/**
 * A speaker model's name as the Settings picker shows it, from its id.
 * Mirrors `model_label` in rust-sidecar/src/diarization/mod.rs; an id this
 * table does not know gets no name rather than a raw id.
 */
const SPEAKER_MODEL_NAMES: Record<string, string> = {
  pyannote_community1: "pyannote community-1",
  nemotron3_diarization: "Nemotron 3 Diarization",
  ecapa_tdnn_speaker: "ECAPA-TDNN 512",
  resnet34_speaker: "ResNet34",
  campplus_speaker: "CAM++",
  eres2netv2_speaker: "ERes2NetV2",
};

/**
 * Turned off while its license is unresolved (see
 * `LICENSE_BLOCKED_SPEAKER_MODEL_ID` in rust-sidecar/src/diarization/mod.rs).
 * The picker no longer offers it; its name stays above so older meetings and
 * remembered voices can still say which model produced them.
 */
export const TURNED_OFF_SPEAKER_MODEL_ID = "eres2netv2_speaker";

export function speakerModelName(modelId: string): string | null {
  return SPEAKER_MODEL_NAMES[modelId] ?? null;
}

/** The picker row: name, download size, and whether it still needs downloading. */
export function speakerModelOptionLabel(model: DiarizationModelOption): string {
  const size = model.downloadSize ? `, ${model.downloadSize}` : "";
  return `${model.label}${size}${model.installed ? "" : " (not downloaded)"}`;
}
