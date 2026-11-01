import userEvent from "@testing-library/user-event";
import { StrictMode, useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModelsScreen } from "@/components/models/models-screen";
import type { AsrProviderInventory } from "@/types";
import type { Settings } from "@/types/settings";
import type { ProductReadinessSnapshot } from "@/features/readiness/product-readiness";
import { invoke } from "@/lib/electron";

const getAsrProviderInventoryMock = vi.fn();
const listDownloadedModelsMock = vi.fn();
const downloadAsrModelsMock = vi.fn();
const getBundledCleanupModelStatusMock = vi.fn();
const downloadBundledCleanupModelMock = vi.fn();
const deleteBundledCleanupModelMock = vi.fn();
const getAppleLanguageModelAvailabilityMock = vi.fn();
const getLivePreviewEngineStatusMock = vi.fn();
const downloadLivePreviewEngineModelMock = vi.fn();
const deleteLivePreviewEngineModelMock = vi.fn();
const installAppleSpeechLanguageMock = vi.fn();
const cancelAppleSpeechLanguageInstallMock = vi.fn();
const listOllamaModelCatalogMock = vi.fn();
const getCuratedOllamaModelCatalogMock = vi.fn();
const installOllamaModelMock = vi.fn();
const cancelOllamaModelInstallMock = vi.fn();
const listenMock = vi.hoisted(() => vi.fn(async (_event: string, _callback: (payload: unknown) => void) => () => {}));
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

const deleteModelFileMock = vi.hoisted(() => vi.fn(async (_path: string) => {}));
vi.mock("@/lib/backend/asr", () => ({
  deleteModelFile: (path: string) => deleteModelFileMock(path),
  refreshAsrRuntimeProbes: vi.fn(async () => {}),
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
  getLivePreviewEngineStatus: () => getLivePreviewEngineStatusMock(),
  downloadLivePreviewEngineModel: () => downloadLivePreviewEngineModelMock(),
  deleteLivePreviewEngineModel: () => deleteLivePreviewEngineModelMock(),
  listOllamaModelCatalog: () => listOllamaModelCatalogMock(),
  getCuratedOllamaModelCatalog: () => getCuratedOllamaModelCatalogMock(),
  installOllamaModel: (modelId: string, acceptedLicense: boolean) => installOllamaModelMock(modelId, acceptedLicense),
  cancelOllamaModelInstall: () => cancelOllamaModelInstallMock(),
}));

/** A build with the streaming engine compiled in, weights not yet fetched. */
const LIVE_PREVIEW_STATUS = {
  supported: true,
  ready: false,
  modelId: "nemotron-3.5-asr-streaming-0.6b-q8_0",
  displayName: "Nemotron 3.5 ASR Streaming 0.6B (GGUF Q8_0)",
  engineName: "Nemotron 3.5 ASR Streaming via transcribe.cpp",
  license: "OpenMDW-1.1",
  upstreamUrl: "https://example.invalid/nemotron",
  downloadBytes: 751_094_240,
  bytesOnDisk: 0,
  languages: ["en", "es", "fr"],
  chunkMs: 560,
  path: "/models/transcribe_cpp/nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf",
};
vi.mock("@/lib/backend/settings", () => ({
  installAppleSpeechLanguage: (locale?: string) =>
    installAppleSpeechLanguageMock(locale),
  cancelAppleSpeechLanguageInstall: () => cancelAppleSpeechLanguageInstallMock(),
}));

vi.mock("@/lib/electron", () => ({
  invoke: vi.fn(async (command: string) => {
    if (command === "chatgpt_get_status") {
      return {
        loaded: false,
        modelsReady: false,
        accounts: [],
        models: [],
      };
    }
    return undefined;
  }),
  listen: listenMock,
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
  { id: "tiny", label: "Whisper Tiny" },
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
        { id: "parakeet-tdt-ctc-110m", label: "Parakeet 110M (older, English)" },
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
        { id: "distil-large-v3.5", label: "Distil-Whisper Large (English)" },
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
        { id: "macos_apple_speech", label: "Apple Speech" },
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
      onAiModelsRefresh={vi.fn()}
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
    getLivePreviewEngineStatusMock.mockResolvedValue(LIVE_PREVIEW_STATUS);
    downloadLivePreviewEngineModelMock.mockResolvedValue({
      ...LIVE_PREVIEW_STATUS,
      ready: true,
      bytesOnDisk: 751_094_240,
    });
    deleteLivePreviewEngineModelMock.mockResolvedValue(LIVE_PREVIEW_STATUS);
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
    cancelAppleSpeechLanguageInstallMock.mockResolvedValue(undefined);
    listOllamaModelCatalogMock.mockResolvedValue([]);
    getCuratedOllamaModelCatalogMock.mockResolvedValue([]);
    installOllamaModelMock.mockResolvedValue(undefined);
    cancelOllamaModelInstallMock.mockResolvedValue({ cancelled: true });
  });

  it("shows curated uninstalled Ollama models and requires Meta license acceptance", async () => {
    listOllamaModelCatalogMock.mockResolvedValue([
      { id: "llama3.2:3b", displayName: "Llama 3.2 3B", provider: "Meta via Ollama", diskSizeBytes: 2_019_392_628, contextTokens: 131072, minimumMemoryBytes: 4294967296, recommendedMemoryBytes: 8589934592, license: "Llama 3.2 Community License", disclosure: "Installing means you accept the Llama 3.2 Community License and Acceptable Use Policy.", lanes: ["dictation", "meetings"], expectedManifestDigest: "sha256:expected", installed: false, installedDigest: null, installedSizeBytes: null, ready: false },
      { id: "gpt-oss:20b", displayName: "GPT-OSS 20B", provider: "OpenAI via Ollama", diskSizeBytes: 13_793_440_755, contextTokens: 131072, minimumMemoryBytes: 17179869184, recommendedMemoryBytes: 25769803776, license: "Apache-2.0", disclosure: null, lanes: ["meetings"], expectedManifestDigest: "sha256:expected", installed: false, installedDigest: null, installedSizeBytes: null, ready: false },
    ]);
    render(<Harness />);
    expect(await screen.findByText("Llama 3.2 3B")).toBeInTheDocument();
    expect(screen.getByText(/2\.0 GB/)).toBeInTheDocument();
    const row = screen.getByText("Llama 3.2 3B").closest("div.rounded-md") as HTMLElement;
    const install = within(row).getByRole("button", { name: "Install" });
    expect(install).toBeDisabled();
    fireEvent.click(within(row).getByRole("checkbox"));
    fireEvent.click(install);
    await waitFor(() => expect(installOllamaModelMock).toHaveBeenCalledWith("llama3.2:3b", true));
  });

  it("shows the exact AI route pause in Models", async () => {
    const message = "An earlier Ollama request may still be running. Local processing is paused.";
    readinessContext.productReadiness.overall = { domain: "overall", state: "degraded", cause: {
      id: "ai_route", message, action: { id: "open_ai_settings", label: "Review AI & Keys", destination: "ai" },
    } };
    render(<Harness />);
    expect(await screen.findByRole("alert", { name: "Your AI model needs attention" })).toHaveTextContent(message);
  });

  it("shows memory and quality disclosures for an installed non-Meta model", async () => {
    listOllamaModelCatalogMock.mockResolvedValue([
      { id: "qwen3.8:27b-q4_K_M", displayName: "Qwen3.8 27B", provider: "Qwen via Ollama", diskSizeBytes: 17_741_872_132, contextTokens: 262144, minimumMemoryBytes: 24 * 1024 ** 3, recommendedMemoryBytes: 32 * 1024 ** 3, license: "Apache-2.0", disclosure: "Quality is not yet qualified. 32 GB or more memory is recommended.", lanes: ["meetings"], expectedManifestDigest: "sha256:expected", installed: true, installedDigest: "sha256:expected", installedSizeBytes: 17_741_872_132, ready: true },
    ]);
    render(<Harness />);
    const row = (await screen.findByText("Qwen3.8 27B")).closest("div.rounded-md") as HTMLElement;
    expect(within(row).getByText("Files verified")).toBeInTheDocument();
    expect(within(row).queryByText("Ready")).not.toBeInTheDocument();
    expect(within(row).getByText("Memory: 24 GB minimum · 32 GB recommended")).toBeInTheDocument();
    expect(within(row).getByText("Quality is not yet qualified. 32 GB or more memory is recommended.")).toBeInTheDocument();
    expect(within(row).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(installOllamaModelMock).not.toHaveBeenCalled();
  });

  it("keeps the curated catalog discoverable when Ollama status fails", async () => {
    listOllamaModelCatalogMock.mockRejectedValue(new Error("connection refused"));
    getCuratedOllamaModelCatalogMock.mockResolvedValue([
      { id: "phi:2.7b", displayName: "Phi-2 3B", provider: "Microsoft via Ollama", diskSizeBytes: 1_602_462_823, contextTokens: 2048, minimumMemoryBytes: 4294967296, recommendedMemoryBytes: 8589934592, license: "MIT", disclosure: null, lanes: ["dictation"], expectedManifestDigest: "sha256:expected", installed: false, installedDigest: null, installedSizeBytes: null, ready: false },
    ]);
    render(<Harness />);
    expect(await screen.findByText("Phi-2 3B")).toBeInTheDocument();
    expect(screen.getByText(/Ollama isn.t responding on this Mac/)).toBeInTheDocument();
  });

  it("keeps an Ollama install failure visible after refreshing its catalog", async () => {
    listOllamaModelCatalogMock.mockResolvedValue([
      { id: "phi:2.7b", displayName: "Phi-2 3B", provider: "Microsoft via Ollama", diskSizeBytes: 1_602_462_823, contextTokens: 2048, minimumMemoryBytes: null, recommendedMemoryBytes: null, license: "MIT", disclosure: null, lanes: ["dictation"], expectedManifestDigest: "sha256:expected", installed: false, installedDigest: null, installedSizeBytes: null, ready: false },
    ]);
    installOllamaModelMock.mockRejectedValueOnce(new Error("Download failed: disk is full"));
    render(<Harness />);
    const catalog = await screen.findByRole("region", { name: "Local Ollama model catalog" });
    fireEvent.click(within(catalog).getByRole("button", { name: "Install" }));
    await waitFor(() => expect(listOllamaModelCatalogMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(catalog).getByRole("button", { name: "Install" })).toBeEnabled());
    expect(within(catalog).getByText("The Ollama model could not be installed. Check Ollama and available disk space, then try again.")).toBeInTheDocument();
    fireEvent.click(within(catalog).getByRole("button", { name: "Install" }));
    await waitFor(() => expect(installOllamaModelMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(catalog).queryByText("The Ollama model could not be installed. Check Ollama and available disk space, then try again.")).not.toBeInTheDocument());
  });

  it("reports a failed Ollama cancellation while keeping the download active", async () => {
    listOllamaModelCatalogMock.mockResolvedValue([
      { id: "phi:2.7b", displayName: "Phi-2 3B", provider: "Microsoft via Ollama", diskSizeBytes: 1_602_462_823, contextTokens: 2048, minimumMemoryBytes: null, recommendedMemoryBytes: null, license: "MIT", disclosure: null, lanes: ["dictation"], expectedManifestDigest: "sha256:expected", installed: false, installedDigest: null, installedSizeBytes: null, ready: false },
    ]);
    let finishInstall!: () => void;
    installOllamaModelMock.mockImplementationOnce(() => new Promise<void>((resolve) => { finishInstall = resolve; }));
    cancelOllamaModelInstallMock.mockRejectedValueOnce(new Error("Could not stop the download"));
    render(<Harness />);
    const catalog = await screen.findByRole("region", { name: "Local Ollama model catalog" });
    fireEvent.click(within(catalog).getByRole("button", { name: "Install" }));
    fireEvent.click(await within(catalog).findByRole("button", { name: "Cancel" }));
    expect(await within(catalog).findByText("The Ollama download could not be cancelled. Try again.")).toBeInTheDocument();
    expect(within(catalog).getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(within(catalog).queryByRole("button", { name: "Install" })).not.toBeInTheDocument();
    fireEvent.click(within(catalog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(cancelOllamaModelInstallMock).toHaveBeenCalledTimes(2));
    expect(within(catalog).queryByText("The Ollama download could not be cancelled. Try again.")).not.toBeInTheDocument();
    expect(within(catalog).getByRole("button", { name: "Cancel" })).toBeEnabled();
    await act(async () => { finishInstall(); });
    await waitFor(() => expect(within(catalog).getByRole("button", { name: "Install" })).toBeEnabled());
  });

  it("does not let an older catalog response overwrite a newer one", async () => {
    let resolveOld!: (models: unknown[]) => void;
    const oldResponse = new Promise<unknown[]>((resolve) => { resolveOld = resolve; });
    listOllamaModelCatalogMock
      .mockImplementationOnce(() => oldResponse)
      .mockResolvedValueOnce([
        { id: "phi:2.7b", displayName: "Newest catalog", provider: "Microsoft via Ollama", diskSizeBytes: 1_602_462_823, contextTokens: 2048, minimumMemoryBytes: null, recommendedMemoryBytes: null, license: "MIT", disclosure: null, lanes: ["dictation"], expectedManifestDigest: "sha256:new", installed: true, installedDigest: "sha256:new", installedSizeBytes: 1_602_462_823, ready: true },
      ]);
    render(<StrictMode><Harness /></StrictMode>);
    expect(await screen.findByText("Newest catalog")).toBeInTheDocument();
    resolveOld([
      { id: "phi:2.7b", displayName: "Stale catalog", provider: "Microsoft via Ollama", diskSizeBytes: 1_602_462_823, contextTokens: 2048, minimumMemoryBytes: null, recommendedMemoryBytes: null, license: "MIT", disclosure: null, lanes: ["dictation"], expectedManifestDigest: "sha256:old", installed: false, installedDigest: null, installedSizeBytes: null, ready: false },
    ]);
    await Promise.resolve();
    expect(screen.queryByText("Stale catalog")).not.toBeInTheDocument();
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
    expect(row.textContent).toContain("496 MB to download");
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
      screen.getByText(/Speech models on this Mac take 148 MB in 1 file, measured from the files themselves\./),
    ).toBeInTheDocument();
  });

  /**
   * Moved here from the Transcription tab's diagnostics card, where it was
   * called "Meeting quality policy" and stood two tabs away from the list it
   * reorders -- so it read like a second meetings engine picker.
   */
  it("puts the meetings ordering control beside the meetings list and persists it", async () => {
    render(<Harness />);

    const picker = await screen.findByRole("combobox", {
      name: "Which meeting models to list first",
    });
    const describedBy = picker.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(
      document.getElementById(describedBy as string)?.textContent,
    ).toMatch(/only reorders the list below/i);

    fireEvent.change(picker, { target: { value: "best_available" } });

    await waitFor(() => {
      expect(lastSaved().transcription.meetingRoutePolicy).toBe(
        "best_available",
      );
    });
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
        name: "Your speech model needs attention",
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
    fireEvent.click(within(presets).getByRole("radio", { name: /Recommended/ }));

    await waitFor(() => {
      expect(screen.getByText(/^Active preset/).textContent).toContain(
        "Recommended",
      );
    });

    // Every finished model is in the lane's own list, no click away.
    const meetings = screen.getByRole("region", { name: "Speech for meetings" });
    fireEvent.click(
      within(meetings).getByRole("radio", { name: /Distil-Whisper Large \(English\)/ }),
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

    fireEvent.click(within(presets).getByRole("radio", { name: /Recommended/ }));

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
    expect(screen.getByText(/^Active preset/).textContent).toContain("Recommended");
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
    fireEvent.click(within(presets).getByRole("radio", { name: /Recommended/ }));
    await waitFor(() => {
      expect(screen.getByText(/^Active preset/).textContent).toContain(
        "Recommended",
      );
    });

    // Move dictation onto the 110M build, which is not on disk. Meetings stay
    // on v3, which is.
    fireEvent.click(screen.getByRole("button", { name: /Show \d+ more/ }));
    const drawer = screen.getByRole("region", { name: "Experimental models and cloud services" });
    const legacyRow = within(drawer)
      .getByText("Parakeet 110M (older, English)")
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
      // This fixture lists no GGUF Parakeet, so ONNX Parakeet is plain "Parakeet v3".
      within(meetings).getByRole("radio", { name: /Parakeet v3/ }),
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

  it("shows download progress on the row and holds other rows' actions until it finishes", async () => {
    let finish: () => void = () => {};
    downloadAsrModelsMock.mockImplementationOnce(
      () => new Promise<void>((resolve) => { finish = resolve; }),
    );
    let emitProgress: ((payload: unknown) => void) | null = null;
    listenMock.mockImplementation(async (event: string, callback: (payload: unknown) => void) => {
      if (event === "asr-download-progress") emitProgress = callback;
      return () => {};
    });
    render(<Harness />);
    const meetings = await screen.findByRole("region", { name: "Speech for meetings" });
    fireEvent.click(within(meetings).getByRole("radio", { name: /Parakeet v3/ }));
    const meetingsRow = await screen.findByRole("region", { name: "Speech for meetings" });
    await waitFor(() => expect(within(meetingsRow).getByText("Needs download")).toBeInTheDocument());
    fireEvent.click(within(meetingsRow).getByRole("button", { name: "Download" }));

    expect(await within(meetingsRow).findByRole("button", { name: "Downloading…" })).toBeDisabled();
    await waitFor(() => expect(emitProgress).not.toBeNull());
    act(() => {
      emitProgress?.({ payload: ["parakeet", 37.2] });
    });
    expect(await within(meetingsRow).findByRole("button", { name: "Downloading 37%" })).toBeDisabled();

    await act(async () => {
      finish();
    });
    await waitFor(() =>
      expect(within(meetingsRow).queryByRole("button", { name: /Downloading/ })).toBeNull(),
    );
  });

  it("lists downloaded speech models and removes one no lane uses, after a confirm", async () => {
    listDownloadedModelsMock.mockResolvedValue([
      { name: "Whisper ggml-base.en.bin", provider: "whisper", path: "/models/whisper/ggml-base.en.bin", sizeBytes: 148_000_000 },
      { name: "Distil", provider: "distil_whisper", path: "/models/distil_whisper/model.bin", sizeBytes: 756_000_000 },
    ]);
    render(<Harness />);
    const list = await screen.findByRole("list", { name: "Downloaded speech models" });
    const distilRow = within(list).getAllByRole("listitem")[0];
    // The lanes use Distil-Whisper, so it can't be removed from here.
    expect(within(distilRow).getByText(/used for dictation and meetings/)).toBeInTheDocument();
    expect(within(distilRow).queryByRole("button")).toBeNull();

    const whisperRow = within(list).getAllByRole("listitem")[1];
    fireEvent.click(within(whisperRow).getByRole("button", { name: /^Remove / }));
    expect(deleteModelFileMock).not.toHaveBeenCalled();
    listDownloadedModelsMock.mockResolvedValue([
      { name: "Distil", provider: "distil_whisper", path: "/models/distil_whisper/model.bin", sizeBytes: 756_000_000 },
    ]);
    fireEvent.click(within(whisperRow).getByRole("button", { name: /^Remove \d/ }));
    await waitFor(() => expect(deleteModelFileMock).toHaveBeenCalledWith("/models/whisper/ggml-base.en.bin"));
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(1));
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
    const names = options.map((option) =>
      (option.querySelector("span > span")?.textContent ?? "").replace(/^Recommended/, ""),
    );

    // Positive first, and exhaustive. A `?? ""` fallback means a selector that
    // stops matching the name element yields a list of empty strings, and a
    // suite that only asks "does any name contain base.en" passes on that
    // happily while checking nothing at all. Naming every option the lane
    // offers makes the list itself the assertion.
    // Every distinct meeting model, recommended first, then by download size.
    expect(names).toEqual([
      // The only Parakeet v3 this fixture offers.
      "Parakeet v3",
      "Whisper Small",
      "Whisper Medium",
      "Whisper Large Turbo",
      "Distil-Whisper Large (English)",
      "Whisper Large",
    ]);
    expect(names.every((name) => name.trim().length > 0)).toBe(true);

    // And then the exclusions the list above already implies, spelled out so a
    // future addition to the fixture cannot quietly bring one back.
    expect(names.some((name) => name.includes("Whisper Base"))).toBe(false);
    expect(names.some((name) => name.includes("Apple Speech"))).toBe(false);
    expect(names.some((name) => name.includes("Parakeet v3"))).toBe(true);
    // whisper.cpp reaches this lane only through a multilingual model.
    expect(names.some((name) => name.includes("Whisper Large Turbo"))).toBe(true);
  });

  /** Apple Speech, as one lane lists it: it needs no download, so it is listed first after the recommended model. */
  function appleSpeechOption(lane: "Speech for dictation" | "Speech for meetings"): HTMLElement | null {
    const region = screen.getByRole("region", { name: lane });
    return within(region).queryByRole("radio", { name: /^Apple Speech/ });
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

    expect(appleSpeechOption("Speech for meetings")).toBeEnabled();
    expect(appleSpeechOption("Speech for dictation")).toBeEnabled();
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
    // Dictation still offers it.
    expect(appleSpeechOption("Speech for dictation")).toBeEnabled();
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
    fireEvent.click(appleSpeechOption("Speech for dictation") as HTMLElement);

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

  /**
   * macOS owns the download and it can run for minutes. Without a way out,
   * "Installing language…" was a state the reader could only leave by
   * quitting.
   */
  it("lets the reader stop a language install that is taking too long", async () => {
    let releaseInstall: (value: unknown) => void = () => {};
    installAppleSpeechLanguageMock.mockImplementation(
      () =>
        new Promise<unknown>((resolve) => {
          releaseInstall = resolve;
        }),
    );
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
    fireEvent.click(appleSpeechOption("Speech for dictation") as HTMLElement);

    const dictation = await screen.findByRole("region", {
      name: "Speech for dictation",
    });
    fireEvent.click(
      await within(dictation).findByRole("button", { name: "Install language" }),
    );

    // While it runs, the button says so and a way out appears beside it.
    await screen.findByRole("button", { name: "Installing language…" });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(cancelAppleSpeechLanguageInstallMock).toHaveBeenCalledTimes(1),
    );
    expect(await screen.findAllByRole("button", { name: "Stopping…" })).not.toHaveLength(0);

    // The install call returns (the sidecar reports a cancelled install), and
    // the screen goes back to offering it rather than staying stuck.
    releaseInstall({
      install: null,
      readiness: SPEECH_ANALYZER_READINESS,
      notes: ["Apple Speech language install failed: cancelled"],
    });
    await screen.findByRole("button", { name: "Install language" });
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

    // Listed with the other models, but it can't be picked until macOS allows it.
    const apple = within(dictation).getByRole("radio", { name: /^Apple Speech/ });
    expect(apple).toBeDisabled();
    expect(apple.textContent).toMatch(/Permission denied/);
  });

  it.each(["ready provider", "different current model missing"])("offers installed Unified EN in both lanes for %s without selecting it", async (condition) => {
    getAsrProviderInventoryMock.mockResolvedValue([
      ...inventoryFixture(),
      { providerType: "transcribe_cpp", name: "Unified EN", description: "Experimental English",
        isAvailable: condition === "ready provider", inferenceEnabled: true,
        selectedModelId: condition === "ready provider" ? "parakeet-unified-en-0.6b-q8_0" : "parakeet-tdt-0.6b-v3-q8_0",
        modelOptions: [{ id: "parakeet-unified-en-0.6b-q8_0", label: "Parakeet Unified EN Q8" }],
        downloadStatus: condition === "ready provider" ? "Downloaded" : "NotDownloaded" } as AsrProviderInventory,
    ]);
    listDownloadedModelsMock.mockResolvedValue([
      "parakeet-unified-en-0.6b-Q8_0.gguf", "parakeet-unified-en-0.6b-NVIDIA-MODEL-CARD.md",
      "parakeet-unified-en-0.6b-NVIDIA-OPEN-MODEL-LICENSE.pdf",
    ].map(name => ({ name, path: `/models/transcribe_cpp/${name}`, provider: "transcribe_cpp", sizeBytes: 1 })));
    render(<Harness />);
    for (const name of ["Speech for dictation", "Speech for meetings"]) {
      const lane = await screen.findByRole("region", { name });
      const option = await within(lane).findByRole("radio", { name: /Parakeet Unified English/ });
      expect(option).toHaveAttribute("aria-checked", "false");
      expect(option.textContent).toMatch(/English/);
      expect(option.textContent).toMatch(/experimental/i);
    }
  });

  it("marks GGUF Parakeet as recommended for dictation and meetings without switching anything", async () => {
    getAsrProviderInventoryMock.mockResolvedValue([
      ...inventoryFixture(),
      { providerType: "transcribe_cpp", name: "transcribe.cpp", description: "GGUF Parakeet",
        isAvailable: false, inferenceEnabled: true,
        selectedModelId: "parakeet-tdt-0.6b-v3-q8_0",
        modelOptions: [{ id: "parakeet-tdt-0.6b-v3-q8_0", label: "Parakeet TDT 0.6B v3 GGUF Q8_0 via transcribe.cpp" }],
        downloadStatus: "NotDownloaded" } as AsrProviderInventory,
    ]);
    render(<Harness />);
    for (const name of ["Speech for dictation", "Speech for meetings"]) {
      const lane = await screen.findByRole("region", { name });
      const option = await within(lane).findByRole("radio", { name: /^Recommended\s*Parakeet v3(?! Compatible)/ });
      expect(option).toHaveAttribute("aria-checked", "false");
      expect(option.textContent).toMatch(/Recommended/);
      expect(option.textContent).toMatch(/one download covers dictation and meetings/i);
      // A choice card names outcomes, not how the engine schedules work.
      expect(option.textContent).not.toMatch(/one recording at a time|GGUF|transcribe\.cpp|GPU/);
      // No other option in the lane carries the mark.
      expect(within(lane).getAllByText("Recommended")).toHaveLength(1);
    }
    expect(savedSettings).toHaveLength(0);
  });

  it("marks the only Parakeet v3 Recommended where the build lists no GGUF route", async () => {
    render(<Harness />);
    for (const name of ["Speech for dictation", "Speech for meetings"]) {
      const lane = await screen.findByRole("region", { name });
      expect(within(lane).queryByRole("radio", { name: /GGUF|Compatible/ })).toBeNull();
      expect(within(lane).getAllByText("Recommended")).toHaveLength(1);
      // Recommended comes first.
      expect(within(lane).getAllByRole("radio")[0]).toHaveAccessibleName(/^Recommended\s*Parakeet v3/);
    }
  });

  it.each(["missing license", "disabled backend"])("keeps Unified EN out of primary lanes for %s", async (condition) => {
    getAsrProviderInventoryMock.mockResolvedValue([
      ...inventoryFixture(),
      { providerType: "transcribe_cpp", name: "Unified EN", description: "Experimental English",
        isAvailable: true, inferenceEnabled: condition !== "disabled backend",
        selectedModelId: "parakeet-unified-en-0.6b-q8_0",
        modelOptions: [{ id: "parakeet-unified-en-0.6b-q8_0", label: "Parakeet Unified EN Q8" }],
        downloadStatus: "Downloaded" } as AsrProviderInventory,
    ]);
    listDownloadedModelsMock.mockResolvedValue([
      "parakeet-unified-en-0.6b-Q8_0.gguf", "parakeet-unified-en-0.6b-NVIDIA-MODEL-CARD.md",
      ...(condition === "missing license" ? [] : ["parakeet-unified-en-0.6b-NVIDIA-OPEN-MODEL-LICENSE.pdf"]),
    ].map(name => ({ name, path: `/models/transcribe_cpp/${name}`, provider: "transcribe_cpp", sizeBytes: 1 })));
    render(<Harness />);
    for (const name of ["Speech for dictation", "Speech for meetings"]) {
      const lane = await screen.findByRole("region", { name });
      expect(within(lane).queryByRole("radio", { name: /Parakeet Unified English/ })).toBeNull();
    }
  });

  it("lists every finished model in the lanes, and keeps only experimental ones collapsed", async () => {
    render(<Harness />);
    const dictation = await screen.findByRole("region", { name: "Speech for dictation" });

    // No click needed for any distinct model on this Mac, in two sections:
    // the models that also do meetings, then the ones for dictation only.
    const names = (container: HTMLElement) =>
      within(container)
        .getAllByRole("radio")
        .map((option) =>
          (option.querySelector("span > span")?.textContent ?? "").replace(/^Recommended/, ""),
        );
    expect(names(within(dictation).getByRole("group", { name: "Dictation and meetings" }))).toEqual([
      "Parakeet v3",
      "Whisper Small",
      "Whisper Medium",
      "Whisper Large Turbo",
      "Distil-Whisper Large (English)",
      "Whisper Large",
    ]);
    expect(names(within(dictation).getByRole("group", { name: "Dictation only" }))).toEqual([
      "Apple Speech",
      "Whisper Tiny",
      "Whisper Tiny (English)",
      "Whisper Base",
      "Whisper Base (English)",
      "Whisper Small (English)",
      "Whisper Medium (English)",
    ]);
    // The meetings lane lists only models that can do meetings, ungrouped.
    const meetings = screen.getByRole("region", { name: "Speech for meetings" });
    expect(within(meetings).queryByRole("group")).not.toBeInTheDocument();
    // A model that covers both needs no note about meetings.
    expect(within(dictation).queryByText(/is for dictation only/)).not.toBeInTheDocument();
    expect(within(dictation).queryByText(/Parakeet 110M/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Show \d+ more/ }));
    const drawer = screen.getByRole("region", { name: "Experimental models and cloud services" });
    expect(within(drawer).getByText("Parakeet 110M (older, English)")).toBeInTheDocument();
    // Finished models are not repeated here.
    expect(within(drawer).queryByText("Whisper Tiny")).not.toBeInTheDocument();
    expect(within(drawer).queryByText(/Compatible/)).not.toBeInTheDocument();
  });

  it("says when the dictation model is for dictation only, and leads to the meetings model", async () => {
    const initial = settingsFixture();
    initial.transcription = {
      ...initial.transcription,
      useSharedAsrSelection: false,
      dictationProvider: "whisper",
      dictationModelId: "tiny",
    };
    render(<Harness initial={initial} />);
    const dictation = await screen.findByRole("region", { name: "Speech for dictation" });
    expect(
      within(within(dictation).getByRole("group", { name: "Dictation only" })).getByRole("radio", {
        name: /^Whisper Tiny(?! \()/,
      }),
    ).toHaveAttribute("aria-checked", "true");
    expect(within(dictation).getByText("Whisper Tiny is for dictation only.")).toBeInTheDocument();
    expect(within(dictation).getByText("Meetings use Distil-Whisper Large (English).")).toBeInTheDocument();

    fireEvent.click(within(dictation).getByRole("button", { name: "Change meetings model" }));
    const meetings = screen.getByRole("region", { name: "Speech for meetings" });
    expect(document.activeElement).toBe(
      within(meetings).getByRole("radio", { name: /Distil-Whisper Large/ }),
    );

    // Choosing a model that covers both takes the note away.
    fireEvent.click(within(dictation).getByRole("radio", { name: /^Whisper Small(?! \()/ }));
    await waitFor(() =>
      expect(within(dictation).queryByText(/is for dictation only/)).not.toBeInTheDocument(),
    );
    expect(lastSaved().transcription.dictationModelId).toBe("small");
    expect(lastSaved().transcription.meetingModelId).toBe("distil-large-v3.5");
  });

  it("says the engine list could not be read instead of inventing lanes", async () => {
    getAsrProviderInventoryMock.mockResolvedValue([]);

    render(<Harness />);

    expect(
      await screen.findByText(/Couldn.t read the speech models, so/),
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
        /149 MB\. English only\. Speak Spanish or German into it/,
      ),
    ).toBeInTheDocument();
    expect(
      within(dictation).getByText(
        /1\.7 GB\. Built for about 100 languages\. Not yet tested in Plainsong\. About eleven times the size of Whisper Base/,
      ),
    ).toBeInTheDocument();
    expect(
      within(dictation).getByText(
        /670 MB\. Tested in English\. Also built for 24 other European languages\./,
      ),
    ).toBeInTheDocument();
    // Each description appears once: on its own option, not again above the list.
    expect(within(dictation).getAllByText(/149 MB\. English only\./)).toHaveLength(1);
  });
  it("offers the live preview engine as a download that changes no transcription", async () => {
    render(<Harness />);

    const row = (await screen.findByRole("region", {
      name: "Live preview model",
    })) as HTMLElement;
    expect(
      within(row).getByText(/never changes what Plainsong types for you/i),
    ).toBeInTheDocument();
    expect(within(row).getByText("751 MB to download")).toBeInTheDocument();
    // Not downloaded: the row says what happens without it, rather than
    // implying the preview is off.
    expect(
      within(row).getByText(/Plainsong transcribes what you have said so far again/i),
    ).toBeInTheDocument();

    fireEvent.click(within(row).getByRole("button", { name: "Download" }));
    await waitFor(() => {
      expect(downloadLivePreviewEngineModelMock).toHaveBeenCalledTimes(1);
    });
    expect(
      await within(row).findByRole("button", { name: "Delete" }),
    ).toBeInTheDocument();
  });

  it("shows progress only for the preview model being installed", async () => {
    let finish!: (value: typeof LIVE_PREVIEW_STATUS) => void;
    downloadLivePreviewEngineModelMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<Harness />);
    const row = await screen.findByRole("region", { name: "Live preview model" });
    fireEvent.click(within(row).getByRole("button", { name: "Download" }));
    await waitFor(() => expect(downloadLivePreviewEngineModelMock).toHaveBeenCalledTimes(1));
    const callbacks = listenMock.mock.calls.filter(([event]) => event === "model-download-progress").map(([, callback]) => callback);
    const emit = (payload: unknown) => act(() => callbacks.forEach(callback => callback({ event: "model-download-progress", payload, id: 1 })));
    emit({ modelName: "another_model", percentage: 70 });
    expect(within(row).getByRole("button", { name: "Downloading…" })).toBeDisabled();
    emit({ modelName: LIVE_PREVIEW_STATUS.modelId, percentage: 42.3 });
    expect(within(row).getByRole("button", { name: "Downloading 42%" })).toBeDisabled();
    emit({ modelName: LIVE_PREVIEW_STATUS.modelId, percentage: Number.NaN });
    expect(within(row).getByRole("button", { name: "Downloading 42%" })).toBeDisabled();
    await act(async () => finish({ ...LIVE_PREVIEW_STATUS, ready: true }));
    expect(within(row).getByRole("button", { name: "Delete" })).toBeEnabled();
  });

  it("says which languages the engine's own file declares", async () => {
    render(<Harness />);

    const row = (await screen.findByRole("region", {
      name: "Live preview model",
    })) as HTMLElement;
    expect(
      within(row).getByText(/lists 3 languages \(English, Spanish, French\)/),
    ).toBeInTheDocument();
    expect(
      within(row).getByText(/for any other dictation language, the standard preview is used/i),
    ).toBeInTheDocument();
  });

  it("does not mistake a short installed file for an unfinished download", async () => {
    getLivePreviewEngineStatusMock.mockResolvedValue({
      ...LIVE_PREVIEW_STATUS,
      ready: false,
      // bytesOnDisk describes the installed path, not the separate temporary
      // file used for interrupted downloads. Its size cannot identify why
      // verification failed.
      bytesOnDisk: 120_000_000,
    });
    render(<Harness />);

    const row = (await screen.findByRole("region", {
      name: "Live preview model",
    })) as HTMLElement;
    expect(
      within(row).getByText(/couldn't verify the downloaded file, so it won't use it/i),
    ).toBeInTheDocument();
    expect(
      within(row).queryByText(/the download did not finish/i),
    ).not.toBeInTheDocument();
  });

  it("says a whole-but-unusable file could not be verified", async () => {
    getLivePreviewEngineStatusMock.mockResolvedValue({
      ...LIVE_PREVIEW_STATUS,
      ready: false,
      // Every byte is there and it still will not load: this session hashed
      // it and it did not match its pin. The copy says what Plainsong knows
      // --- it could not verify it --- without guessing at the cause.
      bytesOnDisk: LIVE_PREVIEW_STATUS.downloadBytes,
    });
    render(<Harness />);

    const row = (await screen.findByRole("region", {
      name: "Live preview model",
    })) as HTMLElement;
    expect(
      within(row).getByText(/couldn't verify the downloaded file, so it won't use it/i),
    ).toBeInTheDocument();
    expect(
      within(row).queryByText(/the download did not finish/i),
    ).not.toBeInTheDocument();
  });

  it("says nothing about the file when there is none on disk", async () => {
    render(<Harness />);

    const row = (await screen.findByRole("region", {
      name: "Live preview model",
    })) as HTMLElement;
    expect(within(row).queryByText(/checksum/i)).not.toBeInTheDocument();
    expect(
      within(row).queryByText(/the download did not finish/i),
    ).not.toBeInTheDocument();
  });

  it("shows nothing at all when this build has no streaming engine", async () => {
    getLivePreviewEngineStatusMock.mockResolvedValue({
      ...LIVE_PREVIEW_STATUS,
      supported: false,
      ready: false,
      modelId: null,
      displayName: null,
      engineName: null,
      license: null,
      downloadBytes: 0,
      languages: [],
      chunkMs: null,
      path: null,
    });
    render(<Harness />);

    await screen.findByRole("region", { name: "Speech for dictation" });
    expect(
      screen.queryByRole("region", { name: "Live preview model" }),
    ).not.toBeInTheDocument();
  });
});

describe("Models screen on a Mac that runs GGUF Parakeet", () => {
  const GGUF = {
    providerType: "transcribe_cpp",
    name: "transcribe.cpp",
    description: "GGUF Parakeet",
    isAvailable: false,
    inferenceEnabled: true,
    selectedModelId: "parakeet-tdt-0.6b-v3-q8_0",
    modelOptions: [
      { id: "parakeet-tdt-0.6b-v3-q8_0", label: "Parakeet TDT 0.6B v3 GGUF Q8_0 via transcribe.cpp" },
    ],
    downloadStatus: "NotDownloaded",
  } as unknown as AsrProviderInventory;

  /** An older install: both lanes on the shared ONNX Parakeet default, on disk. */
  function olderOnnxSettings(): Settings {
    const settings = settingsFixture();
    return {
      ...settings,
      transcription: {
        ...settings.transcription,
        defaultProvider: "parakeet",
        selectedModelId: "parakeet-tdt-0.6b-v3",
        useSharedAsrSelection: true,
        dictationProvider: "parakeet",
        dictationModelId: "parakeet-tdt-0.6b-v3",
        meetingProvider: "parakeet",
        meetingModelId: "parakeet-tdt-0.6b-v3",
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    savedSettings.length = 0;
    getAsrProviderInventoryMock.mockResolvedValue([
      ...inventoryFixture({
        parakeet: { downloadStatus: "Downloaded" } as Partial<AsrProviderInventory>,
      }),
      GGUF,
    ]);
    listDownloadedModelsMock.mockResolvedValue([
      {
        name: "Parakeet encoder.int8.onnx",
        provider: "parakeet",
        path: "/models/parakeet/parakeet-tdt-0.6b-v3/encoder.int8.onnx",
        sizeBytes: 652_000_000,
      },
    ]);
    downloadAsrModelsMock.mockResolvedValue(undefined);
    getBundledCleanupModelStatusMock.mockResolvedValue(BUNDLED_STATUS);
    getAppleLanguageModelAvailabilityMock.mockResolvedValue(APPLE_AVAILABILITY);
    getLivePreviewEngineStatusMock.mockResolvedValue(LIVE_PREVIEW_STATUS);
    listOllamaModelCatalogMock.mockResolvedValue([]);
    getCuratedOllamaModelCatalogMock.mockResolvedValue([]);
  });

  it("prices the faster version at every byte its download fetches on this Mac", async () => {
    getAsrProviderInventoryMock.mockResolvedValue([
      ...inventoryFixture({
        parakeet: { downloadStatus: "Downloaded" } as Partial<AsrProviderInventory>,
      }),
      // Neural Engine v3 632,169,729 + vocabulary 102,802,576, in place of the GGUF.
      { ...GGUF, modelDownloadBytes: { "parakeet-tdt-0.6b-v3-q8_0": 734_972_305 } },
    ]);
    vi.mocked(invoke).mockImplementation(async (command: string) =>
      command === "get_asr_runtime_diagnostics"
        ? { runtimeStatus: "ready" }
        : command === "chatgpt_get_status"
          ? { loaded: false, modelsReady: false, accounts: [], models: [] }
          : undefined,
    );
    render(<Harness initial={olderOnnxSettings()} />);

    const prompt = await screen.findByRole("region", { name: "Faster Parakeet v3" });
    expect(within(prompt).getByRole("button", { name: "Download and switch — 735 MB" })).toBeEnabled();
    expect(within(prompt).queryByText(/739 MB/)).toBeNull();
  });

  it("lists Parakeet v3 once in each lane, and offers its faster version with one click", async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) =>
      command === "get_asr_runtime_diagnostics"
        ? { runtimeStatus: "ready" }
        : command === "chatgpt_get_status"
          ? { loaded: false, modelsReady: false, accounts: [], models: [] }
          : undefined,
    );
    render(<Harness initial={olderOnnxSettings()} />);

    const prompt = await screen.findByRole("region", { name: "Faster Parakeet v3" });
    expect(prompt).toHaveTextContent("A faster, more accurate version of Parakeet v3 is available.");
    for (const name of ["Speech for dictation", "Speech for meetings"]) {
      const lane = await screen.findByRole("region", { name });
      const parakeet = within(lane)
        .getAllByRole("radio")
        .filter((option) => /Parakeet v3/.test(option.textContent ?? ""));
      // The lane's own Parakeet v3, still the ONNX build that is running.
      expect(parakeet).toHaveLength(1);
      expect(parakeet[0]).toHaveAttribute("aria-checked", "true");
      expect(within(lane).queryByText(/Compatible/)).toBeNull();
    }
    // Nothing downloads until the click.
    expect(downloadAsrModelsMock).not.toHaveBeenCalled();
    expect(savedSettings).toHaveLength(0);

    fireEvent.click(within(prompt).getByRole("button", { name: "Download and switch — 739 MB" }));
    await waitFor(() =>
      expect(downloadAsrModelsMock).toHaveBeenCalledWith("transcribe_cpp", "parakeet-tdt-0.6b-v3-q8_0"),
    );
    await waitFor(() => expect(savedSettings.length).toBeGreaterThan(0));
    expect(lastSaved().transcription).toMatchObject({
      useSharedAsrSelection: false,
      dictationProvider: "transcribe_cpp",
      dictationModelId: "parakeet-tdt-0.6b-v3-q8_0",
      meetingProvider: "transcribe_cpp",
      meetingModelId: "parakeet-tdt-0.6b-v3-q8_0",
      defaultProvider: "parakeet",
    });
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Faster Parakeet v3" })).toBeNull(),
    );
  });

  it("switches nothing when the download doesn't pass its check", async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) =>
      command === "get_asr_runtime_diagnostics" ? { runtimeStatus: "missing_model" } : undefined,
    );
    render(<Harness initial={olderOnnxSettings()} />);
    const prompt = await screen.findByRole("region", { name: "Faster Parakeet v3" });
    fireEvent.click(within(prompt).getByRole("button", { name: /Download and switch/ }));
    expect(await within(prompt).findByRole("alert")).toHaveTextContent(/didn't pass its check/);
    expect(savedSettings).toHaveLength(0);
  });

  it("offers no prompt to an install already on GGUF Parakeet, and never lists the ONNX build", async () => {
    const settings = olderOnnxSettings();
    render(
      <Harness
        initial={{
          ...settings,
          transcription: {
            ...settings.transcription,
            useSharedAsrSelection: false,
            dictationProvider: "transcribe_cpp",
            dictationModelId: "parakeet-tdt-0.6b-v3-q8_0",
            meetingProvider: "transcribe_cpp",
            meetingModelId: "parakeet-tdt-0.6b-v3-q8_0",
          },
        }}
      />,
    );
    const dictation = await screen.findByRole("region", { name: "Speech for dictation" });
    expect(screen.queryByRole("region", { name: "Faster Parakeet v3" })).toBeNull();
    const parakeet = within(dictation)
      .getAllByRole("radio")
      .filter((option) => /Parakeet v3/.test(option.textContent ?? ""));
    expect(parakeet).toHaveLength(1);
    expect(parakeet[0]).toHaveAccessibleName(/^Recommended\s*Parakeet v3/);
    expect(screen.getByText(/^Active preset/).textContent).toContain("Recommended");
  });

  it("asks the backend for nothing more and leaves no timer running once it has loaded", async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) =>
      command === "get_asr_runtime_diagnostics"
        ? { runtimeStatus: "ready" }
        : command === "chatgpt_get_status"
          ? { loaded: false, modelsReady: false, accounts: [], models: [] }
          : undefined,
    );
    const backendCalls = () =>
      [
        getAsrProviderInventoryMock,
        listDownloadedModelsMock,
        getBundledCleanupModelStatusMock,
        getAppleLanguageModelAvailabilityMock,
        getLivePreviewEngineStatusMock,
        listOllamaModelCatalogMock,
        getCuratedOllamaModelCatalogMock,
        listenMock,
        vi.mocked(invoke),
        readinessContext.refresh,
      ].reduce((total, fn) => total + fn.mock.calls.length, 0);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      // Settings > Models with the upgrade prompt showing: the most this
      // screen loads at once.
      render(<Harness initial={olderOnnxSettings()} />);
      await screen.findByRole("region", { name: "Faster Parakeet v3" });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      const settled = backendCalls();
      expect(settled).toBeGreaterThan(0);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });

      expect(backendCalls()).toBe(settled);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("gives each speech lane one Tab stop with arrow, Home and End selection", async () => {
    render(<Harness />);
    const group = await screen.findByRole("radiogroup", { name: "Speech for dictation" });
    const radios = within(group).getAllByRole("radio").filter((radio) => !radio.hasAttribute("disabled"));
    expect(radios.filter((radio) => radio.tabIndex === 0)).toHaveLength(1);
    radios.find((radio) => radio.tabIndex === 0)?.focus();
    await userEvent.keyboard("{End}");
    expect(radios.at(-1)).toHaveFocus();
    expect(radios.at(-1)).toHaveAttribute("aria-checked", "true");
    await userEvent.keyboard("{Home}");
    expect(radios[0]).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(radios[1]).toHaveFocus();
    expect(radios[1]).toHaveAttribute("aria-checked", "true");
  });

});
