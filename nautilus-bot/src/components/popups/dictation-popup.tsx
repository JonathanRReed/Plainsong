import { useEffect, useMemo, useState } from "react";
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
  PanelsTopLeft,
  Square,
  TriangleAlert,
  X,
} from "lucide-react";
import { forceStopDictation, getSettings, getDictationAudioLevel } from "@/lib/tauri";

type DictationPhase = "idle" | "recording" | "stopping" | "transcribing" | "done" | "error";

interface DictationStateChangedEvent {
  phase: DictationPhase;
  startedAtMs?: number | null;
  message?: string | null;
  preview?: string | null;
  sessionId?: number | null;
  stopReason?: string | null;
  outcome?: string | null;
}

export function DictationPopup() {
  const window = getCurrentWindow();
  const [phase, setPhase] = useState<DictationPhase>("idle");
  const [startedAtMs, setStartedAtMs] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [compact, setCompact] = useState(false);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [pushToTalk, setPushToTalk] = useState(true);
  const [audioLevel, setAudioLevel] = useState(0);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const setup = async () => {
      try {
        const initialState = await invoke<DictationStateChangedEvent>("get_dictation_overlay_state");
        try {
          const settings = await getSettings();
          setPushToTalk(Boolean(settings.transcription.dictationPushToTalk));
        } catch {
          // Keep default mode if settings are temporarily unavailable.
        }
        setPhase(initialState.phase);
        setMessage(initialState.message ?? null);
        setPreview(initialState.preview ?? null);
        setOutcome(initialState.outcome ?? null);
        setSessionId(typeof initialState.sessionId === "number" ? initialState.sessionId : null);
        if (initialState.phase === "recording") {
          setStartedAtMs(
            typeof initialState.startedAtMs === "number" ? initialState.startedAtMs : Date.now()
          );
        }
      } catch (error) {
        console.error("Failed to load initial dictation popup state:", error);
      }

      unlisten = await listen<DictationStateChangedEvent>("dictation-state-changed", (event) => {
        const payload = event.payload;
        setPhase(payload.phase);
        setMessage(payload.message ?? null);
        setPreview(payload.preview ?? null);
        setOutcome(payload.outcome ?? null);
        setSessionId(typeof payload.sessionId === "number" ? payload.sessionId : null);
        if (payload.phase === "recording") {
          const startMs =
            typeof payload.startedAtMs === "number" ? payload.startedAtMs : Date.now();
          setStartedAtMs(startMs);
        }
      });
    };

    void setup();
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    if (phase !== "recording") {
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
  }, [phase, startedAtMs]);

  useEffect(() => {
    if (phase !== "recording") {
      setAudioLevel(0);
      return;
    }

    const id = setInterval(() => {
      void getDictationAudioLevel()
        .then((level) => setAudioLevel(level))
        .catch(() => setAudioLevel(0));
    }, 50);
    return () => clearInterval(id);
  }, [phase]);

  useEffect(() => {
    const id = setInterval(() => {
      void invoke<DictationStateChangedEvent>("get_dictation_overlay_state")
        .then((state) => {
          const snapshotSessionId =
            typeof state.sessionId === "number" ? state.sessionId : null;
          if (state.phase !== phase || snapshotSessionId !== sessionId) {
            setPhase(state.phase);
            setMessage(state.message ?? null);
            setPreview(state.preview ?? null);
            setOutcome(state.outcome ?? null);
            setSessionId(snapshotSessionId);
            if (state.phase === "recording") {
              setStartedAtMs(
                typeof state.startedAtMs === "number" ? state.startedAtMs : Date.now()
              );
            }
          }
        })
        .catch(() => {
          // Ignore intermittent overlay polling failures.
        });
    }, 2500);

    return () => clearInterval(id);
  }, [phase, sessionId]);

  const elapsedText = useMemo(() => {
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }, [elapsed]);

  const toggleCompact = async () => {
    const next = !compact;
    setCompact(next);
    try {
      await window.setSize(new LogicalSize(next ? 280 : 360, next ? 120 : 160));
    } catch (error) {
      console.error("Failed to resize dictation popup:", error);
    }
  };

  const openMainApp = async () => {
    try {
      await invoke("open_main_window");
    } catch (error) {
      console.error("Failed to open main window:", error);
    }
  };

  const hidePopup = async () => {
    try {
      await window.hide();
    } catch (error) {
      console.error("Failed to hide dictation popup:", error);
    }
  };

  if (phase === "idle") {
    return <div className="h-screen w-screen bg-transparent" />;
  }

  return (
    <div className="h-screen w-screen bg-transparent p-3">
      <div className="rounded-2xl border border-cyan-400/35 bg-gradient-to-br from-slate-950/95 via-slate-900/90 to-cyan-950/55 px-4 py-3 backdrop-blur-md">
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

        {phase === "recording" && (
          <div className="flex items-center gap-3 text-white">
            <div className="rounded-full bg-orange-500/20 p-2">
              <Mic className="h-5 w-5 text-orange-300 animate-pulse" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold">Listening</p>
              {!compact && (
                <>
                  <div className="mt-1 h-1.5 w-full max-w-[200px] rounded-full bg-slate-700/50 overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-orange-400 to-orange-300 transition-all duration-75 rounded-full"
                      style={{ width: `${Math.min(100, audioLevel * 100)}%` }}
                    />
                  </div>
                  <p className="text-xs text-slate-300 mt-1">
                    {pushToTalk
                      ? "Release hotkey to transcribe + paste"
                      : "Press the hotkey again to transcribe + paste"}
                  </p>
                </>
              )}
            </div>
            <span className="font-mono text-sm text-orange-200">{elapsedText}</span>
            <button
              type="button"
              className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-rose-500/90 text-white hover:bg-rose-500"
              onClick={() => void forceStopDictation()}
              aria-label="Stop dictation"
            >
              <Square className="h-4 w-4 fill-current" />
            </button>
            {!compact && elapsed >= 10 && (
              <button
                type="button"
                className="text-xs text-rose-300 underline underline-offset-2"
                onClick={() => void forceStopDictation()}
              >
                Stop now
              </button>
            )}
          </div>
        )}

        {phase === "stopping" && (
          <div className="flex items-center gap-3 text-white">
            <Loader2 className="h-5 w-5 animate-spin text-orange-300" />
            <div>
              <p className="text-sm font-semibold">Stopping capture</p>
              <p className="text-xs text-slate-300">Finalizing audio…</p>
            </div>
          </div>
        )}

        {phase === "transcribing" && (
          <div className="flex items-center gap-3 text-white">
            <Loader2 className="h-5 w-5 animate-spin text-cyan-300" />
            <div>
              <p className="text-sm font-semibold">Transcribing</p>
              <p className="text-xs text-slate-300">Preparing text for paste/clipboard…</p>
            </div>
          </div>
        )}

        {phase === "done" && (
          <div className="flex items-center gap-3 text-white">
            <CheckCircle2 className="h-5 w-5 text-emerald-300" />
            <div>
              <p className="text-sm font-semibold">
                {outcome === "pasted"
                  ? "Paste command sent"
                  : outcome === "copied"
                    ? "Copied to clipboard"
                    : "Transcription ready"}
              </p>
              {!compact && message && (
                <p className="text-xs text-slate-300 max-w-[280px]">{message}</p>
              )}
              {!compact && !message && preview && (
                <p className="text-xs text-slate-300 truncate max-w-[260px]">{preview}</p>
              )}
            </div>
          </div>
        )}

        {phase === "error" && (
          <div className="flex items-center gap-3 text-white">
            <TriangleAlert className="h-5 w-5 text-rose-300" />
            <div>
              <p className="text-sm font-semibold">Dictation failed</p>
              {!compact && message && <p className="text-xs text-slate-300 max-w-[280px]">{message}</p>}
              {!compact && (
                <p className="text-xs text-rose-200/90">
                  Check microphone access, active provider, and shortcut permissions.
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
