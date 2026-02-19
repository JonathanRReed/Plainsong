/**
 * FirstRunWizard – a 3-step onboarding modal shown once after license activation.
 *
 * Steps:
 *   1. Permissions  – mic + accessibility check
 *   2. Model Setup  – trigger Whisper base.en download
 *   3. Hotkey Test  – animated demo of Cmd+Shift+Space
 */

import { useState, useEffect } from "react";
import {
    Mic,
    ShieldCheck,
    KeyRound,
    ChevronRight,
    CheckCircle2,
    XCircle,
    Loader2,
    Download,
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

type Step = "permissions" | "model" | "hotkey";

const STEPS: Step[] = ["permissions", "model", "hotkey"];
const STEP_LABELS: Record<Step, string> = {
    permissions: "Permissions",
    model: "Voice Model",
    hotkey: "Hotkey",
};

export function FirstRunWizard({ onComplete }: Props) {
    const [step, setStep] = useState<Step>("permissions");
    const [perms, setPerms] = useState<PermissionDiagnostics | null>(null);
    const [permsLoading, setPermsLoading] = useState(false);
    const [modelState, setModelState] = useState<"idle" | "downloading" | "done" | "error">("idle");
    const [modelError, setModelError] = useState<string | null>(null);
    const [hotkeyDemoActive, setHotkeyDemoActive] = useState(false);

    // Load permissions on first step
    useEffect(() => {
        if (step === "permissions") void refreshPerms();
    }, [step]);

    const refreshPerms = async () => {
        setPermsLoading(true);
        try {
            const result = await getPermissionDiagnostics();
            setPerms(result);
        } catch {
            // ignore – will show unknown state
        } finally {
            setPermsLoading(false);
        }
    };

    const startModelDownload = async () => {
        setModelState("downloading");
        setModelError(null);
        try {
            await downloadWhisperModel("base.en");
            setModelState("done");
        } catch (e) {
            setModelState("error");
            setModelError(e instanceof Error ? e.message : String(e));
        }
    };

    const nextStep = () => {
        const idx = STEPS.indexOf(step);
        if (idx < STEPS.length - 1) {
            setStep(STEPS[idx + 1]);
        } else {
            onComplete();
        }
    };

    const stepIdx = STEPS.indexOf(step);
    const progress = ((stepIdx + 1) / STEPS.length) * 100;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
            <div className="relative flex w-full max-w-lg flex-col gap-6 rounded-2xl border border-border bg-card p-8 shadow-2xl">
                {/* Header */}
                <div className="flex items-center justify-between">
                    <div>
                        <h2 className="text-xl font-semibold">Getting Started</h2>
                        <p className="text-sm text-muted-foreground">
                            Step {stepIdx + 1} of {STEPS.length} — {STEP_LABELS[step]}
                        </p>
                    </div>
                    <div className="flex gap-2">
                        {STEPS.map((s, i) => (
                            <div
                                key={s}
                                className={`h-2 w-8 rounded-full transition-colors ${i <= stepIdx ? "bg-primary" : "bg-muted"
                                    }`}
                            />
                        ))}
                    </div>
                </div>

                <Progress value={progress} className="h-1" />

                {/* Step content */}
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
                {step === "hotkey" && (
                    <HotkeyStep active={hotkeyDemoActive} onToggle={() => setHotkeyDemoActive((v) => !v)} />
                )}

                {/* Navigation */}
                <div className="flex justify-between">
                    <Button variant="ghost" onClick={onComplete} className="text-muted-foreground">
                        Skip setup
                    </Button>
                    <Button
                        onClick={nextStep}
                        disabled={step === "model" && modelState === "downloading"}
                        id="wizard-next-btn"
                    >
                        {step === "hotkey" ? "Finish" : "Continue"}
                        <ChevronRight className="ml-1 h-4 w-4" />
                    </Button>
                </div>
            </div>
        </div>
    );
}

// ── Step components ────────────────────────────────────────────────────────────

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
        </div>
    );
}
