import { cn } from "@/lib/utils";
import { CheckCircle2, AlertCircle, Info, XCircle } from "lucide-react";

export type StatusBadgeVariant = "success" | "warning" | "error" | "info" | "default";

interface StatusBadgeProps {
  variant?: StatusBadgeVariant;
  children: React.ReactNode;
  icon?: boolean;
  className?: string;
}

const statusConfig = {
  success: {
    className: "bg-success/10 text-success border-success/20",
    icon: CheckCircle2,
  },
  warning: {
    className: "bg-warning/10 text-warning border-warning/20",
    icon: AlertCircle,
  },
  error: {
    className: "bg-destructive/10 text-destructive border-destructive/20",
    icon: XCircle,
  },
  info: {
    className: "bg-info/10 text-info border-info/20",
    icon: Info,
  },
  default: {
    className: "bg-muted text-muted-foreground border-border",
    icon: null,
  },
};

export function StatusBadge({
  variant = "default",
  children,
  icon = true,
  className,
}: StatusBadgeProps) {
  const config = statusConfig[variant];
  const Icon = config.icon;

  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-all duration-200",
        config.className,
        className
      )}
    >
      {icon && Icon && <Icon className="h-3.5 w-3.5" />}
      <span>{children}</span>
    </div>
  );
}
