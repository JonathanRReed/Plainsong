import { invoke } from "@/lib/electron";

/** A speech-model download Plainsong started on its own, in the background. */
export interface SpeechModelDownloadNotice {
  state: "idle" | "downloading" | "failed";
  percent: number;
  totalBytes: number;
  /**
   * Parakeet cannot transcribe on this Mac until this download finishes.
   * Otherwise it works as before while the download runs.
   */
  needed: boolean;
}

export const IDLE_SPEECH_MODEL_DOWNLOAD_NOTICE: SpeechModelDownloadNotice = {
  state: "idle",
  percent: 0,
  totalBytes: 0,
  needed: false,
};

export function parseSpeechModelDownloadNotice(value: unknown): SpeechModelDownloadNotice {
  if (!value || typeof value !== "object") return IDLE_SPEECH_MODEL_DOWNLOAD_NOTICE;
  const record = value as Record<string, unknown>;
  const state =
    record.state === "downloading" || record.state === "failed" ? record.state : "idle";
  const percent =
    typeof record.percent === "number" && Number.isFinite(record.percent)
      ? Math.min(100, Math.max(0, record.percent))
      : 0;
  const totalBytes =
    typeof record.totalBytes === "number" && Number.isFinite(record.totalBytes) && record.totalBytes > 0
      ? record.totalBytes
      : 0;
  return { state, percent, totalBytes, needed: record.needed === true };
}

export async function getSpeechModelDownloadNotice(): Promise<SpeechModelDownloadNotice> {
  return parseSpeechModelDownloadNotice(await invoke("get_speech_model_download_notice"));
}
