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
        "settle-stagger mx-auto flex max-w-md flex-col items-center justify-center px-6 py-20 text-center",
        className
      )}
    >
      {icon ? (
        <div className="mb-6 flex size-12 items-center justify-center text-muted-foreground/70">
          {icon}
        </div>
      ) : (
        <span className="neume neume-hollow mb-6" aria-hidden="true" />
      )}
      <h3 className="font-serif text-xl font-medium tracking-tight text-foreground">
        {title}
      </h3>
      {description && (
        <p className="mt-2.5 max-w-sm text-sm leading-6 text-muted-foreground">
          {description}
        </p>
      )}
      {action && (
        <Button
          variant="outline"
          className="mt-6"
          onClick={action.onClick}
        >
          {action.label}
        </Button>
      )}
    </div>
  );
}
