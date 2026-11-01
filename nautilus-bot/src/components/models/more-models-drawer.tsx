import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  ReadinessMark,
  laneRouteReadiness,
  routeDownloadLabel,
  routeFactSentence,
} from "@/components/models/model-facts";
import type { SpeechLane } from "@/components/models/model-selection";
import type { AsrRouteCatalogEntry } from "@/lib/asr-route-catalog";

interface MoreModelsDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Experimental models and cloud services: every route the lanes don't list. */
  routes: AsrRouteCatalogEntry[];
  activeRouteIds: Record<SpeechLane, string | null>;
  onDiskFor: (route: AsrRouteCatalogEntry) => boolean | null;
  onSelect: (lane: SpeechLane, route: AsrRouteCatalogEntry) => void;
  onAction?: (route: AsrRouteCatalogEntry) => void;
  busyRouteId?: string | null;
  /** Download progress for the busy route, when its action is a download. */
  busyProgress?: number | null;
  onCancelLanguageInstall?: () => void;
  cancelLanguageInstallBusy?: boolean;
}

/**
 * Experimental models and cloud services, collapsed. Every finished model
 * this Mac can run is listed in the lanes above without a click; what is
 * here is either a preview or sends audio off the Mac with your own key, so
 * it waits to be asked for.
 */
export function MoreModelsDrawer({
  open,
  onOpenChange,
  routes,
  activeRouteIds,
  onDiskFor,
  onSelect,
  onAction,
  busyRouteId = null,
  busyProgress = null,
  onCancelLanguageInstall,
  cancelLanguageInstallBusy = false,
}: MoreModelsDrawerProps) {
  const [query, setQuery] = useState("");
  const [task, setTask] = useState("all");
  const [hosting, setHosting] = useState("all");
  const [availability, setAvailability] = useState("all");
  const searchTerms = query.trim().toLocaleLowerCase("en-US").split(/\s+/u).filter(Boolean);
  const matches = routes.filter((route) => {
    const readiness = laneRouteReadiness(route, onDiskFor(route));
    const searchableText = [route.label, route.providerLabel, route.modelId, routeFactSentence(route)]
      .join(" ").toLocaleLowerCase("en-US");
    return (
      searchTerms.every((term) => searchableText.includes(term)) &&
      (task === "all" || route.laneCompatibility[task as SpeechLane]) &&
      (hosting === "all" || (hosting === "local" ? route.hosting !== "cloud" : route.hosting === "cloud")) &&
      (availability === "all" || (availability === "ready" ? readiness.tone === "ready" : readiness.tone !== "ready"))
    );
  });
  const hiddenSelected = routes.filter((route) =>
    Object.values(activeRouteIds).includes(route.routeId) && !matches.includes(route),
  );
  const local = matches.filter((route) => route.hosting !== "cloud");
  const cloud = matches.filter((route) => route.hosting === "cloud");
  const clearFilters = () => {
    setQuery("");
    setTask("all");
    setHosting("all");
    setAvailability("all");
  };

  const renderGroup = (
    heading: string,
    description: string,
    group: AsrRouteCatalogEntry[],
  ) => {
    if (group.length === 0) {
      return null;
    }

    return (
      <div className="space-y-2">
        <p className="text-sm font-semibold">{heading}</p>
        <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
          {description}
        </p>
        <div className="grid gap-2">
          {group.map((route) => {
            const download = routeDownloadLabel(route, onDiskFor(route));
            const readiness = laneRouteReadiness(route, onDiskFor(route));
            const usedForDictation =
              activeRouteIds.dictation === route.routeId;
            const usedForMeeting = activeRouteIds.meeting === route.routeId;

            return (
              <div
                key={route.routeId}
                className="rounded-md border border-border/60 bg-background p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">{route.label}</p>
                  <span className="flex flex-wrap gap-3">
                    <ReadinessMark label={download.label} tone={download.tone} />
                    {download.label !== readiness.label ? (
                      <ReadinessMark label={readiness.label} tone={readiness.tone === "ready" ? "ready" : "neutral"} />
                    ) : null}
                  </span>
                </div>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  {routeFactSentence(route)}
                </p>
                {readiness.tone !== "ready" && route.readinessDetail ? (
                  <p className="mt-1 text-sm text-muted-foreground">{route.readinessDetail}</p>
                ) : null}
                <div className="mt-2 flex flex-wrap gap-2">
                  {readiness.action && readiness.actionLabel && onAction ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busyRouteId !== null}
                      aria-label={`${readiness.actionLabel} for ${route.label}`}
                      onClick={() => onAction(route)}
                    >
                      {busyRouteId === route.routeId
                        ? readiness.action === "download"
                          ? busyProgress === null
                            ? "Downloading…"
                            : `Downloading ${Math.round(busyProgress)}%`
                          : "Working…"
                        : readiness.actionLabel}
                    </Button>
                  ) : null}
                  {busyRouteId === route.routeId && readiness.action === "install_language" && onCancelLanguageInstall ? (
                    <Button size="sm" variant="ghost" disabled={cancelLanguageInstallBusy} onClick={onCancelLanguageInstall}>
                      {cancelLanguageInstallBusy ? "Stopping…" : "Cancel language install"}
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant={usedForDictation ? "active" : "outline"}
                    disabled={!route.selectable || !route.laneCompatibility.dictation || usedForDictation}
                    onClick={() => onSelect("dictation", route)}
                  >
                    {usedForDictation
                      ? "Used for dictation"
                      : "Use for dictation"}
                  </Button>
                  {route.laneCompatibility.meeting ? (
                    <Button
                      size="sm"
                      variant={usedForMeeting ? "active" : "outline"}
                      disabled={!route.selectable || usedForMeeting}
                      onClick={() => onSelect("meeting", route)}
                    >
                      {usedForMeeting ? "Used for meetings" : "Use for meetings"}
                    </Button>
                  ) : (
                    <p className="self-center text-sm text-muted-foreground">
                      Dictation only. It can&apos;t handle long recordings.
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <section aria-label="Experimental models and cloud services">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="section-heading">Experimental models and cloud services</h3>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
            Previews that aren&apos;t finished yet, and services that transcribe
            with your own API key. Each one says what it&apos;s for and whether
            it&apos;s ready.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          aria-expanded={open}
          onClick={() => onOpenChange(!open)}
        >
          {open ? "Hide these models" : `Show ${routes.length} more`}
        </Button>
      </div>

      {open ? (
        <div className="mt-4 space-y-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm">
              <span>Search speech models</span>
              <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name, language, or model size" />
            </label>
            <label className="space-y-1 text-sm">
              <span>Task</span>
              <select className="h-10 w-full rounded-md border bg-background px-3" value={task} onChange={(event) => setTask(event.target.value)}>
                <option value="all">All tasks</option>
                <option value="dictation">Dictation</option>
                <option value="meeting">Meetings</option>
              </select>
            </label>
            <label className="space-y-1 text-sm">
              <span>Where audio runs</span>
              <select className="h-10 w-full rounded-md border bg-background px-3" value={hosting} onChange={(event) => setHosting(event.target.value)}>
                <option value="all">On this Mac and cloud</option>
                <option value="local">On this Mac</option>
                <option value="cloud">Cloud services</option>
              </select>
            </label>
            <label className="space-y-1 text-sm">
              <span>Status</span>
              <select className="h-10 w-full rounded-md border bg-background px-3" value={availability} onChange={(event) => setAvailability(event.target.value)}>
                <option value="all">Any status</option>
                <option value="ready">Ready to use</option>
                <option value="setup">Needs setup or download</option>
              </select>
            </label>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p role="status" className="text-sm text-muted-foreground">{matches.length} of {routes.length} models match</p>
            <Button size="sm" variant="ghost" onClick={clearFilters}>Clear filters</Button>
          </div>
          {renderGroup("Selected models outside these filters", "Your choices stay selected when you filter the list.", hiddenSelected)}
          {matches.length === 0 ? (
            <p className="text-sm text-muted-foreground">No models match. Clear filters or try another name or language.</p>
          ) : null}
          {renderGroup(
            "Experimental models that run on this Mac",
            "Downloaded once and run here. Nothing is uploaded and nothing is billed.",
            local,
          )}
          {renderGroup(
            "Cloud services",
            "Your audio is uploaded to the service, which bills you by the minute or by the hour. You bring the API key. Nothing to download.",
            cloud,
          )}
        </div>
      ) : null}
    </section>
  );
}
