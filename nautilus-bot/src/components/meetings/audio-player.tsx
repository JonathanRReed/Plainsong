import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useReducer,
  useRef,
  type KeyboardEvent,
} from "react";
import { FastForward, Pause, Play, Rewind } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WaveformVisualizer } from "@/components/waveform-visualizer";
import { listen } from "@/lib/electron";
import {
  prepareRecordingPlayback,
  releaseRecordingPlayback,
} from "@/lib/backend/recordings";
import {
  formatClock,
  initialPlaybackState,
  playbackReducer,
  SEEK_STEP_SECONDS,
} from "@/lib/playback";
import { cn } from "@/lib/utils";

/** What the meeting workspace can ask of the player from the transcript. */
export interface AudioPlayerHandle {
  seekTo: (time: number) => void;
  seekBy: (deltaSeconds: number) => void;
  togglePlayback: () => void;
}

interface AudioPlayerProps {
  recordingId: string;
  /** The stored waveform the scrubber is drawn over. Empty draws a flat line. */
  waveform: number[];
  /** Length from the recording row, shown until the audio reports its own. */
  durationHint?: number;
  onTimeUpdate?: (currentTime: number) => void;
  /**
   * The sidecar's own refusal, verbatim ("Vault is locked. Unlock vault before
   * opening encrypted recordings.") so the caller can pair it with the control
   * that fixes it.
   */
  onError?: (message: string) => void;
  className?: string;
}

type RevokedEvent = { token?: string; recordingId?: string; reason?: string };

const REVOKED_MESSAGE = "Playback stopped because the vault was locked. Unlock it to play again.";

function isInteractiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest("button, a, input:not([type=range]), textarea, select") !== null
  );
}

/**
 * In-app playback of one meeting's audio, synced to the transcript.
 *
 * The bytes come through `plainsong://playback/<token>`: the sidecar prepares
 * the recording (decrypting a vault-protected one into an app-owned temp),
 * the main process keeps the path, and this component only ever holds the
 * token. The token is released when the meeting changes or the player leaves
 * the page, which is what deletes the decrypted copy.
 */
export const AudioPlayer = forwardRef<AudioPlayerHandle, AudioPlayerProps>(function AudioPlayer(
  {
    recordingId,
    waveform,
    durationHint,
    onTimeUpdate,
    onError,
    className,
  },
  ref
) {
  const [state, dispatch] = useReducer(playbackReducer, initialPlaybackState);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const tokenRef = useRef<string | null>(null);
  const onErrorRef = useRef(onError);
  const onTimeUpdateRef = useRef(onTimeUpdate);
  onErrorRef.current = onError;
  onTimeUpdateRef.current = onTimeUpdate;

  // Prepare on mount / meeting change; release on the way out. The token is
  // tracked in a ref so an unmount that lands while prepare is still in
  // flight can still release what the sidecar is about to hand back.
  useEffect(() => {
    let cancelled = false;
    dispatch({ type: "prepare" });
    void prepareRecordingPlayback(recordingId)
      .then((prepared) => {
        if (cancelled) {
          void releaseRecordingPlayback(prepared.token).catch(() => {});
          return;
        }
        tokenRef.current = prepared.token;
        dispatch({
          type: "prepared",
          token: prepared.token,
          url: prepared.url,
          duration: prepared.durationSeconds,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        const message =
          error instanceof Error
            ? error.message
            : typeof error === "string"
              ? error
              : "Couldn't prepare this meeting's audio for playback.";
        dispatch({ type: "failed", message });
        onErrorRef.current?.(message);
      });
    return () => {
      cancelled = true;
      const token = tokenRef.current;
      tokenRef.current = null;
      if (token) {
        void releaseRecordingPlayback(token).catch(() => {});
      }
      dispatch({ type: "released" });
    };
  }, [recordingId]);

  // Locking the vault deletes the decrypted temp under a live token; the
  // sidecar says so and the player stops claiming it can play.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<RevokedEvent>("recording-playback-revoked", (event) => {
      if (event.payload?.token && event.payload.token === tokenRef.current) {
        audioRef.current?.pause();
        dispatch({ type: "failed", message: REVOKED_MESSAGE });
        onErrorRef.current?.(REVOKED_MESSAGE);
      }
    }).then((stop) => {
      if (disposed) {
        stop();
      } else {
        unlisten = stop;
      }
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = state.rate;
    }
  }, [state.rate, state.url]);

  const duration = state.duration > 0 ? state.duration : (durationHint ?? 0);
  const canPlay = state.status === "ready" || state.status === "playing" || state.status === "paused";

  const seekTo = useCallback(
    (time: number) => {
      const audio = audioRef.current;
      if (!audio || !canPlay) {
        return;
      }
      const clamped = Math.max(0, Math.min(time, duration > 0 ? duration : time));
      // The element fires `timeupdate` for the new position itself, which is
      // how the transcript learns of it. Reporting here as well would push a
      // clamped value over a cue the caller just set deliberately.
      audio.currentTime = clamped;
      dispatch({ type: "seek", time: clamped });
    },
    [canPlay, duration]
  );

  const seekBy = useCallback(
    (delta: number) => {
      seekTo((audioRef.current?.currentTime ?? state.currentTime) + delta);
    },
    [seekTo, state.currentTime]
  );

  const togglePlayback = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !canPlay) {
      return;
    }
    if (state.status === "playing") {
      audio.pause();
      return;
    }
    const attempt = audio.play();
    if (attempt && typeof attempt.catch === "function") {
      attempt.catch((error: unknown) => {
        const message =
          error instanceof Error && error.message
            ? `Couldn't play this audio: ${error.message}`
            : "Couldn't play this audio.";
        dispatch({ type: "failed", message });
        onErrorRef.current?.(message);
      });
    }
  }, [canPlay, state.status]);

  useImperativeHandle(ref, () => ({ seekTo, seekBy, togglePlayback }), [
    seekTo,
    seekBy,
    togglePlayback,
  ]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isInteractiveTarget(event.target)) {
      return;
    }
    if (event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      togglePlayback();
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      seekBy(-SEEK_STEP_SECONDS);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      seekBy(SEEK_STEP_SECONDS);
    }
  };

  const progress = duration > 0 ? Math.min(1, state.currentTime / duration) : 0;
  const isPlaying = state.status === "playing";

  return (
    <div
      role="group"
      aria-label="Audio player"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className={cn(
        "rounded-md border border-border/70 bg-card px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
    >
      {/* The element itself stays out of the way; the controls below are the
          player. `preload="metadata"` fetches the header only, so opening a
          long meeting does not pull its whole audio before the first play. */}
      <audio
        ref={audioRef}
        src={state.url ?? undefined}
        preload="metadata"
        data-testid="meeting-audio"
        onLoadedMetadata={(event) =>
          dispatch({ type: "duration", duration: event.currentTarget.duration })
        }
        onDurationChange={(event) =>
          dispatch({ type: "duration", duration: event.currentTarget.duration })
        }
        onTimeUpdate={(event) => {
          const time = event.currentTarget.currentTime;
          dispatch({ type: "time", currentTime: time });
          onTimeUpdateRef.current?.(time);
        }}
        onPlay={() => dispatch({ type: "play" })}
        onPause={() => dispatch({ type: "pause" })}
        onEnded={() => dispatch({ type: "ended" })}
        onError={() => {
          const message = "This meeting's audio could not be read for playback.";
          dispatch({ type: "failed", message });
          onErrorRef.current?.(message);
        }}
      />

      <div className="relative">
        <WaveformVisualizer data={waveform} height={56} />
        {/* Played portion and the playhead, over the stored waveform. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-0 rounded-l-md bg-gold/15 motion-safe:transition-[width] motion-safe:duration-150"
          style={{ width: `${progress * 100}%` }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 w-0.5 bg-gold"
          style={{ left: `${progress * 100}%` }}
        />
        <input
          type="range"
          aria-label="Playback position"
          aria-valuetext={`${formatClock(state.currentTime)} of ${formatClock(duration)}`}
          min={0}
          max={duration > 0 ? duration : 0}
          step={0.1}
          value={Math.min(state.currentTime, duration > 0 ? duration : 0)}
          disabled={!canPlay || duration <= 0}
          onChange={(event) => seekTo(Number(event.target.value))}
          onKeyDown={(event) => {
            // The native step is a tenth of a second; ← → mean five here,
            // the same as everywhere else in the player.
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              seekBy(event.key === "ArrowLeft" ? -SEEK_STEP_SECONDS : SEEK_STEP_SECONDS);
            }
          }}
          className="absolute inset-0 h-full w-full cursor-pointer appearance-none bg-transparent opacity-0 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
        />
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label={isPlaying ? "Pause" : "Play"}
          aria-pressed={isPlaying}
          disabled={!canPlay}
          onClick={togglePlayback}
        >
          {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={`Back ${SEEK_STEP_SECONDS} seconds`}
          disabled={!canPlay}
          onClick={() => seekBy(-SEEK_STEP_SECONDS)}
        >
          <Rewind className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={`Forward ${SEEK_STEP_SECONDS} seconds`}
          disabled={!canPlay}
          onClick={() => seekBy(SEEK_STEP_SECONDS)}
        >
          <FastForward className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={`Playback speed ${state.rate} times`}
          disabled={!canPlay}
          onClick={() => dispatch({ type: "cycleRate" })}
          className="font-mono"
        >
          {state.rate}×
        </Button>

        <span className="time-spec ml-1 inline-flex items-center gap-2 text-sm text-muted-foreground">
          {isPlaying ? <span className="neume neume-lit" aria-hidden="true" /> : null}
          <span aria-live="off">
            {formatClock(state.currentTime)} / {formatClock(duration)}
          </span>
        </span>

        <span className="flex-1" />

        {state.status === "preparing" ? (
          <span className="rubric-muted">Preparing audio</span>
        ) : null}
      </div>

      {state.status === "error" && state.error ? (
        <p className="mt-2 inline-flex items-start gap-2 text-sm text-rust" role="status">
          <span className="neume neume-hollow mt-1.5 shrink-0" aria-hidden="true" />
          <span>{state.error}</span>
        </p>
      ) : null}
    </div>
  );
});
