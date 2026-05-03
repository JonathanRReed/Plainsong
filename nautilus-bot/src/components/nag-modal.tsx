/**
 * Dismissible nag screen shown when the user's 30-day free trial has expired
 * and they don't have a valid license. Never blocks the app.
 *
 * Re-shows after 24h if dismissed (via localStorage timestamp).
 */
import { useState } from "react";
import { Clock, ExternalLink, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";

const BUY_PRO_URL = "https://nautilusbot.lemonsqueezy.com/buy/basic";
const BUY_FRIENDS_URL = "https://nautilusbot.lemonsqueezy.com/buy/friends-club";
const DISMISS_KEY = "nautilus_nag_dismissed_at";
const TRIAL_EXPIRED_KEY = "nautilus_trial_expired_at";

function getDaysSinceExpiry(): number {
    const raw = localStorage.getItem(TRIAL_EXPIRED_KEY);
    if (!raw) {
        localStorage.setItem(TRIAL_EXPIRED_KEY, String(Date.now()));
        return 0;
    }
    return Math.floor((Date.now() - Number(raw)) / 86_400_000);
}

function getNagIntervalHours(daysExpired: number): number {
    if (daysExpired >= 14) return 4;
    if (daysExpired >= 7) return 12;
    return 24;
}

type Props = {
    onActivate(): void;
};

export function shouldShowNag(): boolean {
    const raw = localStorage.getItem(DISMISS_KEY);
    const daysExpired = getDaysSinceExpiry();
    const intervalHours = getNagIntervalHours(daysExpired);

    if (!raw) return true;
    const dismissedAt = Number(raw);
    if (Number.isNaN(dismissedAt)) return true;

    const hoursElapsed = (Date.now() - dismissedAt) / 3_600_000;
    return hoursElapsed >= intervalHours;
}

export function NagModal({ onActivate }: Props) {
    const [visible, setVisible] = useState(true);

    const dismiss = () => {
        localStorage.setItem(DISMISS_KEY, String(Date.now()));
        setVisible(false);
    };

    return (
        <Dialog open={visible} onOpenChange={(open) => { if (!open) dismiss(); }}>
            <DialogContent className="max-w-sm gap-0 overflow-hidden p-0">
                <div className="border-b border-border bg-muted/40 px-5 py-3">
                    <DialogHeader className="space-y-0">
                        <DialogTitle className="flex items-center gap-2 text-sm">
                            <Clock className="h-4 w-4 text-amber-500" />
                            Free trial ended
                        </DialogTitle>
                    </DialogHeader>
                </div>

                <div className="space-y-4 p-5">
                    <DialogDescription className="leading-relaxed">
                        Your 30-day free trial has ended. Nautilus keeps working, and a license
                        removes this reminder. Pro unlocks updates and core paid features.
                        Friends Club adds cloud sync and priority support.
                    </DialogDescription>

                    <div className="space-y-2">
                        <Button
                            id="nag-activate-btn"
                            variant="outline"
                            className="w-full border-primary/40 bg-primary/5 text-primary hover:bg-primary/10"
                            onClick={() => { dismiss(); onActivate(); }}
                        >
                            <KeyRound className="mr-2 h-4 w-4" />
                            Enter License Key
                        </Button>

                        <div className="grid grid-cols-2 gap-2">
                            <Button
                                id="nag-buy-pro-btn"
                                variant="outline"
                                size="sm"
                                className="text-xs"
                                onClick={() => { dismiss(); window.open(BUY_PRO_URL, "_blank", "noopener,noreferrer"); }}
                            >
                                <ExternalLink className="mr-1 h-3.5 w-3.5" />
                                Buy Pro
                            </Button>
                            <Button
                                id="nag-buy-friends-btn"
                                variant="outline"
                                size="sm"
                                className="border-amber-300/60 bg-amber-50/50 text-xs text-amber-700 hover:bg-amber-100 dark:border-amber-700/40 dark:bg-amber-950/20 dark:text-amber-400"
                                onClick={() => { dismiss(); window.open(BUY_FRIENDS_URL, "_blank", "noopener,noreferrer"); }}
                            >
                                <ExternalLink className="mr-1 h-3.5 w-3.5" />
                                Friends Club
                            </Button>
                        </div>
                    </div>

                    <DialogFooter className="justify-center sm:justify-center">
                        <p className="text-xs text-muted-foreground/60">
                            Snoozes for 24 hours · Pro supports up to 5 computers · Friends Club supports up to 10
                        </p>
                    </DialogFooter>
                </div>
            </DialogContent>
        </Dialog>
    );
}
