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
        "mx-auto flex max-w-md flex-col items-center justify-center px-6 py-20 text-center",
        className
      )}
    >
      {icon && (
        <div className="mb-5 flex size-14 items-center justify-center rounded-2xl border border-border/70 bg-muted/35 text-muted-foreground shadow-sm">
          {icon}
        </div>
      )}
      <h3 className="text-lg font-semibold tracking-tight text-foreground">
        {title}
      </h3>
      {description && (
        <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
          {description}
        </p>
      )}
      {action && (
        <Button
          className="mt-6"
          onClick={action.onClick}
        >
          {action.label}
        </Button>
      )}
    </div>
  );
}
