import type { DownloadStatus } from "@/types";

export type NormalizedDownloadStatusKind =
  | "downloaded"
  | "not_downloaded"
  | "downloading"
  | "error"
  | "unknown";

export interface NormalizedDownloadStatus {
  kind: NormalizedDownloadStatusKind;
  progress?: number;
  message?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toProgress(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.min(100, Math.max(0, value));
  }
  return 0;
}

export function normalizeDownloadStatus(status: DownloadStatus | unknown): NormalizedDownloadStatus {
  if (status === "Downloaded") {
    return { kind: "downloaded" };
  }

  if (status === "NotDownloaded") {
    return { kind: "not_downloaded" };
  }

  if (status === "Downloading") {
    return { kind: "downloading", progress: 0 };
  }

  if (status === "Error") {
    return { kind: "error" };
  }

  // Handle snake_case from Rust
  if (status === "downloaded") {
    return { kind: "downloaded" };
  }
  if (status === "not_downloaded") {
    return { kind: "not_downloaded" };
  }
  if (status === "downloading") {
    return { kind: "downloading", progress: 0 };
  }
  if (status === "error") {
    return { kind: "error" };
  }

  if (!isRecord(status)) {
    return { kind: "unknown" };
  }

  if ("Downloaded" in status) {
    return { kind: "downloaded" };
  }

  if ("NotDownloaded" in status) {
    return { kind: "not_downloaded" };
  }

  if ("Downloading" in status) {
    const downloading = status.Downloading;
    if (isRecord(downloading)) {
      return {
        kind: "downloading",
        progress: toProgress(downloading.progress),
      };
    }
    return { kind: "downloading", progress: 0 };
  }

  if ("Error" in status) {
    const errorValue = status.Error;
    if (typeof errorValue === "string") {
      return { kind: "error", message: errorValue };
    }

    if (isRecord(errorValue) && typeof errorValue["0"] === "string") {
      return { kind: "error", message: errorValue["0"] };
    }

    return { kind: "error" };
  }

  return { kind: "unknown" };
}
