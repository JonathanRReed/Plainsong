import { describe, expect, it } from "vitest";
import {
  buildAsrRouteCatalog,
  getLaneRoutes,
  getRecommendedLaneRoute,
} from "@/lib/asr-route-catalog";
import type { AsrProviderInfo } from "@/types";

const providers: AsrProviderInfo[] = [
  {
    providerType: "moonshine",
    name: "UsefulSensors Moonshine",
    description: "Fast local dictation",
    isAvailable: true,
    inferenceEnabled: true,
    modelInfo: {
      name: "Moonshine Base",
      version: "moonshine-base",
      sizeMb: 120,
      parameters: "base",
      languages: ["en"],
      license: "Apache-2.0",
      sourceUrl: "https://example.com/moonshine",
    },
    selectedModelId: "moonshine-base",
    modelOptions: [{ id: "moonshine-base", label: "Moonshine Base" }],
    downloadStatus: "Downloaded",
    runtimeStatus: "ready",
    runtimeDetails: {},
  },
  {
    providerType: "distil_whisper",
    name: "Distil-Whisper",
    description: "Balanced local route",
    isAvailable: true,
    inferenceEnabled: true,
    modelInfo: {
      name: "Distil Whisper",
      version: "distil-large-v3.5",
      sizeMb: 1530,
      parameters: "756M",
      languages: ["en"],
      license: "Apache-2.0",
      sourceUrl: "https://example.com/distil",
    },
    selectedModelId: "distil-large-v3.5",
    modelOptions: [{ id: "distil-large-v3.5", label: "Distil Whisper Large v3.5" }],
    downloadStatus: "Downloaded",
    runtimeStatus: "ready",
    runtimeDetails: {},
  },
  {
    providerType: "parakeet",
    name: "Parakeet",
    description: "Meeting-grade local route",
    isAvailable: true,
    inferenceEnabled: true,
    modelInfo: {
      name: "Parakeet",
      version: "parakeet-tdt-0.6b-v3",
      sizeMb: 2100,
      parameters: "0.6B",
      languages: ["en"],
      license: "NVIDIA Open Model License",
      sourceUrl: "https://example.com/parakeet",
    },
    selectedModelId: "parakeet-tdt-0.6b-v3",
    modelOptions: [
      { id: "parakeet-tdt-0.6b-v3", label: "Parakeet TDT 0.6B v3" },
      { id: "parakeet-ctc-1.1b", label: "Parakeet CTC 1.1B experimental" },
    ],
    downloadStatus: "Downloaded",
    runtimeStatus: "ready",
    runtimeDetails: {},
  },
  {
    providerType: "openai_cloud",
    name: "OpenAI Transcribe",
    description: "Cloud route",
    isAvailable: false,
    inferenceEnabled: true,
    modelInfo: {
      name: "OpenAI",
      version: "gpt-4o-mini-transcribe",
      sizeMb: 0,
      parameters: "managed",
      languages: ["en"],
      license: "OpenAI",
      sourceUrl: "https://example.com/openai",
    },
    selectedModelId: "gpt-4o-mini-transcribe",
    modelOptions: [
      { id: "gpt-4o-mini-transcribe", label: "GPT-4o mini transcribe" },
    ],
    downloadStatus: "Downloaded",
    runtimeStatus: "ready",
    runtimeDetails: {},
  },
];

describe("asr-route-catalog", () => {
  it("keeps dictation-only routes out of meeting selectors and promotes the current Parakeet release", () => {
    const routes = buildAsrRouteCatalog(providers, "prefer_local");
    const meetingRoutes = getLaneRoutes(routes, "meeting", "prefer_local");

    expect(meetingRoutes.some((route) => route.providerType === "moonshine")).toBe(false);
    expect(
      meetingRoutes.some(
        (route) =>
          route.providerType === "parakeet" &&
          route.modelId === "parakeet-tdt-0.6b-v3",
      ),
    ).toBe(true);
  });

  it("recommends the fastest local route for dictation when it is ready", () => {
    const routes = buildAsrRouteCatalog(providers, "prefer_local");
    const recommended = getRecommendedLaneRoute(routes, "dictation", "prefer_local");

    expect(recommended?.providerType).toBe("moonshine");
    expect(recommended?.modelId).toBe("moonshine-base");
  });

  it("marks missing cloud credentials as BYOK-required instead of generic failure", () => {
    const routes = buildAsrRouteCatalog(providers, "prefer_local");
    const openAiRoute = routes.find(
      (route) => route.providerType === "openai_cloud",
    );

    expect(openAiRoute?.readiness).toBe("requires_key");
    expect(openAiRoute?.actionLabel).toBe("Connect API key");
  });
});
