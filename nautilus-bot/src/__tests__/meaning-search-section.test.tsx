import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MeaningSearchSection } from "@/components/settings/meaning-search-section";
import { SearchModelHint } from "@/components/memory/search-model-hint";
import type { EmbeddingStatus } from "@/lib/backend";
import type { TranscriptionSettings } from "@/types/settings";

const backend = vi.hoisted(() => ({
  getEmbeddingStatus: vi.fn(),
  downloadEmbeddingModel: vi.fn(),
  acceptEmbeddingModelTerms: vi.fn(),
  cancelEmbeddingModelDownload: vi.fn(async () => {}),
  deleteEmbeddingModel: vi.fn(),
  reindexEmbeddings: vi.fn(),
}));

vi.mock("@/lib/backend", () => backend);
vi.mock("@/lib/electron", () => ({
  listen: vi.fn(async () => () => {}),
}));
const toast = vi.hoisted(() => vi.fn());
vi.mock("@/components/toast", () => ({
  useToast: () => ({ toast }),
}));

async function chooseOption(trigger: HTMLElement, name: string | RegExp) {
  fireEvent.click(trigger);
  const listbox = await screen.findByRole("listbox");
  fireEvent.click(within(listbox).getByRole("option", { name }));
}

function status(overrides: Partial<EmbeddingStatus> = {}): EmbeddingStatus {
  return {
    memorySearchMode: "builtin",
    embeddingCount: 0,
    ollamaAvailable: false,
    builtInAvailable: true,
    builtInModels: [
      {
        id: "default-model",
        displayName: "Default Model",
        vendor: "Vendor",
        summary: "Best in tests.",
        languages: "English",
        license: "Apache-2.0",
        termsUrl: "https://www.apache.org/licenses/LICENSE-2.0",
        usePolicyUrl: "https://ai.google.dev/gemma/prohibited_use_policy",
        requiresTermsAcceptance: false,
        termsAccepted: true,
        downloadBytes: 330_000_000,
        downloaded: false,
        isDefault: true,
      },
      {
        id: "other-model",
        displayName: "Other Model",
        vendor: "Vendor",
        summary: "Bigger.",
        languages: "English",
        license: "MIT",
        termsUrl: "https://opensource.org/license/mit",
        usePolicyUrl: null,
        requiresTermsAcceptance: false,
        termsAccepted: true,
        downloadBytes: 600_000_000,
        downloaded: true,
        isDefault: false,
      },
      {
        id: "termed-model",
        displayName: "Termed Model",
        vendor: "Google",
        summary: "Needs its terms accepted.",
        languages: "English",
        license: "Gemma Terms of Use",
        termsUrl: "https://ai.google.dev/gemma/terms",
        usePolicyUrl: "https://ai.google.dev/gemma/prohibited_use_policy",
        requiresTermsAcceptance: true,
        termsAccepted: false,
        downloadBytes: 310_000_000,
        downloaded: false,
        isDefault: false,
      },
    ],
    selectedBuiltInModel: "default-model",
    indexedRecordings: 3,
    totalRecordings: 7,
    indexing: true,
    downloading: false,
    lastError: null,
    ...overrides,
  };
}

function transcription(overrides: Partial<TranscriptionSettings> = {}): TranscriptionSettings {
  return {
    memorySearchMode: "builtin",
    embeddingModel: "nomic-embed-text",
    builtinEmbeddingModel: "default-model",
    ...overrides,
  } as TranscriptionSettings;
}

describe("meaning search settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    backend.getEmbeddingStatus.mockResolvedValue(status());
    backend.downloadEmbeddingModel.mockResolvedValue(
      status({ builtInModels: status().builtInModels.map((model) => ({ ...model, downloaded: true })) }),
    );
  });

  it("shows a newly picked model at once, before the sidecar's status catches up", async () => {
    // The status still names the old model; the saved choice is the new one.
    render(
      <MeaningSearchSection
        transcription={transcription({ builtinEmbeddingModel: "other-model" })}
        onChange={vi.fn()}
      />,
    );
    expect(await screen.findByText(/Downloaded and verified/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Download Default Model" })).not.toBeInTheDocument();
  });

  it("shows a download that was already running when the screen opened, with Cancel", async () => {
    backend.getEmbeddingStatus.mockResolvedValue(status({ downloading: true }));
    render(<MeaningSearchSection transcription={transcription()} onChange={vi.fn()} />);
    expect(await screen.findByText(/^Downloading/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(backend.cancelEmbeddingModelDownload).toHaveBeenCalled());
  });

  it("offers the built-in models with their size and downloads the selected one on request", async () => {
    render(<MeaningSearchSection transcription={transcription()} onChange={vi.fn()} />);
    expect(await screen.findByText(/Download it once \(330 MB from Hugging Face\)/)).toBeInTheDocument();
    expect(screen.getByText("3 of 7 recordings indexed.")).toBeInTheDocument();
    expect(screen.getByText(/pauses while you dictate, record or ask/)).toBeInTheDocument();
    expect(backend.downloadEmbeddingModel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Download Default Model" }));
    await waitFor(() => expect(backend.downloadEmbeddingModel).toHaveBeenCalledWith("default-model"));
    expect(await screen.findByText(/Downloaded and verified/)).toBeInTheDocument();
  });

  it("prints the sidecar's summary of the selected search model, with what it was made for", async () => {
    // The sidecar owns this sentence (rust-sidecar/src/llm/builtin_embeddings.rs).
    const models = status().builtInModels.map((model, index) =>
      index === 0
        ? {
            ...model,
            id: "embeddinggemma-2",
            summary:
              "In an October 2026 English test of 124 questions over selected meetings, meaning search returned a relevant passage in the top five for 75.0%, against 53.2% for word matching.",
            languages: "English and 100+ other languages",
          }
        : model,
    );
    backend.getEmbeddingStatus.mockResolvedValue(status({ builtInModels: models, selectedBuiltInModel: "embeddinggemma-2" }));
    render(
      <MeaningSearchSection
        transcription={transcription({ builtinEmbeddingModel: "embeddinggemma-2" })}
        onChange={vi.fn()}
      />,
    );
    expect(
      await screen.findByText(
        "In an October 2026 English test of 124 questions over selected meetings, meaning search returned a relevant passage in the top five for 75.0%, against 53.2% for word matching. Made for English and 100+ other languages.",
      ),
    ).toBeInTheDocument();
  });

  it("marks the default as recommended and links its use policy without asking for acceptance", async () => {
    render(<MeaningSearchSection transcription={transcription()} onChange={vi.fn()} />);
    const select = await screen.findByRole("combobox", { name: "Search model" });
    expect(select).toHaveTextContent("Default Model by Vendor, 330 MB (recommended)");
    fireEvent.click(select);
    const listbox = await screen.findByRole("listbox");
    expect(within(listbox).getByRole("option", { name: /Termed Model.*\(Gemma Terms of Use\)/ })).toBeInTheDocument();
    expect(within(listbox).getByRole("option", { name: /Other Model/ })).not.toHaveTextContent("recommended");
    fireEvent.keyDown(listbox, { key: "Escape" });
    expect(screen.getByRole("link", { name: "Apache-2.0 license" })).toHaveAttribute(
      "href",
      "https://www.apache.org/licenses/LICENSE-2.0",
    );
    expect(screen.getByRole("link", { name: "the Gemma Prohibited Use Policy" })).toHaveAttribute(
      "href",
      "https://ai.google.dev/gemma/prohibited_use_policy",
    );
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByRole("button", { name: "Download Default Model" })).toBeEnabled();
  });

  it("downloads a model with its own terms only after they are accepted", async () => {
    backend.getEmbeddingStatus.mockResolvedValue(status({ selectedBuiltInModel: "termed-model" }));
    const order: string[] = [];
    backend.acceptEmbeddingModelTerms.mockImplementation(async () => {
      order.push("accept");
      return status({
        selectedBuiltInModel: "termed-model",
        builtInModels: status().builtInModels.map((model) => ({ ...model, termsAccepted: true })),
      });
    });
    backend.downloadEmbeddingModel.mockImplementation(async () => {
      order.push("download");
      return status({
        selectedBuiltInModel: "termed-model",
        builtInModels: status().builtInModels.map((model) => ({ ...model, termsAccepted: true, downloaded: true })),
      });
    });
    render(
      <MeaningSearchSection transcription={transcription({ builtinEmbeddingModel: "termed-model" })} onChange={vi.fn()} />,
    );
    const prompt = await screen.findByRole("group", { name: "Accept the Gemma Terms of Use to use Termed Model" });
    expect(within(prompt).getByRole("link", { name: "Gemma Terms of Use" })).toHaveAttribute(
      "href",
      "https://ai.google.dev/gemma/terms",
    );
    expect(within(prompt).getByRole("link", { name: "Gemma Prohibited Use Policy" })).toHaveAttribute(
      "href",
      "https://ai.google.dev/gemma/prohibited_use_policy",
    );
    expect(prompt).toHaveTextContent("Until you accept, search matches words.");
    expect(prompt).toHaveTextContent("Default Model, the recommended model, needs no extra terms.");
    expect(screen.queryByRole("button", { name: "Download Termed Model" })).toBeNull();
    const accept = within(prompt).getByRole("button", { name: "Accept and download (310 MB)" });
    expect(accept).toBeDisabled();
    fireEvent.click(accept);
    expect(backend.acceptEmbeddingModelTerms).not.toHaveBeenCalled();
    fireEvent.click(
      within(prompt).getByRole("checkbox", {
        name: "I accept the Gemma Terms of Use and the Gemma Prohibited Use Policy.",
      }),
    );
    expect(accept).toBeEnabled();
    fireEvent.click(accept);
    await waitFor(() => expect(order).toEqual(["accept", "download"]));
    expect(backend.acceptEmbeddingModelTerms).toHaveBeenCalledWith("termed-model", "https://ai.google.dev/gemma/terms");
    expect(backend.downloadEmbeddingModel).toHaveBeenCalledWith("termed-model");
    expect(await screen.findByText(/Downloaded and verified/)).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /Accept the Gemma Terms of Use/ })).toBeNull();
  });

  it("does not download when recording the acceptance fails", async () => {
    backend.getEmbeddingStatus.mockResolvedValue(status({ selectedBuiltInModel: "termed-model" }));
    backend.acceptEmbeddingModelTerms.mockRejectedValue(new Error("disk full"));
    render(
      <MeaningSearchSection transcription={transcription({ builtinEmbeddingModel: "termed-model" })} onChange={vi.fn()} />,
    );
    const prompt = await screen.findByRole("group", { name: /Accept the Gemma Terms of Use/ });
    fireEvent.click(within(prompt).getByRole("checkbox"));
    fireEvent.click(within(prompt).getByRole("button", { name: /Accept and download/ }));
    await waitFor(() => expect(backend.acceptEmbeddingModelTerms).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("group", { name: /Accept the Gemma Terms of Use/ })).toBeInTheDocument());
    expect(backend.downloadEmbeddingModel).not.toHaveBeenCalled();
  });

  it("cancels a running download without reporting an error", async () => {
    let fail: (error: Error) => void = () => {};
    backend.downloadEmbeddingModel.mockImplementation(
      () => new Promise((_, reject) => {
        fail = reject;
      }),
    );
    backend.cancelEmbeddingModelDownload.mockImplementation(async () => {
      fail(new Error("The search model download was cancelled."));
    });
    render(<MeaningSearchSection transcription={transcription()} onChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Download Default Model" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(backend.cancelEmbeddingModelDownload).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: "Download Default Model" })).toBeEnabled();
    expect(toast).not.toHaveBeenCalledWith(expect.anything(), "error");
  });

  it("removes a downloaded model that is not the one in use", async () => {
    backend.deleteEmbeddingModel.mockResolvedValue(
      status({ builtInModels: status().builtInModels.map((model) => ({ ...model, downloaded: false })) }),
    );
    render(<MeaningSearchSection transcription={transcription()} onChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove Other Model" }));
    await waitFor(() => expect(backend.deleteEmbeddingModel).toHaveBeenCalledWith("other-model"));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remove Other Model" })).toBeNull());
  });

  it("offers removal of downloaded models with word search selected too", async () => {
    backend.getEmbeddingStatus.mockResolvedValue(status({ memorySearchMode: "fts" }));
    render(<MeaningSearchSection transcription={transcription({ memorySearchMode: "fts" })} onChange={vi.fn()} />);
    expect(await screen.findByText("Downloaded search models")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Other Model" })).toBeEnabled();
  });

  it("rebuilds the built-in index in the background and returns at once", async () => {
    backend.getEmbeddingStatus.mockResolvedValue(
      status({ builtInModels: status().builtInModels.map((model) => ({ ...model, downloaded: true })) }),
    );
    backend.reindexEmbeddings.mockResolvedValue({ recordings: 0, segments: 0, errors: 0, background: true });
    render(<MeaningSearchSection transcription={transcription()} onChange={vi.fn()} />);
    const rebuild = await screen.findByRole("button", { name: "Rebuild" });
    await waitFor(() => expect(rebuild).toBeEnabled());
    fireEvent.click(rebuild);
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        "Rebuilding the index in the background. It pauses while you dictate or record.",
        "success",
      ),
    );
  });

  it("switches modes and built-in models through settings", async () => {
    const onChange = vi.fn();
    render(<MeaningSearchSection transcription={transcription()} onChange={onChange} />);
    await chooseOption(await screen.findByRole("combobox", { name: "Search model" }), /Other Model/);
    expect(onChange).toHaveBeenCalledWith({ builtinEmbeddingModel: "other-model" });
    await chooseOption(
      screen.getByRole("combobox", { name: "How Ask finds passages" }),
      "Match the words you type",
    );
    expect(onChange).toHaveBeenCalledWith({ memorySearchMode: "fts" });
  });

  it("keeps a typed Ollama model as Custom and offers the listed ones", async () => {
    const onChange = vi.fn();
    render(
      <MeaningSearchSection
        transcription={transcription({ memorySearchMode: "ollama_embeddings", embeddingModel: "my-embedder" })}
        onChange={onChange}
      />,
    );
    const select = await screen.findByRole("combobox", { name: "Ollama model used for meaning matching" });
    expect(select).toHaveTextContent("Custom…");
    expect(screen.getByLabelText("Ollama model name")).toHaveValue("my-embedder");
    await chooseOption(select, /qwen3-embedding:0\.6b/);
    expect(onChange).toHaveBeenCalledWith({ embeddingModel: "qwen3-embedding:0.6b" });
  });

  it("does not offer the built-in route in a build without its runtime", async () => {
    backend.getEmbeddingStatus.mockResolvedValue(status({ builtInAvailable: false }));
    render(<MeaningSearchSection transcription={transcription({ memorySearchMode: "fts" })} onChange={vi.fn()} />);
    await waitFor(() => expect(backend.getEmbeddingStatus).toHaveBeenCalled());
    await screen.findByRole("combobox", { name: "How Ask finds passages" });
    fireEvent.click(screen.getByRole("combobox", { name: "How Ask finds passages" }));
    const listbox = await screen.findByRole("listbox");
    await waitFor(() =>
      expect(within(listbox).getByRole("option", { name: /built into Plainsong/ })).toHaveAttribute(
        "aria-disabled",
        "true",
      ),
    );
  });

  it("under Ask, offers the missing search model and downloads it only when clicked", async () => {
    render(<SearchModelHint />);
    const button = await screen.findByRole("button", { name: "Download search model (330 MB)" });
    expect(backend.downloadEmbeddingModel).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(backend.downloadEmbeddingModel).toHaveBeenCalledWith("default-model"));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Download search model/ })).toBeNull());
  });

  it("under Ask, asks for the terms of a selected model that needs them, even when its files are present", async () => {
    const termed = status({
      selectedBuiltInModel: "termed-model",
      builtInModels: status().builtInModels.map((model) => ({ ...model, downloaded: true })),
    });
    backend.getEmbeddingStatus.mockResolvedValue(termed);
    backend.acceptEmbeddingModelTerms.mockResolvedValue({
      ...termed,
      builtInModels: termed.builtInModels.map((model) => ({ ...model, termsAccepted: true })),
    });
    render(<SearchModelHint />);
    const prompt = await screen.findByRole("group", { name: "Accept the Gemma Terms of Use to use Termed Model" });
    expect(screen.queryByRole("button", { name: /Download search model/ })).toBeNull();
    fireEvent.click(within(prompt).getByRole("checkbox"));
    fireEvent.click(within(prompt).getByRole("button", { name: "Accept and use" }));
    await waitFor(() =>
      expect(backend.acceptEmbeddingModelTerms).toHaveBeenCalledWith("termed-model", "https://ai.google.dev/gemma/terms"),
    );
    await waitFor(() => expect(screen.queryByRole("group")).toBeNull());
    expect(backend.downloadEmbeddingModel).not.toHaveBeenCalled();
  });

  it("under Ask, says why the download failed and follows one already running", async () => {
    backend.downloadEmbeddingModel.mockRejectedValueOnce(
      new Error("Error invoking remote method 'sidecar:invoke': Error: SIDECAR_DUPLICATE: download_embedding_model is already running for this target."),
    );
    const { unmount } = render(<SearchModelHint />);
    fireEvent.click(await screen.findByRole("button", { name: "Download search model (330 MB)" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This model is already downloading.");
    unmount();

    backend.getEmbeddingStatus.mockResolvedValue(status({ downloading: true }));
    render(<SearchModelHint />);
    expect(await screen.findByText(/^Downloading/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("says nothing under Ask with word search or a downloaded model", async () => {
    backend.getEmbeddingStatus.mockResolvedValue(status({ memorySearchMode: "fts" }));
    const { unmount } = render(<SearchModelHint />);
    await waitFor(() => expect(backend.getEmbeddingStatus).toHaveBeenCalled());
    expect(screen.queryByRole("button")).toBeNull();
    unmount();
    backend.getEmbeddingStatus.mockResolvedValue(
      status({ builtInModels: status().builtInModels.map((model) => ({ ...model, downloaded: true })) }),
    );
    render(<SearchModelHint />);
    await waitFor(() => expect(backend.getEmbeddingStatus).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button")).toBeNull();
  });
});
