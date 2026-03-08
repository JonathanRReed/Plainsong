import { useEffect, useMemo, useRef, useState } from "react";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  AppWindow,
  CheckCircle2,
  GripHorizontal,
  Loader2,
  Mic,
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

type DisplayMode = "full" | "compact" | "minimal";

export function RecordingPopup() {
  const window = getCurrentWindow();
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [startedAtMs, setStartedAtMs] = useState<number | null>(null);
  const [systemAudioActive, setSystemAudioActive] = useState(false);
  const [phase, setPhase] = useState<"recording" | "transcribing" | "error">("recording");
  const [transcriptionPreview, setTranscriptionPreview] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [displayMode, setDisplayMode] = useState<DisplayMode>("full");
  const [levels, setLevels] = useState<number[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const recordingIdRef = useRef<string | null>(null);

  useEffect(() => {
    recordingIdRef.current = recordingId;
  }, [recordingId]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let unlistenStream: (() => void) | undefined;

    const setup = async () => {
      try {
        const initialState = await invoke<MeetingRecordingStateChangedEvent>(
          "get_recording_overlay_state"
        );
        if (
          (initialState.phase === "recording" || initialState.phase === "transcribing") &&
          initialState.recordingId
        ) {
          setRecordingId(initialState.recordingId);
          setStartedAtMs(
            typeof initialState.startedAtMs === "number" ? initialState.startedAtMs : Date.now()
          );
          setSystemAudioActive(Boolean(initialState.systemAudioActive));
          setPhase(initialState.phase);
          setMessage(initialState.message ?? null);
        }
      } catch (error) {
        console.error("Failed to load initial recording popup state:", error);
      }

      unlisten = await listen<MeetingRecordingStateChangedEvent>(
        "meeting-recording-state-changed",
        (event) => {
          const payload = event.payload;
          if ((payload.phase === "recording" || payload.phase === "transcribing") && payload.recordingId) {
            setRecordingId(payload.recordingId);
            setStartedAtMs(
              typeof payload.startedAtMs === "number" ? payload.startedAtMs : Date.now()
            );
            setSystemAudioActive(Boolean(payload.systemAudioActive));
            setPhase(payload.phase);
            setMessage(payload.message ?? null);
            if (payload.phase === "recording") {
              setTranscriptionPreview("");
            }
            setStopping(false);
            return;
          }

          setRecordingId(null);
          setStartedAtMs(null);
          setSystemAudioActive(false);
          setPhase("recording");
          setMessage(null);
          setTranscriptionPreview("");
          setStopping(false);
        }
      );

      unlistenStream = await listen<RecordingTranscriptionStreamEvent>(
        "recording-transcription-stream",
        (event) => {
          const currentRecordingId = recordingIdRef.current;
          if (!currentRecordingId || event.payload.recordingId !== currentRecordingId) {
            return;
          }
          if (event.payload.text.trim()) {
            setTranscriptionPreview(event.payload.text);
          }
          if (event.payload.isFinal) {
            setMessage("Transcript preview is ready in Meetings.");
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
    if (!recordingId || phase === "transcribing") {
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
  }, [phase, recordingId, startedAtMs]);

  useEffect(() => {
    if (!recordingId || phase === "transcribing") {
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
          bars.push(Math.min(1, avg * 12));
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
  }, [phase, recordingId]);

  const elapsedText = useMemo(() => {
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }, [elapsed]);

  const isTranscribing = phase === "transcribing";

  const cycleDisplayMode = async () => {
    const next: DisplayMode =
      displayMode === "full" ? "compact" : displayMode === "compact" ? "minimal" : "full";
    setDisplayMode(next);
    try {
      if (next === "minimal") {
        await window.setSize(new LogicalSize(170, 46));
      } else if (next === "compact") {
        await window.setSize(new LogicalSize(330, 126));
      } else {
        await window.setSize(new LogicalSize(470, 228));
      }
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

  const openMainApp = async (view?: "recordings" | "settings") => {
    try {
      if (view) {
        await invoke("open_main_window_to", { view });
      } else {
        await invoke("open_main_window");
      }
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

  if (displayMode === "minimal") {
    return (
      <div
        className="flex h-screen w-screen items-center justify-center bg-transparent"
        onMouseDown={() => void window.startDragging()}
      >
        <div className="flex items-center gap-3 rounded-full border border-cyan-400/25 bg-slate-950/92 px-3 py-2 text-white shadow-[0_20px_60px_rgba(2,6,23,0.45)] backdrop-blur-md">
          <span className={`h-2.5 w-2.5 rounded-full ${isTranscribing ? "bg-cyan-400" : "bg-rose-400"}`} />
          <span className="text-xs font-medium uppercase tracking-[0.18em]">
            {isTranscribing ? "Processing" : "Meeting"}
          </span>
          <span className="font-mono text-sm text-cyan-100">
            {isTranscribing ? "..." : elapsedText}
          </span>
          {!isTranscribing && (
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-rose-500/90 text-white hover:bg-rose-500 disabled:opacity-50"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={handleStop}
              disabled={stopping}
              aria-label="Stop recording"
            >
              <Square className="h-3.5 w-3.5 fill-current" />
            </button>
          )}
        </div>
      </div>
    );
  }

  const previewText =
    transcriptionPreview.trim() ||
    (isTranscribing
      ? "Generating the first transcript preview for this meeting."
      : "Capture is live. Stop when you want Nautilus to save and process the meeting.");

  const waveformBars = levels.length
    ? levels
    : isTranscribing
      ? [0.2, 0.28, 0.34, 0.26, 0.22, 0.28]
      : [0.18, 0.34, 0.24, 0.4, 0.3, 0.22];

  return (
    <div className="h-screen w-screen bg-transparent p-3">
      <div className="rounded-[28px] border border-cyan-400/20 bg-[linear-gradient(180deg,rgba(2,6,23,0.96),rgba(15,23,42,0.92))] px-4 py-3 text-white shadow-[0_24px_80px_rgba(2,6,23,0.5)] backdrop-blur-xl">
        <div
          className="mb-3 flex items-center justify-between text-slate-300"
          onMouseDown={() => void window.startDragging()}
        >
          <div className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-[0.2em]">
            <GripHorizontal className="h-3 w-3" />
            Move
          </div>
          <div className="inline-flex items-center gap-1">
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-white/10"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => void cycleDisplayMode()}
              aria-label={displayMode === "compact" ? "Minimal popup" : "Compact popup"}
            >
              {displayMode === "compact" ? (
                <PanelsTopLeft className="h-3.5 w-3.5" />
              ) : (
                <Minimize2 className="h-3.5 w-3.5" />
              )}
            </button>
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-white/10"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => void openMainApp()}
              aria-label="Open app"
            >
              <AppWindow className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-white/10"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={() => void hidePopup()}
              aria-label="Hide popup"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-2 rounded-full border border-cyan-400/30 bg-cyan-400/10 px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.16em] text-cyan-100">
            {isTranscribing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mic className="h-3.5 w-3.5" />}
            {isTranscribing ? "Processing" : "Meeting"}
          </span>
          <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] font-medium text-slate-200">
            {systemAudioActive ? <Monitor className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
            {systemAudioActive ? "Mic + system audio" : "Microphone only"}
          </span>
          {transcriptionPreview.trim() && (
            <span className="inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2.5 py-1 text-[11px] font-medium text-emerald-100">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Live transcript preview
            </span>
          )}
        </div>

        <div className={`mt-3 ${displayMode === "compact" ? "flex items-center justify-between gap-3" : "space-y-4"}`}>
          <div className="flex items-center gap-3">
            {displayMode === "full" && (
              <div className="flex h-14 items-end gap-1.5 rounded-2xl border border-white/8 bg-white/[0.04] px-3 py-2">
                {waveformBars.map((level, idx) => (
                  <span
                    key={`${idx}-${Math.round(level * 100)}`}
                    className="w-1.5 rounded-full bg-cyan-300/90 transition-all"
                    style={{ height: `${Math.max(18, Math.round(level * 100))}%` }}
                  />
                ))}
              </div>
            )}
            <div>
              <p className="text-base font-semibold tracking-tight">
                {isTranscribing ? "Finishing your meeting" : "Meeting recording in progress"}
              </p>
              <p className="text-sm text-slate-300">
                {stopping
                  ? "Stopping capture and handing off to transcription."
                  : message ||
                    (isTranscribing
                      ? "Nautilus is preparing the transcript and summary."
                      : "Capture stays local until you stop the meeting.")}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="rounded-2xl border border-cyan-400/20 bg-cyan-400/10 px-3 py-2 text-right">
              <p className="text-[10px] uppercase tracking-[0.18em] text-cyan-100/80">
                {isTranscribing ? "Status" : "Elapsed"}
              </p>
              <p className="font-mono text-base text-cyan-100">
                {isTranscribing ? "Saving" : elapsedText}
              </p>
            </div>
            {!isTranscribing && (
              <button
                type="button"
                className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-rose-500/90 text-white hover:bg-rose-500 disabled:opacity-50"
                onClick={handleStop}
                disabled={stopping}
                aria-label="Stop recording"
              >
                <Square className="h-4.5 w-4.5 fill-current" />
              </button>
            )}
          </div>
        </div>

        {displayMode === "full" && (
          <div className="mt-4 space-y-3">
            <div className="flex items-center gap-2 text-xs text-slate-300">
              <button
                type="button"
                className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 hover:bg-white/10"
                onClick={() => void openMainApp("recordings")}
              >
                Meetings
              </button>
              <button
                type="button"
                className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 hover:bg-white/10"
                onClick={() => void openMainApp("settings")}
              >
                Settings
              </button>
            </div>
            <div className="rounded-2xl border border-white/8 bg-white/[0.04] p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs font-medium uppercase tracking-[0.18em] text-slate-300">
                  Transcript preview
                </p>
                <p className="text-[11px] text-slate-400">
                  {isTranscribing ? "Updates while processing" : "Appears after you stop"}
                </p>
              </div>
              <p className="max-h-20 overflow-hidden text-sm leading-6 text-slate-100">
                {previewText}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
