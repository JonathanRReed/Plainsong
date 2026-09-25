import { useCallback, useEffect, useRef } from "react";
import { getDictationAudioLevel } from "@/lib/backend";

/** Below this the sidecar's level is room tone, not a voice. */
const SILENCE_FLOOR = 0.03;
/** The same lift the dictation pill and onboarding give the raw level. */
const LEVEL_GAIN = 1.9;
const POLL_MS = 90;

/**
 * The live dictation level (0-1) as a getter, for effects that sample it
 * every animation frame. The microphone belongs to the sidecar, so this
 * polls it over IPC while `active` and writes into a ref: nothing re-renders
 * per sample, and the getter reads 0 once dictation stops.
 */
export function useDictationLevel(active: boolean): () => number {
  const levelRef = useRef(0);

  useEffect(() => {
    levelRef.current = 0;
    if (!active) return;
    let mounted = true;
    const sample = () => {
      void getDictationAudioLevel()
        .then((raw) => {
          if (mounted) {
            levelRef.current = raw < SILENCE_FLOOR ? 0 : Math.min(1, raw * LEVEL_GAIN);
          }
        })
        .catch(() => {
          if (mounted) levelRef.current = 0;
        });
    };
    sample();
    const timer = window.setInterval(sample, POLL_MS);
    return () => {
      mounted = false;
      window.clearInterval(timer);
      levelRef.current = 0;
    };
  }, [active]);

  return useCallback(() => levelRef.current, []);
}
