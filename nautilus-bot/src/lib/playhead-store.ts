/**
 * A playhead that can move without re-rendering the page around it.
 *
 * An `<audio>` element reports its position about four times a second. Held in
 * the meetings view's own state, every one of those ticks re-rendered a
 * five-thousand-line component to move one highlight. The value lives here
 * instead: the player writes to the store, and only the component that
 * subscribes to it re-renders.
 *
 * Deliberately not a context: there is one player and one transcript on the
 * screen, and passing the store down is clearer than a provider nobody else
 * reads.
 */
import { useRef, useSyncExternalStore } from "react";

export interface PlayheadStore {
  /** Seconds into the recording, or undefined when nothing is cued yet. */
  get(): number | undefined;
  set(value: number | undefined): void;
  subscribe(listener: () => void): () => void;
}

export function createPlayheadStore(initial?: number): PlayheadStore {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      // `timeupdate` repeats the same position while paused; a tick that
      // changes nothing must not wake a subscriber.
      if (Object.is(next, value)) {
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

/** One store for the life of the component that owns it. */
export function usePlayheadStore(): PlayheadStore {
  const store = useRef<PlayheadStore | null>(null);
  if (!store.current) {
    store.current = createPlayheadStore();
  }
  return store.current;
}

/** Subscribe to the playhead. Re-renders only the caller. */
export function usePlayhead(store: PlayheadStore): number | undefined {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
