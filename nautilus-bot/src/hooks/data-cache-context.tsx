import {
  createContext,
  useContext,
  useRef,
  type ReactNode,
} from "react";
import type { Project, Recording } from "@/types";

const CACHE_TTL_MS = 30_000;
const RECORDINGS_ALL_KEY = "__all__";

type CacheEntry<T> = {
  value: T | null;
  fetchedAt: number;
  inFlight: Promise<T> | null;
};

function createEntry<T>(): CacheEntry<T> {
  return {
    value: null,
    fetchedAt: 0,
    inFlight: null,
  };
}

export class DataCacheStore {
  private readonly projects = createEntry<Project[]>();

  private readonly recordings = new Map<string, CacheEntry<Recording[]>>();

  private resolveRecordingsKey(projectId?: string): string {
    return projectId ?? RECORDINGS_ALL_KEY;
  }

  peekProjects(): Project[] | null {
    return this.projects.value;
  }

  async getProjects(
    fetcher: () => Promise<Project[]>,
    forceRefresh = false
  ): Promise<Project[]> {
    if (
      !forceRefresh &&
      this.projects.value &&
      Date.now() - this.projects.fetchedAt < CACHE_TTL_MS
    ) {
      return this.projects.value;
    }
    if (this.projects.inFlight) {
      return this.projects.inFlight;
    }

    this.projects.inFlight = fetcher()
      .then((data) => {
        this.projects.value = data;
        this.projects.fetchedAt = Date.now();
        return data;
      })
      .finally(() => {
        this.projects.inFlight = null;
      });

    return this.projects.inFlight;
  }

  setProjects(value: Project[]): void {
    this.projects.value = value;
    this.projects.fetchedAt = Date.now();
  }

  invalidateProjects(): void {
    this.projects.fetchedAt = 0;
  }

  peekRecordings(projectId?: string): Recording[] | null {
    return this.recordings.get(this.resolveRecordingsKey(projectId))?.value ?? null;
  }

  async getRecordings(
    projectId: string | undefined,
    fetcher: () => Promise<Recording[]>,
    forceRefresh = false
  ): Promise<Recording[]> {
    const key = this.resolveRecordingsKey(projectId);
    const existing = this.recordings.get(key) ?? createEntry<Recording[]>();
    this.recordings.set(key, existing);

    if (
      !forceRefresh &&
      existing.value &&
      Date.now() - existing.fetchedAt < CACHE_TTL_MS
    ) {
      return existing.value;
    }
    if (existing.inFlight) {
      return existing.inFlight;
    }

    existing.inFlight = fetcher()
      .then((data) => {
        existing.value = data;
        existing.fetchedAt = Date.now();
        return data;
      })
      .finally(() => {
        existing.inFlight = null;
      });
    return existing.inFlight;
  }

  setRecordings(projectId: string | undefined, value: Recording[]): void {
    const key = this.resolveRecordingsKey(projectId);
    const entry = this.recordings.get(key) ?? createEntry<Recording[]>();
    entry.value = value;
    entry.fetchedAt = Date.now();
    this.recordings.set(key, entry);
  }

  invalidateRecordings(projectId?: string): void {
    if (typeof projectId === "undefined") {
      for (const entry of this.recordings.values()) {
        entry.fetchedAt = 0;
      }
      return;
    }

    const key = this.resolveRecordingsKey(projectId);
    const entry = this.recordings.get(key);
    if (entry) {
      entry.fetchedAt = 0;
    }
  }
}

const fallbackStore = new DataCacheStore();

const DataCacheContext = createContext<DataCacheStore | null>(null);

export function DataCacheProvider({ children }: { children: ReactNode }) {
  const cacheRef = useRef<DataCacheStore | null>(null);
  if (!cacheRef.current) {
    cacheRef.current = new DataCacheStore();
  }
  return (
    <DataCacheContext.Provider value={cacheRef.current}>
      {children}
    </DataCacheContext.Provider>
  );
}

export function useDataCache(): DataCacheStore {
  return useContext(DataCacheContext) ?? fallbackStore;
}
