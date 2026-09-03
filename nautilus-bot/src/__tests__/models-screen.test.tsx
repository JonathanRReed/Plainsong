import { useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModelsScreen } from "@/components/models/models-screen";
import type { AsrProviderInventory } from "@/types";
import type { Settings } from "@/types/settings";
import type { ProductReadinessSnapshot } from "@/features/readiness/product-readiness";

const getAsrProviderInventoryMock = vi.fn();
const listDownloadedModelsMock = vi.fn();
const downloadAsrModelsMock = vi.fn();
const getBundledCleanupModelStatusMock = vi.fn();
const downloadBundledCleanupModelMock = vi.fn();
const deleteBundledCleanupModelMock = vi.fn();
const getAppleLanguageModelAvailabilityMock = vi.fn();
const installAppleSpeechLanguageMock = vi.fn();
const readinessContext = vi.hoisted(() => ({
  refresh: vi.fn(async () => {}),
  productReadiness: {
    evidenceObservedAt: 1,
    dictation: { domain: "dictation", state: "ready", cause: null },
    meetings: { domain: "meetings", state: "ready", cause: null },
    meetingsCapture: {
      domain: "meetings_capture",
      state: "ready",
      cause: null,
    },
    fullCapture: { domain: "full_capture", state: "ready", cause: null },
    overall: { domain: "overall", state: "ready", cause: null },
  } as ProductReadinessSnapshot,
}));

vi.mock("@/features/readiness/product-readiness-context", () => ({
  useProductReadinessStatus: () => readinessContext,
}));

vi.mock("@/lib/backend/asr", () => ({
  getAsrProviderInventory: () => getAsrProviderInventoryMock(),
  listDownloadedModels: () => listDownloadedModelsMock(),
  downloadAsrModels: (providerType: string, modelId: string) =>
    downloadAsrModelsMock(providerType, modelId),
}));

vi.mock("@/lib/backend/ai", () => ({
  getBundledCleanupModelStatus: () => getBundledCleanupModelStatusMock(),
  downloadBundledCleanupModel: () => downloadBundledCleanupModelMock(),
  deleteBundledCleanupModel: () => deleteBundledCleanupModelMock(),
  getAppleLanguageModelAvailability: (refresh: boolean) =>
    getAppleLanguageModelAvailabilityMock(refresh),
}));

vi.mock("@/lib/backend/settings", () => ({
  installAppleSpeechLanguage: (locale?: string) =>
    installAppleSpeechLanguageMock(locale),
}));

vi.mock("@/lib/electron", () => ({
  listen: vi.fn(async () => () => {}),
}));

/**
 * An Apple Speech readiness that runs SpeechAnalyzer: macOS 26+, the language
 * supported and its assets on disk. That is the only configuration in which
 * the route returns per-segment timestamps, which is what the meeting lane is
 * assembled from.
 */
const SPEECH_ANALYZER_READINESS = {
  status: "ready",
  ready: true,
  platformSupported: true,
  helperPresent: true,
  authorization: "authorized",
  locale: "en_US",
  localeSupported: true,
  onDeviceAvailable: true,
  recognizerAvailable: true,
  message: "Apple Speech is ready.",
  setupAction: null,
  speechAnalyzerAvailable: true,
  speechAnalyzerLocaleSupported: true,
  speechAnalyzerAssetsInstalled: true,
  speechAnalyzerAssetStatus: "installed",
  speechAnalyzerLocales: ["en_US", "fr_FR"],
  speechAnalyzerInstalledLocales: ["en_US"],
  engine: "speech_analyzer",
  operatingSystemVersion: "27.0.0",
};

const BUNDLED_STATUS = {
  provider: "bundled_local",
  modelId: "s1-mini",
  displayName: "S1-mini",
  vendor: "Superwhisper",
  downloadBytes: 495_654_965,
  bytesOnDisk: 0,
  ready: false,
  missingFiles: ["s1-mini-q4_k_m.gguf"],
  path: "/models/bundled_cleanup",
  backend: "metal",
  backendMeetsBudget: true,
  backendPresent: true,
  residentBytes: 484_219_808,
};

const APPLE_AVAILABILITY = {
  provider: "apple_language_model",
  displayName: "Apple on-device model",
  available: false,
  reason: "apple_intelligence_not_enabled",
  detail:
    "Apple Intelligence is turned off. Turn it on in System Settings to use the Apple on-device model.",
  operatingSystemVersion: "27.0.0",
};

const WHISPER_MODEL_OPTIONS = [
  { id: "tiny", label: "tiny (fastest)" },
  { id: "tiny.en", label: "tiny.en (fastest, English)" },
  { id: "base", label: "base (balanced)" },
  { id: "base.en", label: "base.en (balanced, English)" },
  { id: "small", label: "small (better accuracy)" },
  { id: "small.en", label: "small.en (better accuracy, English)" },
  { id: "medium", label: "medium (high accuracy)" },
  { id: "medium.en", label: "medium.en (high accuracy, English)" },
  { id: "large-v3-turbo", label: "large-v3-turbo (fast + accurate)" },
  { id: "large-v3", label: "large-v3 (best accuracy)" },
];

function inventoryFixture(
  overrides: Partial<Record<string, Partial<AsrProviderInventory>>> = {},
): AsrProviderInventory[] {
  const base = [
    {
      providerType: "whisper",
      name: "Whisper",
      description: "Local Whisper",
      isAvailable: true,
      inferenceEnabled: true,
      selectedModelId: "base.en",
      modelOptions: WHISPER_MODEL_OPTIONS,
      downloadStatus: "Downloaded",
    },
    {
      providerType: "parakeet",
      name: "Parakeet",
      description: "Local Parakeet",
      isAvailable: true,
      inferenceEnabled: true,
      selectedModelId: "parakeet-tdt-0.6b-v3",
      modelOptions: [
        { id: "parakeet-tdt-0.6b-v3", label: "Parakeet TDT 0.6B v3" },
        { id: "parakeet-tdt-ctc-110m", label: "Parakeet TDT CTC 110M legacy" },
      ],
      downloadStatus: "NotDownloaded",
    },
    {
      providerType: "distil_whisper",
      name: "Distil-Whisper",
      description: "Local Distil",
      isAvailable: true,
      inferenceEnabled: true,
      selectedModelId: "distil-large-v3.5",
      modelOptions: [
        { id: "distil-large-v3.5", label: "Distil Whisper Large v3.5" },
      ],
      downloadStatus: "Downloaded",
    },
    {
      providerType: "macos_apple_speech",
      name: "Apple Speech (On-Device)",
      description: "Dictation-only Apple Speech",
      isAvailable: true,
      inferenceEnabled: true,
      selectedModelId: "macos_apple_speech",
      modelOptions: [
        { id: "macos_apple_speech", label: "Apple Speech · on-device dictation" },
      ],
      downloadStatus: "Downloaded",
      platformReadiness: {
        status: "ready",
        ready: true,
        platformSupported: true,
        helperPresent: true,
        authorization: "authorized",
        locale: "en_US",
        localeSupported: true,
        onDeviceAvailable: true,
        recognizerAvailable: true,
        message: "Apple Speech is ready.",
        setupAction: null,
      },
    },
  ] as unknown as AsrProviderInventory[];

  return base.map((provider) => ({
    ...provider,
    ...(overrides[provider.providerType] ?? {}),
  })) as AsrProviderInventory[];
}

function settingsFixture(): Settings {
  return {
    transcription: {
      defaultProvider: "distil_whisper",
      selectedModelId: "distil-large-v3.5",
      useSharedAsrSelection: true,
      dictationProvider: "distil_whisper",
      dictationModelId: "distil-large-v3.5",
      meetingProvider: "distil_whisper",
      meetingModelId: "distil-large-v3.5",
      meetingRoutePolicy: "prefer_local",
    },
    privacy: {
      remoteProcessingEnabled: false,
      dictationAi: { provider: "ollama", modelId: "llama3.2" },
      meetingsAi: { provider: "ollama", modelId: "llama3.2" },
    },
  } as unknown as Settings;
}

const savedSettings: Settings[] = [];

/**
 * The screen is controlled: it hands a patch back and the owner applies it to
 * the newest settings. The harness mirrors that, so a test can click a preset
 * and then read what the screen says about the settings it produced.
 */
function Harness({ initial }: { initial?: Settings }) {
  const [settings, setSettings] = useState<Settings>(
    () => initial ?? settingsFixture(),
  );

  return (
    <ModelsScreen
      settings={settings}
      onPatchSettings={(apply) =>
        setSettings((previous) => {
          const next = apply(previous);
          savedSettings.push(next);
          return next;
        })
      }
      aiModelsForProvider={(provider) =>
        provider === "ollama" ? ["llama3.2"] : []
      }
      aiModelsLoading={false}
      onAiProviderChange={vi.fn()}
      onAiModelChange={vi.fn()}
      onOpenKeySettings={vi.fn()}
      onOpenDiagnostics={vi.fn()}
    />
  );
}

function lastSaved(): Settings {
  const latest = savedSettings[savedSettings.length - 1];
  if (!latest) {
    throw new Error("No settings patch was applied");
  }
  return latest;
}

describe("Models screen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readinessContext.refresh.mockResolvedValue(undefined);
    savedSettings.length = 0;
    readinessContext.productReadiness = {
      evidenceObservedAt: 1,
      dictation: { domain: "dictation", state: "ready", cause: null },
      meetings: { domain: "meetings", state: "ready", cause: null },
      meetingsCapture: {
        domain: "meetings_capture",
        state: "ready",
        cause: null,
      },
      fullCapture: { domain: "full_capture", state: "ready", cause: null },
      overall: { domain: "overall", state: "ready", cause: null },
    };
    getAsrProviderInventoryMock.mockResolvedValue(inventoryFixture());
    listDownloadedModelsMock.mockResolvedValue([
      {
        name: "Whisper ggml-base.en.bin",
        provider: "whisper",
        path: "/models/whisper/ggml-base.en.bin",
        sizeBytes: 148_000_000,
      },
    ]);
    downloadAsrModelsMock.mockResolvedValue(undefined);
    getBundledCleanupModelStatusMock.mockResolvedValue(BUNDLED_STATUS);
    downloadBundledCleanupModelMock.mockResolvedValue({
      ...BUNDLED_STATUS,
      ready: true,
      bytesOnDisk: 495_654_965,
      missingFiles: [],
    });
    deleteBundledCleanupModelMock.mockResolvedValue(BUNDLED_STATUS);
    getAppleLanguageModelAvailabilityMock.mockResolvedValue(APPLE_AVAILABILITY);
    installAppleSpeechLanguageMock.mockResolvedValue({
      install: {
        locale: "en_US",
        installed: true,
        assetStatus: "installed",
        engine: "speech_analyzer",
      },
      readiness: SPEECH_ANALYZER_READINESS,
      notes: [],
    });
  });

  it("never offers a dictation-only provider for meeting notes", async () => {
    // Both on-device providers refuse meeting work in the sidecar. Offering
    // them here would only be a way to choose a guaranteed failure.
    render(<Harness />);

    const meetingsPicker = (await screen.findByLabelText(
      "Who writes summaries, answers, and actions",
    )) as HTMLSelectElement;
    const values = [...meetingsPicker.options].map((option) => option.value);
    expect(values).not.toContain("bundled_local");
    expect(values).not.toContain("apple_language_model");

    const dictationPicker = screen.getByLabelText(
      "Who cleans up dictation",
    ) as HTMLSelectElement;
    expect([...dictationPicker.options].map((option) => option.value)).toContain(
      "bundled_local",
    );
  });

  it("offers the built-in model's download, with its size and what it cannot do", async () => {
    const settings = settingsFixture();
    settings.privacy.dictationAi = { provider: "bundled_local", modelId: null };
    render(<Harness initial={settings} />);

    const row = await screen.findByRole("region", {
      name: "Built-in dictation cleanup model",
    });
    expect(row.textContent).toContain("S1-mini by Superwhisper");
    expect(row.textContent).toContain("473 MiB to download");
    expect(row.textContent).toContain("does not summarize");

    fireEvent.click(within(row).getByRole("button", { name: "Download" }));
    await waitFor(() =>
      expect(downloadBundledCleanupModelMock).toHaveBeenCalledTimes(1),
    );
    await waitFor(() =>
      expect(within(row).getByRole("button", { name: "Delete" })).toBeTruthy(),
    );
  });

  it("says why Apple's on-device model is unavailable rather than only that it is", async () => {
    const settings = settingsFixture();
    settings.privacy.dictationAi = {
      provider: "apple_language_model",
      modelId: null,
    };
    render(<Harness initial={settings} />);

    const row = await screen.findByRole("region", {
      name: "Apple on-device model",
    });
    await waitFor(() =>
      expect(row.textContent).toContain("Apple Intelligence is turned off"),
    );

    fireEvent.click(within(row).getByRole("button", { name: "Check again" }));
    await waitFor(() =>
      expect(getAppleLanguageModelAvailabilityMock).toHaveBeenCalledWith(true),
    );
  });

  it("shows one row per task and a measured disk total", async () => {
    render(<Harness />);

    expect(await screen.findByText("Speech for dictation")).toBeInTheDocument();
    expect(screen.getByText("Speech for meetings")).toBeInTheDocument();
    expect(screen.getByText("Who cleans up dictation")).toBeInTheDocument();
    expect(
      screen.getByText("Who writes summaries, answers, and actions"),
    ).toBeInTheDocument();

    // 148,000,000 bytes measured off the one file on disk.
    expect(
      screen.getByText(/Speech models on this Mac: 141 MiB across 1 file\./),
    ).toBeInTheDocument();
  });

  it("surfaces the canonical selected-route blocker above the model controls", async () => {
    readinessContext.productReadiness = {
      ...readinessContext.productReadiness,
      dictation: {
        domain: "dictation",
        state: "blocked",
        cause: {
          id: "dictation_route",
          message: "Whisper model exists but failed to initialize.",
          action: {
            id: "open_models",
            label: "Review models",
            destination: "models",
          },
        },
      },
      overall: {
        domain: "overall",
        state: "blocked",
        cause: {
          id: "dictation_route",
          message: "Whisper model exists but failed to initialize.",
          action: {
            id: "open_models",
            label: "Review models",
            destination: "models",
          },
        },
      },
    };

    const initial = settingsFixture();
    initial.transcription = {
      ...initial.transcription,
      useSharedAsrSelection: false,
      dictationProvider: "whisper",
      dictationModelId: "base.en",
    };

    render(<Harness initial={initial} />);

    expect(
      await screen.findByRole("alert", {
        name: "Selected speech route needs attention",
      }),
    ).toHaveTextContent("Whisper model exists but failed to initialize.");
    const dictationLane = screen.getByRole("region", {
      name: "Speech for dictation",
    });
    expect(within(dictationLane).getByText("Needs attention")).toBeInTheDocument();
    expect(within(dictationLane).queryByText("Ready")).not.toBeInTheDocument();
    expect(
      within(dictationLane).getByRole("button", {
        name: "Review diagnostics",
      }),
    ).toBeInTheDocument();
  });

  it("applies a preset to every lane and then names it", async () => {
    render(<Harness />);
    const presets = await screen.findByRole("radiogroup", {
      name: "Model preset",
    });

    fireEvent.click(within(presets).getByRole("radio", { name: /Light/ }));

    await waitFor(() => {
      expect(lastSaved().transcription.dictationModelId).toBe("base.en");
    });
    const saved = lastSaved();
    expect(saved.transcription.dictationProvider).toBe("whisper");
    expect(saved.transcription.meetingProvider).toBe("parakeet");
    expect(saved.transcription.useSharedAsrSelection).toBe(false);
    expect(saved.privacy.dictationAi.provider).toBe("ollama");

    // The indicator names the preset, and the tile is checked.
    expect(screen.getByText(/^Active preset/).textContent).toContain("Light");
    expect(
      within(presets).getByRole("radio", { name: /Light/ }),
    ).toHaveAttribute("aria-checked", "true");
  });

  it("moves the preset indicator to Custom when one lane is changed", async () => {
    render(<Harness />);
    const presets = await screen.findByRole("radiogroup", {
      name: "Model preset",
    });
    fireEvent.click(within(presets).getByRole("radio", { name: /Balanced/ }));

    await waitFor(() => {
      expect(screen.getByText(/^Active preset/).textContent).toContain(
        "Balanced",
      );
    });

    // Distil is not a promoted route, so the change comes from the drawer --
    // which is also how a lane gets a model the main list never offers.
    fireEvent.click(screen.getByRole("button", { name: /Show \d+ more models/ }));
    const drawer = screen.getByRole("region", { name: "More models" });
    const distilRow = within(drawer)
      .getByText("Distil Whisper Large v3.5")
      .closest("div")?.parentElement as HTMLElement;
    fireEvent.click(
      within(distilRow).getByRole("button", { name: "Use for meetings" }),
    );

    await waitFor(() => {
      expect(screen.getByText(/^Active preset/).textContent).toContain("Custom");
    });
  });

  it("leaves the AI lanes alone when a preset is applied", async () => {
    // The preset tiles talk about speech. Applying one used to rewrite both AI
    // lanes to the preset's provider, so a deliberate cloud setup -- provider
    // and model id -- disappeared on a click, and the replacement pointed at
    // whatever the new provider had listed first, or at nothing.
    const cloudAi = {
      ...settingsFixture(),
      privacy: {
        ...settingsFixture().privacy,
        dictationAi: { provider: "anthropic", modelId: "claude-x" },
        meetingsAi: { provider: "openai", modelId: "gpt-x" },
      },
    } as unknown as Settings;

    render(<Harness initial={cloudAi} />);
    const presets = await screen.findByRole("radiogroup", {
      name: "Model preset",
    });

    fireEvent.click(within(presets).getByRole("radio", { name: /Balanced/ }));

    await waitFor(() => {
      expect(lastSaved().transcription.dictationProvider).toBe("parakeet");
    });
    const saved = lastSaved();
    expect(saved.privacy.dictationAi).toEqual({
      provider: "anthropic",
      modelId: "claude-x",
    });
    expect(saved.privacy.meetingsAi).toEqual({
      provider: "openai",
      modelId: "gpt-x",
    });

    // And the tile still names itself, rather than reading Custom because of
    // two lanes it never claimed to set.
    expect(screen.getByText(/^Active preset/).textContent).toContain("Balanced");
  });

  it("does not call a lane ready when that lane's model is missing", async () => {
    // The provider carries one download status for every build it lists, and
    // the sidecar keeps one model per provider. Point the two lanes at two
    // Parakeet builds and the provider's answer is right for one of them.
    getAsrProviderInventoryMock.mockResolvedValue(
      inventoryFixture({
        parakeet: { downloadStatus: "Downloaded" } as Partial<AsrProviderInventory>,
      }),
    );
    listDownloadedModelsMock.mockResolvedValue([
      {
        name: "Whisper ggml-base.en.bin",
        provider: "whisper",
        path: "/models/whisper/ggml-base.en.bin",
        sizeBytes: 148_000_000,
      },
      {
        name: "Parakeet encoder.int8.onnx",
        provider: "parakeet",
        path: "/models/parakeet/parakeet-tdt-0.6b-v3/encoder.int8.onnx",
        sizeBytes: 652_000_000,
      },
    ]);

    render(<Harness />);
    const presets = await screen.findByRole("radiogroup", {
      name: "Model preset",
    });
    fireEvent.click(within(presets).getByRole("radio", { name: /Balanced/ }));
    await waitFor(() => {
      expect(screen.getByText(/^Active preset/).textContent).toContain(
        "Balanced",
      );
    });

    // Move dictation onto the 110M build, which is not on disk. Meetings stay
    // on v3, which is.
    fireEvent.click(screen.getByRole("button", { name: /Show \d+ more models/ }));
    const drawer = screen.getByRole("region", { name: "More models" });
    const legacyRow = within(drawer)
      .getByText("Parakeet TDT CTC 110M legacy")
      .closest("div")?.parentElement as HTMLElement;
    fireEvent.click(
      within(legacyRow).getByRole("button", { name: "Use for dictation" }),
    );

    const dictation = await screen.findByRole("region", {
      name: "Speech for dictation",
    });
    await waitFor(() => {
      expect(within(dictation).getByText("Needs download")).toBeInTheDocument();
    });
    expect(within(dictation).queryByText("Ready")).toBeNull();

    // The action the brief requires, and it actually downloads.
    fireEvent.click(within(dictation).getByRole("button", { name: "Download" }));
    await waitFor(() => {
      expect(downloadAsrModelsMock).toHaveBeenCalledWith(
        "parakeet",
        "parakeet-tdt-ctc-110m"
      );
    });

    // The other half of the same contradiction: the meeting lane's model is
    // measurably here, so it must not be told to download it again.
    const meetings = screen.getByRole("region", { name: "Speech for meetings" });
    expect(within(meetings).getByText("Ready")).toBeInTheDocument();
    expect(
      within(meetings).queryByRole("button", { name: "Download" }),
    ).toBeNull();
  });

  it("surfaces the download the chosen model still needs, and runs it", async () => {
    render(<Harness />);
    const meetings = await screen.findByRole("region", {
      name: "Speech for meetings",
    });

    fireEvent.click(
      within(meetings).getByRole("radio", { name: /Parakeet TDT 0\.6B v3/ }),
    );

    const meetingsRow = await screen.findByRole("region", {
      name: "Speech for meetings",
    });
    await waitFor(() => {
      expect(within(meetingsRow).getByText("Needs download")).toBeInTheDocument();
    });

    fireEvent.click(within(meetingsRow).getByRole("button", { name: "Download" }));

    await waitFor(() => {
      expect(downloadAsrModelsMock).toHaveBeenCalledWith(
        "parakeet",
        "parakeet-tdt-0.6b-v3"
      );
    });
  });

  it("never offers a dictation-only engine for meetings", async () => {
    render(<Harness />);
    const meetings = await screen.findByRole("region", {
      name: "Speech for meetings",
    });

    const options = within(meetings).getAllByRole("radio");
    // The route's own name, not the whole card: a card's fact sentence may
    // legitimately name another model to give a size or speed comparison
    // ("about eleven times the size of base.en"), and matching on the card
    // text read that as an offer of base.en.
    const names = options.map(
      (option) => option.querySelector("span > span")?.textContent ?? "",
    );

    // Positive first, and exhaustive. A `?? ""` fallback means a selector that
    // stops matching the name element yields a list of empty strings, and a
    // suite that only asks "does any name contain base.en" passes on that
    // happily while checking nothing at all. Naming every option the lane
    // offers makes the list itself the assertion.
    expect(names).toEqual([
      "large-v3-turbo (fast + accurate)",
      "Distil Whisper Large v3.5",
      "Parakeet TDT 0.6B v3",
    ]);
    expect(names.every((name) => name.trim().length > 0)).toBe(true);

    // And then the exclusions the list above already implies, spelled out so a
    // future addition to the fixture cannot quietly bring one back.
    expect(names.some((name) => name.includes("base.en"))).toBe(false);
    expect(names.some((name) => name.includes("Apple Speech"))).toBe(false);
    expect(names.some((name) => name.includes("Parakeet TDT 0.6B v3"))).toBe(
      true,
    );
    // whisper.cpp reaches this lane only through a multilingual model.
    expect(names.some((name) => name.includes("large-v3-turbo"))).toBe(true);
  });

  /** Apple Speech is not a promoted route, so its row lives in the drawer. */
  function appleSpeechDrawerRow(): HTMLElement {
    fireEvent.click(screen.getByRole("button", { name: /Show \d+ more models/ }));
    const drawer = screen.getByRole("region", { name: "More models" });
    const label = within(drawer).getByText("Apple Speech · on-device dictation");
    return label.closest("div.rounded-md") as HTMLElement;
  }

  it("offers Apple Speech for meetings once SpeechAnalyzer is the engine that runs", async () => {
    getAsrProviderInventoryMock.mockResolvedValue(
      inventoryFixture({
        macos_apple_speech: {
          platformReadiness: SPEECH_ANALYZER_READINESS,
        } as Partial<AsrProviderInventory>,
      }),
    );

    render(<Harness />);
    await screen.findByRole("region", { name: "Speech for dictation" });
    const row = appleSpeechDrawerRow();

    expect(
      within(row).getByRole("button", { name: "Use for meetings" }),
    ).toBeEnabled();
    expect(within(row).queryByText(/Dictation only/)).toBeNull();
  });

  it("still keeps Apple Speech out of meetings when it runs SFSpeechRecognizer", async () => {
    getAsrProviderInventoryMock.mockResolvedValue(
      inventoryFixture({
        macos_apple_speech: {
          platformReadiness: {
            ...SPEECH_ANALYZER_READINESS,
            speechAnalyzerAvailable: false,
            speechAnalyzerLocaleSupported: false,
            speechAnalyzerAssetsInstalled: false,
            speechAnalyzerAssetStatus: "unavailable",
            engine: "sf_speech_recognizer",
            operatingSystemVersion: "15.5.0",
          },
        } as Partial<AsrProviderInventory>,
      }),
    );

    render(<Harness />);
    const meetings = await screen.findByRole("region", {
      name: "Speech for meetings",
    });
    const names = within(meetings)
      .getAllByRole("radio")
      .map((option) => option.querySelector("span > span")?.textContent ?? "");
    expect(names.some((name) => name.includes("Apple Speech"))).toBe(false);

    const row = appleSpeechDrawerRow();
    expect(
      within(row).queryByRole("button", { name: "Use for meetings" }),
    ).toBeNull();
    expect(within(row).getByText(/Dictation only/)).toBeInTheDocument();
  });

  it("offers the language install when SpeechAnalyzer is there but its assets are not", async () => {
    getAsrProviderInventoryMock.mockResolvedValue(
      inventoryFixture({
        macos_apple_speech: {
          platformReadiness: {
            ...SPEECH_ANALYZER_READINESS,
            speechAnalyzerAssetsInstalled: false,
            speechAnalyzerAssetStatus: "supported",
            speechAnalyzerInstalledLocales: [],
            engine: "sf_speech_recognizer",
          },
        } as Partial<AsrProviderInventory>,
      }),
    );

    render(<Harness />);
    await screen.findByRole("region", { name: "Speech for dictation" });
    // Point the dictation lane at Apple Speech so its header is the one that
    // answers for the route.
    fireEvent.click(
      within(appleSpeechDrawerRow()).getByRole("button", {
        name: "Use for dictation",
      }),
    );

    const dictation = await screen.findByRole("region", {
      name: "Speech for dictation",
    });
    const installButton = await within(dictation).findByRole("button", {
      name: "Install language",
    });
    fireEvent.click(installButton);

    await waitFor(() =>
      expect(installAppleSpeechLanguageMock).toHaveBeenCalledTimes(1),
    );
  });

  it("keeps an engine whose permission was denied visible but unpickable", async () => {
    getAsrProviderInventoryMock.mockResolvedValue(
      inventoryFixture({
        macos_apple_speech: {
          isAvailable: false,
          platformReadiness: {
            status: "authorization_denied",
            ready: false,
            platformSupported: true,
            helperPresent: true,
            authorization: "denied",
            locale: "en_US",
            localeSupported: true,
            onDeviceAvailable: true,
            recognizerAvailable: true,
            message: "Speech Recognition permission is denied.",
            setupAction: "Open Speech Settings.",
          },
        } as Partial<AsrProviderInventory>,
      }),
    );

    render(<Harness />);
    const dictation = await screen.findByRole("region", {
      name: "Speech for dictation",
    });

    // Apple Speech is not a promoted route, so it lives in the drawer.
    fireEvent.click(screen.getByRole("button", { name: /Show \d+ more models/ }));
    const drawer = screen.getByRole("region", { name: "More models" });
    const appleRow = within(drawer)
      .getByText("Apple Speech · on-device dictation")
      .closest("div") as HTMLElement;
    const useForDictation = within(
      appleRow.parentElement as HTMLElement,
    ).getByRole("button", { name: "Use for dictation" });
    expect(useForDictation).toBeDisabled();
    expect(within(dictation).queryByText("Permission denied")).toBeNull();
    expect(within(drawer).getByText("Permission denied")).toBeInTheDocument();
  });

  it("keeps the rest of the catalogue collapsed until asked", async () => {
    render(<Harness />);
    await screen.findByText("Speech for dictation");

    expect(screen.queryByText("tiny (fastest)")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Show \d+ more models/ }));
    const drawer = screen.getByRole("region", { name: "More models" });

    for (const label of [
      "tiny (fastest)",
      "tiny.en (fastest, English)",
      "base (balanced)",
      "small (better accuracy)",
      "small.en (better accuracy, English)",
      "medium (high accuracy)",
      "medium.en (high accuracy, English)",
      "large-v3 (best accuracy)",
    ]) {
      expect(within(drawer).getByText(label)).toBeInTheDocument();
    }

    // The promoted three stay in the main list rather than being repeated here.
    expect(
      within(drawer).queryByText("base.en (balanced, English)"),
    ).not.toBeInTheDocument();
    expect(
      within(drawer).queryByText("large-v3-turbo (fast + accurate)"),
    ).not.toBeInTheDocument();
    expect(
      within(drawer).queryByText("Parakeet TDT 0.6B v3"),
    ).not.toBeInTheDocument();
  });

  it("says the engine list could not be read instead of inventing lanes", async () => {
    getAsrProviderInventoryMock.mockResolvedValue([]);

    render(<Harness />);

    expect(
      await screen.findByText(/Could not read the speech engines from the sidecar/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Speech for dictation" }),
    ).not.toBeInTheDocument();
    // The AI lanes do not depend on the speech inventory, so they stay usable.
    expect(screen.getByText("Who cleans up dictation")).toBeInTheDocument();
  });

  it("states size, languages and the downside for a promoted model", async () => {
    render(<Harness />);
    const dictation = await screen.findByRole("region", {
      name: "Speech for dictation",
    });

    expect(
      within(dictation).getByText(
        /142 MiB, English only; English verified in Plainsong; speak Spanish or German into it/,
      ),
    ).toBeInTheDocument();
    expect(
      within(dictation).getByText(
        /1\.6 GiB, ~100 languages listed upstream; not yet qualified across the full set in Plainsong; about eleven times the size of base\.en/,
      ),
    ).toBeInTheDocument();
    expect(
      within(dictation).getByText(
        /639 MiB, 25 European languages listed upstream; English verified in Plainsong/,
      ),
    ).toBeInTheDocument();
  });
});
