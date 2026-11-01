import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import type { ReactNode } from "react";
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
import { groupSpeechChoices } from "@/lib/speech-model-choices";

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
   * Another row's action is running. One action at a time, as in the drawer:
   * a second click would otherwise take over the busy state and leave the
   * first row looking idle while it still downloads.
   */
  actionDisabled?: boolean;
  /** Download progress for this row's busy action, when it is a download. */
  actionProgress?: number | null;
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
  /**
   * Marks the option the app recommends for this lane, the way the first-run
   * wizard does. A label only: it never switches the lane.
   */
  isRecommended?: (route: AsrRouteCatalogEntry) => boolean;
  /**
   * List the options in two labelled sections, "Dictation and meetings" and
   * "Dictation only", the way the first-run wizard does. For the dictation
   * lane, where both kinds are offered.
   */
  groupByMeetingCapability?: boolean;
  /** A line under the header about what this choice means for another lane. */
  notice?: ReactNode;
}

/** "Parakeet v3 stays quiet through pauses, …": the pause fact, about the chosen model. */
function pauseSentence(label: string, behavior: Parameters<typeof describePauseBehavior>[0]): string {
  const sentence = describePauseBehavior(behavior);
  return `${label} ${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}`;
}

export function SpeechLaneRow({
  title,
  implication,
  options,
  activeRoute,
  onDiskFor,
  onSelect,
  onAction,
  actionBusy,
  actionDisabled = actionBusy,
  actionProgress = null,
  onCancelLanguageInstall,
  cancelLanguageInstallBusy = false,
  readinessOverride = null,
  explainPauseBehavior,
  isRecommended,
  groupByMeetingCapability = false,
  notice = null,
}: SpeechLaneRowProps) {
  // The header answers for the model this lane points at, measured off disk --
  // not for the provider that lists it. See `laneRouteReadiness`.
  const headerReadiness = activeRoute
    ? readinessOverride ??
      laneRouteReadiness(activeRoute, onDiskFor(activeRoute))
    : null;

  const sections = groupByMeetingCapability ? laneSections(options) : null;
  const renderOption = (route: AsrRouteCatalogEntry) => {
    const selected = route.routeId === activeRoute?.routeId;
    const download = routeDownloadLabel(route, onDiskFor(route));
    return (
      <Radio.Root
        key={route.routeId}
        value={route.routeId}
        nativeButton
        render={<button type="button" />}
        disabled={!route.selectable}
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
          <span className="flex flex-wrap items-center gap-x-2 text-sm font-medium">
            {isRecommended?.(route) ? (
              <span className="inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-gold-text">
                <span className="neume neume-lit" aria-hidden="true" />
                Recommended
              </span>
            ) : null}
            {route.label}
          </span>
          <ReadinessMark label={download.label} tone={download.tone} />
        </span>
        <span className="mt-1 block text-sm leading-6 text-muted-foreground">
          {routeFactSentence(route)}
        </span>
      </Radio.Root>
    );
  };

  return (
    // A labelled region, so the row's own readiness and action stay findable
    // as "the meetings row's Download button" rather than one of four.
    <section aria-label={title} className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-sm font-semibold">{title}</h4>
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
                disabled={actionBusy || actionDisabled}
                onClick={() => onAction(activeRoute)}
              >
                {actionBusy
                  ? headerReadiness.action === "install_language"
                    ? "Installing language…"
                    : headerReadiness.action === "download"
                      ? actionProgress === null
                        ? "Downloading…"
                        : `Downloading ${Math.round(actionProgress)}%`
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

      {/* The active model is always one of the options below, highlighted,
          with its own description, so it is not repeated up here. */}
      {activeRoute ? null : (
        <p className="text-sm leading-6 text-rust">
          The model chosen for this isn&apos;t available on this Mac. Pick one
          below.
        </p>
      )}

      {notice}

      {explainPauseBehavior && activeRoute?.capability ? (
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
          {pauseSentence(activeRoute.label, activeRoute.capability.pauseBehavior)}
        </p>
      ) : null}

      <RadioGroup<string>
        value={activeRoute?.routeId ?? ""}
        onValueChange={(value) => {
          const route = options.find((option) => option.routeId === value);
          if (route?.selectable) onSelect(route);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Home" && event.key !== "End") return;
          event.preventDefault();
          const radios = event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not([disabled])');
          const next = event.key === "Home" ? radios[0] : radios[radios.length - 1];
          next?.focus();
          next?.click();
        }}
        aria-label={title} className="grid gap-2"
      >
        {sections === null
          ? options.map(renderOption)
          : sections.map((section) => (
              <div
                key={section.title}
                role="group"
                aria-label={section.title}
                className="grid gap-2"
              >
                <p
                  aria-hidden="true"
                  className="pt-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  {section.title}
                </p>
                {section.routes.map(renderOption)}
              </div>
            ))}
      </RadioGroup>

      {options.length < 2 ? (
        <p className="text-sm leading-6 text-muted-foreground">
          Only one model on this Mac can do this. Experimental models and
          cloud services are further down.
        </p>
      ) : null}
    </section>
  );
}

/**
 * The dictation list in two sections, each titled by what its models cover;
 * null when the list has only one kind, which is then shown without titles.
 */
function laneSections(
  options: AsrRouteCatalogEntry[],
): { title: string; routes: AsrRouteCatalogEntry[] }[] | null {
  const { dictationAndMeetings, dictationOnly } = groupSpeechChoices(
    options.map((route) => ({ route })),
  );
  if (dictationAndMeetings.length === 0 || dictationOnly.length === 0) {
    return null;
  }
  return [
    { title: "Dictation and meetings", routes: dictationAndMeetings.map(({ route }) => route) },
    { title: "Dictation only", routes: dictationOnly.map(({ route }) => route) },
  ];
}
