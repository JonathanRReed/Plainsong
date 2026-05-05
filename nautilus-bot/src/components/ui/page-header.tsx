import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  breadcrumbs?: Array<{
    label: string;
    href?: string;
    onClick?: () => void;
  }>;
  className?: string;
  children?: ReactNode;
}

export function PageHeader({
  title,
  subtitle,
  actions,
  breadcrumbs,
  className,
  children,
}: PageHeaderProps) {
  return (
    <div className={cn("border-b border-border/70 bg-background/82 backdrop-blur-xl", className)}>
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-6 py-5 lg:px-8">
        {/* Breadcrumbs */}
        {breadcrumbs && breadcrumbs.length > 0 && (
          <nav className="flex flex-wrap items-center gap-2 text-sm">
            {breadcrumbs.map((crumb, index) => {
              const isLast = index === breadcrumbs.length - 1;
              return (
                <div key={index} className="flex items-center gap-2">
                  {index > 0 && (
                    <span className="text-muted-foreground">/</span>
                  )}
                  {isLast ? (
                    <span className="text-muted-foreground">{crumb.label}</span>
                  ) : (
                    <button
                      type="button"
                      onClick={crumb.onClick}
                      className="text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {crumb.label}
                    </button>
                  )}
                </div>
              );
            })}
          </nav>
        )}

        {/* Header Content */}
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
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

        {children && <div className="mt-4">{children}</div>}
      </div>
    </div>
  );
}
