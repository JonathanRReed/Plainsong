import { isDownloadableProvider } from "@/lib/asr-capabilities";
import type { DownloadedModelFile } from "@/lib/backend/asr";
import type { AsrProviderType } from "@/types";

/**
 * What is actually on disk, read off the files themselves.
 *
 * The provider inventory carries one `downloadStatus` per provider, and that
 * status describes the model the provider currently has selected -- so all ten
 * Whisper builds report the same thing. A drawer whose whole job is to say
 * which model you already have cannot be built on that. `list_downloaded_models`
 * walks the managed models directory and returns each file with its measured
 * `sizeBytes`, which is both per-model and un-guessed.
 *
 * The mapping from file to model mirrors where each provider writes:
 *   - whisper      `models/whisper/ggml-<modelId>.bin`  (asr/whisper.rs `new`)
 *   - parakeet v3  `models/parakeet/parakeet-tdt-0.6b-v3/…` (its own subdirectory)
 *   - parakeet 110m  files sitting directly in `models/parakeet/`
 *   - moonshine    `models/moonshine/` vs `models/moonshine_tiny/`
 *   - everything else downloadable: one model per provider directory.
 * A provider whose layout is not described here returns `null` rather than a
 * guess, and the caller falls back to the route's own readiness.
 */
export interface DownloadedModelIndex {
  /** Measured bytes of every file belonging to a speech model. */
  totalBytes: number;
  fileCount: number;
  /** `provider:modelId` for every model we could positively identify. */
  presentRouteIds: ReadonlySet<string>;
}

const PROVIDER_BY_LIST_VALUE: Record<string, AsrProviderType> = {
  whisper: "whisper",
  parakeet: "parakeet",
  whisper_candle: "whisper_candle",
  distil_whisper: "distil_whisper",
  moonshine: "moonshine",
  qwen3_asr: "qwen3_asr",
  cohere_local: "cohere_local",
};

const SINGLE_MODEL_ROUTE: Partial<Record<AsrProviderType, string>> = {
  whisper_candle: "whisper-large-v3-turbo",
  distil_whisper: "distil-large-v3.5",
  qwen3_asr: "qwen3-asr-0.6b",
  cohere_local: "cohere-transcribe-03-2026-q4",
};

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

/** Suffixes the download manager uses while a file is still being written. */
const PARTIAL_DOWNLOAD_SUFFIXES = [".part", ".partial", ".tmp", ".download", ".crdownload"];

function isPartialDownloadArtifact(path: string): boolean {
  const normalized = normalizePath(path).toLowerCase();
  const fileName = normalized.slice(normalized.lastIndexOf("/") + 1);
  return (
    PARTIAL_DOWNLOAD_SUFFIXES.some((suffix) => fileName.endsWith(suffix)) ||
    fileName.startsWith(".")
  );
}

function modelIdForFile(
  providerType: AsrProviderType,
  file: DownloadedModelFile,
): string | null {
  const path = normalizePath(file.path);
  const fileName = path.slice(path.lastIndexOf("/") + 1);

  if (providerType === "whisper") {
    const match = /^ggml-(.+)\.bin$/.exec(fileName);
    return match ? match[1] : null;
  }

  if (providerType === "parakeet") {
    return path.includes("/parakeet-tdt-0.6b-v3/")
      ? "parakeet-tdt-0.6b-v3"
      : "parakeet-tdt-ctc-110m";
  }

  if (providerType === "moonshine") {
    return path.includes("/moonshine_tiny/") ? "moonshine-tiny" : "moonshine-base";
  }

  return SINGLE_MODEL_ROUTE[providerType] ?? null;
}

export function buildDownloadedModelIndex(
  files: readonly DownloadedModelFile[],
): DownloadedModelIndex {
  let totalBytes = 0;
  let fileCount = 0;
  const presentRouteIds = new Set<string>();

  for (const file of files) {
    if (isPartialDownloadArtifact(file.path)) {
      // A download still in flight writes to a temporary sibling. Counting it
      // made an interrupted download read as an installed model, so the route
      // looked ready and then failed at transcription time.
      continue;
    }

    const providerType = PROVIDER_BY_LIST_VALUE[file.provider];
    if (!providerType) {
      // Silero VAD, diarization embeddings and platform assets are all
      // returned by the same call and are not speech models; counting them
      // would inflate a total the user reads as "my transcription models".
      continue;
    }

    const size = Number.isFinite(file.sizeBytes) ? Math.max(0, file.sizeBytes) : 0;
    totalBytes += size;
    fileCount += 1;

    const modelId = modelIdForFile(providerType, file);
    if (modelId) {
      presentRouteIds.add(`${providerType}:${modelId}`);
    }
  }

  return { totalBytes, fileCount, presentRouteIds };
}

/**
 * Whether this exact model's files are on disk. `null` means we cannot tell --
 * a cloud or platform route has nothing to download, and an index we failed to
 * load says nothing at all.
 */
export function isModelOnDisk(
  index: DownloadedModelIndex | null,
  providerType: AsrProviderType,
  modelId: string,
): boolean | null {
  if (!index || !isDownloadableProvider(providerType)) {
    return null;
  }
  return index.presentRouteIds.has(`${providerType}:${modelId}`);
}

/** Bytes as the same binary units the model catalogue is written in. */
export function bytesToMib(bytes: number): number {
  return bytes / (1024 * 1024);
}
