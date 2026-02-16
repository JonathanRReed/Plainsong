import { useEffect, useMemo, useRef, useState } from "react";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  AppWindow,
  GripHorizontal,
  Minimize2,
  Monitor,
  PanelsTopLeft,
  Square,
  X,
} from "lucide-react";
import { getWaveformData, stopRecording } from "@/lib/tauri";

interface MeetingRecordingStateChangedEvent {
  phase: "idle" | "recording" | "transcribing" | "error";
  recordingId?: string | null;
  startedAtMs?: number | null;
  systemAudioActive?: boolean | null;
  message?: string | null;
}

interface RecordingTranscriptionStreamEvent {
  recordingId: string;
  isPartial: boolean;
  isFinal: boolean;
  text: string;
  startTime?: number;
  endTime?: number;
  confidence?: number;
}

export function RecordingPopup() {
  const window = getCurrentWindow();
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [startedAtMs, setStartedAtMs] = useState<number | null>(null);
  const [systemAudioActive, setSystemAudioActive] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcriptionPreview, setTranscriptionPreview] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [compact, setCompact] = useState(false);
  const [levels, setLevels] = useState<number[]>([]);
  const recordingIdRef = useRef<string | null>(null);
  const isTranscribingRef = useRef(false);

  useEffect(() => {
    recordingIdRef.current = recordingId;
    isTranscribingRef.current = isTranscribing;
  }, [isTranscribing, recordingId]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let unlistenStream: (() => void) | undefined;

    const setup = async () => {
      try {
        const initialState = await invoke<MeetingRecordingStateChangedEvent>(
          "get_recording_overlay_state"
        );
        if (initialState.phase === "recording" && initialState.recordingId) {
          setRecordingId(initialState.recordingId);
          setStartedAtMs(
            typeof initialState.startedAtMs === "number" ? initialState.startedAtMs : Date.now()
          );
          setSystemAudioActive(Boolean(initialState.systemAudioActive));
          setIsTranscribing(false);
        } else if (initialState.phase === "transcribing" && initialState.recordingId) {
          setRecordingId(initialState.recordingId);
          setIsTranscribing(true);
        }
      } catch (error) {
        console.error("Failed to load initial recording popup state:", error);
      }

      unlisten = await listen<MeetingRecordingStateChangedEvent>(
        "meeting-recording-state-changed",
        (event) => {
          const payload = event.payload;
          if (payload.phase === "recording" && payload.recordingId) {
            setRecordingId(payload.recordingId);
            setStartedAtMs(
              typeof payload.startedAtMs === "number" ? payload.startedAtMs : Date.now()
            );
            setSystemAudioActive(Boolean(payload.systemAudioActive));
            setIsTranscribing(false);
            setTranscriptionPreview("");
            setStopping(false);
            return;
          }

          if (payload.phase === "transcribing" && payload.recordingId) {
            setRecordingId(payload.recordingId);
            setIsTranscribing(true);
            setStopping(false);
            return;
          }

          setRecordingId(null);
          setStartedAtMs(null);
          setSystemAudioActive(false);
          setIsTranscribing(false);
          setTranscriptionPreview("");
          setStopping(false);
        }
      );

      unlistenStream = await listen<RecordingTranscriptionStreamEvent>(
        "recording-transcription-stream",
        (event) => {
          const currentRecordingId = recordingIdRef.current;
          const currentTranscribing = isTranscribingRef.current;
          if (event.payload.recordingId !== currentRecordingId && !currentTranscribing) {
            return;
          }
          if (event.payload.text.trim()) {
            setTranscriptionPreview(event.payload.text);
          }
          if (event.payload.isFinal) {
            setIsTranscribing(false);
          }
        }
      );
    };

    void setup();
    return () => {
      unlisten?.();
      unlistenStream?.();
    };
  }, []);

  useEffect(() => {
    if (!recordingId || isTranscribing) {
      setElapsed(0);
      return;
    }

    const tick = () => {
      const start = startedAtMs ?? Date.now();
      setElapsed(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [isTranscribing, recordingId, startedAtMs]);

  useEffect(() => {
    if (!recordingId || isTranscribing) {
      setLevels([]);
      return;
    }

    let cancelled = false;
    const interval = setInterval(async () => {
      try {
        const samples = await getWaveformData(recordingId);
        if (cancelled || !samples?.length) return;

        const targetBars = 18;
        const stride = Math.max(1, Math.floor(samples.length / targetBars));
        const bars: number[] = [];
        for (let i = 0; i < samples.length && bars.length < targetBars; i += stride) {
          const slice = samples.slice(i, i + stride);
          const avg =
            slice.reduce((acc, value) => acc + Math.abs(value), 0) / Math.max(1, slice.length);
          bars.push(Math.min(1, avg * 3));
        }
        setLevels(bars);
      } catch {
        // Ignore transient polling errors while recording starts/stops.
      }
    }, 250);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [isTranscribing, recordingId]);

  const elapsedText = useMemo(() => {
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }, [elapsed]);

  const toggleCompact = async () => {
    const next = !compact;
    setCompact(next);
    try {
      await window.setSize(new LogicalSize(next ? 300 : 460, next ? 130 : 220));
    } catch (error) {
      console.error("Failed to resize recording popup:", error);
    }
  };

  const hidePopup = async () => {
    try {
      await window.hide();
    } catch (error) {
      console.error("Failed to hide recording popup:", error);
    }
  };

  const openMainApp = async () => {
    try {
      await invoke("open_main_window");
    } catch (error) {
      console.error("Failed to open main window:", error);
    }
  };

  const handleStop = async () => {
    if (!recordingId || stopping) return;
    setStopping(true);
    try {
      await stopRecording(recordingId);
    } catch (error) {
      console.error("Failed to stop recording from popup:", error);
      setStopping(false);
    }
  };

  if (!recordingId) {
    return <div className="h-screen w-screen bg-transparent" />;
  }

  return (
    <div className="h-screen w-screen bg-transparent p-3">
      <div className="rounded-2xl border border-cyan-400/30 bg-slate-950/92 px-4 py-3 shadow-2xl backdrop-blur-md">
        <div
          className="mb-2 flex items-center justify-between text-slate-300"
          onMouseDown={() => void window.startDragging()}
        >
          <div className="inline-flex items-center gap-1 text-[11px] uppercase tracking-wide">
            <GripHorizontal className="h-3 w-3" />
            Move
          </div>
          <div className="inline-flex items-center gap-1">
            <button
              type="button"
              className="inline-flex h-6 w-6 items-center justify-center rounded-md hover:bg-white/10"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => void toggleCompact()}
              aria-label={compact ? "Expand popup" : "Compact popup"}
            >
              {compact ? <PanelsTopLeft className="h-3.5 w-3.5" /> : <Minimize2 className="h-3.5 w-3.5" />}
            </button>
            <button
              type="button"
              className="inline-flex h-6 w-6 items-center justify-center rounded-md hover:bg-white/10"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => void openMainApp()}
              aria-label="Open app"
            >
              <AppWindow className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className="inline-flex h-6 w-6 items-center justify-center rounded-md hover:bg-white/10"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => void hidePopup()}
              aria-label="Hide popup"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 text-white">
          <div className="flex items-center gap-3">
            {!compact && (
              <div className="flex h-8 items-end gap-1">
                {(levels.length ? levels : isTranscribing ? [0.25, 0.3, 0.25, 0.3] : [0.15, 0.35, 0.2, 0.4]).map((level, idx) => (
                  <span
                    key={`${idx}-${Math.round(level * 100)}`}
                    className="w-1 rounded-full bg-cyan-300/90 transition-all"
                    style={{ height: `${Math.max(20, Math.round(level * 100))}%` }}
                  />
                ))}
              </div>
            )}
            <div>
              <p className="text-sm font-semibold">Meeting recording</p>
              <p className="text-xs text-slate-300">
                {isTranscribing ? "Generating transcript preview" : "Live capture in progress"}
                {systemAudioActive && !isTranscribing && (
                  <span className="ml-2 inline-flex items-center gap-1">
                    <Monitor className="h-3 w-3" />
                    System audio
                  </span>
                )}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <span className="font-mono text-sm text-cyan-200">{elapsedText}</span>
            {!isTranscribing && (
              <button
                type="button"
                className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-rose-500/90 text-white hover:bg-rose-500 disabled:opacity-50"
                onClick={handleStop}
                disabled={stopping}
                aria-label="Stop recording"
              >
                <Square className="h-4 w-4 fill-current" />
              </button>
            )}
          </div>
        </div>
        {isTranscribing && (
          <div className="mt-2 rounded-lg border border-cyan-300/20 bg-slate-900/70 p-2 text-xs text-slate-200">
            {transcriptionPreview || "Preparing transcript preview..."}
          </div>
        )}
      </div>
    </div>
  );
}
