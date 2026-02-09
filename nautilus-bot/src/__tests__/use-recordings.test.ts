import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useRecordings } from "@/hooks/use-recordings";

const mockRecordings = [
  {
    id: "r1",
    title: "Meeting 1",
    projectId: "p1",
    duration: 120,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    sourceType: "meeting",
    audioPath: "/tmp/audio.wav",
    status: "completed",
  },
];

vi.mock("@/lib/tauri", () => ({
  getRecordings: vi.fn(() => Promise.resolve(mockRecordings)),
}));

describe("useRecordings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches recordings on mount", async () => {
    const { result } = renderHook(() => useRecordings());

    await waitFor(() => {
      expect(result.current.recordings).toHaveLength(1);
    });
    expect(result.current.recordings[0].title).toBe("Meeting 1");
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("passes projectId to fetch", async () => {
    const { getRecordings } = await import("@/lib/tauri");
    renderHook(() => useRecordings("p1"));

    await waitFor(() => {
      expect(getRecordings).toHaveBeenCalledWith("p1");
    });
  });
});
