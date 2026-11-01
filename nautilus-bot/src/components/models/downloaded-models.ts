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
 *   - parakeet v2/v3  `models/parakeet/parakeet-tdt-0.6b-v<version>/…`
 *   - parakeet 110m  files sitting directly in `models/parakeet/`
 *   - moonshine    `models/moonshine/` vs `models/moonshine_tiny/`
 *   - transcribe_cpp  `models/transcribe_cpp/<file>.gguf`, and Parakeet v3's
 *                     Core ML bundles in `models/neural_engine/<modelId>/`
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
  /**
   * The files (or bundle directories) each identified model occupies, for
   * Remove. Only models whose files can be told apart are listed.
   */
  filesByRoute: ReadonlyMap<string, { paths: string[]; bytes: number }>;
}

const PROVIDER_BY_LIST_VALUE: Record<string, AsrProviderType> = {
  whisper: "whisper",
  parakeet: "parakeet",
  whisper_candle: "whisper_candle",
  distil_whisper: "distil_whisper",
  moonshine: "moonshine",
  qwen3_asr: "qwen3_asr",
  cohere_local: "cohere_local",
  whistle: "whistle",
  transcribe_cpp: "transcribe_cpp",
};

const SINGLE_MODEL_ROUTE: Partial<Record<AsrProviderType, string>> = {
  whisper_candle: "whisper-large-v3-turbo",
  distil_whisper: "distil-large-v3.5",
  qwen3_asr: "qwen3-asr-0.6b",
  cohere_local: "cohere-transcribe-03-2026-q4",
  whistle: "whistle-2.0.0",
};

/** `asr/neural_engine.rs` `MODEL_SPECS`: the Core ML speech builds. */
const CORE_ML_SPEECH_BUNDLES = new Set(["parakeet-tdt-0.6b-v3-coreml", "parakeet-tdt-0.6b-v2-coreml"]);

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
    if (path.includes("/orukeet-v0.1.0-int8/")) {
      return "orukeet-v0.1.0-int8";
    }
    if (path.includes("/parakeet-tdt-0.6b-v2/")) {
      return "parakeet-tdt-0.6b-v2";
    }
    if (path.includes("/parakeet-tdt-0.6b-v3/")) {
      return "parakeet-tdt-0.6b-v3";
    }
    return "parakeet-tdt-ctc-110m";
  }

  if (providerType === "moonshine") {
    return path.includes("/moonshine_tiny/") ? "moonshine-tiny" : "moonshine-base";
  }

  if (providerType === "transcribe_cpp") {
    // Every bundle under `models/neural_engine/` is a build of Parakeet v3's
    // route, including the vocabulary model only it uses, so Remove takes
    // them all with the route.
    if (path.includes("/neural_engine/")) return "parakeet-tdt-0.6b-v3-q8_0";
    if (fileName === "parakeet-tdt-0.6b-v3-Q8_0.gguf") return "parakeet-tdt-0.6b-v3-q8_0";
    if (fileName === "orukeet-transcribe-cpp-Q8_0.gguf") return "orukeet-r3-q8_0";
    if (fileName === "Qwen3-ASR-1.7B-Q8_0.gguf") return "qwen3-asr-1.7b-q8_0";
    if (fileName === "Qwen3-ASR-0.6B-Q6_K.gguf") return "qwen3-asr-0.6b-q6_k";
    if (fileName === "nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf") return "nemotron-3.5-asr-streaming-0.6b-q8_0";
    if (fileName === "parakeet-unified-en-0.6b-Q8_0.gguf") return "parakeet-unified-en-0.6b-q8_0";
    if (fileName === "moonshine-streaming-medium-Q8_0.gguf") return "moonshine-streaming-medium-q8_0";
    if (fileName === "fluid-speech-mini-q8_0.gguf") return "fluid-speech-mini-q8_0";
    if (fileName === "underdog-bark-3.0-pro-q8_0.gguf") return "underdog-bark-3.0-pro-q8_0";
    return null;
  }

  return SINGLE_MODEL_ROUTE[providerType] ?? null;
}

export function buildDownloadedModelIndex(
  files: readonly DownloadedModelFile[],
): DownloadedModelIndex {
  let totalBytes = 0;
  let fileCount = 0;
  const presentRouteIds = new Set<string>();
  const whistleFiles = new Set<string>();
  const orukeetOnnxFiles = new Set<string>();
  const nativeFiles = new Set<string>();
  let coreMlSpeechBundle = false;
  const filesByRoute = new Map<string, { paths: string[]; bytes: number }>();
  const claim = (routeId: string, path: string, bytes: number) => {
    const entry = filesByRoute.get(routeId) ?? { paths: [], bytes: 0 };
    entry.paths.push(path);
    entry.bytes += bytes;
    filesByRoute.set(routeId, entry);
  };

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
      claim(`${providerType}:${modelId}`, file.path, size);
    }
    const normalizedPath = normalizePath(file.path);
    const fileName = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);
    if (providerType === "parakeet" && modelId === "orukeet-v0.1.0-int8") {
      if (size > 0) orukeetOnnxFiles.add(fileName);
      continue;
    }
    if (providerType === "transcribe_cpp") {
      if (size > 0 && normalizedPath.includes("/neural_engine/")) {
        // The sidecar names a bundle by its model id only once every pinned
        // file is here; an interrupted download carries a suffix.
        if (CORE_ML_SPEECH_BUNDLES.has(file.name)) coreMlSpeechBundle = true;
        continue;
      }
      if (size > 0) nativeFiles.add(fileName);
      continue;
    }
    if (providerType === "whistle") {
      const normalized = normalizePath(file.path);
      if (size > 0 && normalized.includes("/whistle-2.0.0/")) {
        whistleFiles.add(normalized.slice(normalized.lastIndexOf("/") + 1));
      }
      continue;
    }
    if (modelId) {
      presentRouteIds.add(`${providerType}:${modelId}`);
    }
  }

  if (whistleFiles.has("whistle.cact") && whistleFiles.has("needle")) {
    presentRouteIds.add("whistle:whistle-2.0.0");
  }
  if (["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt", "LICENSE-WEIGHTS", "NOTICE.md"].every((name) => orukeetOnnxFiles.has(name))) {
    presentRouteIds.add("parakeet:orukeet-v0.1.0-int8");
  }
  // On a Mac that runs it, Parakeet's download is the Core ML build alone.
  if (nativeFiles.has("parakeet-tdt-0.6b-v3-Q8_0.gguf") || coreMlSpeechBundle) {
    presentRouteIds.add("transcribe_cpp:parakeet-tdt-0.6b-v3-q8_0");
  }
  if (nativeFiles.has("moonshine-streaming-medium-Q8_0.gguf")) {
    presentRouteIds.add("transcribe_cpp:moonshine-streaming-medium-q8_0");
  }
  if (nativeFiles.has("nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf")) {
    presentRouteIds.add("transcribe_cpp:nemotron-3.5-asr-streaming-0.6b-q8_0");
  }
  if (nativeFiles.has("Qwen3-ASR-1.7B-Q8_0.gguf")) {
    presentRouteIds.add("transcribe_cpp:qwen3-asr-1.7b-q8_0");
  }
  if (nativeFiles.has("Qwen3-ASR-0.6B-Q6_K.gguf")) {
    presentRouteIds.add("transcribe_cpp:qwen3-asr-0.6b-q6_k");
  }
  if (["orukeet-transcribe-cpp-Q8_0.gguf", "orukeet-r3-LICENSE-WEIGHTS", "orukeet-r3-NOTICE.md"].every((name) => nativeFiles.has(name))) {
    presentRouteIds.add("transcribe_cpp:orukeet-r3-q8_0");
  }
  if (["parakeet-unified-en-0.6b-Q8_0.gguf", "parakeet-unified-en-0.6b-NVIDIA-MODEL-CARD.md", "parakeet-unified-en-0.6b-NVIDIA-OPEN-MODEL-LICENSE.pdf"].every((name) => nativeFiles.has(name))) {
    presentRouteIds.add("transcribe_cpp:parakeet-unified-en-0.6b-q8_0");
  }
  // CC BY 4.0: the licence text and credits ship with the weights, and the
  // sidecar's readiness requires all three, so the index does too.
  for (const stem of ["fluid-speech-mini", "underdog-bark-3.0-pro"]) {
    if ([`${stem}-q8_0.gguf`, `${stem}-LICENSE.txt`, `${stem}-NOTICE.txt`].every((name) => nativeFiles.has(name))) {
      presentRouteIds.add(`transcribe_cpp:${stem}-q8_0`);
    }
  }

  for (const routeId of [...filesByRoute.keys()]) {
    if (!presentRouteIds.has(routeId)) filesByRoute.delete(routeId);
  }

  return { totalBytes, fileCount, presentRouteIds, filesByRoute };
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
