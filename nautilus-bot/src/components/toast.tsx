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
}

interface ToastContextValue {
    toast(message: string, variant?: ToastVariant): void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
    const [toasts, setToasts] = useState<Toast[]>([]);

    const toast = useCallback((message: string, variant: ToastVariant = "info") => {
        const id = crypto.randomUUID();
        setToasts((prev) => [...prev, { id, message, variant }]);
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

    const [hovered, setHovered] = useState(false);
    const [focused, setFocused] = useState(false);
    const remainingRef = useRef(TOAST_DURATION_MS);
    const expires = t.variant === "success";

    useEffect(() => {
        const bar = progressRef.current;
        if (bar) {
            bar.style.transition = "none";
            bar.style.width = `${(remainingRef.current / TOAST_DURATION_MS) * 100}%`;
        }
        if (!expires || hovered || focused) return;
        const started = Date.now();
        const timer = window.setTimeout(() => onDismiss(t.id), remainingRef.current);
        const frame = requestAnimationFrame(() => {
            if (bar && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
                bar.style.transition = `width ${remainingRef.current}ms linear`;
                bar.style.width = "0%";
            }
        });
        return () => {
            window.clearTimeout(timer);
            cancelAnimationFrame(frame);
            remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - started));
        };
    }, [expires, hovered, focused, onDismiss, t.id]);

    return (
        <div
            role={t.variant === "error" ? "alert" : "status"}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onFocusCapture={() => setFocused(true)}
            onBlurCapture={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
            }}
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
            {expires ? <div
                ref={progressRef}
                className={cn("absolute bottom-0 left-0 h-0.5", style.bar)}
            /> : null}
        </div>
    );
}
