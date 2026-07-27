import { useMemo, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { AsrRouteCatalogEntry } from "@/lib/asr-route-catalog";

interface AsrRouteComboboxProps {
  emptyText?: string;
  onSelect: (route: AsrRouteCatalogEntry) => void;
  placeholder?: string;
  routes: AsrRouteCatalogEntry[];
  value: string | null;
}

const BADGE_VARIANT_BY_READINESS: Record<
  AsrRouteCatalogEntry["readiness"],
  "default" | "secondary" | "outline" | "destructive"
> = {
  ready: "default",
  needs_download: "secondary",
  requires_key: "outline",
  missing_runtime: "outline",
  unavailable: "destructive",
};

export function AsrRouteCombobox({
  emptyText = "No matching routes.",
  onSelect,
  placeholder = "Choose a route",
  routes,
  value,
}: AsrRouteComboboxProps) {
  const [open, setOpen] = useState(false);

  const selectedRoute =
    routes.find((route) => route.routeId === value) ?? null;

  const primaryRoutes = useMemo(() => {
    return routes.slice(0, 3);
  }, [routes]);

  const primaryRouteIds = new Set(primaryRoutes.map((route) => route.routeId));
  const moreRoutes = routes.filter((route) => !primaryRouteIds.has(route.routeId));

  const renderItem = (route: AsrRouteCatalogEntry) => (
    <CommandItem
      key={route.routeId}
      disabled={!route.selectable}
      value={[
        route.label,
        route.providerLabel,
        route.capabilityBadge,
        route.hosting,
        route.readinessLabel,
        route.summary,
      ].join(" ")}
      onSelect={() => {
        onSelect(route);
        setOpen(false);
      }}
      className="items-start gap-3 px-3 py-3 data-[disabled=true]:opacity-60"
    >
      <Check
        className={cn(
          "mt-0.5 h-4 w-4 shrink-0",
          value === route.routeId ? "opacity-100" : "opacity-0",
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{route.label}</span>
          <Badge variant="outline">{route.providerLabel}</Badge>
          <Badge variant="outline">
            {route.hosting === "platform"
              ? "Platform"
              : route.hosting === "cloud"
                ? "Cloud"
                : "Local"}
          </Badge>
          <Badge variant="outline">{route.capabilityBadge}</Badge>
          <Badge variant={BADGE_VARIANT_BY_READINESS[route.readiness]}>
            {route.readinessLabel}
          </Badge>
          {route.experimental ? (
            <Badge variant="outline">Experimental</Badge>
          ) : null}
          {route.supportsMlxAcceleration ? (
            <Badge variant="outline">Apple Silicon accel</Badge>
          ) : null}
        </div>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {route.readinessDetail ?? route.summary}
        </p>
      </div>
    </CommandItem>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-auto w-full justify-between px-3 py-2 text-left"
        >
          <div className="min-w-0">
            {selectedRoute ? (
              <div className="min-w-0">
                <div className="truncate font-medium">{selectedRoute.label}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {selectedRoute.providerLabel} · {selectedRoute.readinessLabel}
                </div>
              </div>
            ) : (
              <span className="text-muted-foreground">{placeholder}</span>
            )}
          </div>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[30rem] p-0" align="start">
        <Command shouldFilter>
          <CommandInput placeholder="Search routes" />
          <CommandList className="max-h-[24rem]">
            <CommandEmpty>{emptyText}</CommandEmpty>
            {primaryRoutes.length > 0 ? (
              <CommandGroup heading="Top routes">
                {primaryRoutes.map(renderItem)}
              </CommandGroup>
            ) : null}
            {moreRoutes.length > 0 ? (
              <CommandGroup heading="More routes">
                {moreRoutes.map(renderItem)}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
