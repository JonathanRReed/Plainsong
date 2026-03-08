import { useEffect, useMemo, useState } from "react";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  AppWindow,
  CheckCircle2,
  Clipboard,
  GripHorizontal,
  Loader2,
  Mail,
  Mic,
  Minimize2,
  PanelsTopLeft,
  Square,
  StickyNote,
  TextCursorInput,
  TriangleAlert,
  Wand2,
  X,
} from "lucide-react";
import {
  getSettings,
  getDictationAudioLevel,
  stopDictation,
} from "@/lib/tauri";
import type { DictationCustomMode } from "@/types/settings";

type DisplayMode = "full" | "compact" | "minimal";
type DictationPhase =
  | "idle"
  | "starting"
  | "recording"
  | "stopping"
  | "transcribing"
  | "done"
  | "error";

interface DictationStateChangedEvent {
  phase: DictationPhase;
  startedAtMs?: number | null;
  message?: string | null;
  preview?: string | null;
  sessionId?: number | null;
  stopReason?: string | null;
  outcome?: string | null;
  resolvedModePreset?: DictationModePreset | null;
  resolvedCustomModeId?: string | null;
  resolvedModeLabel?: string | null;
  contextSource?: DictationContextSource | null;
  insertionMode?: DictationInsertionMode | null;
  appTarget?: string | null;
  activationMatcher?: string | null;
  dictationProvider?: string | null;
  dictationModelId?: string | null;
}

type DictationModePreset =
  | "voice"
  | "messages"
  | "email"
  | "notes"
  | "meeting_follow_up"
  | "custom";

type DictationContextSource = "none" | "clipboard" | "selected_text" | "application_context";
type DictationInsertionMode = "auto" | "paste" | "inline" | "clipboard_only";
const MODE_META: Record<
  DictationModePreset,
  { label: string; icon: typeof Mic; accent: string }
> = {
  voice: { label: "Voice", icon: Mic, accent: "text-cyan-200 bg-cyan-400/10 border-cyan-400/30" },
  messages: {
    label: "Messages",
    icon: TextCursorInput,
    accent: "text-emerald-200 bg-emerald-400/10 border-emerald-400/30",
  },
  email: { label: "Email", icon: Mail, accent: "text-amber-200 bg-amber-400/10 border-amber-400/30" },
  notes: { label: "Notes", icon: StickyNote, accent: "text-violet-200 bg-violet-400/10 border-violet-400/30" },
  meeting_follow_up: {
    label: "Follow-up",
    icon: Wand2,
    accent: "text-fuchsia-200 bg-fuchsia-400/10 border-fuchsia-400/30",
  },
  custom: { label: "Custom", icon: Wand2, accent: "text-slate-200 bg-slate-400/10 border-slate-400/30" },
};

const CONTEXT_META: Record<DictationContextSource, { label: string; detail: string }> = {
  none: { label: "No context", detail: "Fresh dictation" },
  clipboard: { label: "Clipboard", detail: "Using copied text" },
  selected_text: { label: "Selected text", detail: "Using current selection" },
  application_context: { label: "App context", detail: "Using the frontmost app and window" },
};

const INSERTION_META: Record<DictationInsertionMode, { label: string; detail: string }> = {
  auto: { label: "Recommended", detail: "Best available insert path" },
  paste: { label: "Paste at cursor", detail: "Paste into the frontmost app" },
  inline: { label: "Insert on release", detail: "Single insert after you stop speaking" },
  clipboard_only: { label: "Clipboard only", detail: "Do not try to insert automatically" },
};

function formatRouteLabel(provider: string | null, modelId: string | null) {
  if (!provider && !modelId) {
    return "Current transcription route";
  }
  if (provider && modelId) {
    return `${provider} · ${modelId}`;
  }
  return provider || modelId || "Current transcription route";
}

function estimatePopupTextLines(value: string | null, charsPerLine: number) {
  if (!value) {
    return 0;
  }

  return value
    .split("\n")
    .reduce((total, line) => total + Math.max(1, Math.ceil(line.length / charsPerLine)), 0);
}

function getPopupSize(
  displayMode: DisplayMode,
  phase: DictationPhase,
  message: string | null,
  preview: string | null
) {
  if (displayMode === "minimal") {
    return { width: 180, height: 48 };
  }

  if (displayMode === "compact") {
    const compactMessageLines = estimatePopupTextLines(message, 32);
    const compactPreviewLines = estimatePopupTextLines(preview, 32);
    return {
      width: 360,
      height:
        phase === "idle"
          ? 212
          : phase === "error"
            ? Math.max(212, 168 + compactMessageLines * 20)
            : phase === "done"
              ? Math.max(196, 154 + Math.max(compactMessageLines, compactPreviewLines) * 18)
              : phase === "recording"
                ? Math.max(182, 148 + compactPreviewLines * 16)
                : 164,
    };
  }

  if (phase === "idle") {
    return { width: 480, height: 336 };
  }

  if (phase === "error") {
    const messageLines = estimatePopupTextLines(message, 48);
    return { width: 480, height: Math.max(320, 248 + messageLines * 22) };
  }

  if (phase === "recording") {
    const previewLines = estimatePopupTextLines(preview, 48);
    return { width: 480, height: Math.max(272, 224 + previewLines * 20) };
  }

  if (phase === "done") {
    const contentLines = Math.max(
      estimatePopupTextLines(message, 48),
      estimatePopupTextLines(preview, 48)
    );
    return { width: 480, height: Math.max(264, 214 + contentLines * 20) };
  }

  const previewLines = estimatePopupTextLines(preview, 48);
  const messageLines = estimatePopupTextLines(message, 48);
  return {
    width: 480,
    height: Math.max(236, 194 + Math.max(previewLines, messageLines) * 18),
  };
}

export function DictationPopup() {
  const window = getCurrentWindow();
  const [phase, setPhase] = useState<DictationPhase>("idle");
  const [startedAtMs, setStartedAtMs] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [displayMode, setDisplayMode] = useState<DisplayMode>("full");
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [pushToTalk, setPushToTalk] = useState(true);
  const [audioLevel, setAudioLevel] = useState(0);
  const [modePreset, setModePreset] = useState<DictationModePreset>("voice");
  const [contextSource, setContextSource] = useState<DictationContextSource>("none");
  const [selectedCustomModeId, setSelectedCustomModeId] = useState<string | null>(null);
  const [customModes, setCustomModes] = useState<DictationCustomMode[]>([]);
  const [dictationProvider, setDictationProvider] = useState<string | null>(null);
  const [dictationModelId, setDictationModelId] = useState<string | null>(null);
  const [dictationInsertionMode, setDictationInsertionMode] =
    useState<DictationInsertionMode>("paste");
  const [resolvedModeLabel, setResolvedModeLabel] = useState<string | null>(null);
  const [runtimeAppTarget, setRuntimeAppTarget] = useState<string | null>(null);
  const [activationMatcher, setActivationMatcher] = useState<string | null>(null);

  const refreshPopupSettings = async () => {
    const settings = await getSettings();
    setPushToTalk(Boolean(settings.transcription.dictationPushToTalk));
    setModePreset((settings.transcription.dictationModePreset ?? "voice") as DictationModePreset);
    setSelectedCustomModeId(settings.transcription.dictationSelectedCustomModeId ?? null);
    setCustomModes(settings.transcription.dictationCustomModes ?? []);
    setContextSource(
      (settings.transcription.dictationContextSource ?? "none") as DictationContextSource
    );
    setDictationProvider(settings.transcription.dictationProvider ?? null);
    setDictationModelId(settings.transcription.dictationModelId ?? null);
    setDictationInsertionMode(
      (settings.transcription.dictationInsertionMode ?? "paste") as DictationInsertionMode
    );
  };

  const applyRuntimeMetadata = (payload: DictationStateChangedEvent) => {
    setResolvedModeLabel(payload.resolvedModeLabel ?? null);
    setRuntimeAppTarget(payload.appTarget ?? null);
    if (payload.resolvedModePreset) {
      setModePreset(payload.resolvedModePreset);
    }
    if (typeof payload.resolvedCustomModeId !== "undefined") {
      setSelectedCustomModeId(payload.resolvedCustomModeId ?? null);
    }
    if (payload.contextSource) {
      setContextSource(payload.contextSource);
    }
    if (payload.insertionMode) {
      setDictationInsertionMode(payload.insertionMode);
    }
    if (typeof payload.activationMatcher !== "undefined") {
      setActivationMatcher(payload.activationMatcher ?? null);
    }
    if (typeof payload.dictationProvider !== "undefined") {
      setDictationProvider(payload.dictationProvider ?? null);
    }
    if (typeof payload.dictationModelId !== "undefined") {
      setDictationModelId(payload.dictationModelId ?? null);
    }
  };

  const handleStopFromPopup = async () => {
    try {
      await stopDictation();
    } catch (error) {
      console.error("Failed to stop dictation from popup:", error);
    }
  };

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const setup = async () => {
      try {
        const initialState = await invoke<DictationStateChangedEvent>("get_dictation_overlay_state");
        try {
          await refreshPopupSettings();
        } catch {
          // Keep default mode if settings are temporarily unavailable.
        }
        applyRuntimeMetadata(initialState);
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
        applyRuntimeMetadata(payload);
        setPhase(payload.phase);
        setMessage(payload.message ?? null);
        setPreview(payload.preview ?? null);
        setOutcome(payload.outcome ?? null);
        setSessionId(typeof payload.sessionId === "number" ? payload.sessionId : null);
        if (payload.phase === "recording" && typeof payload.startedAtMs === "number") {
          setStartedAtMs(payload.startedAtMs);
        }
      });
    };

    void setup();
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      if (phase === "idle") {
        void refreshPopupSettings().catch(() => {
          // Ignore intermittent settings fetch issues while idle.
        });
      }
    }, 2500);

    return () => clearInterval(id);
  }, [phase]);

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
        .then((level) => {
          // Apply additional scaling for better visualization
          // The backend already applies sqrt, we boost it further
          // and apply a minimum threshold to show some activity
          const scaled = Math.max(0.05, Math.min(1, level * 2.5));
          setAudioLevel(scaled);
        })
        .catch(() => setAudioLevel(0));
    }, 120);
    return () => clearInterval(id);
  }, [phase]);

  useEffect(() => {
    const id = setInterval(() => {
      void invoke<DictationStateChangedEvent>("get_dictation_overlay_state")
        .then((state) => {
          const snapshotSessionId =
            typeof state.sessionId === "number" ? state.sessionId : null;
          if (state.phase !== phase || snapshotSessionId !== sessionId) {
            applyRuntimeMetadata(state);
            setPhase(state.phase);
            setMessage(state.message ?? null);
            setPreview(state.preview ?? null);
            setOutcome(state.outcome ?? null);
            setSessionId(snapshotSessionId);
            if (state.phase === "recording" && typeof state.startedAtMs === "number") {
              setStartedAtMs(state.startedAtMs);
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

  const modeMeta = MODE_META[modePreset] ?? MODE_META.voice;
  const selectedModeLabel =
    resolvedModeLabel ??
    (modePreset === "custom"
      ? customModes.find((option) => option.id === selectedCustomModeId)?.name ?? modeMeta.label
      : modeMeta.label);
  const contextMeta = CONTEXT_META[contextSource] ?? CONTEXT_META.none;
  const insertionMeta = INSERTION_META[dictationInsertionMode] ?? INSERTION_META.auto;
  const routeLabel = formatRouteLabel(dictationProvider, dictationModelId);
  const targetDetail = runtimeAppTarget ? ` for ${runtimeAppTarget}` : "";
  const autoActivationDetail =
    activationMatcher && runtimeAppTarget
      ? `Auto for ${runtimeAppTarget} via "${activationMatcher}"`
      : activationMatcher
        ? `Auto via "${activationMatcher}"`
        : null;

  const cycleDisplayMode = async () => {
    const next: DisplayMode =
      displayMode === "full" ? "compact" : displayMode === "compact" ? "minimal" : "full";
    setDisplayMode(next);
  };

  useEffect(() => {
    const { width, height } = getPopupSize(displayMode, phase, message, preview);
    void window.setSize(new LogicalSize(width, height)).catch((error) => {
      console.error("Failed to resize dictation popup:", error);
    });
  }, [displayMode, message, phase, preview, window]);

  useEffect(() => {
    if (phase !== "idle") {
      return;
    }

    void window.hide().catch((error) => {
      console.error("Failed to hide dictation popup while idle:", error);
    });
  }, [phase, window]);

  const openMainApp = async (view?: "dictation" | "settings" | "recordings") => {
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

  const hidePopup = async () => {
    try {
      await window.hide();
    } catch (error) {
      console.error("Failed to hide dictation popup:", error);
    }
  };

  // ── Minimal pill mode ────────────────────────────────────────────────────
  if (displayMode === "minimal") {
    const dotColor =
      phase === "recording"
        ? "bg-orange-400"
        : phase === "starting" || phase === "transcribing" || phase === "stopping"
          ? "bg-cyan-400"
          : phase === "done"
            ? "bg-emerald-400"
            : "bg-rose-400";

    return (
      <div
        className="h-screen w-screen bg-transparent flex items-center justify-center"
        onMouseDown={() => void window.startDragging()}
        onDoubleClick={() => void cycleDisplayMode()}
        title="Double-click to expand"
      >
        <div className="flex items-center gap-2 rounded-full bg-[#1a1f2e]/90 px-3 py-[10px] backdrop-blur-md shadow-lg border border-white/10">
          <div className="flex items-center gap-[5px]">
            {[0, 1, 2, 3, 4].map((i) => (
              <span
                key={i}
                className={`block h-[6px] w-[6px] rounded-full ${dotColor}`}
                style={{
                  animation: `dictation-dot-pulse 1.2s ease-in-out ${i * 0.15}s infinite`,
                  opacity: phase === "done" ? 1 : undefined,
                }}
              />
            ))}
          </div>
          <button
            type="button"
            className="inline-flex h-6 w-6 items-center justify-center rounded-full text-slate-300 hover:bg-white/10 hover:text-white"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => void hidePopup()}
            aria-label="Hide popup"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <style>{`
          @keyframes dictation-dot-pulse {
            0%, 80%, 100% { transform: scale(0.7); opacity: 0.4; }
            40% { transform: scale(1); opacity: 1; }
          }
        `}</style>
      </div>
    );
  }

  const compact = displayMode === "compact";

  if (phase === "idle") {
    return <div className="h-screen w-screen bg-transparent" />;
  }

  return (
    <div className="h-screen w-screen bg-transparent p-3">
      <div className="rounded-[24px] border border-cyan-400/35 bg-linear-to-br from-slate-950/95 via-slate-900/92 to-cyan-950/55 px-4 py-3 backdrop-blur-xl shadow-[0_18px_80px_rgba(8,15,28,0.55)] overflow-hidden">
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
              onClick={() => void cycleDisplayMode()}
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

        {!compact && (
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${modeMeta.accent}`}>
              <modeMeta.icon className="h-3.5 w-3.5" />
              {modeMeta.label}
            </div>
            <div className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] font-medium text-slate-200">
              <Clipboard className="h-3.5 w-3.5 text-slate-300" />
              {contextMeta.label}
            </div>
            <div className="inline-flex items-center rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[11px] text-slate-300">
              {pushToTalk ? "Hold to talk" : "Toggle capture"}
            </div>
          </div>
        )}

        {phase === "starting" && (
          <div className="flex items-center gap-3 text-white">
            <Loader2 className="h-5 w-5 animate-spin text-cyan-300" />
            <div>
              <p className="text-sm font-semibold">Starting dictation</p>
              <p className="text-xs text-slate-300">
                Warming the microphone and preparing {routeLabel.toLowerCase()}{targetDetail}…
              </p>
            </div>
          </div>
        )}

        {phase === "recording" && (
          <div className="flex items-center gap-3 text-white">
            <div className="relative rounded-full bg-orange-500/15 p-3 ring-1 ring-orange-300/25">
              <div className="absolute inset-0 rounded-full bg-orange-400/10 blur-md" />
              <Mic className="relative h-5 w-5 text-orange-300 animate-pulse" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold">Listening</p>
              {!compact && (
                <>
                  <p className="mt-1 text-xs text-slate-300">
                    {selectedModeLabel} · {contextMeta.detail} · {insertionMeta.label}
                    {runtimeAppTarget ? ` · Target ${runtimeAppTarget}` : ""}
                  </p>
                  {autoActivationDetail && (
                    <p className="mt-1 text-xs text-cyan-200/90">{autoActivationDetail}</p>
                  )}
                  <div className="mt-2 h-2.5 w-full max-w-[220px] rounded-full bg-slate-700/50 overflow-hidden">
                    <div
                      className="h-full bg-linear-to-r from-emerald-500 via-orange-400 to-rose-500 transition-all duration-50 rounded-full"
                      style={{ width: `${Math.min(100, audioLevel * 100)}%` }}
                    />
                  </div>
                  <p className="text-xs text-slate-300 mt-1.5">
                    {pushToTalk
                      ? `Release hotkey to ${dictationInsertionMode === "clipboard_only" ? "finish to clipboard" : "finish dictation"}`
                      : `Press the hotkey again to ${dictationInsertionMode === "clipboard_only" ? "finish to clipboard" : "finish dictation"}`}
                  </p>
                </>
              )}
            </div>
            <span className="font-mono text-sm text-orange-200">{elapsedText}</span>
            <button
              type="button"
              className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-rose-500/90 text-white hover:bg-rose-500"
              onClick={() => void handleStopFromPopup()}
              aria-label="Stop dictation"
            >
              <Square className="h-4 w-4 fill-current" />
            </button>
            {!compact && elapsed >= 10 && (
              <button
                type="button"
                className="text-xs text-rose-300 underline underline-offset-2"
                onClick={() => void handleStopFromPopup()}
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
              <p className="text-xs text-slate-300">Finalizing audio and preserving context…</p>
            </div>
          </div>
        )}

        {phase === "transcribing" && (
          <div className="flex items-center gap-3 text-white">
            <Loader2 className="h-5 w-5 animate-spin text-cyan-300" />
            <div>
              <p className="text-sm font-semibold">Transcribing</p>
              <p className="text-xs text-slate-300">
                {selectedModeLabel} is shaping the result for {insertionMeta.label.toLowerCase()}{targetDetail}.
              </p>
              {autoActivationDetail && (
                <p className="mt-1 text-xs text-cyan-200/90">{autoActivationDetail}</p>
              )}
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
                <p className="max-w-[330px] text-xs leading-relaxed text-slate-300">{message}</p>
              )}
              {!compact && !message && preview && (
                <p className="max-w-[330px] text-xs leading-relaxed text-slate-300 line-clamp-3">
                  {preview}
                </p>
              )}
              {!compact && !message && !preview && (
                <p className="text-xs text-slate-300">
                  Ready in {selectedModeLabel.toLowerCase()} mode.
                </p>
              )}
              {!compact && (
                <div className="mt-2 flex items-center gap-2 text-xs text-slate-300">
                  <button
                    type="button"
                    className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 hover:bg-white/10"
                    onClick={() => void openMainApp("dictation")}
                  >
                    History
                  </button>
                  <button
                    type="button"
                    className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 hover:bg-white/10"
                    onClick={() => void openMainApp("settings")}
                  >
                    Settings
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {phase === "error" && (
          <div className="flex items-center gap-3 text-white">
            <TriangleAlert className="h-5 w-5 text-rose-300" />
            <div>
              <p className="text-sm font-semibold">Dictation failed</p>
              {!compact && message && (
                <p className="max-w-[330px] text-xs leading-relaxed text-slate-300">{message}</p>
              )}
              {!compact && (
                <p className="text-xs text-rose-200/90">
                  Check microphone access, {routeLabel.toLowerCase()}, and shortcut permissions.
                </p>
              )}
              {!compact && (
                <div className="mt-2 flex items-center gap-2 text-xs text-slate-300">
                  <button
                    type="button"
                    className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 hover:bg-white/10"
                    onClick={() => void openMainApp("settings")}
                  >
                    Open settings
                  </button>
                  <button
                    type="button"
                    className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 hover:bg-white/10"
                    onClick={() => void openMainApp("dictation")}
                  >
                    Open history
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
