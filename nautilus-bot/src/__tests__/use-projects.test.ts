import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { DataCacheProvider } from "@/hooks/data-cache-context";
import { useProjects } from "@/hooks/use-projects";

const mockProjects = [
  {
    id: "p1",
    name: "Test Project",
    description: "A test project",
    parentId: null,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    encrypted: false,
    keySalt: null,
    keyHint: null,
  },
];

vi.mock("@/lib/tauri", () => ({
  getProjects: vi.fn(() => Promise.resolve(mockProjects)),
  createProject: vi.fn((project: { name: string }) =>
    Promise.resolve({
      id: "p2",
      name: project.name,
      description: "",
      parentId: null,
      createdAt: "2025-01-02T00:00:00Z",
      updatedAt: "2025-01-02T00:00:00Z",
      encrypted: false,
      keySalt: null,
      keyHint: null,
    })
  ),
}));

describe("useProjects", () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    createElement(DataCacheProvider, null, children)
  );

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches projects on mount", async () => {
    const { result } = renderHook(() => useProjects(), { wrapper });

    await waitFor(() => {
      expect(result.current.projects).toHaveLength(1);
    });
    expect(result.current.projects[0].name).toBe("Test Project");
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("creates a project and appends it", async () => {
    const { result } = renderHook(() => useProjects(), { wrapper });

    await waitFor(() => {
      expect(result.current.projects).toHaveLength(1);
    });

    await act(async () => {
      const created = await result.current.createProject({ name: "New" });
      expect(created.id).toBe("p2");
    });

    expect(result.current.projects).toHaveLength(2);
  });

  it("deduplicates in-flight fetches across hooks", async () => {
    const { getProjects } = await import("@/lib/tauri");
    const mockedGetProjects = vi.mocked(getProjects);

    const { result } = renderHook(
      () => {
        const first = useProjects();
        const second = useProjects();
        return { first, second };
      },
      { wrapper }
    );

    await waitFor(() => {
      expect(result.current.first.projects).toHaveLength(1);
      expect(result.current.second.projects).toHaveLength(1);
    });
    expect(mockedGetProjects).toHaveBeenCalledTimes(1);
  });
});
