import type { ComponentProps } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MoreModelsDrawer } from "@/components/models/more-models-drawer";
import type { AsrRouteCatalogEntry } from "@/lib/asr-route-catalog";

function route(overrides: Partial<AsrRouteCatalogEntry>): AsrRouteCatalogEntry {
  return {
    routeId: "whisper:small", providerType: "whisper", modelId: "small",
    label: "Whisper small", providerLabel: "Whisper", providerDescription: "Local speech",
    hosting: "local", readiness: "ready", readinessLabel: "Ready", readinessDetail: null,
    selectable: true, downloadable: true, experimental: false, capabilityBadge: "Dictation and meetings",
    action: null, actionLabel: null, summary: "Multilingual speech", capability: null,
    capabilitySummary: null, superseded: false, laneCompatibility: { dictation: true, meeting: true, shared: true },
    recommendedRank: { dictation: null, meeting: null, shared: null }, ...overrides,
  };
}

const local = route({});
const broken = route({ routeId: "whisper:large", modelId: "large", label: "Whisper large", readiness: "missing_runtime", readinessLabel: "Needs setup", action: "fix_setup", actionLabel: "Fix setup" });
const cloud = route({ routeId: "openai_cloud:whisper-1", providerType: "openai_cloud", modelId: "whisper-1", label: "Cloud speech", hosting: "cloud", downloadable: false });

function setup(props: Partial<ComponentProps<typeof MoreModelsDrawer>> = {}) {
  const onSelect = vi.fn();
  const onAction = vi.fn();
  render(<MoreModelsDrawer open onOpenChange={vi.fn()} routes={[local, broken, cloud]} activeRouteIds={{ dictation: null, meeting: null }} onDiskFor={(entry) => entry.hosting === "cloud" ? null : true} onSelect={onSelect} onAction={onAction} {...props} />);
  return { onSelect, onAction };
}

describe("speech model discovery", () => {
  it("matches every search word across model names and facts without changing selection", () => {
    const { onSelect, onAction } = setup();
    fireEvent.change(screen.getByLabelText("Search speech models"), { target: { value: "  MULTILINGUAL   small " } });
    expect(screen.getByRole("status").textContent).toBe("1 of 3 models match");
    expect(screen.getByText("Whisper small")).toBeInTheDocument();
    expect(screen.queryByText("Whisper large")).not.toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onAction).not.toHaveBeenCalled();
  });
  it("combines search and hosting filters without selecting a route and resets an empty result", () => {
    const { onSelect, onAction } = setup();
    fireEvent.change(screen.getByLabelText("Search speech models"), { target: { value: "multilingual" } });
    fireEvent.change(screen.getByLabelText("Where audio runs"), { target: { value: "local" } });
    expect(screen.queryByText("Cloud speech")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("2 of 3 models match");
    fireEvent.change(screen.getByLabelText("Search speech models"), { target: { value: "no-such-model" } });
    expect(screen.getByText(/No models match/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("status").textContent).toBe("3 of 3 models match");
    expect(onSelect).not.toHaveBeenCalled();
    expect(onAction).not.toHaveBeenCalled();
  });

  it("keeps a selected broken model visible and repairable under the ready filter", () => {
    const { onAction } = setup({ activeRouteIds: { dictation: broken.routeId, meeting: null } });
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "ready" } });
    expect(screen.getByRole("status").textContent).toBe("2 of 3 models match");
    expect(screen.getAllByText("Whisper large")).toHaveLength(1);
    expect(screen.getByText("Selected models outside these filters")).toBeTruthy();
    const repair = screen.getByRole("button", { name: "Fix setup for Whisper large" });
    const card = repair.closest("div.rounded-md") as HTMLElement;
    expect(within(card).getByText("On disk")).toBeTruthy();
    expect(within(card).getByText("Needs setup")).toBeTruthy();
    fireEvent.click(repair);
    expect(onAction).toHaveBeenCalledWith(broken);
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.queryByText("Selected models outside these filters")).toBeNull();
    expect(screen.getAllByText("Whisper large")).toHaveLength(1);
  });

  it("offers download for a missing model despite provider readiness and prevents overlapping actions", () => {
    setup({ onDiskFor: () => false, busyRouteId: broken.routeId });
    expect((screen.getByRole("button", { name: "Download for Whisper small" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Working…")).toBeTruthy();
  });

  it("shows how far the busy download has got", () => {
    setup({ onDiskFor: () => false, busyRouteId: local.routeId, busyProgress: 41.6 });
    expect(screen.getByText("Downloading 42%")).toBeTruthy();
  });

  it("hides dictation-only routes when filtering for meetings", () => {
    setup({ routes: [local, route({ routeId: "whisper:tiny", label: "Tiny dictation", laneCompatibility: { dictation: true, meeting: false, shared: false } })] });
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "meeting" } });
    expect(screen.queryByText("Tiny dictation")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("1 of 2 models match");
  });
});
