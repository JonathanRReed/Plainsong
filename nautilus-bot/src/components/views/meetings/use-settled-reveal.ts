import { useEffect, useState, type RefObject } from "react";

/**
 * Holds a region back until what sits above it has stopped changing size.
 *
 * The meetings list sits under a header whose banners (the calendar offer, a
 * detected call) each arrive on their own fetch. Shown straight away, the
 * list jumped down once for every banner that landed. The region stays at
 * opacity 0 until `ready` is true and `watchRef` has kept its size for
 * `quietMs`, then fades in. Content at opacity 0 does not count as a layout
 * shift, and `maxWaitMs` bounds the wait so a slow fetch never leaves the
 * page blank.
 */
export function useSettledReveal(
  ready: boolean,
  watchRef: RefObject<HTMLElement | null>,
  { quietMs = 150, maxWaitMs = 800 }: { quietMs?: number; maxWaitMs?: number } = {},
): boolean {
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    if (revealed) return;
    const cap = window.setTimeout(() => setRevealed(true), maxWaitMs);
    return () => window.clearTimeout(cap);
  }, [maxWaitMs, revealed]);

  useEffect(() => {
    if (revealed || !ready) return;
    const target = watchRef.current;
    if (!target || typeof ResizeObserver === "undefined") {
      setRevealed(true);
      return;
    }
    let quiet = window.setTimeout(() => setRevealed(true), quietMs);
    const observer = new ResizeObserver(() => {
      window.clearTimeout(quiet);
      quiet = window.setTimeout(() => setRevealed(true), quietMs);
    });
    observer.observe(target);
    return () => {
      observer.disconnect();
      window.clearTimeout(quiet);
    };
  }, [quietMs, ready, revealed, watchRef]);

  return revealed;
}
