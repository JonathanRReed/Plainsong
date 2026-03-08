/**
 * FirstRunWizard – dual-track onboarding modal shown once after first launch.
 *
 * Track selection:
 *   Normal  – quick 3-step flow (permissions → base.en download → hotkey)
 *   Power   – extended 4-step flow (permissions → model choice → hotkey → privacy overview)
 */

import { useState, useEffect, useCallback, type KeyboardEvent } from "react";
import {
    Mic,
    ShieldCheck,
    KeyRound,
    ChevronRight,
    CheckCircle2,
    XCircle,
    Loader2,
    Download,
    Zap,
    Settings2,
    Shield,
    Brain,
    Users,
    Palette,
    Cloud,
} from "lucide-react";
import {
    getPermissionDiagnostics,
    requestDictationPermissions,
    openPermissionSettings,
    downloadWhisperModel,
    getSettings,
    saveSettings,
    type PermissionDiagnostics,
} from "@/lib/tauri";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { defaultDictationShortcut, formatShortcutForDisplay, normalizeShortcut } from "@/lib/shortcuts";

type Props = {
    onComplete(): void;
};

type Track = "normal" | "power";
type Step = "track" | "permissions" | "model" | "model-choice" | "hotkey" | "privacy";

const NORMAL_STEPS: Step[] = ["track", "permissions", "model", "hotkey"];
const POWER_STEPS: Step[] = ["track", "permissions", "model-choice", "hotkey", "privacy"];

const STEP_LABELS: Record<Step, string> = {
    track: "Choose Your Path",
    permissions: "Permissions",
    model: "Voice Model",
    "model-choice": "Voice Model",
    hotkey: "Hotkey",
    privacy: "Privacy & Local Mode",
};

const POWER_MODEL_OPTIONS = [
    { id: "base.en", label: "Base English", size: "~148 MB", desc: "Fastest, good for dictation" },
    { id: "small.en", label: "Small English", size: "~488 MB", desc: "Balanced speed and accuracy" },
    { id: "medium.en", label: "Medium English", size: "~1.5 GB", desc: "Best accuracy, slower" },
];

export function FirstRunWizard({ onComplete }: Props) {
    const [track, setTrack] = useState<Track | null>(null);
    const [step, setStep] = useState<Step>("track");
    const [perms, setPerms] = useState<PermissionDiagnostics | null>(null);
    const [permsLoading, setPermsLoading] = useState(false);
    const [modelState, setModelState] = useState<"idle" | "downloading" | "done" | "error">("idle");
    const [modelError, setModelError] = useState<string | null>(null);
    const [selectedModelId, setSelectedModelId] = useState("base.en");
    const [hotkeyDemoActive, setHotkeyDemoActive] = useState(false);
    const [shortcutValue, setShortcutValue] = useState(defaultDictationShortcut());
    const [hotkeyMode, setHotkeyMode] = useState<"hold_to_talk" | "toggle">("hold_to_talk");
    const [autoRequestPermissions, setAutoRequestPermissions] = useState(true);
    const [permissionRequestBusy, setPermissionRequestBusy] = useState(false);
    const [permissionRequestError, setPermissionRequestError] = useState<string | null>(null);
    const [hotkeySaving, setHotkeySaving] = useState(false);
    const [hotkeySaveError, setHotkeySaveError] = useState<string | null>(null);
    const [meetingAudioStorageMode, setMeetingAudioStorageMode] = useState<"always" | "transcript_only">("always");
    const [meetingRetentionPreset, setMeetingRetentionPreset] = useState<"1m" | "2m" | "3m" | "custom" | "never">("never");
    const [meetingRetentionCustomMonths, setMeetingRetentionCustomMonths] = useState(1);
    const [meetingRetentionDeleteMode, setMeetingRetentionDeleteMode] = useState<"audio_only" | "audio_and_transcript">("audio_only");

    const steps = track === "power" ? POWER_STEPS : NORMAL_STEPS;
    const stepIdx = steps.indexOf(step);
    const progress = steps.length > 1 ? ((stepIdx + 1) / steps.length) * 100 : 0;

    useEffect(() => {
        if (step === "permissions") void refreshPerms();
    }, [step]);

    useEffect(() => {
        let mounted = true;
        void getSettings()
            .then((settings) => {
                if (!mounted) return;
                setAutoRequestPermissions(
                    settings.transcription.dictationAutoRequestPermissions ?? true
                );
            })
            .catch(() => {
                // Keep defaults.
            });
        return () => {
            mounted = false;
        };
    }, []);

    useEffect(() => {
        let mounted = true;
        if (step !== "hotkey") return;
        void getSettings()
            .then((settings) => {
                if (!mounted) return;
                setShortcutValue(settings.shortcuts.toggleDictation || defaultDictationShortcut());
                setHotkeyMode(settings.transcription.dictationPushToTalk ? "hold_to_talk" : "toggle");
                setMeetingAudioStorageMode(
                    settings.transcription.meetingAudioStorageMode === "transcript_only"
                        ? "transcript_only"
                        : "always"
                );
                setMeetingRetentionPreset(
                    settings.transcription.meetingRetentionPreset === "1m" ||
                    settings.transcription.meetingRetentionPreset === "2m" ||
                    settings.transcription.meetingRetentionPreset === "3m" ||
                    settings.transcription.meetingRetentionPreset === "custom"
                        ? settings.transcription.meetingRetentionPreset
                        : "never"
                );
                setMeetingRetentionCustomMonths(
                    Math.max(1, settings.transcription.meetingRetentionCustomMonths ?? 1)
                );
                setMeetingRetentionDeleteMode(
                    settings.transcription.meetingRetentionDeleteMode === "audio_and_transcript"
                        ? "audio_and_transcript"
                        : "audio_only"
                );
            })
            .catch(() => {
                // Ignore onboarding prefill errors and continue with defaults.
            });

        return () => {
            mounted = false;
        };
    }, [step]);

    const refreshPerms = async () => {
        setPermsLoading(true);
        try {
            const result = await getPermissionDiagnostics();
            setPerms(result);
        } catch {
            // ignore
        } finally {
            setPermsLoading(false);
        }
    };

    const startModelDownload = useCallback(async (modelId?: string) => {
        setModelState("downloading");
        setModelError(null);
        try {
            await downloadWhisperModel(modelId ?? "base.en");
            setModelState("done");
        } catch (e) {
            setModelState("error");
            setModelError(e instanceof Error ? e.message : String(e));
        }
    }, []);

    const selectTrack = (t: Track) => {
        setTrack(t);
        setStep("permissions");
    };

    const persistHotkeyStep = useCallback(async () => {
        setHotkeySaving(true);
        setHotkeySaveError(null);
        try {
            const settings = await getSettings();
            settings.shortcuts.toggleDictation = normalizeShortcut(shortcutValue);
            settings.shortcuts.toggleDictationAlternates = [];
            settings.transcription.dictationPushToTalk = hotkeyMode === "hold_to_talk";
            settings.transcription.dictationAutoRequestPermissions = autoRequestPermissions;
            await saveSettings(settings);
            return true;
        } catch (error) {
            setHotkeySaveError(error instanceof Error ? error.message : String(error));
            return false;
        } finally {
            setHotkeySaving(false);
        }
    }, [autoRequestPermissions, hotkeyMode, shortcutValue]);

    const requestPermissionsNow = useCallback(async () => {
        setPermissionRequestBusy(true);
        setPermissionRequestError(null);
        try {
            const diagnostics = await requestDictationPermissions();
            setPerms(diagnostics);
        } catch (error) {
            setPermissionRequestError(error instanceof Error ? error.message : String(error));
        } finally {
            setPermissionRequestBusy(false);
        }
    }, []);

    const persistPowerPrivacyStep = useCallback(async () => {
        setHotkeySaving(true);
        setHotkeySaveError(null);
        try {
            const settings = await getSettings();
            settings.transcription.meetingAudioStorageMode = meetingAudioStorageMode;
            settings.transcription.meetingRetentionPreset = meetingRetentionPreset;
            settings.transcription.meetingRetentionCustomMonths = Math.max(1, meetingRetentionCustomMonths);
            settings.transcription.meetingRetentionDeleteMode = meetingRetentionDeleteMode;
            await saveSettings(settings);
            return true;
        } catch (error) {
            setHotkeySaveError(error instanceof Error ? error.message : String(error));
            return false;
        } finally {
            setHotkeySaving(false);
        }
    }, [
        meetingAudioStorageMode,
        meetingRetentionCustomMonths,
        meetingRetentionDeleteMode,
        meetingRetentionPreset,
    ]);

    const nextStep = async () => {
        if (step === "hotkey") {
            const saved = await persistHotkeyStep();
            if (!saved) return;
        }
        if (step === "privacy") {
            const saved = await persistPowerPrivacyStep();
            if (!saved) return;
        }
        const idx = steps.indexOf(step);
        if (idx < steps.length - 1) {
            setStep(steps[idx + 1]);
        } else {
            onComplete();
        }
    };

    const isLastStep = stepIdx === steps.length - 1;
    const isDownloading = (step === "model" || step === "model-choice") && modelState === "downloading";

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
            <div className="relative flex w-full max-w-lg flex-col gap-6 rounded-2xl border border-border bg-card p-8 shadow-2xl">
                {/* Header */}
                <div className="flex items-center justify-between">
                    <div>
                        <h2 className="text-xl font-semibold">Getting Started</h2>
                        <p className="text-sm text-muted-foreground">
                            {step === "track"
                                ? "Welcome to Nautilus"
                                : `Step ${stepIdx} of ${steps.length - 1} — ${STEP_LABELS[step]}`}
                        </p>
                    </div>
                    {step !== "track" && (
                        <div className="flex gap-2">
                            {steps.slice(1).map((s, i) => (
                                <div
                                    key={s}
                                    className={`h-2 w-8 rounded-full transition-colors ${
                                        i < stepIdx ? "bg-primary" : "bg-muted"
                                    }`}
                                />
                            ))}
                        </div>
                    )}
                </div>

                {step !== "track" && <Progress value={progress} className="h-1" />}

                {/* Step content */}
                {step === "track" && <TrackSelectionStep onSelect={selectTrack} />}
                {step === "permissions" && (
                    <PermissionsStep
                        perms={perms}
                        loading={permsLoading}
                        onRefresh={() => void refreshPerms()}
                        autoRequestPermissions={autoRequestPermissions}
                        onAutoRequestPermissionsChange={setAutoRequestPermissions}
                        requestBusy={permissionRequestBusy}
                        requestError={permissionRequestError}
                        onRequestNow={() => void requestPermissionsNow()}
                    />
                )}
                {step === "model" && (
                    <ModelStep
                        state={modelState}
                        error={modelError}
                        onDownload={() => void startModelDownload()}
                    />
                )}
                {step === "model-choice" && (
                    <ModelChoiceStep
                        state={modelState}
                        error={modelError}
                        selectedId={selectedModelId}
                        onSelect={setSelectedModelId}
                        onDownload={() => void startModelDownload(selectedModelId)}
                    />
                )}
                {step === "hotkey" && (
                    <HotkeyStep
                        active={hotkeyDemoActive}
                        onToggle={() => setHotkeyDemoActive((v) => !v)}
                        shortcutValue={shortcutValue}
                        onShortcutChange={setShortcutValue}
                        hotkeyMode={hotkeyMode}
                        onHotkeyModeChange={setHotkeyMode}
                        saveError={hotkeySaveError}
                    />
                )}
                {step === "privacy" && (
                    <PrivacyStep
                        meetingAudioStorageMode={meetingAudioStorageMode}
                        onMeetingAudioStorageModeChange={setMeetingAudioStorageMode}
                        meetingRetentionPreset={meetingRetentionPreset}
                        onMeetingRetentionPresetChange={setMeetingRetentionPreset}
                        meetingRetentionCustomMonths={meetingRetentionCustomMonths}
                        onMeetingRetentionCustomMonthsChange={setMeetingRetentionCustomMonths}
                        meetingRetentionDeleteMode={meetingRetentionDeleteMode}
                        onMeetingRetentionDeleteModeChange={setMeetingRetentionDeleteMode}
                    />
                )}

                {/* Navigation */}
                {step !== "track" && (
                    <div className="flex justify-between">
                        <Button variant="ghost" onClick={onComplete} className="text-muted-foreground">
                            Skip setup
                        </Button>
                        <Button
                            onClick={() => void nextStep()}
                            disabled={isDownloading || hotkeySaving}
                            id="wizard-next-btn"
                        >
                            {hotkeySaving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
                            {isLastStep ? "Finish" : "Continue"}
                            <ChevronRight className="ml-1 h-4 w-4" />
                        </Button>
                    </div>
                )}
            </div>
        </div>
    );
}

// ── Step components ────────────────────────────────────────────────────────────

function TrackSelectionStep({ onSelect }: { onSelect(track: Track): void }) {
    return (
        <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
                How would you like to set up Nautilus?
            </p>
            <div className="grid grid-cols-2 gap-3">
                <button
                    type="button"
                    id="track-normal-btn"
                    onClick={() => onSelect("normal")}
                    className="flex flex-col items-center gap-3 rounded-xl border-2 border-border p-6 text-center transition-all hover:border-primary/60 hover:bg-primary/5"
                >
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                        <Zap className="h-6 w-6 text-primary" />
                    </div>
                    <div>
                        <p className="font-semibold">Normal</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                            Quick setup — get dictating in under a minute
                        </p>
                    </div>
                </button>
                <button
                    type="button"
                    id="track-power-btn"
                    onClick={() => onSelect("power")}
                    className="flex flex-col items-center gap-3 rounded-xl border-2 border-border p-6 text-center transition-all hover:border-primary/60 hover:bg-primary/5"
                >
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
                        <Settings2 className="h-6 w-6 text-primary" />
                    </div>
                    <div>
                        <p className="font-semibold">Power User</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                            Choose model, review privacy, and customize
                        </p>
                    </div>
                </button>
            </div>
            <div className="flex justify-end">
                <Button variant="ghost" onClick={() => onSelect("normal")} className="text-xs text-muted-foreground">
                    Skip setup entirely
                </Button>
            </div>
        </div>
    );
}

function PermissionsStep({
    perms,
    loading,
    onRefresh,
    autoRequestPermissions,
    onAutoRequestPermissionsChange,
    requestBusy,
    requestError,
    onRequestNow,
}: {
    perms: PermissionDiagnostics | null;
    loading: boolean;
    onRefresh(): void;
    autoRequestPermissions: boolean;
    onAutoRequestPermissionsChange(next: boolean): void;
    requestBusy: boolean;
    requestError: string | null;
    onRequestNow(): void;
}) {
    return (
        <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
                Nautilus needs microphone access and input-control permissions to type text at your cursor.
            </p>

            <div className="space-y-3">
                <PermRow
                    label="Microphone"
                    icon={<Mic className="h-4 w-4" />}
                    ready={perms?.microphonePermissionReady ?? perms?.microphoneReady}
                    loading={loading}
                    onFix={() => void openPermissionSettings("microphone")}
                />
                <PermRow
                    label="Speech recognition (Apple native STT)"
                    icon={<Brain className="h-4 w-4" />}
                    ready={perms?.speechRecognitionReady}
                    loading={loading || requestBusy}
                    onFix={() => void openPermissionSettings("speech")}
                />
                <PermRow
                    label="Accessibility (text injection)"
                    icon={<ShieldCheck className="h-4 w-4" />}
                    ready={perms?.accessibilityReady}
                    loading={loading || requestBusy}
                    onFix={() => void openPermissionSettings("accessibility")}
                />
                <PermRow
                    label="Automation (System Events fallback)"
                    icon={<ShieldCheck className="h-4 w-4" />}
                    ready={perms?.automationReady}
                    loading={loading || requestBusy}
                    onFix={() => void openPermissionSettings("automation")}
                />
            </div>

            <div className="rounded-lg border border-border p-3 space-y-3">
                <label className="flex items-center justify-between gap-3">
                    <div>
                        <p className="text-sm font-medium">Auto-request permissions before dictation</p>
                        <p className="text-xs text-muted-foreground">
                            Prompts for native speech/mic access as soon as needed, instead of failing silently.
                        </p>
                    </div>
                    <input
                        type="checkbox"
                        checked={autoRequestPermissions}
                        onChange={(event) => onAutoRequestPermissionsChange(event.target.checked)}
                    />
                </label>
                <Button
                    variant="outline"
                    size="sm"
                    onClick={onRequestNow}
                    disabled={requestBusy}
                >
                    {requestBusy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                    Request permissions now
                </Button>
                {requestError ? <p className="text-xs text-destructive">{requestError}</p> : null}
            </div>

            <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading || requestBusy}>
                {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Re-check permissions
            </Button>

            {perms?.notes?.map((note, i) => (
                <p key={i} className="text-xs text-muted-foreground">
                    {note}
                </p>
            ))}
        </div>
    );
}

function PermRow({
    label,
    icon,
    ready,
    loading,
    onFix,
}: {
    label: string;
    icon: React.ReactNode;
    ready: boolean | undefined;
    loading: boolean;
    onFix(): void;
}) {
    return (
        <div className="flex items-center justify-between rounded-lg border border-border p-3">
            <div className="flex items-center gap-2">
                <span className="text-muted-foreground">{icon}</span>
                <span className="text-sm font-medium">{label}</span>
            </div>
            <div className="flex items-center gap-2">
                {loading ? (
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                ) : ready ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                ) : (
                    <>
                        <XCircle className="h-4 w-4 text-amber-500" />
                        <Button variant="outline" size="sm" onClick={onFix} className="h-7 text-xs">
                            Fix
                        </Button>
                    </>
                )}
            </div>
        </div>
    );
}

function ModelStep({
    state,
    error,
    onDownload,
}: {
    state: "idle" | "downloading" | "done" | "error";
    error: string | null;
    onDownload(): void;
}) {
    return (
        <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
                Nautilus uses Whisper for offline transcription. Download the fast base.en model (~148 MB)
                to get started immediately — larger models can be added later.
            </p>

            {state === "idle" && (
                <Button id="download-model-btn" onClick={onDownload} className="gap-2">
                    <Download className="h-4 w-4" />
                    Download Whisper base.en (~148 MB)
                </Button>
            )}

            {state === "downloading" && (
                <div className="flex items-center gap-3 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Downloading… this may take a minute.
                </div>
            )}

            {state === "done" && (
                <div className="flex items-center gap-2 text-sm text-emerald-600">
                    <CheckCircle2 className="h-4 w-4" />
                    Model downloaded and ready.
                </div>
            )}

            {state === "error" && (
                <div className="space-y-2">
                    <div className="flex items-center gap-2 text-sm text-destructive">
                        <XCircle className="h-4 w-4" />
                        Download failed: {error}
                    </div>
                    <Button variant="outline" size="sm" onClick={onDownload}>
                        Retry
                    </Button>
                </div>
            )}

            <p className="text-xs text-muted-foreground">
                You can also skip this and download models later in Settings → ASR Models.
            </p>
        </div>
    );
}

function ModelChoiceStep({
    state,
    error,
    selectedId,
    onSelect,
    onDownload,
}: {
    state: "idle" | "downloading" | "done" | "error";
    error: string | null;
    selectedId: string;
    onSelect(id: string): void;
    onDownload(): void;
}) {
    return (
        <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
                Choose a model based on your performance needs. You can download more later.
            </p>

            <div className="space-y-2">
                {POWER_MODEL_OPTIONS.map((opt) => (
                    <button
                        key={opt.id}
                        type="button"
                        onClick={() => { if (state !== "downloading") onSelect(opt.id); }}
                        className={`flex w-full items-center justify-between rounded-lg border-2 p-3 text-left transition-all ${
                            selectedId === opt.id
                                ? "border-primary bg-primary/5"
                                : "border-border hover:border-primary/40"
                        }`}
                    >
                        <div>
                            <p className="text-sm font-medium">{opt.label}</p>
                            <p className="text-xs text-muted-foreground">{opt.desc}</p>
                        </div>
                        <span className="text-xs text-muted-foreground">{opt.size}</span>
                    </button>
                ))}
            </div>

            {state === "idle" && (
                <Button id="download-model-btn" onClick={onDownload} className="gap-2">
                    <Download className="h-4 w-4" />
                    Download {POWER_MODEL_OPTIONS.find((o) => o.id === selectedId)?.label}
                </Button>
            )}

            {state === "downloading" && (
                <div className="flex items-center gap-3 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Downloading… this may take a minute.
                </div>
            )}

            {state === "done" && (
                <div className="flex items-center gap-2 text-sm text-emerald-600">
                    <CheckCircle2 className="h-4 w-4" />
                    Model downloaded and ready.
                </div>
            )}

            {state === "error" && (
                <div className="space-y-2">
                    <div className="flex items-center gap-2 text-sm text-destructive">
                        <XCircle className="h-4 w-4" />
                        Download failed: {error}
                    </div>
                    <Button variant="outline" size="sm" onClick={onDownload}>
                        Retry
                    </Button>
                </div>
            )}
        </div>
    );
}

function formatShortcutFromKeyboardEvent(event: KeyboardEvent<HTMLInputElement>) {
    const parts: string[] = [];
    if (event.metaKey) parts.push("Cmd");
    if (event.ctrlKey) parts.push("Ctrl");
    if (event.altKey) parts.push("Alt");
    if (event.shiftKey) parts.push("Shift");

    const key = event.key;
    if (["Meta", "Control", "Alt", "Shift"].includes(key) || parts.length === 0) {
        return null;
    }

    let mainKey = "";
    if (key === " ") {
        mainKey = "Space";
    } else if (key.length === 1) {
        mainKey = key.toUpperCase();
    } else {
        const normalized = key.startsWith("Arrow") ? key.replace("Arrow", "") : key;
        mainKey = normalized.charAt(0).toUpperCase() + normalized.slice(1);
    }
    return [...parts, mainKey].join("+");
}

function HotkeyStep({
    active,
    onToggle,
    shortcutValue,
    onShortcutChange,
    hotkeyMode,
    onHotkeyModeChange,
    saveError,
}: {
    active: boolean;
    onToggle(): void;
    shortcutValue: string;
    onShortcutChange(value: string): void;
    hotkeyMode: "hold_to_talk" | "toggle";
    onHotkeyModeChange(value: "hold_to_talk" | "toggle"): void;
    saveError: string | null;
}) {
    const displayShortcut = formatShortcutForDisplay(shortcutValue);

    return (
        <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
                {hotkeyMode === "hold_to_talk"
                    ? `Hold ${displayShortcut} anywhere to start dictating. Release to transcribe and paste.`
                    : `Press ${displayShortcut} anywhere to start dictating. Press again to transcribe and paste.`}
            </p>

            <div className="space-y-2 rounded-lg border border-border p-3">
                <label className="text-xs font-medium text-muted-foreground">Dictation shortcut</label>
                <Input
                    value={displayShortcut}
                    readOnly
                    onKeyDown={(event) => {
                        if (event.key === "Tab") return;
                        event.preventDefault();
                        event.stopPropagation();
                        if (event.key === "Escape") return;
                        const parsed = formatShortcutFromKeyboardEvent(event);
                        if (!parsed) return;
                        onShortcutChange(parsed);
                    }}
                    className="font-mono text-center"
                />
                <p className="text-xs text-muted-foreground">
                    Click the field and press your preferred key combination.
                </p>
            </div>

            <div className="space-y-2 rounded-lg border border-border p-3">
                <label className="text-xs font-medium text-muted-foreground">Hotkey behavior</label>
                <select
                    className="w-full rounded-md border border-border bg-background p-2 text-sm"
                    value={hotkeyMode}
                    onChange={(event) =>
                        onHotkeyModeChange(event.target.value as "hold_to_talk" | "toggle")
                    }
                >
                    <option value="hold_to_talk">Hold-to-talk</option>
                    <option value="toggle">Toggle press</option>
                </select>
            </div>

            {/* Interactive demo */}
            <button
                type="button"
                id="hotkey-demo-btn"
                onClick={onToggle}
                className={`
          relative w-full rounded-xl border-2 p-6 text-center transition-all duration-200
          ${active
                        ? "border-primary bg-primary/5 shadow-[0_0_20px_hsl(var(--primary)/0.3)]"
                        : "border-border bg-muted/30 hover:border-primary/40"
                    }
        `}
            >
                <div
                    className={`
            inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-all
            ${active ? "bg-primary text-primary-foreground scale-105" : "bg-muted text-muted-foreground"}
          `}
                >
                    <KeyRound className="h-4 w-4" />
                    {active ? "🎤 Listening…" : "Click to preview"}
                </div>
                {active && (
                    <div className="mt-3 flex justify-center gap-1">
                        {[1, 2, 3, 4, 5].map((i) => (
                            <div
                                key={i}
                                className="w-0.5 rounded-full bg-primary"
                                style={{
                                    height: `${12 + Math.sin(i * 1.2) * 10}px`,
                                    animation: `pulse ${0.4 + i * 0.07}s ease-in-out infinite alternate`,
                                }}
                            />
                        ))}
                    </div>
                )}
                <p className="mt-2 text-xs text-muted-foreground">
                    {active ? "Click again to dismiss demo" : "The real hotkey works system-wide"}
                </p>
            </button>

            <p className="text-xs text-muted-foreground">
                You can change the hotkey anytime in Settings → General.
            </p>
            {saveError && <p className="text-xs text-destructive">Failed to save hotkey: {saveError}</p>}

            <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2">
                <p className="text-xs font-medium">What you can do with Nautilus:</p>
                <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                    <div className="flex items-center gap-1.5">
                        <Mic className="h-3 w-3 shrink-0" />
                        <span>Dictation &amp; meeting recording</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                        <Users className="h-3 w-3 shrink-0" />
                        <span>Speaker diarization</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                        <Brain className="h-3 w-3 shrink-0" />
                        <span>AI summaries &amp; Memory search</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                        <Palette className="h-3 w-3 shrink-0" />
                        <span>10+ premium color themes</span>
                    </div>
                </div>
            </div>
        </div>
    );
}

function PrivacyStep({
    meetingAudioStorageMode,
    onMeetingAudioStorageModeChange,
    meetingRetentionPreset,
    onMeetingRetentionPresetChange,
    meetingRetentionCustomMonths,
    onMeetingRetentionCustomMonthsChange,
    meetingRetentionDeleteMode,
    onMeetingRetentionDeleteModeChange,
}: {
    meetingAudioStorageMode: "always" | "transcript_only";
    onMeetingAudioStorageModeChange(value: "always" | "transcript_only"): void;
    meetingRetentionPreset: "1m" | "2m" | "3m" | "custom" | "never";
    onMeetingRetentionPresetChange(value: "1m" | "2m" | "3m" | "custom" | "never"): void;
    meetingRetentionCustomMonths: number;
    onMeetingRetentionCustomMonthsChange(value: number): void;
    meetingRetentionDeleteMode: "audio_only" | "audio_and_transcript";
    onMeetingRetentionDeleteModeChange(value: "audio_only" | "audio_and_transcript"): void;
}) {
    return (
        <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
                Nautilus is local-first. Here is how your data flows:
            </p>

            <div className="space-y-3">
                <div className="flex items-start gap-3 rounded-lg border border-border p-3">
                    <Shield className="mt-0.5 h-5 w-5 shrink-0 text-emerald-500" />
                    <div>
                        <p className="text-sm font-medium">Audio stays on your device</p>
                        <p className="text-xs text-muted-foreground">
                            Local transcription runs via providers like Whisper, Parakeet, Canary, Distil-Whisper,
                            Moonshine, and Voxtral-local. Nothing is sent to a server unless you explicitly
                            enable cloud ASR or LLM providers.
                        </p>
                    </div>
                </div>
                <div className="flex items-start gap-3 rounded-lg border border-border p-3">
                    <Cloud className="mt-0.5 h-5 w-5 shrink-0 text-blue-500" />
                    <div>
                        <p className="text-sm font-medium">Optional cloud providers</p>
                        <p className="text-xs text-muted-foreground">
                            Enable ElevenLabs Scribe or OpenAI Whisper cloud for faster transcription,
                            or use Ollama, OpenAI, Anthropic, Gemini, or DeepSeek for AI analysis.
                            Configure in Settings → AI &amp; Keys.
                        </p>
                    </div>
                </div>
                <div className="flex items-start gap-3 rounded-lg border border-border p-3">
                    <Shield className="mt-0.5 h-5 w-5 shrink-0 text-emerald-500" />
                    <div>
                        <p className="text-sm font-medium">Local Mode indicator</p>
                        <p className="text-xs text-muted-foreground">
                            The green dot in the sidebar shows when all processing is local.
                            It turns amber when a cloud provider is active.
                        </p>
                    </div>
                </div>
            </div>

            <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2">
                <p className="text-xs font-medium">Pro features included with your license:</p>
                <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                    <div className="flex items-center gap-1.5">
                        <Brain className="h-3 w-3 shrink-0" />
                        <span>Memory — ask your meetings anything</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                        <Users className="h-3 w-3 shrink-0" />
                        <span>Speaker diarization &amp; naming</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                        <Zap className="h-3 w-3 shrink-0" />
                        <span>Auto silence skip</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                        <Palette className="h-3 w-3 shrink-0" />
                        <span>10+ premium color themes</span>
                    </div>
                </div>
            </div>

            <div className="rounded-lg border border-border p-3 space-y-3">
                <p className="text-xs font-medium">Meeting storage defaults</p>
                <div className="space-y-2">
                    <label className="text-xs text-muted-foreground">Meeting audio storage</label>
                    <select
                        className="w-full rounded-md border border-border bg-background p-2 text-sm"
                        value={meetingAudioStorageMode}
                        onChange={(event) =>
                            onMeetingAudioStorageModeChange(
                                event.target.value as "always" | "transcript_only"
                            )
                        }
                    >
                        <option value="always">Always keep audio</option>
                        <option value="transcript_only">
                            Transcript only (delete audio after transcription)
                        </option>
                    </select>
                </div>

                <div className="space-y-2">
                    <label className="text-xs text-muted-foreground">Meeting retention</label>
                    <select
                        className="w-full rounded-md border border-border bg-background p-2 text-sm"
                        value={meetingRetentionPreset}
                        onChange={(event) =>
                            onMeetingRetentionPresetChange(
                                event.target.value as "1m" | "2m" | "3m" | "custom" | "never"
                            )
                        }
                    >
                        <option value="1m">After 1 month</option>
                        <option value="2m">After 2 months</option>
                        <option value="3m">After 3 months</option>
                        <option value="never">Never</option>
                        <option value="custom">Custom</option>
                    </select>
                </div>

                {meetingRetentionPreset === "custom" && (
                    <div className="space-y-2">
                        <label className="text-xs text-muted-foreground">Custom retention months</label>
                        <Input
                            type="number"
                            min={1}
                            value={meetingRetentionCustomMonths}
                            onChange={(event) =>
                                onMeetingRetentionCustomMonthsChange(
                                    Math.max(1, Number(event.target.value) || 1)
                                )
                            }
                        />
                    </div>
                )}

                <div className="space-y-2">
                    <label className="text-xs text-muted-foreground">Retention delete mode</label>
                    <select
                        className="w-full rounded-md border border-border bg-background p-2 text-sm"
                        value={meetingRetentionDeleteMode}
                        onChange={(event) =>
                            onMeetingRetentionDeleteModeChange(
                                event.target.value as "audio_only" | "audio_and_transcript"
                            )
                        }
                    >
                        <option value="audio_only">Delete audio only</option>
                        <option value="audio_and_transcript">Delete audio and transcript</option>
                    </select>
                </div>
            </div>

            <p className="text-xs text-muted-foreground">
                Review privacy in Settings → Security. Use Settings → Storage to reset app data on this device.
            </p>
        </div>
    );
}
