import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  /**
   * The page's single rust rubric eyebrow. STYLE.md budgets exactly one per
   * page and it lives here — sections inside the page use `.section-heading`
   * (or nothing), never a second `.rubric`.
   */
  eyebrow?: string;
  subtitle?: string;
  actions?: ReactNode;
  className?: string;
  children?: ReactNode;
}

export function PageHeader({
  title,
  eyebrow,
  subtitle,
  actions,
  className,
  children,
}: PageHeaderProps) {
  return (
    <div className={cn("border-b border-border/70 bg-background/82 backdrop-blur-xl", className)}>
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-6 py-5 lg:px-8">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1">
            {eyebrow && <p className="rubric mb-1.5">{eyebrow}</p>}
            <h1 className="font-serif text-2xl font-semibold tracking-tight text-foreground">
              {title}
            </h1>
            {subtitle && (
              <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
                {subtitle}
              </p>
            )}
          </div>
          {actions && (
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {actions}
            </div>
          )}
        </div>

        {children}
      </div>
    </div>
  );
}
