import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center py-20 text-center px-6",
        className
      )}
    >
      {icon && (
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-muted/50 mb-4 animate-fade-in">
          {icon}
        </div>
      )}
      <h3 className="text-lg font-semibold text-foreground animate-slide-in-from-top">
        {title}
      </h3>
      {description && (
        <p className="mt-2 text-sm text-muted-foreground max-w-xs animate-slide-in-from-top" style={{ animationDelay: "50ms" }}>
          {description}
        </p>
      )}
      {action && (
        <Button
          className="mt-6 animate-slide-in-from-top"
          style={{ animationDelay: "100ms" }}
          onClick={action.onClick}
        >
          {action.label}
        </Button>
      )}
    </div>
  );
}
