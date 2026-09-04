export const ELECTRON_MODULE_ENTRY_AT = process.hrtime.bigint();

export const LAUNCH_MILESTONE_NAMES = [
  "electron-module-entry",
  "app-ready",
  "sidecar-spawned",
  "sidecar-first-response",
  "window-created",
  "did-finish-load",
  "renderer-first-contentful-paint",
  "renderer-post-commit-frame",
  "workspace-or-wizard-interactive",
] as const;

export type LaunchMilestoneName = (typeof LAUNCH_MILESTONE_NAMES)[number];

const RENDERER_LAUNCH_MILESTONES = new Set<LaunchMilestoneName>([
  "renderer-first-contentful-paint",
  "renderer-post-commit-frame",
  "workspace-or-wizard-interactive",
]);

export type RendererLaunchMilestone = {
  name: LaunchMilestoneName;
  rendererElapsedMs: number;
};

export type LaunchMilestone = {
  name: LaunchMilestoneName;
  elapsedMs: number;
  wallTimeMs: number;
  source: "main" | "renderer";
  rendererElapsedMs?: number;
};

export function parseRendererLaunchMilestone(value: unknown): RendererLaunchMilestone | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { name?: unknown; rendererElapsedMs?: unknown };
  if (
    typeof candidate.name !== "string" ||
    !RENDERER_LAUNCH_MILESTONES.has(candidate.name as LaunchMilestoneName) ||
    typeof candidate.rendererElapsedMs !== "number" ||
    !Number.isFinite(candidate.rendererElapsedMs) ||
    candidate.rendererElapsedMs < 0
  ) {
    return null;
  }
  return {
    name: candidate.name as LaunchMilestoneName,
    rendererElapsedMs: candidate.rendererElapsedMs,
  };
}

export function formatLaunchMilestone(milestone: LaunchMilestone): string {
  return `[launch-milestone] ${JSON.stringify(milestone)}`;
}
