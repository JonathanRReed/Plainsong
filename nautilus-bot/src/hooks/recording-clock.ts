/**
 * The live capture clock, held outside React state.
 *
 * The recording provider sits at the root of the app. With the elapsed
 * seconds in its state, every tick produced a new context value and
 * re-rendered every view that reads recording state, once a second for the
 * length of a meeting. The seconds live here instead: the provider's timer
 * writes to the store, and only the labels that show the clock subscribe.
 * Same shape as `playhead-store`.
 */
import { useSyncExternalStore } from "react";

export interface RecordingClock {
  /** Whole seconds of capture so far; 0 when nothing is recording. */
  get(): number;
  set(value: number): void;
  subscribe(listener: () => void): () => void;
}

export function createRecordingClock(): RecordingClock {
  let value = 0;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      if (next === value) {
        return;
      }
      value = next;
      for (const listener of [...listeners]) {
        listener();
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** mm:ss, the format every live timer label uses. */
export function formatRecordingClock(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

/** Subscribe to the clock. Re-renders only the caller. */
export function useRecordingClockValue(clock: RecordingClock): number {
  return useSyncExternalStore(clock.subscribe, clock.get, clock.get);
}
