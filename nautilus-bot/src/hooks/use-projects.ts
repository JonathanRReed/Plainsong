import { useEffect, useState, useCallback } from "react";
import {
  getProjects,
  createProject as createProjectApi,
} from "@/lib/backend/projects";
import { useDataCache } from "@/hooks/data-cache-context";
import type { Project } from "@/types";

export function useProjects() {
  const cache = useDataCache();
  const [projects, setProjects] = useState<Project[]>(
    () => cache.peekProjects() ?? []
  );
  const [isLoading, setIsLoading] = useState(() => !cache.peekProjects());
  const [error, setError] = useState<string | null>(null);

  const fetchProjects = useCallback(
    async (forceRefresh = false) => {
      setIsLoading(true);
      setError(null);
      try {
        const data = await cache.getProjects(() => getProjects(), forceRefresh);
        setProjects(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to fetch projects");
      } finally {
        setIsLoading(false);
      }
    },
    [cache]
  );

  const createProject = useCallback(
    async (project: {
      name: string;
      description?: string;
      parentId?: string;
    }) => {
      const newProject = await createProjectApi(project);
      setProjects((prev) => {
        const next = [...prev, newProject];
        cache.setProjects(next);
        return next;
      });
      return newProject;
    },
    [cache]
  );

  useEffect(() => {
    void fetchProjects();
  }, [fetchProjects]);

  return {
    projects,
    isLoading,
    error,
    refetch: () => fetchProjects(true),
    createProject,
  };
}
