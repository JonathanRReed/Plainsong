import { useState } from "react";
import { Shield, ExternalLink, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { activateLicense } from "@/lib/tauri";
import type { LicenseInfo } from "@/lib/tauri";

// ── Update these with your real Lemon Squeezy checkout URLs ──────────────────
const BUY_BASIC_URL = "https://nautilusbot.lemonsqueezy.com/buy/basic";
const BUY_FRIENDS_URL = "https://nautilusbot.lemonsqueezy.com/buy/friends-club";

type Props = {
    onActivated(info: LicenseInfo): void;
    onCancel?(): void;
    /** If true render as a modal overlay, otherwise render as inline card. */
    overlay?: boolean;
};

export function ActivationModal({ onActivated, onCancel, overlay = true }: Props) {
    const [keyInput, setKeyInput] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState(false);

    const handleActivate = async () => {
        const key = keyInput.trim();
        if (!key) {
            setError("Please paste your license key.");
            return;
        }
        setError(null);
        setLoading(true);
        try {
            const info = await activateLicense(key);
            setSuccess(true);
            await new Promise((r) => setTimeout(r, 700));
            onActivated(info);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setLoading(false);
        }
    };

    const card = (
        <div className="relative flex w-full max-w-md flex-col items-center gap-6 rounded-2xl border border-border bg-card p-10 shadow-2xl">
            <div className="pointer-events-none absolute inset-0 rounded-2xl bg-[radial-gradient(ellipse_80%_50%_at_50%_-10%,hsl(var(--primary)/0.12),transparent)]" />

            {/* Icon + heading */}
            <div className="flex flex-col items-center gap-3 text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 ring-1 ring-primary/20">
                    <Shield className="h-7 w-7 text-primary" />
                </div>
                <div>
                    <h2 className="text-2xl font-semibold tracking-tight">Activate Nautilus</h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                        Paste the key from your Lemon Squeezy receipt.
                    </p>
                </div>
            </div>

            {/* Key input */}
            <div className="w-full space-y-3">
                <input
                    id="license-key-input"
                    type="text"
                    value={keyInput}
                    onChange={(e) => { setError(null); setKeyInput(e.target.value.trim()); }}
                    onKeyDown={(e) => { if (e.key === "Enter") void handleActivate(); }}
                    placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                    spellCheck={false}
                    autoComplete="off"
                    className={`
            w-full rounded-lg border bg-background px-4 py-3 font-mono text-sm
            placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2
            ${error ? "border-destructive focus:ring-destructive/30" : "border-input focus:ring-primary/30"}
          `}
                    aria-label="License key"
                    aria-invalid={!!error}
                />
                {error && (
                    <div className="flex items-start gap-2 text-sm text-destructive">
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>{error}</span>
                    </div>
                )}
                {success && (
                    <div className="flex items-center gap-2 text-sm text-emerald-600">
                        <CheckCircle2 className="h-4 w-4" />
                        <span>Activated! Loading…</span>
                    </div>
                )}
            </div>

            {/* Actions */}
            <div className="flex w-full flex-col gap-2">
                <button
                    id="activate-btn"
                    type="button"
                    onClick={() => void handleActivate()}
                    disabled={loading || success}
                    className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
                >
                    {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                    {success && <CheckCircle2 className="h-4 w-4" />}
                    {loading ? "Activating…" : success ? "Activated!" : "Activate License"}
                </button>

                <div className="grid grid-cols-2 gap-2">
                    <button
                        id="buy-basic-btn"
                        type="button"
                        onClick={() => window.open(BUY_BASIC_URL, "_blank", "noopener,noreferrer")}
                        className="flex items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                    >
                        <ExternalLink className="h-3.5 w-3.5" />
                        Buy Basic
                    </button>
                    <button
                        id="buy-friends-btn"
                        type="button"
                        onClick={() => window.open(BUY_FRIENDS_URL, "_blank", "noopener,noreferrer")}
                        className="flex items-center justify-center gap-1.5 rounded-lg border border-amber-300/60 bg-amber-50/50 px-3 py-2.5 text-xs text-amber-700 transition-colors hover:bg-amber-50 dark:border-amber-700/40 dark:bg-amber-950/20 dark:text-amber-400"
                    >
                        <ExternalLink className="h-3.5 w-3.5" />
                        Friends Club ⭐
                    </button>
                </div>
            </div>

            <div className="flex w-full items-center justify-between text-xs text-muted-foreground/60">
                <span>1 user · up to 5 computers · lifetime</span>
                {onCancel && (
                    <button type="button" onClick={onCancel} className="hover:text-foreground">
                        Cancel
                    </button>
                )}
            </div>
        </div>
    );

    if (!overlay) return card;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
            {card}
        </div>
    );
}
