import { cn } from "@/lib/utils";

interface WorkspaceSkeletonProps {
  /** What is being fetched, said plainly for screen readers. */
  label: string;
  lines?: number;
  className?: string;
}

/**
 * What a pane shows while its meeting is still loading. It exists because the
 * alternative is worse than blank: a workspace that renders "0 segments",
 * "Needs refresh" and "Not grounded" before the data lands is asserting
 * absence when it only means "not yet".
 */
export function WorkspaceSkeleton({ label, lines = 4, className }: WorkspaceSkeletonProps) {
  return (
    <div
      className={cn("space-y-4", className)}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <p className="text-sm text-muted-foreground">{label}</p>
      <div className="space-y-2.5" aria-hidden="true">
        {Array.from({ length: lines }, (_, index) => (
          <div
            key={index}
            className="animate-pulse-subtle h-3.5 rounded-sm bg-muted/50"
            style={{ width: `${100 - (index % 3) * 14}%` }}
          />
        ))}
      </div>
    </div>
  );
}
