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
    useState,
    type ReactNode,
} from "react";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";

export type ToastVariant = "success" | "error" | "info";

export interface Toast {
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
        setTimeout(() => {
            setToasts((prev) => prev.filter((t) => t.id !== id));
        }, 3500);
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

function ToastItem({
    toast: t,
    onDismiss,
}: {
    toast: Toast;
    onDismiss(id: string): void;
}) {
    const icon =
        t.variant === "success" ? (
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
        ) : t.variant === "error" ? (
            <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />
        ) : (
            <Info className="h-4 w-4 shrink-0 text-primary" />
        );

    return (
        <div
            role="status"
            className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 shadow-lg animate-in slide-in-from-right-4 fade-in duration-200"
        >
            {icon}
            <span className="text-sm">{t.message}</span>
            <button
                type="button"
                onClick={() => onDismiss(t.id)}
                aria-label="Dismiss notification"
                className="ml-auto text-muted-foreground transition-colors hover:text-foreground"
            >
                <X className="h-4 w-4" />
            </button>
        </div>
    );
}
