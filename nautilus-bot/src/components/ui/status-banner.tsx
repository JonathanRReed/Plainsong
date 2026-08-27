import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export type StatusBannerTone = "rust" | "muted";

interface StatusBannerProps {
  /** What happened, in the reader's terms. One line. */
  title: string;
  /** The cause and the next step. Passed through from the backend when it said it. */
  message?: ReactNode;
  /** Rust for something that needs attention; muted for something merely in progress. */
  tone?: StatusBannerTone;
  /** Buttons, in order. Keep it to one primary action. */
  actions?: ReactNode;
  /**
   * `alert` for a failure the reader must see, `status` for a state that is
   * still resolving. Defaults to the tone's usual reading.
   */
  role?: "alert" | "status";
  className?: string;
}

/**
 * The one persistent notice surface.
 *
 * It exists because the same idea was rebuilt three times — the meetings
 * readiness strip, the meeting lifecycle strip and `AudioIssueBanner` — each
 * with its own markup, and engine loss had no surface at all outside the buried
 * Setup view. Everything that has to stay on screen until the reader acts uses
 * this: rust hairline, quiet fill, message, and the actions inline.
 */
export function StatusBanner({
  title,
  message,
  tone = "rust",
  actions,
  role,
  className,
}: StatusBannerProps) {
  return (
    <Card
      role={role ?? (tone === "rust" ? "alert" : "status")}
      className={cn(
        tone === "rust"
          ? "border-rust/40 bg-rust/5"
          : "border-border/80 bg-muted/30",
        className,
      )}
    >
      <CardContent className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2.5">
            <span
              className={cn(
                "neume mt-1.5 shrink-0",
                tone === "rust" ? "neume-rust" : "neume-hollow",
              )}
              aria-hidden="true"
            />
            <div className="min-w-0">
              <p
                className={cn(
                  "text-sm font-medium",
                  tone === "rust" ? "text-rust" : "text-foreground",
                )}
              >
                {title}
              </p>
              {message ? (
                <div className="mt-1 text-sm leading-6 text-muted-foreground">
                  {message}
                </div>
              ) : null}
            </div>
          </div>
          {actions ? (
            <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
