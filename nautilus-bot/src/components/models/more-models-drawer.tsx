import { Button } from "@/components/ui/button";
import {
  ReadinessMark,
  routeDownloadLabel,
  routeFactSentence,
} from "@/components/models/model-facts";
import type { SpeechLane } from "@/components/models/model-selection";
import type { AsrRouteCatalogEntry } from "@/lib/asr-route-catalog";

interface MoreModelsDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Every route that is not one of the promoted three. */
  routes: AsrRouteCatalogEntry[];
  activeRouteIds: Record<SpeechLane, string | null>;
  onDiskFor: (route: AsrRouteCatalogEntry) => boolean | null;
  onSelect: (lane: SpeechLane, route: AsrRouteCatalogEntry) => void;
}

/**
 * The rest of the catalogue, collapsed. Everything here is selectable and
 * honestly described; it is out of the main list because three routes that
 * fail differently is a choice a person can make, and fifteen is not.
 */
export function MoreModelsDrawer({
  open,
  onOpenChange,
  routes,
  activeRouteIds,
  onDiskFor,
  onSelect,
}: MoreModelsDrawerProps) {
  const local = routes.filter((route) => route.hosting !== "cloud");
  const cloud = routes.filter((route) => route.hosting === "cloud");

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
                  <ReadinessMark label={download.label} tone={download.tone} />
                </div>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                  {routeFactSentence(route)}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant={usedForDictation ? "active" : "outline"}
                    disabled={!route.selectable || usedForDictation}
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
                      Dictation only — it is not wired for long recordings.
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
    <section aria-label="More models">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="section-heading">More models</p>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
            The rest of the Whisper family and the engines behind it. Nothing
            here is hidden because it is bad — it is here because the three
            above already cover the ways a model can fail you.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          aria-expanded={open}
          onClick={() => onOpenChange(!open)}
        >
          {open ? "Hide more models" : `Show ${routes.length} more models`}
        </Button>
      </div>

      {open ? (
        <div className="mt-4 space-y-5">
          {renderGroup(
            "Other local builds",
            "Downloaded to this Mac and run here.",
            local,
          )}
          {renderGroup(
            "Cloud engines",
            "Your audio is uploaded to the service, and you bring the API key. No download, so no size to report.",
            cloud,
          )}
        </div>
      ) : null}
    </section>
  );
}
