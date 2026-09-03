import { useCallback, useEffect, useState } from "react";
import { getSettings, saveSettings } from "@/lib/backend/settings";
import { resolveSavedPrompts, type SavedPrompt } from "@/lib/saved-prompts";

/**
 * The saved prompt library, loaded from settings and written back to it.
 *
 * `save_settings` takes the whole settings object, so every write here
 * re-reads settings first and edits only `ai.savedPrompts`. That is what
 * keeps a prompt edit from clobbering a change made on the Settings screen
 * between this component mounting and the reader pressing Save -- the same
 * read-modify-write discipline the Settings screen itself uses.
 *
 * A failure to load is not surfaced as an error banner: the picker is a
 * convenience over a chat box that works perfectly well without it, so the
 * failure mode is the shipped starters and no persistence, not a warning over
 * someone's meeting.
 */
export function useSavedPrompts() {
  const [prompts, setPrompts] = useState<SavedPrompt[]>(() =>
    resolveSavedPrompts([]),
  );
  const [loaded, setLoaded] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const settings = await getSettings();
      setPrompts(resolveSavedPrompts(settings.ai?.savedPrompts));
    } catch (error) {
      console.error("Failed to load saved prompts:", error);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const settings = await getSettings();
        if (cancelled) return;
        setPrompts(resolveSavedPrompts(settings.ai?.savedPrompts));
      } catch (error) {
        if (!cancelled) {
          console.error("Failed to load saved prompts:", error);
        }
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Persist a whole resolved library.
   *
   * The list is written optimistically so the dialog does not flicker, then
   * reconciled with whatever the sidecar's sanitizer actually kept -- which
   * is the only honest source for "did that save".
   */
  const persist = useCallback(async (next: readonly SavedPrompt[]) => {
    setPrompts([...next]);
    setSaveError(null);
    try {
      const settings = await getSettings();
      await saveSettings({
        ...settings,
        ai: { ...(settings.ai ?? {}), savedPrompts: [...next] },
      });
      const saved = await getSettings();
      setPrompts(resolveSavedPrompts(saved.ai?.savedPrompts));
      return true;
    } catch (error) {
      console.error("Failed to save prompts:", error);
      setSaveError(
        error instanceof Error
          ? error.message
          : "Plainsong could not save your prompts.",
      );
      await reload();
      return false;
    }
  }, [reload]);

  return { prompts, loaded, saveError, persist, reload };
}
