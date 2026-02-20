/**
 * FirstRunWizard – dual-track onboarding modal shown once after first launch.
 *
 * Track selection:
 *   Normal  – quick 3-step flow (permissions → base.en download → hotkey)
 *   Power   – extended 4-step flow (permissions → model choice → hotkey → privacy overview)
 */

import { useState, useEffect, useCallback } from "react";
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
    openPermissionSettings,
    downloadWhisperModel,
    type PermissionDiagnostics,
} from "@/lib/tauri";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";

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

    const steps = track === "power" ? POWER_STEPS : NORMAL_STEPS;
    const stepIdx = steps.indexOf(step);
    const progress = steps.length > 1 ? ((stepIdx + 1) / steps.length) * 100 : 0;

    useEffect(() => {
        if (step === "permissions") void refreshPerms();
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

    const nextStep = () => {
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
                    <HotkeyStep active={hotkeyDemoActive} onToggle={() => setHotkeyDemoActive((v) => !v)} />
                )}
                {step === "privacy" && <PrivacyStep />}

                {/* Navigation */}
                {step !== "track" && (
                    <div className="flex justify-between">
                        <Button variant="ghost" onClick={onComplete} className="text-muted-foreground">
                            Skip setup
                        </Button>
                        <Button
                            onClick={nextStep}
                            disabled={isDownloading}
                            id="wizard-next-btn"
                        >
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
}: {
    perms: PermissionDiagnostics | null;
    loading: boolean;
    onRefresh(): void;
}) {
    return (
        <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
                Nautilus needs microphone access and accessibility permission to inject text at your cursor.
            </p>

            <div className="space-y-3">
                <PermRow
                    label="Microphone"
                    icon={<Mic className="h-4 w-4" />}
                    ready={perms?.microphoneReady}
                    loading={loading}
                    onFix={() => void openPermissionSettings("microphone")}
                />
                <PermRow
                    label="Accessibility (text injection)"
                    icon={<ShieldCheck className="h-4 w-4" />}
                    ready={perms?.accessibilityReady}
                    loading={loading}
                    onFix={() => void openPermissionSettings("accessibility")}
                />
            </div>

            <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
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

function HotkeyStep({ active, onToggle }: { active: boolean; onToggle(): void }) {
    return (
        <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
                Hold{" "}
                <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs">
                    ⌘
                </kbd>{" "}
                +{" "}
                <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs">
                    ⇧
                </kbd>{" "}
                +{" "}
                <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs">
                    Space
                </kbd>{" "}
                anywhere to start dictating. Release to transcribe and paste.
            </p>

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

function PrivacyStep() {
    return (
        <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
                Nautilus is local-first. Here is how your data flows:
            </p>

            <div className="space-y-3">
                <div className="flex items-start gap-3 rounded-lg border border-border p-3">
                    <Shield className="mt-0.5 h-5 w-5 shrink-0 text-emerald-500" />
                    <div>
                        <p className="text-sm font-medium">Audio stays on your Mac</p>
                        <p className="text-xs text-muted-foreground">
                            All transcription runs locally via Whisper. Nothing is sent to a server unless
                            you explicitly enable a cloud ASR or LLM provider.
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

            <p className="text-xs text-muted-foreground">
                Review all privacy settings in Settings → Security.
            </p>
        </div>
    );
}
