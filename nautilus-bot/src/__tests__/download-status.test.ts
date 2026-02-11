import { describe, expect, it } from "vitest";
import { normalizeDownloadStatus } from "@/lib/download-status";

describe("normalizeDownloadStatus", () => {
  it("parses string downloaded status", () => {
    expect(normalizeDownloadStatus("Downloaded")).toEqual({ kind: "downloaded" });
  });

  it("parses string not-downloaded status", () => {
    expect(normalizeDownloadStatus("NotDownloaded")).toEqual({ kind: "not_downloaded" });
  });

  it("parses downloading object status", () => {
    expect(normalizeDownloadStatus({ Downloading: { progress: 42 } })).toEqual({
      kind: "downloading",
      progress: 42,
    });
  });

  it("parses error object status with string message", () => {
    expect(normalizeDownloadStatus({ Error: "network" })).toEqual({
      kind: "error",
      message: "network",
    });
  });

  it("parses legacy object-key downloaded status", () => {
    expect(normalizeDownloadStatus({ Downloaded: {} })).toEqual({ kind: "downloaded" });
  });

  it("parses legacy error object with tuple-like payload", () => {
    expect(normalizeDownloadStatus({ Error: { 0: "legacy error" } })).toEqual({
      kind: "error",
      message: "legacy error",
    });
  });

  it("returns unknown for null", () => {
    expect(normalizeDownloadStatus(null)).toEqual({ kind: "unknown" });
  });

  it("returns unknown for undefined", () => {
    expect(normalizeDownloadStatus(undefined)).toEqual({ kind: "unknown" });
  });

  it("returns unknown for numbers", () => {
    expect(normalizeDownloadStatus(123)).toEqual({ kind: "unknown" });
  });

  it("returns unknown for arrays", () => {
    expect(normalizeDownloadStatus(["Downloaded"])).toEqual({ kind: "unknown" });
  });

  it("returns unknown for malformed objects", () => {
    expect(normalizeDownloadStatus({ foo: "bar" })).toEqual({ kind: "unknown" });
  });
});
