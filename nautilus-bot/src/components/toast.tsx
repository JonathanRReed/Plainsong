/**
 * Lightweight in-app toast notification system.
 *
 * Usage:
 *   const { toast, ToastContainer } = useToast();
 *   toast("Export saved!", "success");
 *   // Render <ToastContainer /> at the top of your component tree.
 *
 * Alternatively, use the standalone <ToastProvider> + useToastContext()
 * if you want cross-component access.
 */

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useRef,
    useState,
    type ReactNode,
} from "react";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";
import { cn } from "@/lib/utils";

type ToastVariant = "success" | "error" | "info";

const TOAST_DURATION_MS = 3500;

interface Toast {
    id: string;
    message: string;
    variant: ToastVariant;
    createdAt: number;
}

interface ToastContextValue {
    toast(message: string, variant?: ToastVariant): void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
    const [toasts, setToasts] = useState<Toast[]>([]);

    const toast = useCallback((message: string, variant: ToastVariant = "info") => {
        const id = crypto.randomUUID();
        setToasts((prev) => [...prev, { id, message, variant, createdAt: Date.now() }]);
        setTimeout(() => {
            setToasts((prev) => prev.filter((t) => t.id !== id));
        }, TOAST_DURATION_MS);
    }, []);

    const dismiss = useCallback((id: string) => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
    }, []);

    return (
        <ToastContext.Provider value={{ toast }}>
            {children}
            <ToastContainer toasts={toasts} onDismiss={dismiss} />
        </ToastContext.Provider>
    );
}

export function useToast(): ToastContextValue {
    const ctx = useContext(ToastContext);
    if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
    return ctx;
}

// ── Internal container ────────────────────────────────────────────────────────

function ToastContainer({
    toasts,
    onDismiss,
}: {
    toasts: Toast[];
    onDismiss(id: string): void;
}) {
    if (toasts.length === 0) return null;

    return (
        <div
            aria-live="polite"
            className="fixed bottom-4 right-4 z-50 flex flex-col gap-2"
        >
            {toasts.map((t) => (
                <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />
            ))}
        </div>
    );
}

const VARIANT_STYLES: Record<ToastVariant, { icon: typeof CheckCircle2; iconClass: string; accent: string; bar: string }> = {
    success: {
        icon: CheckCircle2,
        iconClass: "text-gold-text",
        accent: "border-l-gold",
        bar: "bg-gold",
    },
    error: {
        icon: AlertCircle,
        iconClass: "text-rust",
        accent: "border-l-rust",
        bar: "bg-rust",
    },
    info: {
        icon: Info,
        iconClass: "text-muted-foreground",
        accent: "border-l-muted",
        bar: "bg-muted",
    },
};

function ToastItem({
    toast: t,
    onDismiss,
}: {
    toast: Toast;
    onDismiss(id: string): void;
}) {
    const style = VARIANT_STYLES[t.variant];
    const Icon = style.icon;
    const progressRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const bar = progressRef.current;
        if (!bar) return;
        const elapsed = Date.now() - t.createdAt;
        const remaining = Math.max(0, TOAST_DURATION_MS - elapsed);
        bar.style.transition = "none";
        bar.style.width = `${(remaining / TOAST_DURATION_MS) * 100}%`;
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            return;
        }
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                bar.style.transition = `width ${remaining}ms linear`;
                bar.style.width = "0%";
            });
        });
    }, [t.createdAt]);

    return (
        <div
            role="status"
            className={cn(
                "group relative overflow-hidden rounded-md border border-l-[3px] bg-card shadow-[0_14px_38px_hsl(34_26%_4%/0.18)]",
                "animate-in slide-in-from-right-4 fade-in duration-300 ease-out",
                style.accent,
            )}
        >
            <div className="flex items-center gap-3 px-4 py-3">
                <Icon className={cn("h-4 w-4 shrink-0", style.iconClass)} />
                <span className="text-sm leading-5">{t.message}</span>
                <button
                    type="button"
                    onClick={() => onDismiss(t.id)}
                    aria-label="Dismiss notification"
                    className="ml-auto rounded-sm opacity-0 transition-opacity group-hover:opacity-70 hover:opacity-100! focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                    <X className="h-4 w-4" />
                </button>
            </div>
            <div
                ref={progressRef}
                className={cn("absolute bottom-0 left-0 h-0.5", style.bar)}
            />
        </div>
    );
}
