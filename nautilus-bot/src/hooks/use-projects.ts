import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Project } from "@/types";

export function useProjects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchProjects = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await invoke<Project[]>("get_projects");
      setProjects(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch projects");
    } finally {
      setIsLoading(false);
    }
  }, []);

  const createProject = useCallback(
    async (project: {
      name: string;
      description?: string;
      parentId?: string;
    }) => {
      try {
        const newProject = await invoke<Project>("create_project", { project });
        setProjects((prev) => [...prev, newProject]);
        return newProject;
      } catch (err) {
        console.error("Failed to create project:", err);
        throw err;
      }
    },
    []
  );

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  return {
    projects,
    isLoading,
    error,
    refetch: fetchProjects,
    createProject,
  };
}
