/**
 * Pure state for in-app audio playback: the reducer the player drives, the
 * rate steps, and the segment-at-time lookup the transcript uses to follow
 * the playhead. Nothing here touches the DOM or the bridge, so every policy
 * decision is testable without an `<audio>` element.
 */

export type PlaybackStatus = "idle" | "preparing" | "ready" | "playing" | "paused" | "error";

export type PlaybackRate = 1 | 1.5 | 2;

export const PLAYBACK_RATES: readonly PlaybackRate[] = [1, 1.5, 2];

/** How far the ← → keys and the skip buttons move, in seconds. */
export const SEEK_STEP_SECONDS = 5;

export interface PlaybackState {
  status: PlaybackStatus;
  token: string | null;
  url: string | null;
  currentTime: number;
  duration: number;
  rate: PlaybackRate;
  error: string | null;
}

export type PlaybackAction =
  | { type: "prepare" }
  | { type: "prepared"; token: string; url: string; duration: number }
  | { type: "failed"; message: string }
  | { type: "play" }
  | { type: "pause" }
  | { type: "ended" }
  | { type: "time"; currentTime: number }
  | { type: "duration"; duration: number }
  | { type: "seek"; time: number }
  | { type: "rate"; rate: PlaybackRate }
  | { type: "cycleRate" }
  | { type: "released" };

export const initialPlaybackState: PlaybackState = {
  status: "idle",
  token: null,
  url: null,
  currentTime: 0,
  duration: 0,
  rate: 1,
  error: null,
};

export function clampTime(time: number, duration: number): number {
  if (!Number.isFinite(time) || time < 0) {
    return 0;
  }
  if (Number.isFinite(duration) && duration > 0 && time > duration) {
    return duration;
  }
  return time;
}

export function nextPlaybackRate(rate: PlaybackRate): PlaybackRate {
  const index = PLAYBACK_RATES.indexOf(rate);
  return PLAYBACK_RATES[(index + 1) % PLAYBACK_RATES.length];
}

export function playbackReducer(state: PlaybackState, action: PlaybackAction): PlaybackState {
  switch (action.type) {
    case "prepare":
      return { ...initialPlaybackState, rate: state.rate, status: "preparing" };
    case "prepared":
      return {
        ...state,
        status: "ready",
        token: action.token,
        url: action.url,
        duration: Math.max(0, action.duration),
        currentTime: 0,
        error: null,
      };
    case "failed":
      // The token is kept on a failure that arrives after a successful
      // prepare (a revoke), so the release on unmount still finds it.
      return { ...state, status: "error", error: action.message };
    case "play":
      return state.status === "error" ? state : { ...state, status: "playing" };
    case "pause":
      return state.status === "playing" ? { ...state, status: "paused" } : state;
    case "ended":
      return state.status === "error"
        ? state
        : { ...state, status: "paused", currentTime: state.duration };
    case "time":
      return { ...state, currentTime: clampTime(action.currentTime, state.duration) };
    case "duration":
      return Number.isFinite(action.duration) && action.duration > 0
        ? { ...state, duration: action.duration }
        : state;
    case "seek":
      return { ...state, currentTime: clampTime(action.time, state.duration) };
    case "rate":
      return { ...state, rate: action.rate };
    case "cycleRate":
      return { ...state, rate: nextPlaybackRate(state.rate) };
    case "released":
      return { ...initialPlaybackState, rate: state.rate };
    default:
      return state;
  }
}

export interface TimeRange {
  start: number;
  end: number;
}

/**
 * Index of the range containing `time`, or -1.
 *
 * Binary search over ranges sorted by `start`: the last range starting at or
 * before `time` is the only candidate, and it wins only if `time` has not run
 * past its end. Adjacent ranges that share a boundary resolve to the later
 * one, which is what a playhead crossing into the next line should show.
 */
export function rangeIndexAtTime(ranges: readonly TimeRange[], time: number): number {
  if (ranges.length === 0 || !Number.isFinite(time)) {
    return -1;
  }
  let low = 0;
  let high = ranges.length - 1;
  let candidate = -1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (ranges[mid].start <= time) {
      candidate = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (candidate === -1) {
    return -1;
  }
  return time <= ranges[candidate].end ? candidate : -1;
}

/** `m:ss`, or `h:mm:ss` once an hour is on the clock. */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const mmss = `${minutes.toString().padStart(hours > 0 ? 2 : 1, "0")}:${secs
    .toString()
    .padStart(2, "0")}`;
  return hours > 0 ? `${hours}:${mmss}` : mmss;
}
