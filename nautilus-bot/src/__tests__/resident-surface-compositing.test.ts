import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Surfaces that stay mounted while Plainsong idles with its window open, or
// while a meeting runs. A CSS backdrop filter on any of them gives the GPU
// process its own render pass and blur textures for as long as it is on
// screen: about 40 MiB of the 8 GB Mac's 300 MiB idle budget in the packaged
// footprint gate (candidate-b12/idle-gpu). Over the app's flat or gently
// graded backgrounds the blur changed no pixel by more than one level.
const RESIDENT_SURFACES = [
  "src/components/sidebar.tsx",
  "src/components/ui/page-header.tsx",
  "src/components/popups/recording-popup.tsx",
];

describe("resident surface compositing", () => {
  it.each(RESIDENT_SURFACES)("%s uses no backdrop filter", (file) => {
    const source = readFileSync(file, "utf8");
    expect(source).not.toMatch(/backdrop-blur|backdrop-filter|backdrop-saturate/);
  });
});
