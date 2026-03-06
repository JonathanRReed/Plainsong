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
  saveSettings,
  startDictation,
  stopDictation,
} from "@/lib/tauri";
import type { DictationCustomMode, Settings } from "@/types/settings";

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
}

type DictationModePreset =
  | "voice"
  | "messages"
  | "email"
  | "notes"
  | "meeting_follow_up"
  | "custom";

type DictationContextSource = "none" | "clipboard" | "selected_text" | "application_context";
type DictationModeOption = {
  id: string;
  label: string;
  preset: DictationModePreset;
  customModeId?: string;
};

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

function popupModeOptions(customModes: DictationCustomMode[]): DictationModeOption[] {
  return [
    { id: "voice", label: "Voice", preset: "voice" },
    { id: "messages", label: "Messages", preset: "messages" },
    { id: "email", label: "Email", preset: "email" },
    { id: "notes", label: "Notes", preset: "notes" },
    { id: "meeting_follow_up", label: "Meeting Follow-up", preset: "meeting_follow_up" },
    ...customModes.map((mode) => ({
      id: `custom:${mode.id}`,
      label: mode.name,
      preset: "custom" as const,
      customModeId: mode.id,
    })),
  ];
}

function applyModeToSettings(
  settings: Settings,
  preset: DictationModePreset,
  customModeId?: string
): Settings {
  const next = structuredClone(settings);
  const transcription = next.transcription;

  const applyBase = (mode: DictationCustomMode | null, fallback?: Partial<DictationCustomMode>) => {
    if (mode) {
      transcription.dictationProfile = mode.profile;
      transcription.dictationInsertionMode = mode.insertionMode;
      transcription.dictationContextSource = mode.contextSource;
      transcription.dictationSaveToInbox = mode.saveToInbox;
      transcription.dictationCopyToClipboard = mode.copyToClipboard;
      transcription.dictationCommandModeEnabled = mode.commandModeEnabled;
      if (mode.dictationProvider) transcription.dictationProvider = mode.dictationProvider;
      if (mode.dictationModelId) transcription.dictationModelId = mode.dictationModelId;
      if (mode.aiProvider) next.privacy.llmProvider = mode.aiProvider;
      next.privacy.llmModelId = mode.aiModelId ?? next.privacy.llmModelId ?? null;
      return;
    }
    if (!fallback) return;
    if (fallback.profile) transcription.dictationProfile = fallback.profile;
    if (fallback.insertionMode) transcription.dictationInsertionMode = fallback.insertionMode;
    if (fallback.contextSource) transcription.dictationContextSource = fallback.contextSource;
    if (typeof fallback.saveToInbox === "boolean") {
      transcription.dictationSaveToInbox = fallback.saveToInbox;
    }
    if (typeof fallback.copyToClipboard === "boolean") {
      transcription.dictationCopyToClipboard = fallback.copyToClipboard;
    }
    if (typeof fallback.commandModeEnabled === "boolean") {
      transcription.dictationCommandModeEnabled = fallback.commandModeEnabled;
    }
  };

  transcription.dictationModePreset = preset;
  transcription.dictationSelectedCustomModeId = preset === "custom" ? customModeId ?? null : null;

  if (preset === "custom") {
    const customMode =
      transcription.dictationCustomModes?.find((mode) => mode.id === customModeId) ?? null;
    applyBase(customMode);
    return next;
  }

  const presetMode: Partial<DictationCustomMode> = {
    voice: {
      profile: "normal_speed" as const,
      insertionMode: "auto" as const,
      contextSource: "none" as const,
      saveToInbox: true,
      copyToClipboard: true,
      commandModeEnabled: true,
    },
    messages: {
      profile: "normal_speed" as const,
      insertionMode: "paste" as const,
      contextSource: "none" as const,
      saveToInbox: false,
      copyToClipboard: true,
      commandModeEnabled: false,
    },
    email: {
      profile: "power_rewrite" as const,
      insertionMode: "auto" as const,
      contextSource: "selected_text" as const,
      saveToInbox: true,
      copyToClipboard: true,
      commandModeEnabled: true,
    },
    notes: {
      profile: "normal_speed" as const,
      insertionMode: "inline" as const,
      contextSource: "none" as const,
      saveToInbox: true,
      copyToClipboard: true,
      commandModeEnabled: true,
    },
    meeting_follow_up: {
      profile: "power_rewrite" as const,
      insertionMode: "clipboard_only" as const,
      contextSource: "clipboard" as const,
      saveToInbox: true,
      copyToClipboard: true,
      commandModeEnabled: true,
    },
    custom: {},
  }[preset];
  applyBase(null, presetMode);
  return next;
}

function getPopupSize(displayMode: DisplayMode, phase: DictationPhase, message: string | null) {
  if (displayMode === "minimal") {
    return { width: 130, height: 44 };
  }

  if (displayMode === "compact") {
    return { width: 320, height: phase === "idle" ? 158 : phase === "error" ? 148 : 132 };
  }

  if (phase === "idle") {
    return { width: 440, height: 270 };
  }

  if (phase === "error") {
    return { width: 440, height: message && message.length > 110 ? 264 : 246 };
  }

  if (phase === "recording") {
    return { width: 440, height: 224 };
  }

  return { width: 440, height: 198 };
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
  const [saveToInbox, setSaveToInbox] = useState(true);
  const [projectId, setProjectId] = useState<string>("inbox");
  const [dictationProfile, setDictationProfile] = useState<"normal_speed" | "power_rewrite">(
    "normal_speed"
  );
  const [isBusyAction, setIsBusyAction] = useState(false);

  const refreshPopupSettings = async () => {
    const settings = await getSettings();
    setPushToTalk(Boolean(settings.transcription.dictationPushToTalk));
    setModePreset((settings.transcription.dictationModePreset ?? "voice") as DictationModePreset);
    setSelectedCustomModeId(settings.transcription.dictationSelectedCustomModeId ?? null);
    setCustomModes(settings.transcription.dictationCustomModes ?? []);
    setContextSource(
      (settings.transcription.dictationContextSource ?? "none") as DictationContextSource
    );
    setSaveToInbox(Boolean(settings.transcription.dictationSaveToInbox));
    setProjectId(settings.transcription.dictationProjectId || "inbox");
    setDictationProfile(
      (settings.transcription.dictationProfile ?? "normal_speed") as
        | "normal_speed"
        | "power_rewrite"
    );
  };

  const handleModeChange = async (modeId: string) => {
    try {
      const settings = await getSettings();
      const [preset, customId] = modeId.startsWith("custom:")
        ? (["custom", modeId.slice("custom:".length)] as const)
        : ([modeId as DictationModePreset, undefined] as const);
      const next = applyModeToSettings(settings, preset, customId);
      await saveSettings(next);
      await refreshPopupSettings();
    } catch (error) {
      console.error("Failed to switch dictation mode from popup:", error);
    }
  };

  const handleStartFromPopup = async () => {
    try {
      setIsBusyAction(true);
      await startDictation({
        saveToInbox,
        projectId,
        profile: dictationProfile,
        contextSource,
      });
    } catch (error) {
      console.error("Failed to start dictation from popup:", error);
    } finally {
      setIsBusyAction(false);
    }
  };

  const handleStopFromPopup = async () => {
    try {
      setIsBusyAction(true);
      await stopDictation();
    } catch (error) {
      console.error("Failed to stop dictation from popup:", error);
    } finally {
      setIsBusyAction(false);
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

  const modeOptions = useMemo(() => popupModeOptions(customModes), [customModes]);
  const selectedModeOptionId =
    modePreset === "custom" && selectedCustomModeId ? `custom:${selectedCustomModeId}` : modePreset;
  const modeMeta = MODE_META[modePreset] ?? MODE_META.voice;
  const contextMeta = CONTEXT_META[contextSource] ?? CONTEXT_META.none;

  const cycleDisplayMode = async () => {
    const next: DisplayMode =
      displayMode === "full" ? "compact" : displayMode === "compact" ? "minimal" : "full";
    setDisplayMode(next);
  };

  useEffect(() => {
    const { width, height } = getPopupSize(displayMode, phase, message);
    void window.setSize(new LogicalSize(width, height)).catch((error) => {
      console.error("Failed to resize dictation popup:", error);
    });
  }, [displayMode, message, phase, window]);

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
        <div className="flex items-center gap-[5px] rounded-full bg-[#1a1f2e]/90 px-4 py-[10px] backdrop-blur-md shadow-lg border border-white/10">
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

  return (
    <div className="h-screen w-screen bg-transparent p-3">
      <div className="rounded-[24px] border border-cyan-400/35 bg-linear-to-br from-slate-950/95 via-slate-900/92 to-cyan-950/55 px-4 py-3 backdrop-blur-xl shadow-[0_18px_80px_rgba(8,15,28,0.55)]">
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

        {phase === "idle" && (
          <div className="space-y-3 text-white">
            <div className="space-y-1">
              <p className="text-sm font-semibold">Dictation ready</p>
              <p className="text-xs text-slate-300">
                Start from here, switch modes, or jump back into Nautilus.
              </p>
            </div>
            <div className="grid gap-3">
              <label className="space-y-1 text-xs text-slate-300">
                <span className="block uppercase tracking-wide text-slate-400">Mode</span>
                <select
                  className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none"
                  value={selectedModeOptionId}
                  onChange={(event) => void handleModeChange(event.target.value)}
                >
                  {modeOptions.map((option) => (
                    <option key={option.id} value={option.id} className="text-slate-950">
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-slate-300">
                {contextMeta.detail}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="inline-flex flex-1 items-center justify-center rounded-xl bg-cyan-400/90 px-3 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-60"
                onClick={() => void handleStartFromPopup()}
                disabled={isBusyAction}
              >
                <Mic className="mr-2 h-4 w-4" />
                {isBusyAction ? "Starting…" : "Start dictation"}
              </button>
              <button
                type="button"
                className="inline-flex items-center justify-center rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white hover:bg-white/10"
                onClick={() => void openMainApp()}
              >
                Open app
              </button>
            </div>
          </div>
        )}

        {phase === "starting" && (
          <div className="flex items-center gap-3 text-white">
            <Loader2 className="h-5 w-5 animate-spin text-cyan-300" />
            <div>
              <p className="text-sm font-semibold">Starting dictation</p>
              <p className="text-xs text-slate-300">
                Warming the microphone and Apple Speech session…
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
                  <p className="mt-1 text-xs text-slate-300">{contextMeta.detail}</p>
                  <div className="mt-2 h-2.5 w-full max-w-[220px] rounded-full bg-slate-700/50 overflow-hidden">
                    <div
                      className="h-full bg-linear-to-r from-emerald-500 via-orange-400 to-rose-500 transition-all duration-50 rounded-full"
                      style={{ width: `${Math.min(100, audioLevel * 100)}%` }}
                    />
                  </div>
                  <p className="text-xs text-slate-300 mt-1.5">
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
                {modeMeta.label} mode is shaping the result for insert or clipboard.
              </p>
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
              {!compact && !message && !preview && (
                <p className="text-xs text-slate-300">
                  Ready in {modeMeta.label.toLowerCase()} mode.
                </p>
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
