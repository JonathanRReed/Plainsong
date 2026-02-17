import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { DataCacheProvider } from "@/hooks/data-cache-context";
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
  const wrapper = ({ children }: { children: ReactNode }) => (
    createElement(DataCacheProvider, null, children)
  );

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches recordings on mount", async () => {
    const { result } = renderHook(() => useRecordings(), { wrapper });

    await waitFor(() => {
      expect(result.current.recordings).toHaveLength(1);
    });
    expect(result.current.recordings[0].title).toBe("Meeting 1");
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("passes projectId to fetch", async () => {
    const { getRecordings } = await import("@/lib/tauri");
    renderHook(() => useRecordings("p1"), { wrapper });

    await waitFor(() => {
      expect(getRecordings).toHaveBeenCalledWith("p1");
    });
  });

  it("deduplicates recording fetches by project key", async () => {
    const { getRecordings } = await import("@/lib/tauri");
    const mockedGetRecordings = vi.mocked(getRecordings);

    const { result } = renderHook(
      () => {
        const first = useRecordings("p1");
        const second = useRecordings("p1");
        return { first, second };
      },
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current.first.recordings).toHaveLength(1);
      expect(result.current.second.recordings).toHaveLength(1);
    });
    expect(mockedGetRecordings).toHaveBeenCalledTimes(1);
  });
});
