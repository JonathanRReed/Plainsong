import { useCallback, useEffect, useRef, useState } from "react";
import { getSettings, setSavedPrompts } from "@/lib/backend/settings";
import { resolveSavedPrompts, type SavedPrompt } from "@/lib/saved-prompts";

export function useSavedPrompts() {
  const [prompts, setPrompts] = useState<SavedPrompt[]>(() =>
    resolveSavedPrompts([]),
  );
  const [loaded, setLoaded] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const savedRevision = useRef(0);
  const canPersist = useRef(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    canPersist.current = false;
    setLoaded(false);
    setLoadError(null);
    const revision = savedRevision.current;
    try {
      const settings = await getSettings();
      if (revision === savedRevision.current) {
        setPrompts(resolveSavedPrompts(settings.ai?.savedPrompts));
      }
      canPersist.current = true;
      setLoaded(true);
    } catch (error) {
      console.error("Failed to load saved prompts:", error);
      setLoadError("Could not load saved prompts. Retry before making changes.");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const revision = savedRevision.current;
    void (async () => {
      try {
        const settings = await getSettings();
        if (cancelled || revision !== savedRevision.current) return;
        setPrompts(resolveSavedPrompts(settings.ai?.savedPrompts));
        canPersist.current = true;
        setLoaded(true);
      } catch (error) {
        if (!cancelled) {
          console.error("Failed to load saved prompts:", error);
          setLoadError("Could not load saved prompts. Retry before making changes.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = useCallback(async (next: readonly SavedPrompt[]) => {
    if (!canPersist.current) {
      setSaveError("Load your saved prompts before making changes.");
      return false;
    }
    setSaveError(null);
    try {
      const saved = await setSavedPrompts(next);
      savedRevision.current += 1;
      setPrompts(resolveSavedPrompts(saved));
      return true;
    } catch (error) {
      console.error("Failed to save prompts:", error);
      setSaveError(
        error instanceof Error
          ? error.message
          : "Plainsong could not save your prompts.",
      );
      return false;
    }
  }, []);

  return { prompts, loaded, loadError, saveError, persist, reload };
}
