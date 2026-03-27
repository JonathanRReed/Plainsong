import { useState } from "react";
import { Shield, ExternalLink, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { activateLicense } from "@/lib/tauri";
import type { LicenseInfo } from "@/lib/tauri";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";

const BUY_PRO_URL = "https://nautilusbot.lemonsqueezy.com/buy/pro";
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

    const cardContent = (
        <>
            <div className="pointer-events-none absolute inset-0 rounded-2xl bg-[radial-gradient(ellipse_80%_50%_at_50%_-10%,hsl(var(--primary)/0.12),transparent)]" />

            <DialogHeader className="items-center text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 ring-1 ring-primary/20">
                    <Shield className="h-7 w-7 text-primary" />
                </div>
                <DialogTitle className="text-2xl">Activate Nautilus</DialogTitle>
                <DialogDescription>
                    Paste the key from your Lemon Squeezy receipt.
                </DialogDescription>
            </DialogHeader>

            <div className="w-full space-y-3">
                <Input
                    id="license-key-input"
                    value={keyInput}
                    onChange={(e) => { setError(null); setKeyInput(e.target.value.trim()); }}
                    onKeyDown={(e) => { if (e.key === "Enter") void handleActivate(); }}
                    placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                    spellCheck={false}
                    autoComplete="off"
                    className={`h-12 font-mono ${error ? "border-destructive focus-visible:ring-destructive/30" : ""}`}
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

            <div className="flex w-full flex-col gap-2">
                <Button
                    id="activate-btn"
                    size="lg"
                    onClick={() => void handleActivate()}
                    disabled={loading || success}
                    className="w-full"
                >
                    {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {success && <CheckCircle2 className="mr-2 h-4 w-4" />}
                    {loading ? "Activating…" : success ? "Activated!" : "Activate License"}
                </Button>

                <div className="grid grid-cols-2 gap-2">
                    <Button
                        id="buy-basic-btn"
                        variant="outline"
                        size="sm"
                        className="text-xs"
                        onClick={() => window.open(BUY_PRO_URL, "_blank", "noopener,noreferrer")}
                    >
                        <ExternalLink className="mr-1 h-3.5 w-3.5" />
                        Buy Pro
                    </Button>
                    <Button
                        id="buy-friends-btn"
                        variant="outline"
                        size="sm"
                        className="border-amber-300/60 bg-amber-50/50 text-xs text-amber-700 hover:bg-amber-50 dark:border-amber-700/40 dark:bg-amber-950/20 dark:text-amber-400"
                        onClick={() => window.open(BUY_FRIENDS_URL, "_blank", "noopener,noreferrer")}
                    >
                        <ExternalLink className="mr-1 h-3.5 w-3.5" />
                        Friends Club
                    </Button>
                </div>
            </div>

            <DialogFooter className="w-full justify-between sm:justify-between">
                <span className="text-xs text-muted-foreground/60">
                    1 user · up to 5 computers · lifetime
                </span>
                {onCancel && (
                    <Button variant="ghost" size="sm" className="text-xs" onClick={onCancel}>
                        Cancel
                    </Button>
                )}
            </DialogFooter>
        </>
    );

    if (!overlay) {
        return (
            <div className="relative flex w-full max-w-md flex-col items-center gap-6 rounded-2xl border border-border bg-card p-10 shadow-2xl">
                {cardContent}
            </div>
        );
    }

    return (
        <Dialog open onOpenChange={(open) => { if (!open) onCancel?.(); }}>
            <DialogContent className="max-w-md items-center gap-6 p-10">
                {cardContent}
            </DialogContent>
        </Dialog>
    );
}
