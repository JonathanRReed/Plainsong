import type { AsrRouteCatalogEntry } from "@/lib/asr-route-catalog";

type Readiness = AsrRouteCatalogEntry["readiness"];

/**
 * State as a neume, never as a colour temperature.
 *
 * `ready` is the filled gold diamond -- this can run right now. `attention` is
 * rust, and is reserved for something standing between the user and a capture
 * they have already chosen. A model in the drawer that simply has not been
 * downloaded is `neutral`: it is a fact about a model nobody picked, and ten
 * rust diamonds in a list would read as ten problems.
 */
export type ReadinessTone = "ready" | "neutral" | "attention";

const NEUME_BY_TONE: Record<ReadinessTone, string> = {
  ready: "neume neume-lit",
  neutral: "neume",
  attention: "neume neume-rust",
};

export function ReadinessMark({
  label,
  tone,
}: {
  label: string;
  tone: ReadinessTone;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
      <span aria-hidden="true" className={NEUME_BY_TONE[tone]} />
      {label}
    </span>
  );
}

/** The tone for the route a lane is actually pointing at. */
function activeRouteTone(readiness: Readiness): ReadinessTone {
  return readiness === "ready" ? "ready" : "attention";
}

/** What a lane header says about the route a capture will actually hit. */
export interface LaneReadiness {
  label: string;
  tone: ReadinessTone;
  action: AsrRouteCatalogEntry["action"];
  actionLabel: string | null;
}

/**
 * Readiness for a *model*, not for the provider that lists it.
 *
 * `route.readiness` is built from the provider-level `downloadStatus`, and the
 * sidecar keeps exactly one model per provider -- so every Whisper build in the
 * catalogue reports whatever is true of the one Whisper model the provider is
 * currently pointed at. Point the two lanes at two builds of the same engine
 * and the provider's answer is right for one lane and wrong for the other. A
 * header reading "Ready" with no Download button, directly above a tile reading
 * "Not downloaded", is that bug: the screen contradicting itself and hiding a
 * download the capture needs.
 *
 * `onDisk` is measured from the files themselves, per model, so it outranks the
 * provider's claim in both directions -- absent files are never "Ready", and
 * present files are never "Needs download".
 *
 * It only outranks a route that reports itself runnable or merely un-fetched.
 * `missing_runtime` and `unavailable` name a blocker no download clears, and
 * keeping their own label there tells the user more than "Needs download"
 * would. (`requires_key` cannot reach this branch: cloud routes have nothing to
 * measure, so `onDisk` is null for them.)
 */
export function laneRouteReadiness(
  route: AsrRouteCatalogEntry,
  onDisk: boolean | null,
): LaneReadiness {
  const fromProvider: LaneReadiness = {
    label: route.readinessLabel,
    tone: activeRouteTone(route.readiness),
    action: route.action,
    actionLabel: route.actionLabel,
  };

  if (
    onDisk === null ||
    (route.readiness !== "ready" && route.readiness !== "needs_download")
  ) {
    return fromProvider;
  }

  return onDisk
    ? { label: "Ready", tone: "ready", action: null, actionLabel: null }
    : {
        label: "Needs download",
        tone: "attention",
        action: "download",
        actionLabel: "Download",
      };
}

/**
 * What an option says about itself before you pick it.
 *
 * The catalogue's `capabilitySummary` is size, language coverage and the
 * downside in one sentence, built from `asr-capabilities`. Cloud routes have
 * no download and deliberately carry no size, so they fall back to the route
 * summary rather than being given an invented one.
 */
export function routeFactSentence(route: AsrRouteCatalogEntry): string {
  return route.capabilitySummary ?? route.summary;
}

/**
 * The download state to print beside an option that is not the current choice.
 *
 * `onDisk` is measured from the files themselves and is the honest answer here:
 * the provider inventory only knows about the model each provider currently
 * points at, so it would report the same thing for all ten Whisper builds. When
 * there is no measurement (cloud routes, or a failed listing) the route's own
 * readiness label stands.
 */
export function routeDownloadLabel(
  route: AsrRouteCatalogEntry,
  onDisk: boolean | null,
): { label: string; tone: ReadinessTone } {
  if (onDisk === true) {
    return { label: "On disk", tone: "ready" };
  }
  if (onDisk === false) {
    return { label: "Not downloaded", tone: "neutral" };
  }
  return {
    label: route.readinessLabel,
    tone: route.readiness === "ready" ? "ready" : "neutral",
  };
}
