import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { describePauseBehavior } from "@/lib/asr-capabilities";
import {
  ReadinessMark,
  laneRouteReadiness,
  routeDownloadLabel,
  routeFactSentence,
  type LaneReadiness,
} from "@/components/models/model-facts";
import type { AsrRouteCatalogEntry } from "@/lib/asr-route-catalog";

interface SpeechLaneRowProps {
  title: string;
  /** What choosing here actually changes for the user. */
  implication: string;
  options: AsrRouteCatalogEntry[];
  activeRoute: AsrRouteCatalogEntry | null;
  /** What settings says the lane points at, for when no route matches it. */
  activeRouteId: string;
  onDiskFor: (route: AsrRouteCatalogEntry) => boolean | null;
  onSelect: (route: AsrRouteCatalogEntry) => void;
  onAction: (route: AsrRouteCatalogEntry) => void;
  actionBusy: boolean;
  /**
   * Stops a running language install.
   *
   * Every other action on this row is quick; the language install is macOS'
   * own download and can run for minutes, so the busy state needs a way out
   * that is not quitting the app. Only rendered while that is the action
   * running.
   */
  onCancelLanguageInstall?: () => void;
  cancelLanguageInstallBusy?: boolean;
  readinessOverride?: LaneReadiness | null;
  /** Whether the pause-behaviour sentence earns its place in this lane. */
  explainPauseBehavior: boolean;
}

export function SpeechLaneRow({
  title,
  implication,
  options,
  activeRoute,
  activeRouteId,
  onDiskFor,
  onSelect,
  onAction,
  actionBusy,
  onCancelLanguageInstall,
  cancelLanguageInstallBusy = false,
  readinessOverride = null,
  explainPauseBehavior,
}: SpeechLaneRowProps) {
  // The header answers for the model this lane points at, measured off disk --
  // not for the provider that lists it. See `laneRouteReadiness`.
  const headerReadiness = activeRoute
    ? readinessOverride ??
      laneRouteReadiness(activeRoute, onDiskFor(activeRoute))
    : null;

  return (
    // A labelled region, so the row's own readiness and action stay findable
    // as "the meetings row's Download button" rather than one of four.
    <section aria-label={title} className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold">{title}</p>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
            {implication}
          </p>
        </div>
        {activeRoute && headerReadiness ? (
          <div className="flex items-center gap-3">
            <ReadinessMark
              label={headerReadiness.label}
              tone={headerReadiness.tone}
            />
            {headerReadiness.action && headerReadiness.actionLabel ? (
              <Button
                size="sm"
                variant="outline"
                disabled={actionBusy}
                onClick={() => onAction(activeRoute)}
              >
                {actionBusy
                  ? headerReadiness.action === "install_language"
                    ? "Installing language…"
                    : "Working…"
                  : headerReadiness.actionLabel}
              </Button>
            ) : null}
            {actionBusy &&
            headerReadiness.action === "install_language" &&
            onCancelLanguageInstall ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={cancelLanguageInstallBusy}
                onClick={onCancelLanguageInstall}
              >
                {cancelLanguageInstallBusy ? "Stopping…" : "Cancel"}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {activeRoute ? (
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
          <span className="font-medium text-foreground">
            {activeRoute.label}
          </span>{" "}
          — {routeFactSentence(activeRoute)}
        </p>
      ) : (
        <p className="text-sm leading-6 text-rust">
          Settings points this at {activeRouteId}, which this build does not
          offer. Pick one below.
        </p>
      )}

      {explainPauseBehavior && activeRoute?.capability ? (
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
          {describePauseBehavior(activeRoute.capability.pauseBehavior)}
        </p>
      ) : null}

      <div role="radiogroup" aria-label={title} className="grid gap-2">
        {options.map((route) => {
          const selected = route.routeId === activeRoute?.routeId;
          const download = routeDownloadLabel(route, onDiskFor(route));

          return (
            <button
              key={route.routeId}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={!route.selectable}
              onClick={() => onSelect(route)}
              className={cn(
                "w-full rounded-md border p-3 text-left transition-smooth",
                "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                selected
                  ? "border-gold/40 bg-gold/10"
                  : "border-border/60 bg-background hover:border-border",
                !route.selectable && "cursor-not-allowed opacity-60",
              )}
            >
              <span className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">{route.label}</span>
                <ReadinessMark label={download.label} tone={download.tone} />
              </span>
              <span className="mt-1 block text-sm leading-6 text-muted-foreground">
                {routeFactSentence(route)}
              </span>
            </button>
          );
        })}
      </div>

      {options.length < 2 ? (
        <p className="text-sm leading-6 text-muted-foreground">
          Only one of the promoted engines can serve this task. The rest are
          under More models below.
        </p>
      ) : null}
    </section>
  );
}
